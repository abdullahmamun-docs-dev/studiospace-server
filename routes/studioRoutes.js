import express from "express";
import { ObjectId } from "mongodb";
import { auth } from "../auth.js";
import connectDB from "../db.js";

const router = express.Router();

const ALLOWED_CATEGORIES = [
  "Photo Studios",
  "Sound Stages",
  "Podcast Rooms",
  "Music Suites",
  "Art Workshops",
];

const ACTIVE_STATUSES = ["Pending", "Confirmed"];

const DEFAULT_MAX_CAPACITY = 10;
const DEFAULT_SECURITY_DEPOSIT = 0;

function normalizeGallery(gallery, image) {
  const galleryItems = Array.isArray(gallery)
    ? gallery
        .filter(
          (item) =>
            typeof item === "string" &&
            item.trim()
        )
        .map((item) => item.trim())
    : [];

  const combined = [
    image,
    ...galleryItems,
  ].filter(Boolean);

  return [...new Set(combined)].slice(0, 10);
}

function normalizeReviews(reviews) {
  if (!Array.isArray(reviews)) {
    return [];
  }

  return reviews
    .filter(
      (review) =>
        review &&
        typeof review === "object" &&
        typeof review.userId === "string" &&
        typeof review.userName === "string" &&
        Number(review.rating) >= 1 &&
        Number(review.rating) <= 5 &&
        typeof review.comment === "string"
    )
    .map((review) => ({
      _id:
        review._id ||
        new ObjectId().toString(),
      userId: review.userId,
      userName: review.userName,
      rating: Number(review.rating),
      comment: review.comment.trim().slice(0, 500),
      createdAt:
        review.createdAt ||
        new Date().toISOString(),
    }));
}

function calculateAverageRating(reviews) {
  if (!reviews.length) {
    return 0;
  }

  const total = reviews.reduce(
    (sum, review) => sum + Number(review.rating),
    0
  );

  return Number(
    (total / reviews.length).toFixed(1)
  );
}

function isValidStudioData(body) {
  if (
    !body.name ||
    typeof body.name !== "string" ||
    !body.name.trim()
  ) {
    return "Studio name is required.";
  }

  if (
    !body.location ||
    typeof body.location !== "string" ||
    !body.location.trim()
  ) {
    return "Studio location is required.";
  }

  if (
    !ALLOWED_CATEGORIES.includes(body.category)
  ) {
    return "Invalid studio category.";
  }

  if (
    !Number.isFinite(Number(body.pricePerHour)) ||
    Number(body.pricePerHour) <= 0
  ) {
    return "Price per hour must be greater than 0.";
  }

  if (
    !body.description ||
    typeof body.description !== "string" ||
    !body.description.trim()
  ) {
    return "Studio description is required.";
  }

  if (
    !body.image ||
    typeof body.image !== "string" ||
    !body.image.trim()
  ) {
    return "Studio image is required.";
  }

  if (
    body.securityDeposit !== undefined &&
    (!Number.isFinite(
      Number(body.securityDeposit)
    ) ||
      Number(body.securityDeposit) < 0)
  ) {
    return "Security deposit must be 0 or greater.";
  }

  if (
    body.maxCapacity !== undefined &&
    (!Number.isInteger(
      Number(body.maxCapacity)
    ) ||
      Number(body.maxCapacity) < 1)
  ) {
    return "Maximum capacity must be at least 1.";
  }

  if (
    body.gallery !== undefined &&
    !Array.isArray(body.gallery)
  ) {
    return "Gallery must be an array of image URLs.";
  }

  return null;
}

async function getSessionUser(req) {
  try {
    const session = await auth.api.getSession({
      headers: req.headers,
    });

    return session?.user || null;
  } catch (error) {
    console.error("Session error:", error);
    return null;
  }
}

function isStudioOwner(studio, user) {
  return (
    studio &&
    user &&
    String(studio.hostId) === String(user.id)
  );
}

/*
|--------------------------------------------------------------------------
| GET MY STUDIOS
|--------------------------------------------------------------------------
*/

router.get("/my-studios", async (req, res) => {
  try {
    const user = await getSessionUser(req);

    if (!user) {
      return res.status(401).json({
        message: "Unauthorized. Please login first.",
      });
    }

    const db = await connectDB();

    const studios = await db
      .collection("studios")
      .find({
        hostId: user.id,
      })
      .sort({
        createdAt: -1,
      })
      .toArray();

    return res.json(studios);
  } catch (error) {
    console.error("Get my studios error:", error);

    return res.status(500).json({
      message: "Failed to load your studios.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| GET ALL STUDIOS
|--------------------------------------------------------------------------
*/

router.get("/", async (req, res) => {
  try {
    const db = await connectDB();

    const limit = Math.min(
      Math.max(Number(req.query.limit) || 0, 0),
      50
    );

    let cursor = db
      .collection("studios")
      .find({})
      .sort({
        createdAt: -1,
      });

    if (limit > 0) {
      cursor = cursor.limit(limit);
    }

    const studios = await cursor.toArray();

    return res.json(studios);
  } catch (error) {
    console.error("Get studios error:", error);

    return res.status(500).json({
      message: "Failed to load studios.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| CREATE STUDIO
|--------------------------------------------------------------------------
*/

router.post("/", async (req, res) => {
  try {
    const user = await getSessionUser(req);

    if (!user) {
      return res.status(401).json({
        message: "Unauthorized. Please login first.",
      });
    }

    const validationError = isValidStudioData(
      req.body
    );

    if (validationError) {
      return res.status(400).json({
        message: validationError,
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
      gallery,
      amenities,
    } = req.body;

    const normalizedGallery = normalizeGallery(
      gallery,
      image
    );

    const now = new Date();

    const studio = {
      name: name.trim(),
      location: location.trim(),
      category,
      pricePerHour: Number(pricePerHour),
      securityDeposit:
        securityDeposit === undefined
          ? DEFAULT_SECURITY_DEPOSIT
          : Number(securityDeposit),
      maxCapacity:
        maxCapacity === undefined
          ? DEFAULT_MAX_CAPACITY
          : Number(maxCapacity),
      description: description.trim(),
      image: image.trim(),
      gallery: normalizedGallery,
      amenities: Array.isArray(amenities)
        ? amenities
            .filter(
              (item) =>
                typeof item === "string" &&
                item.trim()
            )
            .map((item) => item.trim())
        : [],
      hostId: user.id,
      hostName: user.name || "",
      hostEmail: user.email || "",
      reviews: [],
      rating: 0,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db
      .collection("studios")
      .insertOne(studio);

    return res.status(201).json({
      ...studio,
      _id: result.insertedId,
    });
  } catch (error) {
    console.error("Create studio error:", error);

    return res.status(500).json({
      message: "Failed to create studio.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| GET SINGLE STUDIO
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

    const studio = await db
      .collection("studios")
      .findOne({
        _id: new ObjectId(id),
      });

    if (!studio) {
      return res.status(404).json({
        message: "Studio not found.",
      });
    }

    const gallery = normalizeGallery(
      studio.gallery,
      studio.image
    );

    const reviews = normalizeReviews(
      studio.reviews
    );

    const rating = calculateAverageRating(
      reviews
    );

    const needsUpdate =
      JSON.stringify(studio.gallery || []) !==
        JSON.stringify(gallery) ||
      JSON.stringify(studio.reviews || []) !==
        JSON.stringify(reviews) ||
      Number(studio.rating || 0) !== rating ||
      !studio.maxCapacity ||
      Number(studio.maxCapacity) < 1;

    if (needsUpdate) {
      await db.collection("studios").updateOne(
        {
          _id: new ObjectId(id),
        },
        {
          $set: {
            gallery,
            reviews,
            rating,
            maxCapacity:
              Number(studio.maxCapacity) >= 1
                ? Number(studio.maxCapacity)
                : DEFAULT_MAX_CAPACITY,
            securityDeposit:
              Number(studio.securityDeposit) >= 0
                ? Number(studio.securityDeposit)
                : DEFAULT_SECURITY_DEPOSIT,
            updatedAt: new Date(),
          },
        }
      );

      studio.gallery = gallery;
      studio.reviews = reviews;
      studio.rating = rating;

      if (
        !studio.maxCapacity ||
        Number(studio.maxCapacity) < 1
      ) {
        studio.maxCapacity =
          DEFAULT_MAX_CAPACITY;
      }
    }

    return res.json(studio);
  } catch (error) {
    console.error("Get studio error:", error);

    return res.status(500).json({
      message: "Failed to load studio.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| ADD REVIEW
|--------------------------------------------------------------------------
*/

router.post("/:id/reviews", async (req, res) => {
  try {
    const user = await getSessionUser(req);

    if (!user) {
      return res.status(401).json({
        message: "Unauthorized. Please login first.",
      });
    }

    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid studio ID.",
      });
    }

    const rating = Number(req.body.rating);
    const comment =
      typeof req.body.comment === "string"
        ? req.body.comment.trim()
        : "";

    if (
      !Number.isInteger(rating) ||
      rating < 1 ||
      rating > 5
    ) {
      return res.status(400).json({
        message: "Rating must be between 1 and 5.",
      });
    }

    if (!comment) {
      return res.status(400).json({
        message: "Review comment is required.",
      });
    }

    if (comment.length > 500) {
      return res.status(400).json({
        message:
          "Review comment cannot exceed 500 characters.",
      });
    }

    const db = await connectDB();

    const studio = await db
      .collection("studios")
      .findOne({
        _id: new ObjectId(id),
      });

    if (!studio) {
      return res.status(404).json({
        message: "Studio not found.",
      });
    }

    if (
      String(studio.hostId) === String(user.id)
    ) {
      return res.status(403).json({
        message:
          "Studio owners cannot review their own studio.",
      });
    }

    const reviews = normalizeReviews(
      studio.reviews
    );

    const alreadyReviewed = reviews.some(
      (review) =>
        String(review.userId) === String(user.id)
    );

    if (alreadyReviewed) {
      return res.status(409).json({
        message:
          "You have already reviewed this studio.",
      });
    }

    const newReview = {
      _id: new ObjectId().toString(),
      userId: user.id,
      userName: user.name || "Creator",
      rating,
      comment,
      createdAt: new Date().toISOString(),
    };

    const updatedReviews = [
      ...reviews,
      newReview,
    ];

    const averageRating =
      calculateAverageRating(updatedReviews);

    await db.collection("studios").updateOne(
      {
        _id: new ObjectId(id),
      },
      {
        $set: {
          reviews: updatedReviews,
          rating: averageRating,
          updatedAt: new Date(),
        },
      }
    );

    return res.status(201).json({
      message: "Review added successfully.",
      review: newReview,
      rating: averageRating,
    });
  } catch (error) {
    console.error("Add review error:", error);

    return res.status(500).json({
      message: "Failed to add review.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| UPDATE STUDIO
|--------------------------------------------------------------------------
*/

router.patch("/:id", async (req, res) => {
  try {
    const user = await getSessionUser(req);

    if (!user) {
      return res.status(401).json({
        message: "Unauthorized. Please login first.",
      });
    }

    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid studio ID.",
      });
    }

    const db = await connectDB();

    const studio = await db
      .collection("studios")
      .findOne({
        _id: new ObjectId(id),
      });

    if (!studio) {
      return res.status(404).json({
        message: "Studio not found.",
      });
    }

    if (!isStudioOwner(studio, user)) {
      return res.status(403).json({
        message:
          "You are not allowed to update this studio.",
      });
    }

    const validationError = isValidStudioData(
      req.body
    );

    if (validationError) {
      return res.status(400).json({
        message: validationError,
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
      gallery,
      amenities,
    } = req.body;

    const normalizedGallery = normalizeGallery(
      gallery,
      image
    );

    const existingReviews = normalizeReviews(
      studio.reviews
    );

    const updateData = {
      name: name.trim(),
      location: location.trim(),
      category,
      pricePerHour: Number(pricePerHour),
      securityDeposit:
        securityDeposit === undefined
          ? DEFAULT_SECURITY_DEPOSIT
          : Number(securityDeposit),
      maxCapacity:
        maxCapacity === undefined
          ? DEFAULT_MAX_CAPACITY
          : Number(maxCapacity),
      description: description.trim(),
      image: image.trim(),
      gallery: normalizedGallery,
      amenities: Array.isArray(amenities)
        ? amenities
            .filter(
              (item) =>
                typeof item === "string" &&
                item.trim()
            )
            .map((item) => item.trim())
        : [],
      reviews: existingReviews,
      rating:
        calculateAverageRating(existingReviews),
      updatedAt: new Date(),
    };

    await db.collection("studios").updateOne(
      {
        _id: new ObjectId(id),
      },
      {
        $set: updateData,
      }
    );

    return res.json({
      message: "Studio updated successfully.",
    });
  } catch (error) {
    console.error("Update studio error:", error);

    return res.status(500).json({
      message: "Failed to update studio.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| DELETE STUDIO
|--------------------------------------------------------------------------
*/

router.delete("/:id", async (req, res) => {
  try {
    const user = await getSessionUser(req);

    if (!user) {
      return res.status(401).json({
        message: "Unauthorized. Please login first.",
      });
    }

    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid studio ID.",
      });
    }

    const db = await connectDB();

    const studio = await db
      .collection("studios")
      .findOne({
        _id: new ObjectId(id),
      });

    if (!studio) {
      return res.status(404).json({
        message: "Studio not found.",
      });
    }

    if (!isStudioOwner(studio, user)) {
      return res.status(403).json({
        message:
          "You are not allowed to delete this studio.",
      });
    }

    const activeBooking = await db
      .collection("bookings")
      .findOne({
        studioId: id,
        status: {
          $in: ACTIVE_STATUSES,
        },
      });

    if (activeBooking) {
      return res.status(409).json({
        message:
          "This studio cannot be deleted because it has an active booking.",
      });
    }

    const result = await db
      .collection("studios")
      .deleteOne({
        _id: new ObjectId(id),
      });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        message: "Studio not found.",
      });
    }

    return res.json({
      message: "Studio deleted successfully.",
    });
  } catch (error) {
    console.error("Delete studio error:", error);

    return res.status(500).json({
      message: "Failed to delete studio.",
    });
  }
});

export default router;