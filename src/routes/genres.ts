import { Router } from "express";
import prisma from "../prisma";

const router = Router();

// GET all genres
router.get("/", async (_req, res) => {
  try {
    const genres = await prisma.genre.findMany(); // fetch all genres
    res.json(genres);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch genres" });
  }
});

// POST selected genres for a user
router.post("/user", async (req, res) => {
  const { userId, genreIds } = req.body; // genreIds is array of genre_id

  if (!userId || !Array.isArray(genreIds)) {
    return res.status(400).json({ error: "Invalid request data" });
  }

  try {
    // Remove previous selections
    await prisma.userGenres.deleteMany({ where: { userId } });

    // Insert new selections
    const newUserGenres = genreIds.map((genreId: number) => ({
      userId,
      genreId,
    }));
    await prisma.userGenres.createMany({ data: newUserGenres });

    res.json({ message: "User genres updated successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save user genres" });
  }
});

export default router;
