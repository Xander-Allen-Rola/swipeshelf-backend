import { Router } from "express";
import axios from "axios";
import pLimit from "p-limit";
import prisma from "../prisma";
import { matchGenresFromCategories, type GenreLite } from "../utils/genreMatch";

const router = Router();
const GOOGLE_API_KEY = process.env.GOOGLE_BOOKS_API_KEY;
const limit = pLimit(5); // max 5 concurrent Open Library requests
const googleVolumeLimit = pLimit(5); // max 5 concurrent Google volume lookups

// 📝 Truncate Description
const truncateDescription = (text: string, wordLimit = 150) => {
  if (!text) return "";
  const words = text.split(/\s+/);
  return words.length <= wordLimit
    ? text
    : words.slice(0, wordLimit).join(" ") + " ...";
};

// 📚 Fetch cover from Open Library (NO CACHING)
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
    }
    return null;
  }
};

const fetchCoverWithLimit = (title: string, author: string) =>
  limit(() => fetchOpenLibraryCover(title, author));

// 📚 Fetch categories from Google Volume-by-ID (more complete than search results)
const fetchGoogleVolumeCategories = async (googleBooksId: string): Promise<string[]> => {
  try {
    const res = await axios.get(
      `https://www.googleapis.com/books/v1/volumes/${googleBooksId}`,
      { params: { key: GOOGLE_API_KEY } }
    );
    const categories = res.data?.volumeInfo?.categories;
    return Array.isArray(categories) ? categories : [];
  } catch (err: any) {
    // Fall back to categories from the search endpoint if this fails.
    return [];
  }
};

const fetchGoogleVolumeCategoriesWithLimit = (googleBooksId: string) =>
  googleVolumeLimit(() => fetchGoogleVolumeCategories(googleBooksId));

// 📖 Fetch books from Google API
const fetchBooksFromGoogle = async (
  query: string,
  maxResults = 20,
  genres: GenreLite[] = []
) => {
  const res = await axios.get("https://www.googleapis.com/books/v1/volumes", {
    params: { q: query, maxResults, key: GOOGLE_API_KEY },
  });

  if (!res.data.items) return [];

  // Extract metadata first
  const metadata = res.data.items
    .filter((item: any) => item.volumeInfo)
    .map((item: any) => ({
      id: item.id,
      title: item.volumeInfo.title || "",
      authorsList: item.volumeInfo.authors || [],
      publishedDate: item.volumeInfo.publishedDate || null,
      description: item.volumeInfo.description || "",
      averageRating: item.volumeInfo.averageRating || 0,
      categories: item.volumeInfo.categories || [],
      isbn:
        item.volumeInfo.industryIdentifiers?.find(
          (id: any) => id.type === "ISBN_13"
        )?.identifier || null,
    }));

  // Fetch covers in parallel
  const books = await Promise.all(
    metadata.map(async (meta: any) => {
      const coverUrl = await fetchCoverWithLimit(meta.title, meta.authorsList[0] || "");
      if (!coverUrl || !meta.description) return null;

      const forbidden = ["annotated", "illustrated"];
      if (forbidden.some((w) => meta.title.toLowerCase().includes(w))) return null;

      // Use per-volume categories for matching (aligns with shelves/add-to-* behavior).
      // If the volume lookup fails, fall back to search-result categories.
      const volumeCategories = await fetchGoogleVolumeCategoriesWithLimit(meta.id);
      const categoriesForMatching =
        volumeCategories.length > 0 ? volumeCategories : (meta.categories || []);

      const matchedGenres = matchGenresFromCategories(categoriesForMatching, genres);

      return {
        id: 0,
        title: meta.title,
        authors: meta.authorsList.join(", ") || "Unknown",
        publishedDate: meta.publishedDate ? new Date(meta.publishedDate) : null,
        isbn: meta.isbn,
        coverUrl,
        googleBooksId: meta.id,
        description: truncateDescription(meta.description, 150),
        averageRating: meta.averageRating,
        categories: categoriesForMatching,
        sourceGenreIds: matchedGenres.map((g) => g.id),
        sourceGenreNames: matchedGenres.map((g) => g.name),
      };
    })
  );

  // Filter out null + deduplicate
  const filteredBooks = books.filter(Boolean) as typeof books[number][];
  const uniqueBooksMap = new Map<string, typeof filteredBooks[number]>();
  for (const book of filteredBooks) {
    const key = `${book.title.toLowerCase()}|${book.authors.toLowerCase()}`;
    if (!uniqueBooksMap.has(key)) uniqueBooksMap.set(key, book);
  }

  const uniqueBooks = Array.from(uniqueBooksMap.values());

  // Sort consistently by title + authors
  uniqueBooks.sort((a, b) => {
    const tCompare = a.title.localeCompare(b.title);
    if (tCompare !== 0) return tCompare;
    return a.authors.localeCompare(b.authors);
  });

  return uniqueBooks;
};

// ✅ GET /api/books/search?query=harry+potter
router.get("/search", async (req, res) => {
  const query = (req.query.query as string)?.trim();
  if (!query) return res.status(400).json({ error: "Missing query" });

  try {
    const genres = await prisma.genre.findMany({ select: { id: true, name: true } });
    const books = await fetchBooksFromGoogle(query, 20, genres);

    // Overlay with DB-authoritative genres (BookGenre) + known book id when present.
    const existing = await prisma.book.findMany({
      where: { googleBooksId: { in: books.map((b) => b.googleBooksId) } },
      select: {
        id: true,
        googleBooksId: true,
        genres: { select: { genreId: true, genre: { select: { name: true } } } },
      },
    });
    const existingByGoogleId = new Map(
      existing.map((b) => [b.googleBooksId, b])
    );

    const merged = books.map((b) => {
      const db = existingByGoogleId.get(b.googleBooksId);
      if (!db || db.genres.length === 0) return b;

      return {
        ...b,
        id: db.id,
        sourceGenreIds: db.genres.map((g) => g.genreId),
        sourceGenreNames: db.genres.map((g) => g.genre.name),
      };
    });

    res.json(merged);
  } catch (err: any) {
    console.error("❌ Search error:", err.message);
    res.status(500).json({ error: "Failed to fetch search results" });
  }
});

export default router;
