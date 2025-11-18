/******************************************************************************************
 *  FINAL COMPLETE SERVER.JS — COPY/PASTE READY
 *  Includes:
 *  ✔ All your original API logic  
 *  ✔ Cron job every 30 minutes
 *  ✔ Auto fetch tweets → save as article
 *  ✔ BASE_URL support for Render + Localhost
 ******************************************************************************************/

import express from "express";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import cors from "cors";
import mongoose from "mongoose";
import cron from "node-cron";

// --- 1. INITIALIZATION ---
dotenv.config();
const app = express();

const PORT = process.env.PORT || 4001;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MONGO_URI = process.env.MONGO_URI;
const TWITTER_API_IO_KEY = process.env.TWITTER_API_KEY;

// --- BASE URL HANDLING (Render vs Local) ---
const BASE_URL =
  process.env.NODE_ENV === "production"
    ? "https://tweet-server-jd9n.onrender.com"
    : `http://localhost:${PORT}`;

// --- 2. VALIDATE KEYS ---
if (!GEMINI_API_KEY || !MONGO_URI || !TWITTER_API_IO_KEY) {
  console.error("❌ Missing required env variables");
  process.exit(1);
}

// --- 3. CACHE ---
const processedTweetCache = new Map();
const CACHE_DURATION_MS = 12 * 60 * 60 * 1000;

// --- 4. DATABASE CONNECT ---
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err));

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "https://news-dashboard-ob0p.onrender.com",
];

// --- CORS ---
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
  })
);

app.use(express.json());

/******************************************************************************************
 *  ARTICLE SCHEMA
 ******************************************************************************************/
const articleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    slug: { type: String, required: true, unique: true, sparse: true },
    summary: String,
    content: String,
    liveContent: String,
    isFullArticle: { type: Boolean, default: false },
    author: { type: String, default: "Admin" },
    category: { type: String, default: "news" },
    featuredImage: String,
    featuredVideo: String,
    tags: [String],
    publishedDate: Date,
    status: { type: String, default: "published" },
    tweetId: { type: String, unique: true, sparse: true },
    tweetUrl: String,
    twitterEmbed: String,

    slug_te: String,
    tags_te: [String],

    // NEW FIELD
    type: { type: String, default: "twitter" },
  },
  { timestamps: true, collection: "articles" }
);

const Article = mongoose.model("Article", articleSchema);

/******************************************************************************************
 *  GEMINI FORMATTER FUNCTIONS
 ******************************************************************************************/
const genAI = new GoogleGenAI(GEMINI_API_KEY);

async function formatTweetWithGemini(text) {
  const prompt = `
    You are a professional Telugu news editor.
    Generate JSON only:
    { "title", "summary", "slug", "tags", "slug_te", "tags_te" }
    Text: ${text}
  `;

  try {
    const result = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ parts: [{ text: prompt }] }],
    });

    const cleaned = result.text.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    return {
      title: text.slice(0, 60),
      summary: text,
      slug: text.slice(0, 60) + Date.now(),
      tags: ["news"],
      slug_te: "fallback-te-" + Date.now(),
      tags_te: ["వార్తలు"],
    };
  }
}

async function formatTextWithGemini(text, instruction) {
  const prompt = `
    Process the text following instruction: ${instruction}
    Return JSON: { "title", "summary" }
    Text: ${text}
  `;

  try {
    const result = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ parts: [{ text: prompt }] }],
    });

    const cleaned = result.text.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    return { title: "Error", summary: e.message };
  }
}

/******************************************************************************************
 *  PROCESS TWEET + SAVE TO DB
 ******************************************************************************************/
async function processTweetId(tweetId) {
  const TWITTER_API_URL = "https://api.twitterapi.io/twitter/tweets";

  try {
    const response = await fetch(`${TWITTER_API_URL}?tweet_ids=${tweetId}`, {
      headers: { "X-API-Key": TWITTER_API_IO_KEY },
    });

    if (!response.ok) throw new Error("Twitter API request failed");

    const data = await response.json();
    if (!data?.tweets?.[0]) throw new Error("Tweet not found");

    const tweet = data.tweets[0];
    const geminiData = await formatTweetWithGemini(tweet.text);

    const twitterEmbed = `
      <blockquote class="twitter-tweet">
        <p>${tweet.text}</p>
        — ${tweet.author.name} (@${tweet.author.userName})
        <a href="${tweet.url}">${tweet.createdAt}</a>
      </blockquote>
      <script async src="https://platform.twitter.com/widgets.js"></script>
    `;

    const article = new Article({
      title: geminiData.title,
      summary: geminiData.summary,
      slug: geminiData.slug,
      slug_te: geminiData.slug_te,
      tags: geminiData.tags,
      tags_te: geminiData.tags_te,
      content: geminiData.summary,
      liveContent: geminiData.summary,
      tweetId: tweet.id,
      tweetUrl: tweet.url,
      featuredImage:
        tweet.extendedEntities?.media?.[0]?.media_url_https || null,
      twitterEmbed,
      author: "Vijay",
      category: "news",
      publishedDate: new Date(),
      status: "published",
      type: "twitter",
    });

    const savedArticle = await article.save();
    return { success: true, data: savedArticle };
  } catch (error) {
    return { success: false, id: tweetId, reason: error.message };
  }
}

/******************************************************************************************
 *  TWEET FETCH ROUTES (UNCHANGED)
 ******************************************************************************************/

app.post("/api/fetch-tweet-and-save", async (req, res) => {
  const { tweet_ids } = req.body;
  if (!tweet_ids) return res.status(400).json({ error: "tweet_ids required" });

  const success = [];
  const failed = [];

  for (const id of tweet_ids) {
    const result = await processTweetId(id);
    result.success ? success.push(result.data) : failed.push(result);
  }

  res.json({ success, failed });
});

app.get("/api/fetch-tweet-and-save", async (req, res) => {
  const ids = req.query.tweet_ids?.split(",") || [];

  const success = [];
  const failed = [];

  for (const id of ids) {
    const result = await processTweetId(id);
    result.success ? success.push(result.data) : failed.push(result);
  }

  res.json({ success, failed });
});

/******************************************************************************************
 *  FETCH USER LAST TWEETS
 ******************************************************************************************/
app.get("/api/fetch-user-last-tweets", async (req, res) => {
  const { userName } = req.query;
  if (!userName) return res.status(400).json({ error: "username required" });

  const API_URL = "https://api.twitterapi.io/twitter/user/last_tweets";

  try {
    const response = await fetch(`${API_URL}?userName=${userName}`, {
      headers: { "X-API-Key": TWITTER_API_IO_KEY },
    });

    const data = await response.json();
    let tweets =
      data?.tweets ?? data?.data?.tweets ?? data?.items ?? [];

    if (!Array.isArray(tweets)) tweets = [];

    const toProcess = [];
    const skipped = [];
    const now = Date.now();

    for (const t of tweets) {
      const cached = processedTweetCache.get(t.id);

      if (cached && now - cached < CACHE_DURATION_MS) {
        skipped.push(t.id);
      } else {
        toProcess.push(t);
      }
    }

    const success = [];
    const failed = [];

    for (const t of toProcess) {
      const res = await processTweetId(t.id);
      res.success ? success.push(res.data) : failed.push(res);
      processedTweetCache.set(t.id, now);
    }

    res.json({ success, failed, skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/******************************************************************************************
 *  GET ALL ARTICLES
 ******************************************************************************************/
app.get("/api/articles", async (req, res) => {
  try {
    const articles = await Article.find().sort({ createdAt: -1 });
    res.json({ success: true, data: articles });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/******************************************************************************************
 *  CUSTOM TEXT SUMMARIZATION
 ******************************************************************************************/
app.post("/api/summarize-text", async (req, res) => {
  const { text, instruction } = req.body;

  const result = await formatTextWithGemini(text, instruction);
  res.json({ success: true, data: result });
});

/******************************************************************************************
 *  UPDATE ARTICLE
 ******************************************************************************************/
app.post("/api/update-article/:id", async (req, res) => {
  try {
    const updated = await Article.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });

    if (!updated) return res.status(404).json({ error: "Not found" });

    res.json({ success: true, data: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/******************************************************************************************
 *  CRON JOB — RUNS EVERY 30 MINUTES
 ******************************************************************************************/

const CRON_TWITTER_USERS = [
  "bigtvtelugu",
  "UttarandhraNow"
];

cron.schedule("*/30 * * * *", async () => {
  console.log("⏳ CRON: Fetching tweets...");

  for (const userName of CRON_TWITTER_USERS) {
    try {
      const url = `${BASE_URL}/api/fetch-user-last-tweets?userName=${userName}`;
      console.log("Fetching:", url);

      const res = await fetch(url);
      const result = await res.json();

      console.log(
        `✔ CRON DONE — @${userName} | saved=${result.success?.length || 0}`
      );
    } catch (err) {
      console.error(`❌ CRON FAILED @${userName}:`, err.message);
    }
  }
});

app.get("/debug/twitterapi", async (req, res) => {
  const { userName } = req.query;

  if (!userName) return res.json({ error: "username required" });

  try {
    const response = await fetch(
      `https://api.twitterapi.io/twitter/user/last_tweets?userName=${userName}`,
      {
        headers: { "X-API-Key": TWITTER_API_IO_KEY },
      }
    );

    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.json({ error: e.message });
  }
});


// YOUR ENTIRE ORIGINAL CODE HERE (unchanged)...

// --------------------------------------------------
// ADD THIS NEW CRON API ENDPOINT (SAFE, NEW SECTION)
// --------------------------------------------------

app.get("/api/run-cron-twitter", async (req, res) => {
  console.log("⏳ CRON API Triggered Manually");

  // Add as many users as you want here
  const USERS = ["NDTVProfitIndia"];
  const results = [];

  // Use correct URL for localhost + production
  const API_BASE = BASE_URL; 

  for (const user of USERS) {
    try {
      console.log(`🔍 Fetching tweets for: ${user}`);

      const response = await fetch(
        `${API_BASE}/api/fetch-user-last-tweets?userName=${user}`
      );

      // If request failed, capture error
      if (!response.ok) {
        const body = await response.text();
        console.log("❌ Inner API error:", body);

        results.push({
          user,
          error: `Inner API failed (${response.status})`,
          body,
        });
        continue;
      }

      const data = await response.json();

      results.push({
        user,
        success: data.success || data.successfulPosts || [],
        failed: data.failed || data.failedIds || [],
        skipped: data.skipped || data.skippedCachedIds || []
      });

      console.log(`✅ Completed: ${user}`);
    } catch (err) {
      console.error(`❌ Error processing ${user}:`, err.message);
      results.push({
        user,
        error: err.message
      });
    }
  }

  res.json({
    message: "Cron fetch completed for all users",
    results
  });
});





/******************************************************************************************
 *  START SERVER
 ******************************************************************************************/
app.listen(PORT, () => {
  console.log(`🚀 Server running at ${BASE_URL}`);
});
