import { Router } from "express";
import prisma from "../prisma";

const router = Router();

router.post("/", async (req, res) => {
  const { userId, genreIds } = req.body;

  if (!userId || !Array.isArray(genreIds)) {
    return res.status(400).json({ error: "Invalid request" });
  }

  try {
    // Clear old preferences
    await prisma.userGenre.deleteMany({
      where: { userId },
    });

    // Insert new preferences
    const data = genreIds.map((genreId: number) => ({
      userId,
      genreId,
    }));

    await prisma.userGenre.createMany({ data });

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error saving user genres:", err);
    res
      .status(500)
      .json({ error: "Failed to save user genres", details: err });
  }
});

export default router;
