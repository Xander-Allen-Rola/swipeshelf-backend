import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth";
import uploadRoutes from "./routes/upload";
import userRoutes from "./routes/user";
import dotenv from "dotenv";
import genresRouter from "./routes/genres";
import userGenresRouter from "./routes/userGenres";
import recommendationsRouter from "./routes/recommendations";
import markSeenRouter from "./routes/markSeen";
import shelvesRouter from "./routes/shelves";
import search from "./routes/search";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/users", userRoutes);
app.use("/api/genres", genresRouter);
app.use("/api/user-genres", userGenresRouter);
app.use("/api/recommendations", recommendationsRouter);
app.use("/api/markSeen", markSeenRouter);
app.use("/api/shelves", shelvesRouter);
app.use("/api/search", search);

const PORT = parseInt(process.env.PORT || "5000", 10);
const HOST = process.env.HOST || "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`✅ Backend running on http://${HOST}:${PORT}`);
});
