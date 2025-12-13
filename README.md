# SwipeShelf Backend

This repository contains the backend API for SwipeShelf.
It is responsible for authentication, book recommendations, search, shelves, profiles, and favorites, and is only accessed by the SwipeShelf frontend application.

The backend is a REST API built with Express and written in TypeScript.

## Features

- JWT-based authentication
  - Register, login, and guest access
  - Passwords hashed with bcrypt
  - Stateless authentication (no server-side sessions)
- Book recommendations
  - Genre-driven recommendation algorithm
  - Excludes already seen or shelved books
  - Round-robin selection strategy
- Book search
  - Uses Google Books API for metadata
  - Uses Open Library for book cover images
- Shelves
  - To Read and Finished shelves
  - Add, move, delete, and list books
  - Prevents conflicts between shelves
- Favorites
  - Add and remove favorite books (up to 10)
  - Check favorite status
  - List favorites
- Profiles
  - Update name, bio, and profile picture
  - Public profile fetching
  - Profile image uploads via Cloudinary

## Tech Stack

- TypeScript
- Node.js with Express
- REST API architecture
- Prisma ORM
- PostgreSQL
- JWT authentication (jsonwebtoken)
- bcrypt for password hashing
- Google Books API
- Open Library API
- Cloudinary for image uploads
- Multer for handling file uploads
- ts-node-dev for development
- Compiled to JavaScript for production

## Project Structure

- Express routers (e.g. `/api/auth`, `/api/search`, `/api/recommendations`)
- Middleware for authentication and request handling
- Prisma schema and migrations for database access

## Installation

```bash
npm install
```

##Development

```bash
npm run build
node dist/index.js
```

## Environment Variables

Create a .env file in the project root:

```bash
JWT_SECRET=
DATABASE_URL=

CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=

GOOGLE_BOOKS_API_KEY=
```

## External Services

- Google Books API (book metadata)
- Open Library (book cover images)
- Cloudinary (profile image uploads)

## API Access

This backend is not intended for public consumption and is only accessed by the SwipeShelf frontend application.

## Project Status

This project is an MVP and is still under active development.
This repository is part of a two-repository setup ([frontend](https://github.com/Xander-Allen-Rola/swipeshelf.git) and backend).
