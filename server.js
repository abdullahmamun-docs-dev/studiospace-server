
import "dotenv/config";
import express from "express";
import cors from "cors";
import { auth } from "./auth.js";
import { toNodeHandler } from "better-auth/node";
import connectDB from "./db.js";
import studioRoutes from "./routes/studioRoutes.js";
import bookingRoutes from "./routes/bookingRoutes.js";

const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigins = [
  process.env.CLIENT_URL,
  "https://studiospace-client-lemon.vercel.app",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
].filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true;

  if (allowedOrigins.includes(origin)) {
    return true;
  }

  try {
    const url = new URL(origin);

    return (
      url.protocol === "https:" &&
      url.hostname.endsWith(".vercel.app")
    );
  } catch {
    return false;
  }
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`CORS blocked origin: ${origin}`));
    },
    credentials: true,
  })
);

app.all("/api/auth/*splat", toNodeHandler(auth));

app.use(express.json());

app.use("/api/studios", studioRoutes);
app.use("/api/bookings", bookingRoutes);

app.get("/", (req, res) => {
  res.send("StudioSpace Server is running!");
});

const db = await connectDB();

const bookingsCollection = db.collection("bookings");
const studiosCollection = db.collection("studios");

/*
 * Create indexes safely.
 *
 * MongoDB can throw IndexOptionsConflict when an index with
 * the same key pattern already exists under a different name.
 * We check existing indexes first and only create missing ones.
 */

async function ensureIndexes(collection, indexes) {
  const existingIndexes = await collection.listIndexes().toArray();

  for (const index of indexes) {
    const existingIndex = existingIndexes.find((existing) => {
      return (
        JSON.stringify(existing.key) === JSON.stringify(index.key)
      );
    });

    if (existingIndex) {
      console.log(
        `Index already exists: ${collection.collectionName}.${existingIndex.name}`
      );
      continue;
    }

    await collection.createIndex(index.key, {
      name: index.name,
    });

    console.log(
      `Index created: ${collection.collectionName}.${index.name}`
    );
  }
}

await ensureIndexes(bookingsCollection, [
  {
    key: {
      studioId: 1,
      date: 1,
      status: 1,
      startTime: 1,
      endTime: 1,
    },
    name: "booking_overlap_lookup",
  },
  {
    key: {
      userId: 1,
      createdAt: -1,
    },
    name: "user_bookings_lookup",
  },
  {
    key: {
      userEmail: 1,
      createdAt: -1,
    },
    name: "user_email_bookings_lookup",
  },
  {
    key: {
      hostId: 1,
      createdAt: -1,
    },
    name: "host_bookings_lookup",
  },
  {
    key: {
      hostEmail: 1,
      createdAt: -1,
    },
    name: "host_email_studios_lookup",
  },
]);

await ensureIndexes(studiosCollection, [
  {
    key: {
      createdAt: -1,
    },
    name: "studios_created_at_lookup",
  },
  {
    key: {
      hostId: 1,
      createdAt: -1,
    },
    name: "host_studios_lookup",
  },
  {
    key: {
      hostEmail: 1,
      createdAt: -1,
    },
    name: "host_email_studios_lookup",
  },
]);

console.log("MongoDB indexes checked successfully!");

app.listen(PORT, () => {
  console.log(`StudioSpace Server running on port ${PORT}`);
});
