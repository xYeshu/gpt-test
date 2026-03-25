import "dotenv/config"
import express from "express"
import ImageKit from "imagekit"
import cors from "cors"
import mongoose from "mongoose";
import Chat from "./models/chat.js";
import UserChats from "./models/userChats.js";
import { clerkMiddleware, requireAuth } from '@clerk/express'

const port = process.env.PORT || 8080;

const app = express()

const allowedOrigins = [
  process.env.CLIENT_URL,
  "https://gpt-test-frontend.vercel.app",
  "http://localhost:5173",
  "http://localhost:5174",
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // allow requests with no origin (mobile apps, curl, etc.)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Handle preflight requests explicitly
app.options("*", cors());

app.use(clerkMiddleware())
app.use(express.json())

// ─── Serverless-safe MongoDB connection (cached for Vercel) ───────────────────
let cachedConnection = null;

const connect = async () => {
  if (cachedConnection && mongoose.connection.readyState === 1) {
    return cachedConnection;
  }
  try {
    cachedConnection = await mongoose.connect(process.env.MONGO, {
      bufferCommands: false,
      maxPoolSize: 10,        // keep pool small for serverless
    });
    console.log("Connected to MongoDB");
    return cachedConnection;
  } catch (err) {
    console.log("MongoDB connection error:", err);
    throw err;
  }
};

// ─── ImageKit ────────────────────────────────────────────────────────────────
const imagekit = new ImageKit({
  urlEndpoint: process.env.IMAGE_KIT_ENDPOINT,
  publicKey: process.env.IMAGE_KIT_PUBLIC_KEY,
  privateKey: process.env.IMAGE_KIT_PRIVATE_KEY,
});

app.get('/auth', function (req, res) {
  var result = imagekit.getAuthenticationParameters();
  res.send(result);
});

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post('/api/chats', requireAuth(), async (req, res) => {
  await connect();
  const userId = req.auth.userId;
  const { text } = req.body;
  try {
    const newChat = new Chat({
      userId: userId,
      history: {
        role: "user",
        parts: [{ text }]
      }
    });
    const savedChat = await newChat.save();

    const userChats = await UserChats.find({ userId: userId });

    if (!userChats.length) {
      const newUserChats = new UserChats({
        userId: userId,
        chats: [{
          _id: savedChat._id,
          title: text.substring(0, 40)
        }]
      });
      await newUserChats.save();
    } else {
      await UserChats.updateOne({ userId: userId }, {
        $push: {
          chats: {
            _id: savedChat._id,
            title: text.substring(0, 40),
          }
        }
      });
    }
    res.status(201).send(newChat._id);
  } catch (err) {
    console.log(err);
    res.status(500).send("Error creating chat");
  }
});


app.get("/api/userchats", requireAuth(), async (req, res) => {
  await connect();
  const userId = req.auth.userId;
  try {
    const userChats = await UserChats.find({ userId });
    res.status(200).send(userChats[0]?.chats || []);
  } catch (err) {
    console.log(err);
    res.status(500).send("Error fetching dashboard userChats");
  }
});

app.get("/api/chats/:id", requireAuth(), async (req, res) => {
  await connect();
  const userId = req.auth.userId;
  try {
    const chat = await Chat.findOne({ _id: req.params.id, userId: userId });
    res.status(200).send(chat);
  } catch (err) {
    console.log(err);
    res.status(500).send("Error fetching chat conversation");
  }
});

app.put("/api/chats/:id", requireAuth(), async (req, res) => {
  await connect();
  const userId = req.auth.userId;
  const { question, answer, img } = req.body;
  const newItems = [
    ...(question
      ? [{ role: "user", parts: [{ text: question }], ...(img && { img }) }]
      : []),
    { role: "model", parts: [{ text: answer }] },
  ];
  try {
    const updatedChat = await Chat.updateOne({ _id: req.params.id, userId }, {
      $push: {
        history: {
          $each: newItems,
        }
      }
    });
    res.status(200).send(updatedChat);
  } catch (err) {
    console.log(err);
    res.status(500).send("Error adding chat conversation");
  }
});

// ─── Start server (local dev only — Vercel uses the exported app) ─────────────
app.listen(port, function () {
  connect();
  console.log(`Server running on port ${port}`);
});

export default app;
