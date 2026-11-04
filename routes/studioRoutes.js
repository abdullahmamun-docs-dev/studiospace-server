import express from "express";
import { ObjectId } from "mongodb";

import connectDB from "../db.js";
import { auth } from "../auth.js";

const router = express.Router();

const ALLOWED_CATEGORIES = [
  "Photo Studios",
  "Sound Stages",
  "Podcast Rooms",
  "Music Suites",
  "Art Workshops",
];

const ACTIVE_STATUSES = ["pending", "confirmed"];

const DEFAULT_MAX_CAPACITY = 10;
const DEFAULT_SECURITY_DEPOSIT = 0;

function isValidStudioData(data) {
  const {
    name,
    location,
    category,
    pricePerHour,
    description,
    image,
    securityDeposit,
    maxCapacity,
  } = data;

  const price = Number(pricePerHour);

  if (
    typeof name !== "string" ||
    !name.trim() ||
    typeof location !== "string" ||
    !location.trim() ||
    !ALLOWED_CATEGORIES.includes(category) ||
    pricePerHour === "" ||
    !Number.isFinite(price) ||
    price <= 0 ||
    typeof description !== "string" ||
    !description.trim() ||
    typeof image !== "string" ||
    !image.trim()
  ) {
    return false;
  }

  if (
    securityDeposit !== undefined &&
    (!Number.isFinite(Number(securityDeposit)) ||
      Number(securityDeposit) < 0)
  ) {
    return false;
  }

  if (
    maxCapacity !== undefined &&
    (!Number.isInteger(Number(maxCapacity)) ||
      Number(maxCapacity) <= 0)
  ) {
    return false;
  }

  return true;
}

function isStudioOwner(studio, user) {
  if (!studio || !user) {
    return false;
  }

  const sameHostId =
    studio.hostId &&
    user.id &&
    String(studio.hostId) === String(user.id);

  const sameHostEmail =
    studio.hostEmail &&
    user.email &&
    studio.hostEmail.toLowerCase() ===
      user.email.toLowerCase();

  return Boolean(sameHostId || sameHostEmail);
}

/*
|--------------------------------------------------------------------------
| Get studios created by logged-in user
|--------------------------------------------------------------------------
*/
router.get("/my-studios", async (req, res) => {
  try {
    const session = await auth.api.getSession({
      headers: req.headers,
    });

    if (!session?.user) {
      return res.status(401).json({
        message: "You must be logged in to view your studios.",
      });
    }

    const db = await connectDB();

    const studios = await db
      .collection("studios")
      .find({
        $or: [
          {
            hostId: session.user.id,
          },
          {
            hostEmail: session.user.email,
          },
        ],
      })
      .sort({
        createdAt: -1,
      })
      .toArray();

    return res.status(200).json(studios);
  } catch (error) {
    console.error("Failed to fetch your studios:", error);

    return res.status(500).json({
      message: "Failed to fetch your studios.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| Get all studios
| Supports: ?limit=6
|--------------------------------------------------------------------------
*/
router.get("/", async (req, res) => {
  try {
    const db = await connectDB();

    const query = db
      .collection("studios")
      .find({})
      .sort({
        createdAt: -1,
      });

    const requestedLimit = Number.parseInt(
      req.query.limit,
      10
    );

    if (
      Number.isInteger(requestedLimit) &&
      requestedLimit > 0
    ) {
      query.limit(Math.min(requestedLimit, 100));
    }

    const studios = await query.toArray();

    return res.status(200).json(studios);
  } catch (error) {
    console.error("Failed to fetch studios:", error);

    return res.status(500).json({
      message: "Failed to fetch studios.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| Create a new studio
|--------------------------------------------------------------------------
*/
router.post("/", async (req, res) => {
  try {
    const session = await auth.api.getSession({
      headers: req.headers,
    });

    if (!session?.user) {
      return res.status(401).json({
        message: "You must be logged in to list a studio.",
      });
    }

    if (
      !isValidStudioData(req.body) ||
      req.body.securityDeposit === undefined ||
      req.body.maxCapacity === undefined
    ) {
      return res.status(400).json({
        message:
          "Please provide valid studio information, including security deposit and maximum capacity.",
      });
    }

    const db = await connectDB();

    const {
      name,
      location,
      category,
      pricePerHour,
      securityDeposit,
      maxCapacity,
      description,
      image,
      amenities,
    } = req.body;

    const studio = {
      name: name.trim(),
      location: location.trim(),
      category,
      pricePerHour: Number(pricePerHour),
      securityDeposit: Number(securityDeposit),
      maxCapacity: Number(maxCapacity),
      description: description.trim(),
      image: image.trim(),

      amenities: Array.isArray(amenities)
        ? amenities
            .filter(
              (item) =>
                typeof item === "string" &&
                item.trim() !== ""
            )
            .map((item) => item.trim())
        : [],

      hostId: session.user.id,
      hostName: session.user.name || "",
      hostEmail: session.user.email || "",

      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db
      .collection("studios")
      .insertOne(studio);

    return res.status(201).json({
      message: "Studio created successfully.",
      studio: {
        _id: result.insertedId,
        ...studio,
      },
    });
  } catch (error) {
    console.error("Failed to create studio:", error);

    return res.status(500).json({
      message: "Failed to create studio.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| Get a single studio
|--------------------------------------------------------------------------
*/
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid studio ID.",
      });
    }

    const db = await connectDB();

    const studioObjectId = new ObjectId(id);

    const studio = await db
      .collection("studios")
      .findOne({
        _id: studioObjectId,
      });

    if (!studio) {
      return res.status(404).json({
        message: "Studio not found.",
      });
    }

    /*
     * Upgrade old/default studio capacity from 5 to 10.
     */
    if (
      studio.maxCapacity === undefined ||
      studio.maxCapacity === 5
    ) {
      await db.collection("studios").updateOne(
        {
          _id: studioObjectId,
        },
        {
          $set: {
            maxCapacity: DEFAULT_MAX_CAPACITY,
            updatedAt: new Date(),
          },
        }
      );

      studio.maxCapacity = DEFAULT_MAX_CAPACITY;
    }

    return res.status(200).json(studio);
  } catch (error) {
    console.error("Failed to fetch studio:", error);

    return res.status(500).json({
      message: "Failed to fetch studio.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| Update a studio
|--------------------------------------------------------------------------
*/
router.patch("/:id", async (req, res) => {
  try {
    const session = await auth.api.getSession({
      headers: req.headers,
    });

    if (!session?.user) {
      return res.status(401).json({
        message: "You must be logged in to update a studio.",
      });
    }

    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid studio ID.",
      });
    }

    if (!isValidStudioData(req.body)) {
      return res.status(400).json({
        message: "Please provide valid studio information.",
      });
    }

    const db = await connectDB();

    const studioObjectId = new ObjectId(id);

    const studio = await db
      .collection("studios")
      .findOne({
        _id: studioObjectId,
      });

    if (!studio) {
      return res.status(404).json({
        message: "Studio not found.",
      });
    }

    /*
     * Allow ownership through either hostId or hostEmail.
     * This is important for older studio documents.
     */
    if (!isStudioOwner(studio, session.user)) {
      return res.status(403).json({
        message: "You can only update your own studio.",
      });
    }

    const {
      name,
      location,
      category,
      pricePerHour,
      securityDeposit,
      maxCapacity,
      description,
      image,
      amenities,
    } = req.body;

    const updateData = {
      name: name.trim(),
      location: location.trim(),
      category,
      pricePerHour: Number(pricePerHour),
      description: description.trim(),
      image: image.trim(),

      amenities: Array.isArray(amenities)
        ? amenities
            .filter(
              (item) =>
                typeof item === "string" &&
                item.trim() !== ""
            )
            .map((item) => item.trim())
        : [],

      /*
       * Backfill ownership information for legacy studios.
       */
      hostId: session.user.id,
      hostName: session.user.name || studio.hostName || "",
      hostEmail:
        session.user.email || studio.hostEmail || "",

      updatedAt: new Date(),
    };

    /*
     * New values are explicitly provided by the edit form.
     */
    if (securityDeposit !== undefined) {
      updateData.securityDeposit = Number(
        securityDeposit
      );
    } else if (studio.securityDeposit === undefined) {
      updateData.securityDeposit =
        DEFAULT_SECURITY_DEPOSIT;
    }

    if (maxCapacity !== undefined) {
      updateData.maxCapacity = Number(maxCapacity);
    } else if (studio.maxCapacity === undefined) {
      updateData.maxCapacity = DEFAULT_MAX_CAPACITY;
    }

    await db.collection("studios").updateOne(
      {
        _id: studioObjectId,
      },
      {
        $set: updateData,
      }
    );

    return res.status(200).json({
      message: "Studio updated successfully.",
    });
  } catch (error) {
    console.error("Failed to update studio:", error);

    return res.status(500).json({
      message: "Failed to update studio.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| Delete a studio
|--------------------------------------------------------------------------
|
| A studio cannot be deleted if it has a pending or confirmed
| booking.
|--------------------------------------------------------------------------
*/
router.delete("/:id", async (req, res) => {
  try {
    const session = await auth.api.getSession({
      headers: req.headers,
    });

    if (!session?.user) {
      return res.status(401).json({
        message: "You must be logged in to delete a studio.",
      });
    }

    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid studio ID.",
      });
    }

    const db = await connectDB();

    const studioObjectId = new ObjectId(id);

    const studio = await db
      .collection("studios")
      .findOne({
        _id: studioObjectId,
      });

    if (!studio) {
      return res.status(404).json({
        message: "Studio not found.",
      });
    }

    /*
     * Allow legacy studios to be deleted through hostEmail.
     */
    if (!isStudioOwner(studio, session.user)) {
      return res.status(403).json({
        message: "You can only delete your own studio.",
      });
    }

    /*
     * Check both possible studioId formats:
     *
     * New bookings:
     * studioId = ObjectId
     *
     * Older bookings:
     * studioId = string
     */
    const activeBooking = await db
      .collection("bookings")
      .findOne({
        studioId: {
          $in: [studioObjectId, id],
        },
        status: {
          $in: ACTIVE_STATUSES,
        },
      });

    if (activeBooking) {
      return res.status(409).json({
        message:
          "This studio cannot be deleted because it has pending or confirmed bookings.",
      });
    }

    /*
     * Delete only this exact studio and owner.
     */
    const ownerFilter = {
      $or: [
        {
          hostId: session.user.id,
        },
        {
          hostEmail: session.user.email,
        },
      ],
    };

    const result = await db
      .collection("studios")
      .deleteOne({
        _id: studioObjectId,
        ...ownerFilter,
      });

    if (result.deletedCount === 0) {
      return res.status(403).json({
        message: "You can only delete your own studio.",
      });
    }

    return res.status(200).json({
      message: "Studio deleted successfully.",
    });
  } catch (error) {
    console.error("Failed to delete studio:", error);

    return res.status(500).json({
      message: "Failed to delete studio.",
    });
  }
});

export default router;