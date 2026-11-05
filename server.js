
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

// Allowed frontend origins
const allowedOrigins = [
  process.env.CLIENT_URL,
   "https://studiospace-client-lemon.vercel.app",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
].filter(Boolean);

// CORS configuration
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`CORS blocked origin: ${origin}`));
    },
    credentials: true,
  })
);

// Better Auth handler
// Keep this before express.json()
app.all("/api/auth/*splat", toNodeHandler(auth));

// Parse JSON requests for normal API routes
app.use(express.json());

// Normal API routes
app.use("/api/studios", studioRoutes);
app.use("/api/bookings", bookingRoutes);

// Test route
app.get("/", (req, res) => {
  res.send("StudioSpace Server is running!");
});

// Connect database
const db = await connectDB();

// Collections
const bookingsCollection = db.collection("bookings");
const studiosCollection = db.collection("studios");

// Create booking indexes
await bookingsCollection.createIndexes([
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
    name: "host_email_bookings_lookup",
  },
]);

// Create studio indexes
await studiosCollection.createIndexes([
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

console.log("MongoDB indexes created successfully!");

// Start server
app.listen(PORT, () => {
  console.log(`StudioSpace Server running on port ${PORT}`);
});
