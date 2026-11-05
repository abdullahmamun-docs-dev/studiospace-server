import express from "express";
import { ObjectId } from "mongodb";
import connectDB, { client } from "../db.js";
import { auth } from "../auth.js";

const router = express.Router();

async function getCurrentUser(req) {
  const headers = new Headers();

  if (req.headers.cookie) {
    headers.set("cookie", req.headers.cookie);
  }

  if (req.headers.authorization) {
    headers.set("authorization", req.headers.authorization);
  }

  const session = await auth.api.getSession({ headers });

  return session?.user || null;
}

// Create a new booking
router.post("/", async (req, res) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({
        message: "Unauthorized. Please login first.",
      });
    }

    const {
      studioId,
      date,
      startTime,
      endTime,
      guests,
    } = req.body;

    // Required field validation
    if (
      !studioId ||
      !date ||
      !startTime ||
      !endTime ||
      guests === undefined
    ) {
      return res.status(400).json({
        message: "All booking fields are required.",
      });
    }

    // Validate MongoDB ObjectId
    if (!ObjectId.isValid(studioId)) {
      return res.status(400).json({
        message: "Invalid studio ID.",
      });
    }

    // Validate guests
    const guestCount = Number(guests);

    if (!Number.isInteger(guestCount) || guestCount < 1) {
      return res.status(400).json({
        message: "Guests must be a positive integer.",
      });
    }

   // Validate date format
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  return res.status(400).json({
    message: "Invalid date format. Use YYYY-MM-DD.",
  });
}

// Validate calendar date without relying on server timezone
const [year, month, day] = date.split("-").map(Number);

const bookingDate = new Date(
  Date.UTC(year, month - 1, day)
);

const isValidCalendarDate =
  bookingDate.getUTCFullYear() === year &&
  bookingDate.getUTCMonth() === month - 1 &&
  bookingDate.getUTCDate() === day;

if (!isValidCalendarDate) {
  return res.status(400).json({
    message: "Invalid booking date.",
  });
}



    // Validate time format
    const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

    if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
      return res.status(400).json({
        message: "Invalid time format. Use HH:mm.",
      });
    }

    // Validate time range
    if (endTime <= startTime) {
      return res.status(400).json({
        message: "End time must be after start time.",
      });
    }

    // Validate future date and time
    const now = new Date();
    const requestedStart = new Date(`${date}T${startTime}:00`);

    if (requestedStart <= now) {
      return res.status(400).json({
        message: "Booking date and time must be in the future.",
      });
    }

    // Calculate duration
    const [startHour, startMinute] = startTime
      .split(":")
      .map(Number);

    const [endHour, endMinute] = endTime
      .split(":")
      .map(Number);

    const startMinutes = startHour * 60 + startMinute;
    const endMinutes = endHour * 60 + endMinute;

    const totalHours =
      (endMinutes - startMinutes) / 60;

    if (totalHours <= 0) {
      return res.status(400).json({
        message: "Invalid booking duration.",
      });
    }

    const db = await connectDB();

    const studiosCollection = db.collection("studios");
    const bookingsCollection = db.collection("bookings");
    const locksCollection = db.collection("bookingLocks");

    // Find studio
    const studio = await studiosCollection.findOne({
      _id: new ObjectId(studioId),
    });

    if (!studio) {
      return res.status(404).json({
        message: "Studio not found.",
      });
    }

    // Prevent booking own studio
    const isOwner =
      studio.hostId?.toString() === user.id?.toString() ||
      studio.hostEmail?.toLowerCase() ===
        user.email?.toLowerCase();

    if (isOwner) {
      return res.status(403).json({
        message: "You cannot book your own studio.",
      });
    }

    // Check studio capacity
    const capacity = Number(
      studio.maxCapacity ?? studio.capacity ?? 10
    );

    if (guestCount > capacity) {
      return res.status(400).json({
        message: `Maximum capacity is ${capacity} guests.`,
      });
    }

    // Calculate price on server
    const pricePerHour = Number(
      studio.pricePerHour ?? studio.price ?? 0
    );

    const securityDeposit = Number(
      studio.securityDeposit ?? 0
    );

    if (
      !Number.isFinite(pricePerHour) ||
      pricePerHour < 0 ||
      !Number.isFinite(securityDeposit) ||
      securityDeposit < 0
    ) {
      return res.status(400).json({
        message: "Invalid studio pricing information.",
      });
    }

    const totalPrice = totalHours * pricePerHour;
    const totalAmount = totalPrice + securityDeposit;

    // Booking data
    const booking = {
      studioId: new ObjectId(studioId),
      studioName: studio.name || studio.title || "",
      studioImage: studio.image || studio.imageUrl || "",

      userId: user.id,
      userName: user.name || "",
      userEmail: user.email || "",

      hostId: studio.hostId || "",
      hostName: studio.hostName || "",
      hostEmail: studio.hostEmail || "",

      date,
      startTime,
      endTime,
      guests: guestCount,

      totalHours,
      pricePerHour,
      totalPrice,
      securityDeposit,
      totalAmount,

      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Lock key for the same studio and date
    const lockId = `${studioId}:${date}`;

    // Ensure lock document exists
    try {
      await locksCollection.updateOne(
        { _id: lockId },
        {
          $setOnInsert: {
            createdAt: new Date(),
          },
        },
        { upsert: true }
      );
    } catch (error) {
      if (error.code !== 11000) {
        throw error;
      }
    }

    // Transaction prevents concurrent overlapping bookings
    const session = client.startSession();

    let createdBooking;

    try {
      await session.withTransaction(
        async () => {
          // Write to the same lock document.
          // Concurrent transactions for this studio/date
          // will conflict and be retried by MongoDB.
          await locksCollection.updateOne(
            { _id: lockId },
            { $inc: { version: 1 } },
            { session }
          );

          // Check overlapping bookings
          const existingBooking =
            await bookingsCollection.findOne(
              {
                studioId: new ObjectId(studioId),
                date,
                status: {
                  $in: ["pending", "confirmed"],
                },
                startTime: {
                  $lt: endTime,
                },
                endTime: {
                  $gt: startTime,
                },
              },
              { session }
            );

          if (existingBooking) {
            const error = new Error(
              "This studio is already booked for the selected time."
            );

            error.statusCode = 409;
            throw error;
          }

          // Insert booking
          const result = await bookingsCollection.insertOne(
            booking,
            { session }
          );

          createdBooking = {
            ...booking,
            _id: result.insertedId,
          };
        },
        {
          readConcern: { level: "snapshot" },
          writeConcern: { w: "majority" },
          readPreference: "primary",
        }
      );
    } catch (error) {
      if (error.statusCode === 409) {
        return res.status(409).json({
          message: error.message,
        });
      }

      throw error;
    } finally {
      await session.endSession();
    }

    return res.status(201).json({
      message: "Booking created successfully.",
      booking: createdBooking,
    });
  } catch (error) {
    console.error("Create booking error:", error);

    return res.status(500).json({
      message: "Failed to create booking.",
    });
  }
});

// Get bookings of current user
router.get("/my-bookings", async (req, res) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({
        message: "Unauthorized.",
      });
    }

    const db = await connectDB();
    const bookingsCollection = db.collection("bookings");

    const bookings = await bookingsCollection
      .find({
        $or: [
          { userId: user.id },
          { userEmail: user.email },
        ],
      })
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json(bookings);
  } catch (error) {
    console.error("Get my bookings error:", error);

    return res.status(500).json({
      message: "Failed to fetch bookings.",
    });
  }
});

// Get bookings for host
router.get("/host-bookings", async (req, res) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({
        message: "Unauthorized.",
      });
    }

    const db = await connectDB();
    const bookingsCollection = db.collection("bookings");

    const bookings = await bookingsCollection
      .find({
        $or: [
          { hostId: user.id },
          { hostEmail: user.email },
        ],
      })
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json(bookings);
  } catch (error) {
    console.error("Get host bookings error:", error);

    return res.status(500).json({
      message: "Failed to fetch host bookings.",
    });
  }
});

// Confirm booking
router.patch("/:id/confirm", async (req, res) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({
        message: "Unauthorized.",
      });
    }

    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        message: "Invalid booking ID.",
      });
    }

    const db = await connectDB();
    const bookingsCollection = db.collection("bookings");

    const bookingId = new ObjectId(req.params.id);

    const booking = await bookingsCollection.findOne({
      _id: bookingId,
    });

    if (!booking) {
      return res.status(404).json({
        message: "Booking not found.",
      });
    }

    const isHost =
      booking.hostId?.toString() === user.id?.toString() ||
      booking.hostEmail?.toLowerCase() ===
        user.email?.toLowerCase();

    if (!isHost) {
      return res.status(403).json({
        message: "You are not allowed to confirm this booking.",
      });
    }

    if (booking.status !== "pending") {
      return res.status(400).json({
        message: "Only pending bookings can be confirmed.",
      });
    }

    // Atomic ownership + status check
    const result = await bookingsCollection.updateOne(
      {
        _id: bookingId,
        status: "pending",
        $or: [
          { hostId: user.id },
          { hostEmail: user.email },
        ],
      },
      {
        $set: {
          status: "confirmed",
          updatedAt: new Date(),
        },
      }
    );

    if (result.modifiedCount !== 1) {
      return res.status(409).json({
        message: "Booking status has already changed.",
      });
    }

    return res.status(200).json({
      message: "Booking confirmed successfully.",
    });
  } catch (error) {
    console.error("Confirm booking error:", error);

    return res.status(500).json({
      message: "Failed to confirm booking.",
    });
  }
});

// Reject booking
router.patch("/:id/reject", async (req, res) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({
        message: "Unauthorized.",
      });
    }

    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        message: "Invalid booking ID.",
      });
    }

    const db = await connectDB();
    const bookingsCollection = db.collection("bookings");

    const bookingId = new ObjectId(req.params.id);

    const booking = await bookingsCollection.findOne({
      _id: bookingId,
    });

    if (!booking) {
      return res.status(404).json({
        message: "Booking not found.",
      });
    }

    const isHost =
      booking.hostId?.toString() === user.id?.toString() ||
      booking.hostEmail?.toLowerCase() ===
        user.email?.toLowerCase();

    if (!isHost) {
      return res.status(403).json({
        message: "You are not allowed to reject this booking.",
      });
    }

    if (booking.status !== "pending") {
      return res.status(400).json({
        message: "Only pending bookings can be rejected.",
      });
    }

    // Atomic ownership + status check
    const result = await bookingsCollection.updateOne(
      {
        _id: bookingId,
        status: "pending",
        $or: [
          { hostId: user.id },
          { hostEmail: user.email },
        ],
      },
      {
        $set: {
          status: "cancelled",
          updatedAt: new Date(),
        },
      }
    );

    if (result.modifiedCount !== 1) {
      return res.status(409).json({
        message: "Booking status has already changed.",
      });
    }

    return res.status(200).json({
      message: "Booking rejected successfully.",
    });
  } catch (error) {
    console.error("Reject booking error:", error);

    return res.status(500).json({
      message: "Failed to reject booking.",
    });
  }
});

// Complete booking
router.patch("/:id/complete", async (req, res) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({
        message: "Unauthorized.",
      });
    }

    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        message: "Invalid booking ID.",
      });
    }

    const db = await connectDB();
    const bookingsCollection = db.collection("bookings");

    const bookingId = new ObjectId(req.params.id);

    const booking = await bookingsCollection.findOne({
      _id: bookingId,
    });

    if (!booking) {
      return res.status(404).json({
        message: "Booking not found.",
      });
    }

    const isHost =
      booking.hostId?.toString() === user.id?.toString() ||
      booking.hostEmail?.toLowerCase() ===
        user.email?.toLowerCase();

    if (!isHost) {
      return res.status(403).json({
        message: "You are not allowed to complete this booking.",
      });
    }

    if (booking.status !== "confirmed") {
      return res.status(400).json({
        message: "Only confirmed bookings can be completed.",
      });
    }

    // Atomic ownership + status check
    const result = await bookingsCollection.updateOne(
      {
        _id: bookingId,
        status: "confirmed",
        $or: [
          { hostId: user.id },
          { hostEmail: user.email },
        ],
      },
      {
        $set: {
          status: "completed",
          updatedAt: new Date(),
        },
      }
    );

    if (result.modifiedCount !== 1) {
      return res.status(409).json({
        message: "Booking status has already changed.",
      });
    }

    return res.status(200).json({
      message: "Booking completed successfully.",
    });
  } catch (error) {
    console.error("Complete booking error:", error);

    return res.status(500).json({
      message: "Failed to complete booking.",
    });
  }
});

// Cancel booking (customer)
router.patch("/:id/cancel", async (req, res) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({
        message: "Unauthorized.",
      });
    }

    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        message: "Invalid booking ID.",
      });
    }

    const db = await connectDB();
    const bookingsCollection = db.collection("bookings");

    const bookingId = new ObjectId(req.params.id);

    const booking = await bookingsCollection.findOne({
      _id: bookingId,
    });

    if (!booking) {
      return res.status(404).json({
        message: "Booking not found.",
      });
    }

    const isCustomer =
      booking.userId?.toString() === user.id?.toString() ||
      booking.userEmail?.toLowerCase() ===
        user.email?.toLowerCase();

    if (!isCustomer) {
      return res.status(403).json({
        message: "You are not allowed to cancel this booking.",
      });
    }

    if (booking.status !== "pending") {
      return res.status(400).json({
        message: "Only pending bookings can be cancelled.",
      });
    }

    // Atomic ownership + status check
    const result = await bookingsCollection.updateOne(
      {
        _id: bookingId,
        status: "pending",
        $or: [
          { userId: user.id },
          { userEmail: user.email },
        ],
      },
      {
        $set: {
          status: "cancelled",
          updatedAt: new Date(),
        },
      }
    );

    if (result.modifiedCount !== 1) {
      return res.status(409).json({
        message: "Booking status has already changed.",
      });
    }

    return res.status(200).json({
      message: "Booking cancelled successfully.",
    });
  } catch (error) {
    console.error("Cancel booking error:", error);

    return res.status(500).json({
      message: "Failed to cancel booking.",
    });
  }
});

export default router;