import express from "express";
import { ObjectId } from "mongodb";

import connectDB from "../db.js";
import { auth } from "../auth.js";

const router = express.Router();

async function getCurrentUser(req) {
  try {
    const headers = new Headers();

    if (req.headers.cookie) {
      headers.set("cookie", req.headers.cookie);
    }

    if (req.headers.authorization) {
      headers.set("authorization", req.headers.authorization);
    }

    const session = await auth.api.getSession({
      headers,
    });

    return session?.user || null;
  } catch (error) {
    console.error("Failed to get current user:", error);
    return null;
  }
}

/*
|--------------------------------------------------------------------------
| Create booking
|--------------------------------------------------------------------------
*/
router.post("/", async (req, res) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({
        message: "You must be logged in to create a booking.",
      });
    }

    const {
      studioId,
      studioName,
      date,
      startTime,
      endTime,
      guests,
    } = req.body;

    if (
      !studioId ||
      !date ||
      !startTime ||
      !endTime ||
      guests === undefined
    ) {
      return res.status(400).json({
        message:
          "Studio, date, time, and guest information are required.",
      });
    }

    if (!ObjectId.isValid(studioId)) {
      return res.status(400).json({
        message: "Invalid studio ID.",
      });
    }

    const guestCount = Number(guests);

    if (!Number.isInteger(guestCount) || guestCount < 1) {
      return res.status(400).json({
        message: "Guest count must be at least 1.",
      });
    }

    // Strict YYYY-MM-DD and HH:mm validation.
    const dateMatch =
      /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(date);

    const timePattern =
      /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;

    if (
      !dateMatch ||
      !timePattern.test(startTime) ||
      !timePattern.test(endTime)
    ) {
      return res.status(400).json({
        message:
          "Date must use YYYY-MM-DD and time must use HH:mm format.",
      });
    }

    const [, yearText, monthText, dayText] = dateMatch;

    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);

    const dateCheck = new Date(
      Date.UTC(year, month - 1, day)
    );

    // Reject impossible dates such as 2026-02-31.
    if (
      dateCheck.getUTCFullYear() !== year ||
      dateCheck.getUTCMonth() !== month - 1 ||
      dateCheck.getUTCDate() !== day
    ) {
      return res.status(400).json({
        message: "Invalid booking date.",
      });
    }

    const bookingDate = new Date(
      `${date}T${startTime}:00`
    );

    if (Number.isNaN(bookingDate.getTime())) {
      return res.status(400).json({
        message: "Invalid booking date or time.",
      });
    }

    if (bookingDate.getTime() <= Date.now()) {
      return res.status(400).json({
        message: "Booking time must be in the future.",
      });
    }

    const [startHour, startMinute] =
      startTime.split(":").map(Number);

    const [endHour, endMinute] =
      endTime.split(":").map(Number);

    const startMinutes =
      startHour * 60 + startMinute;

    const endMinutes =
      endHour * 60 + endMinute;

    if (endMinutes <= startMinutes) {
      return res.status(400).json({
        message: "End time must be later than start time.",
      });
    }

    const calculatedHours =
      (endMinutes - startMinutes) / 60;

    if (
      !Number.isFinite(calculatedHours) ||
      calculatedHours <= 0
    ) {
      return res.status(400).json({
        message: "Invalid booking duration.",
      });
    }

    const db = await connectDB();

    const studiosCollection =
      db.collection("studios");

    const bookingsCollection =
      db.collection("bookings");

    // Find studio.
    const studio = await studiosCollection.findOne({
      _id: new ObjectId(studioId),
    });

    if (!studio) {
      return res.status(404).json({
        message: "Studio not found.",
      });
    }

    // Prevent booking own studio.
    const isOwnStudio =
      (studio.hostEmail &&
        user.email &&
        studio.hostEmail === user.email) ||
      (studio.hostId &&
        user.id &&
        String(studio.hostId) === String(user.id));

    if (isOwnStudio) {
      return res.status(400).json({
        message: "You cannot book your own studio.",
      });
    }

    // Capacity validation.
    const storedCapacity = Number(studio.maxCapacity);

    const maxCapacity =
      Number.isInteger(storedCapacity) &&
      storedCapacity > 0
        ? storedCapacity
        : 10;

    if (guestCount > maxCapacity) {
      return res.status(400).json({
        message: `This studio can accommodate a maximum of ${maxCapacity} guests.`,
      });
    }

    // Hourly price.
    const rawPrice =
      studio.pricePerHour ?? studio.price ?? 0;

    const pricePerHour = Number(rawPrice);

    if (
      !Number.isFinite(pricePerHour) ||
      pricePerHour <= 0
    ) {
      return res.status(400).json({
        message:
          "This studio does not have a valid hourly price.",
      });
    }

    // Security deposit.
    const securityDeposit = Math.max(
      0,
      Number(studio.securityDeposit) || 0
    );

    // Calculate booking price on the server.
    const totalPrice =
      Math.round(
        calculatedHours * pricePerHour * 100
      ) / 100;

    const totalAmount =
      Math.round(
        (totalPrice + securityDeposit) * 100
      ) / 100;

    /*
    |--------------------------------------------------------------------------
    | Prevent overlapping bookings
    |--------------------------------------------------------------------------
    */
    const existingBooking =
      await bookingsCollection.findOne({
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
      });

    if (existingBooking) {
      return res.status(409).json({
        message:
          "This studio is already booked for the selected time. Please choose another time.",
      });
    }

    // Create booking.
    const booking = {
      studioId: new ObjectId(studioId),

      studioName:
        studio.name || studioName || "Studio",

      hostId: studio.hostId || null,
      hostEmail: studio.hostEmail || null,

      userId: user.id || user._id,
      userEmail: user.email,
      userName: user.name || user.email,

      date,
      startTime,
      endTime,

      guests: guestCount,

      totalHours: calculatedHours,

      // Studio rental price only.
      price: totalPrice,

      // Security deposit.
      deposit: securityDeposit,

      // Final amount.
      totalAmount,

      status: "pending",

      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result =
      await bookingsCollection.insertOne(booking);

    return res.status(201).json({
      message: "Booking created successfully.",
      booking: {
        ...booking,
        _id: result.insertedId,
      },
    });
  } catch (error) {
    console.error("Create booking error:", error);

    return res.status(500).json({
      message:
        "Something went wrong while creating a booking.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| Get user's bookings
|--------------------------------------------------------------------------
*/
router.get("/my-bookings", async (req, res) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({
        message: "You must be logged in.",
      });
    }

    const db = await connectDB();

    const bookings = await db
      .collection("bookings")
      .find({
        $or: [
          {
            userId: user.id || user._id,
          },
          {
            userEmail: user.email,
          },
        ],
      })
      .sort({
        createdAt: -1,
      })
      .toArray();

    return res.status(200).json(bookings);
  } catch (error) {
    console.error("Get my bookings error:", error);

    return res.status(500).json({
      message: "Failed to load bookings.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| Get host bookings
|--------------------------------------------------------------------------
*/
router.get("/host-bookings", async (req, res) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({
        message: "You must be logged in.",
      });
    }

    const db = await connectDB();

    const bookings = await db
      .collection("bookings")
      .find({
        $or: [
          {
            hostId: user.id || user._id,
          },
          {
            hostEmail: user.email,
          },
        ],
      })
      .sort({
        createdAt: -1,
      })
      .toArray();

    return res.status(200).json(bookings);
  } catch (error) {
    console.error("Get host bookings error:", error);

    return res.status(500).json({
      message: "Failed to load host bookings.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| Confirm booking
|--------------------------------------------------------------------------
*/
router.patch("/:id/confirm", async (req, res) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({
        message: "You must be logged in.",
      });
    }

    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid booking ID.",
      });
    }

    const db = await connectDB();

    const bookingsCollection =
      db.collection("bookings");

    const booking = await bookingsCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!booking) {
      return res.status(404).json({
        message: "Booking not found.",
      });
    }

    const isHost =
      String(booking.hostId) ===
        String(user.id || user._id) ||
      booking.hostEmail === user.email;

    if (!isHost) {
      return res.status(403).json({
        message:
          "You can only manage bookings for your own studios.",
      });
    }

    if (booking.status !== "pending") {
      return res.status(400).json({
        message:
          "Only pending bookings can be confirmed.",
      });
    }

    // Atomic status update.
    const updateResult =
      await bookingsCollection.updateOne(
        {
          _id: new ObjectId(id),
          status: "pending",
        },
        {
          $set: {
            status: "confirmed",
            updatedAt: new Date(),
          },
        }
      );

    if (updateResult.modifiedCount !== 1) {
      return res.status(409).json({
        message:
          "This booking has already been updated. Please refresh and try again.",
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

/*
|--------------------------------------------------------------------------
| Reject booking
|--------------------------------------------------------------------------
*/
router.patch("/:id/reject", async (req, res) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({
        message: "You must be logged in.",
      });
    }

    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid booking ID.",
      });
    }

    const db = await connectDB();

    const bookingsCollection =
      db.collection("bookings");

    const booking = await bookingsCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!booking) {
      return res.status(404).json({
        message: "Booking not found.",
      });
    }

    const isHost =
      String(booking.hostId) ===
        String(user.id || user._id) ||
      booking.hostEmail === user.email;

    if (!isHost) {
      return res.status(403).json({
        message:
          "You can only manage bookings for your own studios.",
      });
    }

    if (booking.status !== "pending") {
      return res.status(400).json({
        message:
          "Only pending bookings can be rejected.",
      });
    }

    // Atomic status update.
    const updateResult =
      await bookingsCollection.updateOne(
        {
          _id: new ObjectId(id),
          status: "pending",
        },
        {
          $set: {
            status: "cancelled",
            updatedAt: new Date(),
          },
        }
      );

    if (updateResult.modifiedCount !== 1) {
      return res.status(409).json({
        message:
          "This booking has already been updated. Please refresh and try again.",
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

/*
|--------------------------------------------------------------------------
| Complete booking
|--------------------------------------------------------------------------
*/
router.patch("/:id/complete", async (req, res) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({
        message: "You must be logged in.",
      });
    }

    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid booking ID.",
      });
    }

    const db = await connectDB();

    const bookingsCollection =
      db.collection("bookings");

    const booking = await bookingsCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!booking) {
      return res.status(404).json({
        message: "Booking not found.",
      });
    }

    const isHost =
      String(booking.hostId) ===
        String(user.id || user._id) ||
      booking.hostEmail === user.email;

    if (!isHost) {
      return res.status(403).json({
        message:
          "You can only manage bookings for your own studios.",
      });
    }

    if (booking.status !== "confirmed") {
      return res.status(400).json({
        message:
          "Only confirmed bookings can be completed.",
      });
    }

    // Atomic status update.
    const updateResult =
      await bookingsCollection.updateOne(
        {
          _id: new ObjectId(id),
          status: "confirmed",
        },
        {
          $set: {
            status: "completed",
            updatedAt: new Date(),
          },
        }
      );

    if (updateResult.modifiedCount !== 1) {
      return res.status(409).json({
        message:
          "This booking has already been updated. Please refresh and try again.",
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

/*
|--------------------------------------------------------------------------
| Cancel booking
|--------------------------------------------------------------------------
*/
router.patch("/:id/cancel", async (req, res) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({
        message: "You must be logged in.",
      });
    }

    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid booking ID.",
      });
    }

    const db = await connectDB();

    const bookingsCollection =
      db.collection("bookings");

    const booking = await bookingsCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!booking) {
      return res.status(404).json({
        message: "Booking not found.",
      });
    }

    const isOwner =
      String(booking.userId) ===
        String(user.id || user._id) ||
      booking.userEmail === user.email;

    if (!isOwner) {
      return res.status(403).json({
        message:
          "You cannot cancel another user's booking.",
      });
    }

    if (booking.status !== "pending") {
      return res.status(400).json({
        message:
          "Only pending bookings can be cancelled.",
      });
    }

    // Atomic status update.
    const updateResult =
      await bookingsCollection.updateOne(
        {
          _id: new ObjectId(id),
          status: "pending",
        },
        {
          $set: {
            status: "cancelled",
            updatedAt: new Date(),
          },
        }
      );

    if (updateResult.modifiedCount !== 1) {
      return res.status(409).json({
        message:
          "This booking has already been updated. Please refresh and try again.",
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