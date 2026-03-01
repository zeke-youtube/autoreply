import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { google } from "googleapis";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "data");
const REPLIED_PATH = path.join(DATA_DIR, "replied.json");
const TOKEN_PATH = path.join(DATA_DIR, "tokens.json");

const MIN_DELAY_SEC = 20;
const MAX_DELAY_SEC = 90;
const RUN_INTERVAL_MS = 60 * 1000;

const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/youtube.force-ssl",
];

dotenv.config();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function loadJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function isEmojiOnly(text) {
  const cleaned = normalizeText(text);
  if (!cleaned) return true;
  const noPunct = cleaned.replace(/[\p{P}\p{S}\p{Z}]/gu, "");
  if (noPunct.length > 0) return false;
  const emojiRegex = /\p{Extended_Pictographic}/u;
  return [...cleaned].some((ch) => emojiRegex.test(ch));
}

function hasLink(text) {
  return /(https?:\/\/|www\.|\.[a-z]{2,}\b)/i.test(text || "");
}

function looksSpam(text) {
  const t = normalizeText(text).toLowerCase();
  if (!t) return true;
  const spamSignals = [
    "subscribe", "sub4sub", "check my channel", "free", "giveaway",
    "telegram", "whatsapp", "dm me", "earn", "crypto", "forex",
  ];
  return spamSignals.some((s) => t.includes(s));
}

function hasQuestion(text) {
  return /\?/.test(text || "");
}

function loadRepliedSet() {
  const arr = loadJson(REPLIED_PATH, []);
  return new Set(Array.isArray(arr) ? arr : []);
}

function saveRepliedSet(set) {
  saveJson(REPLIED_PATH, Array.from(set));
}

// Rate limiting disabled by request.

async function getOAuthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error("Missing Google OAuth env vars.");
  }

  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );

  const tokens = loadJson(TOKEN_PATH, null);
  if (tokens) {
    oauth2Client.setCredentials(tokens);
    return oauth2Client;
  }

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: REQUIRED_SCOPES,
    prompt: "consent",
  });

  console.log("Authorize this app by visiting this url:");
  console.log(authUrl);
  console.log("\nAfter approving, paste the code here and press Enter:");

  const code = await new Promise((resolve) => {
    process.stdin.once("data", (data) => resolve(String(data).trim()));
  });

  const { tokens: newTokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(newTokens);
  saveJson(TOKEN_PATH, newTokens);
  console.log("Tokens saved to data/tokens.json");
  return oauth2Client;
}

async function getMyChannelId(youtube) {
  const res = await youtube.channels.list({
    part: ["id", "snippet"],
    mine: true,
  });
  const item = res.data.items?.[0];
  if (!item?.id) throw new Error("Could not determine your channel ID.");
  return item.id;
}

async function listTopLevelComments(youtube, myChannelId) {
  const res = await youtube.commentThreads.list({
    part: ["id", "snippet", "replies"],
    allThreadsRelatedToChannelId: myChannelId,
    maxResults: 50,
    order: "time",
  });
  return res.data.items || [];
}

function findMyReply(thread, myChannelId) {
  const replies = thread.replies?.comments || [];
  return replies.find((r) => r?.snippet?.authorChannelId?.value === myChannelId);
}

function shouldReplyToThread(thread, myChannelId, repliedSet) {
  const top = thread.snippet?.topLevelComment;
  const topId = top?.id;
  if (!topId) return { ok: false, reason: "missing top id" };
  if (repliedSet.has(topId)) return { ok: false, reason: "already replied" };

  const text = top?.snippet?.textOriginal || "";
  if (isEmojiOnly(text)) return { ok: false, reason: "emoji-only" };
  if (hasLink(text)) return { ok: false, reason: "link" };
  if (looksSpam(text)) return { ok: false, reason: "spam" };

  const myReply = findMyReply(thread, myChannelId);
  if (myReply) return { ok: false, reason: "has my reply" };

  const authorChannelId = top?.snippet?.authorChannelId?.value;
  if (authorChannelId && authorChannelId === myChannelId) {
    return { ok: false, reason: "my own top-level comment" };
  }

  return { ok: true, reason: "ok" };
}

async function generateReply(openai, commentText) {
  const prompt = [
    "You are a YouTuber replying to your own video comments.",
    "Write a short, casual reply (3-10 words).",
    "Tone: casual, slightly chaotic, internet-native.",
    "No formal language.",
    "Emojis optional.",
    "No questions unless the comment asks one.",
    "Never mention AI, bots, or automation.",
    `Comment: ${commentText}`,
  ].join("\n");

  const res = await openai.responses.create({
    model: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
    input: prompt,
  });

  const text = res.output_text?.trim() || "";
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 120);
}

async function postReply(youtube, parentId, text) {
  return youtube.comments.insert({
    part: ["snippet"],
    requestBody: {
      snippet: {
        parentId,
        textOriginal: text,
      },
    },
  });
}

async function runOnce(youtube, myChannelId, repliedSet, openai) {
  const threads = await listTopLevelComments(youtube, myChannelId);
  console.log(`Fetched ${threads.length} comment threads.`);

  for (const thread of threads) {
    const top = thread.snippet?.topLevelComment;
    const topId = top?.id;
    const text = top?.snippet?.textOriginal || "";

    const check = shouldReplyToThread(thread, myChannelId, repliedSet);
    if (!check.ok) {
      console.log(`Skip ${topId}: ${check.reason}`);
      continue;
    }

    const delaySec = randomInt(MIN_DELAY_SEC, MAX_DELAY_SEC);
    console.log(`Waiting ${delaySec}s before replying to ${topId}...`);
    await sleep(delaySec * 1000);

    const reply = await generateReply(openai, text);
    if (!reply || reply.length < 3) {
      console.log(`Skip ${topId}: reply too short`);
      continue;
    }

    await postReply(youtube, topId, reply);
    repliedSet.add(topId);
    saveRepliedSet(repliedSet);
    console.log(`Replied to ${topId}: ${reply}`);
  }
}

async function main() {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) throw new Error("Missing GROQ_API_KEY.");

  const auth = await getOAuthClient();
  const youtube = google.youtube({ version: "v3", auth });
  const myChannelId = await getMyChannelId(youtube);

  const repliedSet = loadRepliedSet();
  const openai = new OpenAI({
    apiKey: groqKey,
    baseURL: "https://api.groq.com/openai/v1",
  });

  while (true) {
    try {
      await runOnce(youtube, myChannelId, repliedSet, openai);
    } catch (err) {
      console.error("Run error:", err);
    }
    console.log("Sleeping 60s before next run...");
    await sleep(RUN_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
