import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import prisma from "../prisma";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "fallbacksecret"; // ⚠️ replace in production

// Register
router.post("/register", async (req, res) => {
  const { email, password, firstName, lastName, suffix, dob } = req.body;

  if (!email || !password || !firstName || !lastName) {
    return res.status(400).json({
      error: "Email, password, first name, and last name are required",
    });
  }

  try {
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        firstName,
        lastName,
        suffix,
        dob: dob ? new Date(dob) : null,
      },
    });

    // 🔑 Generate JWT for the newly registered user
    const token = jwt.sign(
      { userId: newUser.id },
      process.env.JWT_SECRET as string,
      { expiresIn: "7d" } // optional: adjust expiry as needed
    );

    res.status(201).json({
      message: "User registered successfully",
      user: {
        id: newUser.id,
        email: newUser.email,
        firstName: newUser.firstName,
        lastName: newUser.lastName,
        suffix: newUser.suffix,
        dob: newUser.dob,
      },
      token, // ✅ send token to frontend
    });

  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ error: "Something went wrong" });
  }
});


// Login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res
      .status(400)
      .json({ error: "Email and password are required" });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, {
      expiresIn: "10h",
    });

    res.json({
      message: "Logged in successfully",
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        suffix: user.suffix,
        dob: user.dob,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// Guest login
router.post("/guest", (_req, res) => {
  const token = jwt.sign({ guest: true }, JWT_SECRET, { expiresIn: "1h" });
  res.json({ message: "Guest login successful", token });
});

export default router;
