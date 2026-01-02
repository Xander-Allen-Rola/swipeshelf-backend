import { Router } from "express";
import prisma from "../prisma";
import axios from "axios";

import pLimit from "p-limit";

const limit = pLimit(5); // max 5 concurrent Open Library requests

const router = Router();
const GOOGLE_API_KEY = process.env.GOOGLE_BOOKS_API_KEY;

type CandidateBook = {
  title: string;
  authors: string;
  publishedDate: number | null;
  isbn: string | null;
  coverUrl: string;
  googleBooksId: string;
  description: string;
  averageRating: number;
  categories: string[];
  // Sent to the frontend: all genres we associate with the recommendation.
  // (This will be overwritten to the effective multi-genre set at response time.)
  sourceGenreIds: number[];
  sourceGenreNames: string[];
};

type ScoredCandidate = {
  candidate: CandidateBook;
  score: number;
  genreIds: number[];
  genreScore: number;
  genreOverlapRatio: number;
  finishedScore: number;
  toReadScore: number;
  weights: { genre: number; finished: number; toRead: number };
};

type ShelfBookLite = {
  googleBooksId: string;
  title: string;
  description: string;
};

// Helper: fetch books for a query
// Helper: truncate description to N words
const truncateDescription = (text: string, wordLimit = 150) => {
  const words = text.split(/\s+/);
  if (words.length <= wordLimit) return text;
  return words.slice(0, wordLimit).join(" ") + " ...";
};

// Helper: fetch first Open Library cover by title + author
const fetchOpenLibraryCover = async (title: string, author: string): Promise<string | null> => {
  try {
    const res = await axios.get("https://openlibrary.org/search.json", {
      params: { title, author, limit: 1 },
    });

    const docs = res.data.docs;
    if (!docs || !docs.length) return null;

    const bookWithCover = docs.find((doc: any) => doc.cover_i);
    if (bookWithCover) {
      return `https://covers.openlibrary.org/b/id/${bookWithCover.cover_i}-L.jpg`;
    }

    return null;
  } catch (err: any) {
    if (err.response?.status === 429) {
      console.warn(`⚠️ Open Library rate limit hit for "${title}" by "${author}".`);
    } else {
      //console.error("❌ Error fetching Open Library cover:", err?.response?.data || err.message || err);
    }
    return null;
  }
};

// Wrapper to safely fetch with concurrency limit
const fetchCoverWithLimit = (title: string, author: string) =>
  limit(() => fetchOpenLibraryCover(title, author));

const fetchBooksFromGoogle = async (query: string, maxResults = 20) => {
  const res = await axios.get("https://www.googleapis.com/books/v1/volumes", {
    params: { q: query, maxResults, key: GOOGLE_API_KEY },
  });

  const books = await Promise.all(
    res.data.items?.map(async (item: any) => {
      const coverUrl = await fetchCoverWithLimit(
        item.volumeInfo.title,
        item.volumeInfo.authors?.[0] || ""
      );

      let description = item.volumeInfo.description || null;
      if (!coverUrl || !description) return null; // exclude books missing essential info

      // ✅ limit to 150 words
      description = truncateDescription(description, 150);

      const title = item.volumeInfo.title || "";

      // 🚫 filter out Annotated / Illustrated editions
      const forbidden = ["annotated", "illustrated"];
      if (forbidden.some((word) => title.toLowerCase().includes(word))) {
        return null;
      }

      return {
        title,
        authors: item.volumeInfo.authors?.join(", ") || "Unknown",
        publishedDate: item.volumeInfo.publishedDate
          ? parseInt(item.volumeInfo.publishedDate.slice(0, 4))
          : null,
        isbn:
          item.volumeInfo.industryIdentifiers?.find(
            (id: any) => id.type === "ISBN_13"
          )?.identifier || null,
        coverUrl,
        googleBooksId: item.id,
        description, // ✅ already truncated
        averageRating: item.volumeInfo.averageRating || 0,
        categories: item.volumeInfo.categories || [],
      };
    }) || []
  );

  return books.filter(Boolean);
};

const tokenize = (text: string): Set<string> => {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3)
  );
};

const jaccardSimilarity = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) {
    if (b.has(x)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

const bookToText = (book: { title?: string; authors?: string; description?: string; categories?: string[] }) => {
  const parts = [book.title ?? "", book.authors ?? "", book.description ?? "", (book.categories ?? []).join(" ")];
  return parts.filter(Boolean).join(" ");
};

const normalizeKeyPart = (value: string) => {
  return value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
};

const normalizedCandidateKey = (book: CandidateBook): string => {
  const title = normalizeKeyPart(book.title ?? "");
  const author = normalizeKeyPart((book.authors ?? "").split(",")[0] ?? "");
  if (title && author) return `${title}|${author}`;
  if (title) return `${title}|unknown-author`;
  return `id|${book.googleBooksId}`;
};

type SimilarityDetail = {
  score: number;
  matchedIndex: number;
};

const maxSimilarityToShelfDetailed = (
  candidateTokens: Set<string>,
  shelfTokenSets: Set<string>[]
): SimilarityDetail => {
  let best = 0;
  let matchedIndex = -1;
  for (let i = 0; i < shelfTokenSets.length; i += 1) {
    const sim = jaccardSimilarity(candidateTokens, shelfTokenSets[i]!);
    if (sim > best) {
      best = sim;
      matchedIndex = i;
    }
  }
  return { score: best, matchedIndex };
};

const countIntersection = (a: Set<number>, b: Set<number>) => {
  let count = 0;
  for (const x of a) {
    if (b.has(x)) count += 1;
  }
  return count;
};

const addSourceGenre = (candidate: CandidateBook, genreId?: number, genreName?: string) => {
  if (!genreId) return;
  const ids = new Set<number>(candidate.sourceGenreIds ?? []);
  ids.add(genreId);
  candidate.sourceGenreIds = Array.from(ids);

  const names = new Set<string>(candidate.sourceGenreNames ?? []);
  if (genreName) names.add(genreName);
  candidate.sourceGenreNames = Array.from(names);
};

const tokenizeWords = (value: string) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 3);

const splitGenreParts = (genreName: string) =>
  genreName
    .split(/[/,&]|\band\b/i)
    .map((p) => p.trim())
    .filter(Boolean);

const isTokenSubset = (a: Set<string>, b: Set<string>) => {
  for (const t of a) {
    if (!b.has(t)) return false;
  }
  return true;
};

const deriveGenreIdsFromCategories = (
  categories: string[] | undefined,
  allGenres: Array<{ id: number; name: string }>
): Set<number> => {
  const derived = new Set<number>();
  if (!categories || categories.length === 0) return derived;

  const categoryTokenSets = categories
    .map((c) => new Set(tokenizeWords(c)))
    .filter((s) => s.size > 0);

  const matched: Array<{ id: number; tokens: Set<string> }> = [];

  for (const genre of allGenres) {
    const fullTokens = new Set(tokenizeWords(genre.name));
    if (fullTokens.size === 0) continue;

    const parts = splitGenreParts(genre.name);
    const partTokenSets = parts
      .map((p) => new Set(tokenizeWords(p)))
      .filter((s) => s.size > 0);

    const matchedAnyCategory = categoryTokenSets.some((catTokens) =>
      partTokenSets.some((genrePartTokens) => isTokenSubset(genrePartTokens, catTokens))
    );

    if (matchedAnyCategory) {
      matched.push({ id: genre.id, tokens: fullTokens });
    }
  }

  // Prune less-specific matches when a more specific genre is also matched.
  const matchedIds = matched.map((m) => m.id);
  const tokensById = new Map<number, Set<string>>(matched.map((m) => [m.id, m.tokens]));
  const prunedIds = new Set<number>(matchedIds);
  for (const a of matchedIds) {
    const aTokens = tokensById.get(a);
    if (!aTokens) continue;
    for (const b of matchedIds) {
      if (a === b) continue;
      const bTokens = tokensById.get(b);
      if (!bTokens) continue;
      if (aTokens.size >= bTokens.size) continue;
      if (isTokenSubset(aTokens, bTokens)) {
        prunedIds.delete(a);
        break;
      }
    }
  }

  for (const id of prunedIds) derived.add(id);
  return derived;
};

/** Get books from the "To Read" shelf for a user */
async function getToReadBooks(userId: number) {
  const shelf = await prisma.shelf.findFirst({
    where: { userId, name: "To Read" },
    include: {
      books: {
        include: { book: true },
        orderBy: { addedAt: "desc" }
      }
    }
  });

  if (!shelf) return [];

  return shelf.books.map((shelfBook) => ({
    id: shelfBook.id,
    googleBooksId: shelfBook.book.googleBooksId,
    title: shelfBook.title,
    coverURL: shelfBook.coverURL,
    description: shelfBook.description,
    status: shelfBook.status,
    addedAt: shelfBook.addedAt
  }));
}

/** Get books from the "Finished" shelf for a user */
async function getFinishedBooks(userId: number) {
  const shelf = await prisma.shelf.findFirst({
    where: { userId, name: "Finished" },
    include: {
      books: {
        include: { book: true },
        orderBy: { addedAt: "desc" }
      }
    }
  });

  if (!shelf) return [];

  return shelf.books.map((shelfBook) => ({
    id: shelfBook.id,
    googleBooksId: shelfBook.book.googleBooksId,
    title: shelfBook.title,
    coverURL: shelfBook.coverURL,
    description: shelfBook.description,
    status: shelfBook.status,
    addedAt: shelfBook.addedAt
  }));
}

async function getUserGenres(userId: number) {
  const userGenres = await prisma.userGenre.findMany({
    where: { userId },
    include: { genre: true },
  });

  // Return an array of genre objects or an empty array if none
  return userGenres.map((ug) => ug.genre);
}

/* --- Single endpoint ---
router.get("/books/:userId", async (req, res) => {
  const userId = Number(req.params.userId);
  if (!userId || isNaN(userId)) {
    return res.status(400).json({ error: "Valid userId is required" });
  }

  try {
    const toRead = await getToReadBooks(userId);
    const finished = await getFinishedBooks(userId);
    const genres = await getUserGenres(userId);

    res.json({
      toRead: { books: toRead, count: toRead.length },
      finished: { books: finished, count: finished.length },
      genres: { list: genres, count: genres.length }
    });
  } catch (err: any) {
    console.error("Error fetching books:", err);
    res.status(500).json({ error: "Failed to fetch books", details: err.message });
  }
}); */

// GET /api/recommendations/fetch/:userId
router.get("/fetch/:userId", async (req, res) => {
  const userId = parseInt(req.params.userId);
  if (!userId) return res.status(400).json({ error: "Invalid userId" });

  try {
    const userGenres = await prisma.userGenre.findMany({
      where: { userId },
      include: { genre: true },
    });

    if (!userGenres.length) {
      return res.status(200).json({ message: "User has no selected genres" });
    }

    console.log(`\n==============================`);
    console.log(`📌 Recommendations requested for userId=${userId}`);

    // User signals
    const preferredGenreIds = new Set<number>(userGenres.map((ug) => ug.genreId));
    console.log(
      `📚 Preferred genres (${userGenres.length}): ${userGenres
        .map((ug) => `${ug.genre.name}#${ug.genreId}`)
        .join(", ")}`
    );

    // Shelf context for similarity + exclusion
    const [toRead, finished] = await Promise.all([
      getToReadBooks(userId),
      getFinishedBooks(userId),
    ]);

    console.log(`📖 Shelf counts: toRead=${toRead.length}, finished=${finished.length}`);

    const toReadLite: ShelfBookLite[] = toRead
      .map((b) => ({
        googleBooksId: b.googleBooksId,
        title: b.title ?? "",
        description: b.description ?? "",
      }))
      .filter((b) => !!b.googleBooksId);

    const finishedLite: ShelfBookLite[] = finished
      .map((b) => ({
        googleBooksId: b.googleBooksId,
        title: b.title ?? "",
        description: b.description ?? "",
      }))
      .filter((b) => !!b.googleBooksId);

    const excludeGoogleIds = new Set<string>([
      ...toReadLite.map((b) => b.googleBooksId),
      ...finishedLite.map((b) => b.googleBooksId),
    ]);

    // Also exclude books the user has explicitly marked/seen
    const seen = await prisma.userBook.findMany({
      where: { userId },
      include: { book: true },
    });
    for (const ub of seen) {
      if (ub.book?.googleBooksId) excludeGoogleIds.add(ub.book.googleBooksId);
    }

    console.log(`👁️ UserBook(seen) count=${seen.length}; total excluded googleBooksId=${excludeGoogleIds.size}`);

    const toReadTokenSets = toReadLite.map((b) => tokenize(bookToText(b)));
    const finishedTokenSets = finishedLite.map((b) => tokenize(bookToText(b)));

    const weights = finishedLite.length > 0
      ? { genre: 0.35, finished: 0.40, toRead: 0.25 }
      : { genre: 0.70, finished: 0.20, toRead: 0.10 };
    console.log(
      `⚖️ Weights applied: genre=${weights.genre.toFixed(2)} finished=${weights.finished.toFixed(
        2
      )} toRead=${weights.toRead.toFixed(2)} (finishedBooks=${finishedLite.length})`
    );

    // 1️⃣ Fetch candidate books per preferred genre (dedupe BEFORE scoring)
    // Key: normalized title + author (fallback googleBooksId)
    const candidateMap = new Map<string, CandidateBook>();
    let fetchedTotal = 0;
    let skippedExcluded = 0;
    let skippedMissingId = 0;
    let dedupedCollisions = 0;
    for (const ug of userGenres) {
      const rawBooks = (await fetchBooksFromGoogle(`subject:${ug.genre.name}`, 40)) as CandidateBook[];
      fetchedTotal += rawBooks.length;
      for (const book of rawBooks) {
        if (!book?.googleBooksId) {
          skippedMissingId += 1;
          continue;
        }
        if (excludeGoogleIds.has(book.googleBooksId)) {
          skippedExcluded += 1;
          continue;
        }

        const candidate: CandidateBook = {
          ...book,
          sourceGenreIds: [],
          sourceGenreNames: [],
        };
        addSourceGenre(candidate, ug.genre.id, ug.genre.name);
        const key = normalizedCandidateKey(candidate);
        const existingCandidate = candidateMap.get(key);
        if (!existingCandidate) {
          candidateMap.set(key, candidate);
          continue;
        }

        // Same book key appeared under another genre query: merge the source genre(s).
        addSourceGenre(existingCandidate, ug.genre.id, ug.genre.name);

        // Collision: same normalized key (likely the same book with different Google Books IDs)
        dedupedCollisions += 1;
        console.log(
          `🧩 Deduped candidate key="${key}" kept=${existingCandidate.googleBooksId} dropped=${candidate.googleBooksId}`
        );

        // Heuristic: keep the one with higher rating; if tied, keep the longer description.
        const existingRating = existingCandidate.averageRating ?? 0;
        const incomingRating = candidate.averageRating ?? 0;
        const existingDescLen = (existingCandidate.description ?? "").length;
        const incomingDescLen = (candidate.description ?? "").length;

        const shouldReplace =
          incomingRating > existingRating ||
          (incomingRating === existingRating && incomingDescLen > existingDescLen);

        if (shouldReplace) {
          // Preserve merged source genres when replacing.
          const mergedSourceIds = new Set<number>(existingCandidate.sourceGenreIds);
          for (const id of candidate.sourceGenreIds) mergedSourceIds.add(id);
          candidate.sourceGenreIds = Array.from(mergedSourceIds);

          const mergedSourceNames = new Set<string>(existingCandidate.sourceGenreNames);
          for (const name of candidate.sourceGenreNames) mergedSourceNames.add(name);
          candidate.sourceGenreNames = Array.from(mergedSourceNames);

          candidateMap.set(key, candidate);
          console.log(
            `   ↳ replaced kept=${existingCandidate.googleBooksId} with=${candidate.googleBooksId} (rating ${existingRating}→${incomingRating}, descLen ${existingDescLen}→${incomingDescLen})`
          );
        }
      }
    }

    const candidates = Array.from(candidateMap.values());
    console.log(
      `🧪 Candidate fetch summary: fetchedTotal=${fetchedTotal}, uniqueCandidates=${candidates.length}, skippedExcluded=${skippedExcluded}, skippedMissingId=${skippedMissingId}, dedupedCollisions=${dedupedCollisions}`
    );
    if (candidates.length === 0) {
      return res.status(200).json([]);
    }

    // Fetch all genres once so we can map Google categories -> DB genres.
    const allGenres = await prisma.genre.findMany({ select: { id: true, name: true } });

    // 2️⃣ Pull any existing DB genres for candidates (authoritative)
    const existing = await prisma.book.findMany({
      where: { googleBooksId: { in: candidates.map((c) => c.googleBooksId) } },
      select: {
        googleBooksId: true,
        genres: { select: { genreId: true } },
      },
    });
    const existingGenreIdsByGoogleId = new Map<string, Set<number>>(
      existing.map((b) => [b.googleBooksId, new Set<number>(b.genres.map((g) => g.genreId))])
    );

    // 3️⃣ Score candidates
    console.log(`🧮 Scoring ${candidates.length} candidates...`);

    const scored: ScoredCandidate[] = candidates.map((c) => {
      // DB genres are authoritative; if none exist, fall back to the genre we fetched this candidate from.
      const dbGenreIds = existingGenreIdsByGoogleId.get(c.googleBooksId) ?? new Set<number>();

      const sourceGenreIds = new Set<number>(c.sourceGenreIds ?? []);
      const categoryGenreIds = deriveGenreIdsFromCategories(c.categories, allGenres);

      const inferredGenreIds = new Set<number>([...sourceGenreIds, ...categoryGenreIds]);
      const effectiveGenreIds = dbGenreIds.size > 0 ? dbGenreIds : inferredGenreIds;

      const totalGenres = effectiveGenreIds.size;
      const matchedGenres = countIntersection(effectiveGenreIds, preferredGenreIds);
      const genreOverlapRatio = totalGenres > 0 ? matchedGenres / totalGenres : 0;
      const genreScore = totalGenres > 0 ? 0.6 + 0.4 * genreOverlapRatio : 0;

      const candidateTokens = tokenize(bookToText(c));
      const finishedDetail = maxSimilarityToShelfDetailed(candidateTokens, finishedTokenSets);
      const toReadDetail = maxSimilarityToShelfDetailed(candidateTokens, toReadTokenSets);

      const finishedScore = finishedDetail.score;
      const toReadScore = toReadDetail.score;

      const score =
        weights.genre * genreScore +
        weights.finished * finishedScore +
        weights.toRead * toReadScore;

      const dbVsSource = dbGenreIds.size > 0
        ? `dbGenreIds=[${Array.from(dbGenreIds).join(",")}]`
        : inferredGenreIds.size > 0
          ? `inferredGenreIds=[${Array.from(inferredGenreIds).join(",")}]`
          : `noGenreIds`;

      const finishedMatch =
        finishedDetail.matchedIndex >= 0
          ? finishedLite[finishedDetail.matchedIndex]
          : null;

      const toReadMatch =
        toReadDetail.matchedIndex >= 0
          ? toReadLite[toReadDetail.matchedIndex]
          : null;

      const key = normalizedCandidateKey(c);
      console.log(
        `🧾 Score breakdown | key="${key}" | ${c.googleBooksId} | "${c.title}" | ${dbVsSource} | ` +
          `genreOverlap=${matchedGenres}/${totalGenres}=${genreOverlapRatio.toFixed(2)} ` +
          `genreScore=${genreScore.toFixed(3)} finishedScore=${finishedScore.toFixed(3)} toReadScore=${toReadScore.toFixed(
            3
          )} | ` +
          `weights(g=${weights.genre.toFixed(2)},f=${weights.finished.toFixed(2)},t=${weights.toRead.toFixed(
            2
          )}) => total=${score.toFixed(3)}`
      );
      if (finishedMatch) {
        console.log(
          `   ↳ bestFinished match sim=${finishedScore.toFixed(3)} vs ${finishedMatch.googleBooksId} | "${finishedMatch.title}"`
        );
      }
      if (toReadMatch) {
        console.log(
          `   ↳ bestToRead  match sim=${toReadScore.toFixed(3)} vs ${toReadMatch.googleBooksId} | "${toReadMatch.title}"`
        );
      }

      return {
        candidate: c,
        score,
        genreIds: Array.from(effectiveGenreIds),
        genreScore,
        genreOverlapRatio,
        finishedScore,
        toReadScore,
        weights,
      };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 20);

    console.log(`🏁 Top ${top.length} recommendations:`);
    top.forEach((r, idx) => {
      console.log(
        `   #${idx + 1} total=${r.score.toFixed(3)} ` +
          `(genre=${r.genreScore.toFixed(3)} finished=${r.finishedScore.toFixed(3)} toRead=${r.toReadScore.toFixed(
            3
          )}) ` +
          `weights(g=${r.weights.genre.toFixed(2)},f=${r.weights.finished.toFixed(2)},t=${r.weights.toRead.toFixed(
            2
          )}) ` +
          `genreIds=[${(r.genreIds ?? []).join(",") || ""}] | ${r.candidate.googleBooksId} | "${r.candidate.title}"`
      );
    });

    // 4️⃣ Persist genres for returned recommendations
    for (const r of top) {
      const dbGenreIds = existingGenreIdsByGoogleId.get(r.candidate.googleBooksId) ?? new Set<number>();

      const sourceGenreIds = new Set<number>(r.candidate.sourceGenreIds ?? []);
      const categoryGenreIds = deriveGenreIdsFromCategories(r.candidate.categories, allGenres);
      const inferredGenreIds = new Set<number>([...sourceGenreIds, ...categoryGenreIds]);

      const genreIdsToPersist = new Set<number>();
      // Always keep existing DB genres, but also add any newly inferred ones.
      for (const gid of dbGenreIds) genreIdsToPersist.add(gid);
      for (const gid of inferredGenreIds) genreIdsToPersist.add(gid);

      if (genreIdsToPersist.size === 0) continue;

      try {
        const upserted = await prisma.book.upsert({
          where: { googleBooksId: r.candidate.googleBooksId },
          create: { googleBooksId: r.candidate.googleBooksId },
          update: {},
        });

        await prisma.bookGenre.createMany({
          data: Array.from(genreIdsToPersist).map((genreId) => ({
            bookId: upserted.id,
            genreId,
          })),
          skipDuplicates: true,
        });
        console.log(
          `💾 Persisted genres=[${Array.from(genreIdsToPersist).join(",")}] for ${r.candidate.googleBooksId} ("${r.candidate.title}")`
        );
      } catch (e) {
        console.warn(
          `⚠️ Failed to persist genres for book ${r.candidate.googleBooksId}:`,
          (e as any)?.message
        );
      }
    }

    // Keep response shape the same as before (just the book objects)
    const genreNameById = new Map<number, string>(allGenres.map((g) => [g.id, g.name]));
    res.status(200).json(
      top.map((r) => {
        const sourceGenreIds = Array.from(new Set<number>(r.genreIds ?? [])).sort((a, b) => a - b);
        const sourceGenreNames = sourceGenreIds
          .map((id) => genreNameById.get(id))
          .filter((name): name is string => !!name);

        return {
          ...r.candidate,
          sourceGenreIds,
          sourceGenreNames,
        } satisfies CandidateBook;
      })
    );
  } catch (err: any) {
    console.error(
      "❌ Error fetching recommendations:",
      err?.response?.data || err.message || err
    );
    res.status(500).json({
      error: "Failed to fetch recommendations",
      details: err?.message,
    });
  }
});

export default router;
