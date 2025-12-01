import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";

const prisma = new PrismaClient();
const router = Router();

// Middleware to verify JWT and extract userId
const authenticateToken = (req: any, res: any, next: any) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.sendStatus(401);

  jwt.verify(token, process.env.JWT_SECRET as string, (err: any, user: any) => {
    if (err) return res.sendStatus(403);
    req.userId = user.userId;
    console.log("Token received:", token);
    next();
  });
};

/**
 * 📝 PUT /users/update — Update first name, last name, bio
 */
router.put("/update", authenticateToken, async (req: any, res) => {
  try {
    const { firstName, lastName, bio } = req.body;

    // Build dynamic update object
    const updateData: any = {};
    if (firstName) updateData.firstName = firstName;
    if (lastName) updateData.lastName = lastName;
    if (bio) updateData.bio = bio;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const updatedUser = await prisma.user.update({
      where: { id: req.userId },
      data: updateData,
    });

    res.json({ message: "Profile updated", user: updatedUser });
  } catch (err) {
    console.error("❌ Error updating user info:", err);
    res.status(500).json({ error: "Failed to update user info" });
  }
});

/**
 * 🖼️ PUT /users/profile-picture — Update only profile picture URL
 */
router.put("/profile-picture", authenticateToken, async (req: any, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: "Profile picture URL required" });
    }

    const updatedUser = await prisma.user.update({
      where: { id: req.userId },
      data: { profilePicture: url },
    });

    res.json({ message: "Profile picture updated", user: updatedUser });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update profile picture" });
  }
});

// 🧑 GET /users/:id — Fetch user information by ID
router.get("/:id", async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);

    if (isNaN(userId)) {
      return res.status(400).json({ error: "Invalid user ID" });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        firstName: true,
        lastName: true,
        suffix: true,
        profilePicture: true,
        bio: true
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ user });
  } catch (err) {
    console.error("Error fetching user info:", err);
    res.status(500).json({ error: "Failed to fetch user information" });
  }
});

router.get("/:userId/finished-count", async (req, res) => {
  const { userId } = req.params;

  try {
    // Find the shelf with name "Finished" for the user
    const shelf = await prisma.shelf.findFirst({
      where: {
        userId: Number(userId),
        name: "Finished",
      },
      include: {
        books: true,
      },
    });

    if (!shelf) {
      return res.json({ count: 0 });
    }

    return res.json({ count: shelf.books.length });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to fetch finished count" });
  }
});

/**
 * ✅ Get count of books in the "To Read" shelf for a user
 */
router.get("/:userId/to-read-count", async (req, res) => {
  const { userId } = req.params;

  try {
    const shelf = await prisma.shelf.findFirst({
      where: {
        userId: Number(userId),
        name: "To Read",
      },
      include: {
        books: true,
      },
    });

    if (!shelf) {
      return res.json({ count: 0 });
    }

    return res.json({ count: shelf.books.length });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to fetch to-read count" });
  }
});

export default router;
