// backend/routes/markSeen.ts
import { Router } from "express";
import prisma from "../prisma";

const router = Router();

// POST /api/markSeen
router.post("/", async (req, res) => {
  const { userId, googleBooksId } = req.body;

  if (!userId || !googleBooksId) {
    return res.status(400).json({ error: "userId and googleBooksId are required" });
  }

  try {
    // Check if book exists globally
    let bookRecord = await prisma.book.findUnique({
      where: { googleBooksId },
    });

    if (!bookRecord) {
      bookRecord = await prisma.book.create({
        data: { googleBooksId },
      });
    }

    // Check if already linked to user
    const alreadyUserBook = await prisma.userBook.findUnique({
      where: { userId_bookId: { userId, bookId: bookRecord.id } },
    });

    if (!alreadyUserBook) {
      await prisma.userBook.create({
        data: { userId, bookId: bookRecord.id },
      });
    }

    res.status(200).json({ message: "Book marked as seen" });
  } catch (err: any) {
    console.error("❌ Error marking book as seen:", err);
    res.status(500).json({ error: "Failed to mark book as seen" });
  }
});

export default router;
