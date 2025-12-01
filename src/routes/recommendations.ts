import { Router } from "express";
import prisma from "../prisma";
import axios from "axios";

import pLimit from "p-limit";

const limit = pLimit(5); // max 5 concurrent Open Library requests

const router = Router();
const GOOGLE_API_KEY = process.env.GOOGLE_BOOKS_API_KEY;

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

    // 1️⃣ Fetch candidate books for each genre and store them in pools
    const genreBookPool: Record<number, any[]> = {};
    for (const ug of userGenres) {
      const rawBooks = await fetchBooksFromGoogle(`subject:${ug.genre.name}`, 40);
      const filtered: any[] = [];

      for (const book of rawBooks) {
        // Skip duplicates in pool
        if (filtered.find((b) => b.googleBooksId === book.googleBooksId)) continue;

        // Check DB if book already exists and if user has interacted with it
        const bookRecord = await prisma.book.findUnique({
          where: { googleBooksId: book.googleBooksId },
        });

        if (bookRecord) {
          const alreadyUserBook = await prisma.userBook.findUnique({
            where: { userId_bookId: { userId, bookId: bookRecord.id } },
          });
          if (alreadyUserBook) continue;
        }

        filtered.push(book);
      }

      genreBookPool[ug.genre.id] = filtered;
    }

    // 2️⃣ Alternate between genres in round-robin fashion
    const finalRecommendations: any[] = [];
    const genreIds = userGenres.map((ug) => ug.genre.id);

    // 🎲 Randomize starting genre
    let genreIndex = Math.floor(Math.random() * genreIds.length);

    while (finalRecommendations.length < 20 && genreIds.length > 0) {
      const currentGenreId = genreIds[genreIndex]!;
      const pool = genreBookPool[currentGenreId]!;

      if (pool.length > 0) {
        finalRecommendations.push(pool.shift());
      }

      // If pool runs out, remove genre from rotation
      if (pool.length === 0) {
        genreIds.splice(genreIndex, 1);
        if (genreIds.length === 0) break;
        genreIndex = genreIndex % genreIds.length;
      } else {
        genreIndex = (genreIndex + 1) % genreIds.length;
      }
    }

    
  // 🔹 Log if we ran out of books before reaching 20 recommendations
  if (finalRecommendations.length < 20) {
    console.log(`⚠️ Ran out of books to recommend. Only ${finalRecommendations.length} available.`);
  }

    res.status(200).json(finalRecommendations);
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
