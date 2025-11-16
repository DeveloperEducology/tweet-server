import express from 'express';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import cors from 'cors';
import mongoose from 'mongoose'; // Added for database

// --- 1. INITIALIZATION ---
dotenv.config();
const app = express();

const PORT = process.env.PORT || 4001;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MONGO_URI = process.env.MONGO_URI; // Added for database
const TWITTER_API_IO_KEY = process.env.TWITTER_API_KEY; // Added for Twitter

// --- 2. VALIDATE KEYS ---
if (!GEMINI_API_KEY || !MONGO_URI || !TWITTER_API_IO_KEY) {
  console.error("Error: Missing required .env variables (GEMINI_API_KEY, MONGO_URI, TWITTER_API_KEY)");
  process.exit(1);
}

// --- 3. CACHE SETUP (NEW) ---
const processedTweetCache = new Map();
const CACHE_DURATION_MS = 12 * 60 * 60 * 1000; 

// --- 4. DATABASE SETUP & CORS ---
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Connection Error:", err));

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'https://news-dashboard-ob0p.onrender.com'
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
};

// ** UPDATED Article Schema **
const articleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true }, // Telugu Title
    slug: { type: String, required: true, unique: true, sparse: true }, // English Slug
    summary: { type: String }, // Telugu Summary
    content: { type: String }, 
    liveContent: { type: String }, 
    isFullArticle: { type: Boolean, default: false },
    author: { type: String, default: "Admin" },
    category: { type: String, default: "news" },
    featuredImage: { type: String, default: "placeholder" },
    featuredVideo: { type: String, default: "" },
    tags: [String], // English Tags
    publishedDate: { type: Date },
    status: { type: String, default: "published" },
    tweetId: { type: String, unique: true, sparse: true },
    tweetUrl: { type: String },
    twitterEmbed: { type: String },

    // --- NEW TELUGU FIELDS ---
    slug_te: { type: String, sparse: true }, // Telugu Slug
    tags_te: [String], // Telugu Tags
  },
  { timestamps: true, collection: "articles" }
);

const Article = mongoose.model("Article", articleSchema);

// --- 5. GEMINI SETUP ---
const genAI = new GoogleGenAI(GEMINI_API_KEY);

// --- 6. MIDDLEWARE ---
app.use(cors(corsOptions));
app.use(express.json());

// --- 7. GEMINI HELPER FUNCTION (UPDATED) ---
async function formatTweetWithGemini(text) {
  const prompt = `You are a professional news editor.
  Take the following English text and generate all the required fields.

  1.  **title:** A short, catchy headline translated into **Telugu**.
  2.  **summary:** A concise summary translated into **Telugu**, approximately 50 words like telugu professional news editor.
  3.  **slug:** A URL-friendly slug based on the *original English text* (e.g., "new-system-implemented").
  4.  **tags:** An array of 3-5 relevant tags in **English** (e.g., ["viral", "news"]).
  5.  **slug_te:** A URL-friendly slug based on the *Telugu title* (e.g., "kotha-pranali-amalu").
  6.  **tags_te:** An array of 3-5 relevant tags in **Telugu** (e.g., ["వైరల్", "వార్తలు"]).

  Return ONLY a valid JSON object with six keys: "title", "summary", "slug", "tags", "slug_te", and "tags_te".
  Do not add any other text, markdown, or backticks.

  Input Text:
  ${text}`;

  try {
    const result = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ parts: [{ text: prompt }] }],
    });

    if (!result || !result.text) {
      throw new Error("Gemini returned no text.");
    }
    
    const cleanedJsonString = result.text.trim().replace(/```json/g, "").replace(/```/g, "").trim();
    const parsedData = JSON.parse(cleanedJsonString);
    
    // Updated validation for new keys
    if (!parsedData.title || !parsedData.summary || !parsedData.slug || !parsedData.tags || !parsedData.slug_te || !parsedData.tags_te) {
      throw new Error("Gemini returned incomplete JSON data.");
    }
    
    return parsedData; // Returns { title, summary, slug, tags, slug_te, tags_te }

  } catch (error) {
    console.error("Gemini helper function error:", error.message);
    // Return a fallback if Gemini fails
    return {
      title: text.slice(0, 50),
      summary: text,
      slug: `fallback-${Date.now()}`, // English slug
      tags: ["news"], // English tags
      slug_te: `fallback-te-${Date.now()}`, // Telugu slug
      tags_te: ["వార్తలు"], // Telugu tags
    };
  }
}

// --- 8. TWEET PROCESSING HELPER (UPDATED) ---
async function processTweetId(tweetId) {
  const TWITTER_API_URL = "https://api.twitterapi.io/twitter/tweets";
  
  try {
    // --- Step 1: Fetch from Twitter API ---
    const response = await fetch(`${TWITTER_API_URL}?tweet_ids=${tweetId}`, {
      headers: {
        "X-API-Key": TWITTER_API_IO_KEY
      }
    });

    if (!response.ok) {
      throw new Error(`Twitter API request failed with status ${response.status}`);
    }
    
    const data = await response.json();

    if (data.status !== "success" || !data.tweets || data.tweets.length === 0) {
      console.warn(`Could not fetch or find tweet with ID: ${tweetId}`);
      throw new Error("Not found or API error");
    }

    const tweet = data.tweets[0];

    // --- Step 2: Process with Gemini ---
    const geminiResult = await formatTweetWithGemini(tweet.text);

    // --- Step 3: Construct Twitter Embed ---
    const tweetDate = new Date(tweet.createdAt).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });

    const twitterEmbed = `
      <blockquote class="twitter-tweet" data-media-max-width="560">
        <p lang="${tweet.lang || 'en'}" dir="ltr">${tweet.text}</p>
        &mdash; ${tweet.author.name} (@${tweet.author.userName}) 
        <a href="${tweet.url}">${tweetDate}</a>
      </blockquote>
      <script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>
    `;
    
    const liveContent = `${geminiResult.summary}`;

    // --- Step 4: Save to Database (Updated) ---
    const newArticle = new Article({
      title: geminiResult.title, // Telugu
      slug: geminiResult.slug, // English
      summary: geminiResult.summary, // Telugu
      content: geminiResult.summary ? geminiResult.summary : `<p>${tweet.text}</p>`,
      liveContent: liveContent,
      isFullArticle: false,
      author: "Vijay",
      category: "news",
      featuredImage: tweet.extendedEntities?.media?.[0]?.media_url_https || null,
      featuredVideo: "",
      tags: geminiResult.tags, // English
      publishedDate: new Date(),
      status: "draft",
      tweetId: tweet.id,
      tweetUrl: tweet.url,
      twitterEmbed: twitterEmbed,
      
      // --- NEW TELUGU FIELDS ADDED ---
      slug_te: geminiResult.slug_te,
      tags_te: geminiResult.tags_te,
    });

    const savedArticle = await newArticle.save();
    return { success: true, data: savedArticle };

  } catch (error) {
    console.error(`Failed to process tweet ID ${tweetId}:`, error.message);
    if (error.code === 11000) {
      console.warn(`Article with this tweetId or slug already exists: ${tweetId}`);
    }
    return { success: false, id: tweetId, reason: error.message };
  }
}

// --- 9. API ENDPOINTS ---

// ** POST ENDPOINT (from req.body) **
app.post('/api/fetch-tweet-and-save', async (req, res) => {
  console.log('Received POST for /api/fetch-tweet-and-save');
  
  const { tweet_ids } = req.body;

  if (!tweet_ids || !Array.isArray(tweet_ids) || tweet_ids.length === 0) {
    return res.status(400).json({ error: "tweet_ids must be a non-empty array." });
  }

  const successfulPosts = [];
  const failedIds = [];

  for (const tweetId of tweet_ids) {
    const result = await processTweetId(tweetId);
    if (result.success) {
      successfulPosts.push(result.data);
    } else {
      failedIds.push({ id: result.id, reason: result.reason });
    }
  }

  res.json({
    message: `Processed ${successfulPosts.length} of ${tweet_ids.length} tweets.`,
    successfulPosts: successfulPosts,
    failedIds: failedIds,
  });
});

// ** GET ENDPOINT (from req.query) **
app.get('/api/fetch-tweet-and-save', async (req, res) => {
  console.log('Received GET for /api/fetch-tweet-and-save');
  
  const { tweet_ids } = req.query;

  if (!tweet_ids) {
    return res.status(400).json({ error: "tweet_ids query parameter is required." });
  }

  const idsToProcess = tweet_ids.split(',')
                                .map(id => id.trim())
                                .filter(id => id.length > 0);

  if (idsToProcess.length === 0) {
    return res.status(400).json({ error: "No valid tweet_ids provided." });
  }

  const successfulPosts = [];
  const failedIds = [];

  for (const tweetId of idsToProcess) {
    const result = await processTweetId(tweetId);
    if (result.success) {
      successfulPosts.push(result.data);
    } else {
      failedIds.push({ id: result.id, reason: result.reason });
    }
  }

  res.json({
    message: `Processed ${successfulPosts.length} of ${idsToProcess.length} tweets.`,
    successfulPosts: successfulPosts,
    failedIds: failedIds,
  });
});

// ** UPDATED GET ENDPOINT (for user's last tweets with caching by USERNAME) **
app.get('/api/fetch-user-last-tweets', async (req, res) => {
  console.log("Received GET for /api/fetch-user-last-tweets");
  
  const { userName } = req.query;
  
  if (!userName) {
    return res.status(400).json({ error: "username query parameter is required." });
  }
  
  const TWITTER_USER_API_URL = "https://api.twitterapi.io/twitter/user/last_tweets";
  
  try {
    // --- Step 1: Fetch user's last tweets ---
    const response = await fetch(`${TWITTER_USER_API_URL}?userName=${userName}`, {
      headers: {
        "X-API-Key": TWITTER_API_IO_KEY
      }
    });

    if (!response.ok) {
      throw new Error(`Twitter User API request failed with status ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.status !== "success" || !data.tweets) {
      console.warn(`Could not fetch tweets for username: ${userName}`);
      throw new Error("Not found or Twitter API error");
    }

    // --- Step 2: Filter tweets against cache (This logic remains the same) ---
    const tweetsToProcess = [];
    const skippedCachedIds = [];
    const now = Date.now();

    for (const tweet of data.tweets) {
      const tweetId = tweet.id;
      const cacheEntry = processedTweetCache.get(tweetId);

      if (cacheEntry && (now - cacheEntry < CACHE_DURATION_MS)) {
        skippedCachedIds.push(tweetId);
      } else {
        tweetsToProcess.push(tweet);
      }
    }
    
    // --- Step 3: Process the filtered tweets (This logic remains the same) ---
    const successfulPosts = [];
    const failedIds = [];

    for (const tweet of tweetsToProcess) {
      const tweetId = tweet.id;
      const result = await processTweetId(tweetId); 
      
      if (result.success) {
        successfulPosts.push(result.data);
      } else {
        failedIds.push({ id: result.id, reason: result.reason });
      }
      
      processedTweetCache.set(tweetId, now);
    }
    
    // --- Step 4: Send response (This logic remains the same) ---
    res.json({
      message: `Fetched ${data.tweets.length} tweets. Processed ${successfulPosts.length}, failed ${failedIds.length}, skipped ${skippedCachedIds.length} (cached).`,
      successfulPosts: successfulPosts,
      failedIds: failedIds,
      skippedCachedIds: skippedCachedIds
    });

  } catch (error) {
    console.error(`Failed to process user ${userName} tweets:`, error.message);
    res.status(500).json({ 
      error: "Failed to process user's last tweets",
      details: error.message 
    });
  }
});


// --- 10. START THE SERVER ---
app.listen(PORT, () => {
  console.log(`✅ Server with Twitter & DB running at http://localhost:${PORT}`);
});