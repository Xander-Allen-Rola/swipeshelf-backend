import { Router } from "express";
import prisma from "../prisma";
import jwt from "jsonwebtoken";

const router = Router();

const authenticateToken = (req: any, res: any, next: any) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // Bearer <token>

  if (!token) return res.sendStatus(401); // Unauthorized

  jwt.verify(token, process.env.JWT_SECRET as string, (err: any, user: any) => {
    if (err) return res.sendStatus(403); // Forbidden
    req.userId = user.userId; // attach userId to request
    next();
  });
};

/**
 * POST /api/shelves/add-to-to-read
 * Body: { userId, book: { googleBooksId, title, coverUrl, description } }
 */
router.post("/add-to-to-read", authenticateToken, async (req, res) => {
  const { userId, book } = req.body;

  if (!userId || !book?.googleBooksId) {
    return res.status(400).json({ error: "Missing userId or book data" });
  }

  try {
    // 1️⃣ Find or create the "To Read" shelf
    let shelf = await prisma.shelf.findFirst({
      where: { userId, name: "To Read" },
    });

    if (!shelf) {
      shelf = await prisma.shelf.create({
        data: { userId, name: "To Read" },
      });
    }

    // 2️⃣ Find or create the book
    let dbBook = await prisma.book.findUnique({
      where: { googleBooksId: book.googleBooksId },
    });

    if (!dbBook) {
      dbBook = await prisma.book.create({
        data: { googleBooksId: book.googleBooksId },
      });
    }

    // 3️⃣ Check if the book is in "Finished" shelf
    const finishedShelf = await prisma.shelf.findFirst({
      where: { userId, name: "Finished" },
      include: {
        books: {
          where: { bookId: dbBook.id }
        }
      }
    });

    if (finishedShelf && finishedShelf.books.length > 0) {
      return res.status(400).json({
        error: "❌ Cannot add book to 'To Read' because it is already in 'Finished' shelf."
      });
    }

    // 4️⃣ Upsert into "To Read" shelf
    const shelfBook = await prisma.shelfBook.upsert({
      where: {
        shelfId_bookId: {
          shelfId: shelf.id,
          bookId: dbBook.id,
        },
      },
      update: {
        status: "to-read",
        title: book.title,
        coverURL: book.coverUrl ?? null,
        description: book.description ?? null,
      },
      create: {
        shelfId: shelf.id,
        bookId: dbBook.id,
        status: "to-read",
        title: book.title,
        coverURL: book.coverUrl ?? null,
        description: book.description ?? null,
      },
    });

    res.status(200).json({ message: "✅ Book added to To Read shelf", shelfBook });

  } catch (err: any) {
    console.error("❌ Error adding book to shelf:", err);
    res.status(500).json({ error: "Failed to add book to shelf", details: err.message });
  }
});

/**
 * POST /api/shelves/add-to-finished
 * Body: { userId, book: { googleBooksId, title, coverUrl, description } }
 */
router.post("/add-to-finished", authenticateToken, async (req, res) => {
  const { userId, book } = req.body;

  if (!userId || !book?.googleBooksId) {
    return res.status(400).json({ error: "Missing userId or book data" });
  }

  try {
    // 1️⃣ Find or create the "Finished" shelf
    let shelf = await prisma.shelf.findFirst({
      where: { userId, name: "Finished" },
    });

    if (!shelf) {
      shelf = await prisma.shelf.create({
        data: { userId, name: "Finished" },
      });
    }

    // 2️⃣ Find or create the book
    let dbBook = await prisma.book.findUnique({
      where: { googleBooksId: book.googleBooksId },
    });

    if (!dbBook) {
      dbBook = await prisma.book.create({
        data: { googleBooksId: book.googleBooksId },
      });
    }

    // 3️⃣ Check if the book is in "To Read" shelf
    const toReadShelf = await prisma.shelf.findFirst({
      where: { userId, name: "To Read" },
      include: {
        books: {
          where: { bookId: dbBook.id }
        }
      }
    });

    if (toReadShelf && toReadShelf.books.length > 0) {
      return res.status(400).json({
        error: "❌ Cannot add book to 'Finished' because it is already in 'To Read' shelf."
      });
    }

    // 4️⃣ Upsert into "Finished" shelf
    const shelfBook = await prisma.shelfBook.upsert({
      where: {
        shelfId_bookId: {
          shelfId: shelf.id,
          bookId: dbBook.id,
        },
      },
      update: {
        status: "finished",
        title: book.title,
        coverURL: book.coverUrl ?? null,
        description: book.description ?? null,
      },
      create: {
        shelfId: shelf.id,
        bookId: dbBook.id,
        status: "finished",
        title: book.title,
        coverURL: book.coverUrl ?? null,
        description: book.description ?? null,
      },
    });

    res.status(200).json({ message: "✅ Book added to Finished shelf", shelfBook });

  } catch (err: any) {
    console.error("❌ Error adding book to shelf:", err);
    res.status(500).json({ error: "Failed to add book to shelf", details: err.message });
  }
});

router.get("/to-read/:userId", async (req, res) => {
  const { userId } = req.params;

  if (!userId || isNaN(Number(userId))) {
    return res.status(400).json({ error: "Valid userId is required" });
  }

  try {
    // Find the "To Read" shelf for the user
    const shelf = await prisma.shelf.findFirst({
      where: { 
        userId: Number(userId), 
        name: "To Read" 
      },
      include: {
        books: {
          include: {
            book: true, // Include the Book record for googleBooksId
          },
          orderBy: {
            addedAt: 'desc' // Most recently added first
          }
        }
      }
    });

    if (!shelf) {
      return res.status(200).json({ 
        message: "No 'To Read' shelf found", 
        books: [] 
      });
    }

    // Format the response to include both ShelfBook metadata and Book data
    const toReadBooks = shelf.books.map(shelfBook => ({
      id: shelfBook.id,
      googleBooksId: shelfBook.book.googleBooksId,
      title: shelfBook.title,
      coverURL: shelfBook.coverURL,
      description: shelfBook.description,
      status: shelfBook.status,
      addedAt: shelfBook.addedAt
    }));

    res.status(200).json({
      message: "✅ To Read books fetched successfully",
      books: toReadBooks,
      count: toReadBooks.length
    });

  } catch (err: any) {
    console.error("❌ Error fetching To Read books:", err);
    res.status(500).json({ 
      error: "Failed to fetch To Read books", 
      details: err.message 
    });
  }
});

router.delete("/delete-books", authenticateToken, async (req, res) => {
  const { userId, bookIds } = req.body;

  if (!userId || !bookIds || !Array.isArray(bookIds) || bookIds.length === 0) {
    return res.status(400).json({ 
      error: "Missing userId or bookIds array" 
    });
  }

  try {
    // Delete ShelfBooks that belong to the user's shelves
    const deleteResult = await prisma.shelfBook.deleteMany({
      where: {
        id: {
          in: bookIds
        },
        shelf: {
          userId: Number(userId) // Ensure books belong to this user
        }
      }
    });

    res.status(200).json({
      message: `✅ Successfully deleted ${deleteResult.count} book(s)`,
      deletedCount: deleteResult.count,
      requestedCount: bookIds.length
    });

  } catch (err: any) {
    console.error("❌ Error deleting books:", err);
    res.status(500).json({ 
      error: "Failed to delete books", 
      details: err.message 
    });
  }
});

router.put("/move-book", authenticateToken, async (req, res) => {
  const { userId, shelfBookId, targetShelfName } = req.body;

  if (!userId || !shelfBookId || !targetShelfName) {
    return res.status(400).json({ error: "Missing userId, shelfBookId, or targetShelfName" });
  }

  try {
    // 1️⃣ Verify the ShelfBook belongs to this user
    const shelfBook = await prisma.shelfBook.findFirst({
      where: {
        id: Number(shelfBookId),
        shelf: { userId: Number(userId) } // make sure it belongs to the user
      },
    });

    if (!shelfBook) {
      return res.status(404).json({ error: "Book not found in this user's shelves" });
    }

    // 2️⃣ Find or create the target shelf for this user
    let targetShelf = await prisma.shelf.findFirst({
      where: { userId: Number(userId), name: targetShelfName },
    });

    if (!targetShelf) {
      targetShelf = await prisma.shelf.create({
        data: { userId: Number(userId), name: targetShelfName },
      });
    }

    // 3️⃣ Move the book by updating shelfId
    const updatedShelfBook = await prisma.shelfBook.update({
      where: { id: Number(shelfBookId) },
      data: {
        shelfId: targetShelf.id,
        status: targetShelfName.toLowerCase(),
      },
    });

    res.status(200).json({
      message: `✅ Book moved to ${targetShelfName} shelf`,
      shelfBook: updatedShelfBook,
    });

  } catch (err: any) {
    console.error("❌ Error moving book:", err);
    res.status(500).json({ error: "Failed to move book", details: err.message });
  }
});

router.get("/finished/:userId", async (req, res) => {
  const { userId } = req.params;

  if (!userId || isNaN(Number(userId))) {
    return res.status(400).json({ error: "Valid userId is required" });
  }

  try {
    // Find the "Finished" shelf for the user
    const shelf = await prisma.shelf.findFirst({
      where: { 
        userId: Number(userId), 
        name: "Finished" 
      },
      include: {
        books: {
          include: {
            book: true, // Include the Book record for googleBooksId
          },
          orderBy: {
            addedAt: 'desc' // Most recently added first
          }
        }
      }
    });

    if (!shelf) {
      return res.status(200).json({ 
        message: "No 'Finished' shelf found", 
        books: [] 
      });
    }

    // Format the response to include both ShelfBook metadata and Book data
    const finishedBooks = shelf.books.map(shelfBook => ({
      id: shelfBook.id,
      googleBooksId: shelfBook.book.googleBooksId,
      title: shelfBook.title,
      coverURL: shelfBook.coverURL,
      description: shelfBook.description,
      status: shelfBook.status,
      addedAt: shelfBook.addedAt
    }));

    res.status(200).json({
      message: "✅ Finished books fetched successfully",
      books: finishedBooks,
      count: finishedBooks.length
    });

  } catch (err: any) {
    console.error("❌ Error fetching Finished books:", err);
    res.status(500).json({ 
      error: "Failed to fetch Finished books", 
      details: err.message 
    });
  }
});

router.post("/add-to-favorites", authenticateToken, async (req, res) => {
  const { userId, books, book } = req.body;

  // ✅ Normalize input so we can handle single or multiple books
  const booksToAdd = books ?? (book ? [book] : []);

  if (!userId || booksToAdd.length === 0) {
    return res.status(400).json({ error: "Missing userId or book(s) data" });
  }

  try {
    // 1️⃣ Find or create the "Favorites" shelf
    let favoritesShelf = await prisma.shelf.findFirst({
      where: { userId: Number(userId), name: "Favorites" },
    });

    if (!favoritesShelf) {
      favoritesShelf = await prisma.shelf.create({
        data: { userId: Number(userId), name: "Favorites" },
      });
    }

    // 2️⃣ Check how many favorites already exist
    const favoriteCount = await prisma.shelfBook.count({
      where: { shelfId: favoritesShelf.id },
    });

    if (favoriteCount + booksToAdd.length > 10) {
      return res.status(400).json({
        error: `You can only have up to 10 favorite books.`,
      });
    }

    const addedBooks: any[] = [];

    // 3️⃣ Process each book
    for (const b of booksToAdd) {
      if (!b?.googleBooksId) continue;

      // 🪄 Find or create the book
      let dbBook = await prisma.book.findUnique({
        where: { googleBooksId: b.googleBooksId },
      });

      if (!dbBook) {
        dbBook = await prisma.book.create({
          data: {
            googleBooksId: b.googleBooksId,
          },
        });
      }

      // 4️⃣ Upsert into shelfBook
      const shelfBook = await prisma.shelfBook.upsert({
        where: {
          shelfId_bookId: {
            shelfId: favoritesShelf.id,
            bookId: dbBook.id,
          },
        },
        update: {
          title: b.title,
          status: "favorites",
          coverURL: b.coverUrl ?? null,
          description: b.description ?? null,
        },
        create: {
          shelfId: favoritesShelf.id,
          bookId: dbBook.id,
          status: "favorites",
          title: b.title,
          coverURL: b.coverUrl ?? null,
          description: b.description ?? null,
        },
      });

      addedBooks.push(shelfBook);
    }

    return res.status(200).json({
      message: `✅ ${addedBooks.length} book(s) added to Favorites shelf`,
      addedBooks,
    });
  } catch (err: any) {
    console.error("❌ Error adding books to Favorites:", err);
    return res.status(500).json({
      error: "Failed to add books to Favorites",
      details: err.message,
    });
  }
});

router.get("/favorites/:userId", async (req, res) => {
  const { userId } = req.params;

  if (!userId || isNaN(Number(userId))) {
    return res.status(400).json({ error: "Valid userId is required" });
  }

  try {
    // 1️⃣ Find the "Favorites" shelf for the user
    const favoritesShelf = await prisma.shelf.findFirst({
      where: { 
        userId: Number(userId), 
        name: "Favorites" 
      },
      include: {
        books: {
          include: {
            book: true, // Include the Book record for googleBooksId
          },
          orderBy: {
            addedAt: 'desc'
          }
        }
      }
    });

    if (!favoritesShelf) {
      return res.status(200).json({ 
        message: "No 'Favorites' shelf found", 
        books: [] 
      });
    }

    // 2️⃣ Format the response to include both ShelfBook metadata and Book data
    const favoriteBooks = favoritesShelf.books.map(shelfBook => ({
      id: shelfBook.id,
      googleBooksId: shelfBook.book.googleBooksId,
      title: shelfBook.title,
      coverURL: shelfBook.coverURL,
      description: shelfBook.description,
      status: shelfBook.status,
      addedAt: shelfBook.addedAt
    }));

    res.status(200).json({
      message: "✅ Favorite books fetched successfully",
      books: favoriteBooks,
      count: favoriteBooks.length
    });

  } catch (err: any) {
    console.error("❌ Error fetching favorite books:", err);
    res.status(500).json({ 
      error: "Failed to fetch favorite books", 
      details: err.message 
    });
  }
});

/**
 * GET /api/shelves/is-favorited
 * Query params: userId, googleBooksId
 * Returns: { isFavorited: boolean }
 */
router.get("/is-favorited", async (req, res) => {
  const { userId, googleBooksId } = req.query;

  if (!userId || !googleBooksId) {
    return res.status(400).json({ error: "Missing userId or googleBooksId" });
  }

  try {
    // Find the Favorites shelf for the user
    const favoritesShelf = await prisma.shelf.findFirst({
      where: { userId: Number(userId), name: "Favorites" },
    });

    if (!favoritesShelf) {
      return res.status(200).json({ isFavorited: false });
    }

    // Check if the book exists in that shelf
    const shelfBook = await prisma.shelfBook.findFirst({
      where: {
        shelfId: favoritesShelf.id,
        book: { googleBooksId: String(googleBooksId) },
      },
    });

    res.status(200).json({ isFavorited: !!shelfBook });
  } catch (err: any) {
    console.error("❌ Error checking if book is favorited:", err);
    res.status(500).json({ error: "Failed to check favorite", details: err.message });
  }
});

/**
 * DELETE /api/shelves/remove-from-favorites
 * Body: { userId, googleBooksId }
 */
router.delete("/remove-from-favorites", authenticateToken, async (req, res) => {
  const { userId, googleBooksId } = req.body;

  if (!userId || !googleBooksId) {
    return res.status(400).json({ error: "Missing userId or googleBooksId" });
  }

  try {
    // Find the Favorites shelf for the user
    const favoritesShelf = await prisma.shelf.findFirst({
      where: { userId: Number(userId), name: "Favorites" },
    });

    if (!favoritesShelf) {
      return res.status(404).json({ error: "Favorites shelf not found" });
    }

    // Find the book in the Favorites shelf
    const shelfBook = await prisma.shelfBook.findFirst({
      where: {
        shelfId: favoritesShelf.id,
        book: { googleBooksId: String(googleBooksId) },
      },
    });

    if (!shelfBook) {
      return res.status(404).json({ error: "Book not found in Favorites" });
    }

    // Delete the ShelfBook entry
    await prisma.shelfBook.delete({
      where: { id: shelfBook.id },
    });

    res.status(200).json({ message: "✅ Book removed from Favorites" });

  } catch (err: any) {
    console.error("❌ Error removing book from Favorites:", err);
    res.status(500).json({ error: "Failed to remove book from Favorites", details: err.message });
  }
});

router.get("/non-favorites/:userId", async (req, res) => {
  const { userId } = req.params;

  if (!userId || isNaN(Number(userId))) {
    return res.status(400).json({ error: "Valid userId is required" });
  }

  try {
    // 1️⃣ Fetch IDs of books in Favorites shelf
    const favoritesShelf = await prisma.shelf.findFirst({
      where: { userId: Number(userId), name: "Favorites" },
      include: { books: true },
    });

    const favoriteBookIds = favoritesShelf
      ? favoritesShelf.books.map((b) => b.bookId)
      : [];

    // 2️⃣ Fetch books in "To Read" and "Finished" shelves that are not in Favorites
    const shelves = await prisma.shelf.findMany({
      where: {
        userId: Number(userId),
        name: { in: ["To Read", "Finished"] },
      },
      include: {
        books: {
          where: {
            bookId: { notIn: favoriteBookIds },
          },
          include: {
            book: true,
          },
          orderBy: { addedAt: "desc" },
        },
      },
    });

    // 3️⃣ Flatten results from multiple shelves
    const nonFavoriteBooks = shelves.flatMap((shelf) =>
      shelf.books.map((shelfBook) => ({
        id: shelfBook.id,
        googleBooksId: shelfBook.book.googleBooksId,
        title: shelfBook.title,
        coverURL: shelfBook.coverURL,
        description: shelfBook.description,
        status: shelfBook.status,
        shelfName: shelf.name,
        addedAt: shelfBook.addedAt,
      }))
    );

    res.status(200).json({
      message: "✅ Non-favorite books fetched successfully",
      books: nonFavoriteBooks,
      count: nonFavoriteBooks.length,
    });
  } catch (err: any) {
    console.error("❌ Error fetching non-favorite books:", err);
    res.status(500).json({
      error: "Failed to fetch non-favorite books",
      details: err.message,
    });
  }
});


export default router;
