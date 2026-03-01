// src/index.ts
import "dotenv/config";
import express from "express";
import twilio from "twilio";
import crypto from "crypto";

import { replyWithGemini, listGeminiModels } from "./gemini.js";
import { lookupResources } from "./snowflake.js";
import { elevenlabsTTS } from "./elevenlabs.js";
import { loadMemory } from "./memory.js";

const {
  PORT = "3000",
  BASE_URL = "",
  TWILIO_AUTH_TOKEN = "",
  GEMINI_API_KEY = "",
  ELEVENLABS_API_KEY = "",
  ELEVENLABS_VOICE_ID = "",
  MONGODB_URI = "",
  MONGODB_DB = "",
  SKIP_TWILIO_SIGNATURE = "true",

  SNOWFLAKE_ACCOUNT_URL = "",
  SNOWFLAKE_PAT = "",
  SNOWFLAKE_WAREHOUSE = "",
  SNOWFLAKE_DATABASE = "",
  SNOWFLAKE_SCHEMA = "",
  SNOWFLAKE_TABLE = "",
  SNOWFLAKE_ROLE = ""
} = process.env;

const app = express();

// Twilio sends x-www-form-urlencoded by default
app.use(express.urlencoded({ extended: false }));

/** ---------- Debug endpoints ---------- **/

app.get("/debug-models", async (_req, res) => {
  try {
    if (!GEMINI_API_KEY) return res.status(400).json({ error: "Missing GEMINI_API_KEY" });
    const models = await listGeminiModels(GEMINI_API_KEY);
    res.json(models);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get("/debug-env", (_req, res) => {
  res.json({
    SNOWFLAKE_ACCOUNT_URL,
    SNOWFLAKE_DATABASE,
    SNOWFLAKE_SCHEMA,
    SNOWFLAKE_TABLE,
    SNOWFLAKE_WAREHOUSE,
    SNOWFLAKE_ROLE,
    PAT_LEN: SNOWFLAKE_PAT ? SNOWFLAKE_PAT.length : 0,
    BASE_URL_SET: Boolean(BASE_URL),
    SKIP_TWILIO_SIGNATURE
  });
});

/** ---------- Helpers ---------- **/

const audioCache = new Map<string, { buf: Buffer; expiresAt: number }>();
const AUDIO_TTL_MS = 5 * 60 * 1000; // 5 minutes

function baseUrlNoSlash() {
  return (BASE_URL || "").replace(/\/$/, "");
}

function extractCity(text: string): string | null {
  const s = text.toLowerCase();
  if (s.includes("toronto")) return "Toronto";
  if (s.includes("vancouver")) return "Vancouver";
  if (s.includes("montreal") || s.includes("montréal")) return "Montreal";
  if (s.includes("ottawa")) return "Ottawa";
  if (s.includes("calgary")) return "Calgary";
  if (s.includes("edmonton")) return "Edmonton";
  if (s.includes("waterloo")) return "Waterloo";
  if (s.includes("kitchener")) return "Kitchener";
  return null;
}

function validateTwilioRequest(req: express.Request): boolean {
  if (SKIP_TWILIO_SIGNATURE === "true") return true;
  if (!TWILIO_AUTH_TOKEN || !BASE_URL) return false;

  const signature = req.header("X-Twilio-Signature") || "";
  const url = baseUrlNoSlash() + req.originalUrl;

  return twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body);
}

function safeEscalationText() {
  return (
    "I’m here with you. If this feels urgent or you feel unsafe, please contact local urgent help right now (or a trusted person nearby). " +
    "If you tell me your city, I can share local postpartum support and 24/7 helplines."
  );
}

function isCrisis(text: string) {
  const s = text.toLowerCase();
  return (
    /suicide|kill myself|end my life|hurt myself|harm myself|self harm|hurt my baby|harm my baby|shake (the )?baby|abuse|overdose|i can't breathe|cant breathe|unconscious|bleeding heavily|chest pain|seizure/i.test(
      s
    )
  );
}

function isAskingForLocalHelp(text: string) {
  const s = text.toLowerCase();
  return /helpline|hotline|call someone|support group|therapist|counsellor|counselor|near me|in my area|local resources|postpartum support|ppd support/i.test(
    s
  );
}

async function snowflakeLookup(query: string, locationHint?: string) {
  return await lookupResources({
    accountUrl: SNOWFLAKE_ACCOUNT_URL,
    pat: SNOWFLAKE_PAT,
    warehouse: SNOWFLAKE_WAREHOUSE || undefined,
    role: SNOWFLAKE_ROLE || undefined,
    database: SNOWFLAKE_DATABASE,
    schema: SNOWFLAKE_SCHEMA,
    table: SNOWFLAKE_TABLE,
    query,
    locationHint
  });
}

async function maybeLoadMemory(phone: string) {
  if (!MONGODB_URI || !MONGODB_DB) return null;
  return await loadMemory({ uri: MONGODB_URI, dbName: MONGODB_DB, phone });
}

function cacheAudio(id: string, buf: Buffer) {
  audioCache.set(id, { buf, expiresAt: Date.now() + AUDIO_TTL_MS });
}

function getCachedAudio(id: string): Buffer | null {
  const entry = audioCache.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    audioCache.delete(id);
    return null;
  }
  return entry.buf;
}

/** ---------- Local test endpoints ---------- **/

app.get("/test-snowflake", async (_req, res) => {
  try {
    const out = await snowflakeLookup("Toronto");
    res.type("text/plain").send(out || "No rows");
  } catch (e: any) {
    console.error("test-snowflake error:", e?.message || e);
    if (e?.stack) console.error(e.stack);
    res.status(500).type("text/plain").send(String(e?.message || e));
  }
});

app.post("/sms-test", async (req, res) => {
  try {
    const from = String(req.body.From || "+16478710296");
    const body = String(req.body.Body || "").trim();

    const memory = await maybeLoadMemory(from);
    const crisis = isCrisis(body);

    let resourcesText = "";
    if (crisis || isAskingForLocalHelp(body)) {
      const city = extractCity(body) || memory?.location || "";
      resourcesText = await snowflakeLookup(city || body, city || undefined);
    }

    const reply = crisis
      ? safeEscalationText()
      : await replyWithGemini({
          apiKey: GEMINI_API_KEY,
          userText: body,
          memory,
          resourcesText
        });

    res.json({ crisis, reply, resourcesText });
  } catch (e: any) {
    console.error("sms-test error:", e?.message || e);
    res.status(500).json({ error: e?.message || "unknown error" });
  }
});

/** ---------- SMS webhook ---------- **/

app.post("/sms", async (req, res) => {
  try {
    if (!validateTwilioRequest(req)) {
      res.status(403).send("Invalid Twilio signature");
      return;
    }

    const from = String(req.body.From || "");
    const body = String(req.body.Body || "").trim();

    const memory = await maybeLoadMemory(from);
    const crisis = isCrisis(body);

    let resourcesText = "";
    if (crisis || isAskingForLocalHelp(body)) {
      const city = extractCity(body) || memory?.location || "";
      resourcesText = await snowflakeLookup(city || body, city || undefined);
    }

    const reply = crisis
      ? safeEscalationText()
      : await replyWithGemini({
          apiKey: GEMINI_API_KEY,
          userText: body,
          memory,
          resourcesText
        });

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);

    res.type("text/xml").send(twiml.toString());
  } catch (e: any) {
    console.error("SMS handler error:", e?.message || e);
    if (e?.stack) console.error(e.stack);

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Hey love — I’m having a tiny glitch. Can you try that again?");
    res.type("text/xml").send(twiml.toString());
  }
});

/** ---------- Voice webhooks ---------- **/

app.post("/voice", async (req, res) => {
  try {
    if (!validateTwilioRequest(req)) {
      res.status(403).send("Invalid Twilio signature");
      return;
    }

    const base = baseUrlNoSlash();
    const vr = new twilio.twiml.VoiceResponse();

    vr.say(
      { voice: "alice" },
      "Hi! I’m MamaMode, your personal assistant here to support you through the ups and downs of new motherhood. What can I help you with today?"
    );

    vr.gather({
      input: ["speech"],
      speechTimeout: "auto",
      action: `${base}/voice/intent`,
      method: "POST",
      timeout: 6,
      actionOnEmptyResult: true
    });

    vr.say({ voice: "alice" }, "I didn't catch that. You can say it again.");
    vr.redirect({ method: "POST" }, `${base}/voice`);

    res.type("text/xml").send(vr.toString());
  } catch (e: any) {
    console.error("VOICE handler error:", e?.message || e);
    const vr = new twilio.twiml.VoiceResponse();
    vr.say({ voice: "alice" }, "Sorry — I’m having trouble right now.");
    res.type("text/xml").send(vr.toString());
  }
});

app.post("/voice/intent", async (req, res) => {
  try {
    if (!validateTwilioRequest(req)) {
      res.status(403).send("Invalid Twilio signature");
      return;
    }

    const from = String(req.body.From || "");
    const speech = String(req.body.SpeechResult || "").trim();

if (!speech) {
  const vr = new twilio.twiml.VoiceResponse();
  const base = baseUrlNoSlash();

  vr.say({ voice: "alice" }, "It’s okay, love — I didn’t catch that. Say it one more time.");
  vr.gather({
    input: ["speech"],
    action: `${base}/voice/intent`,
    method: "POST",
    timeout: 10,
    speechTimeout: 2,
    actionOnEmptyResult: true,
    bargeIn: true
  });

  // If still nothing, then restart the call flow:
  vr.redirect({ method: "POST" }, `${base}/voice`);

  res.type("text/xml").send(vr.toString());
  return;
}

    const memory = await maybeLoadMemory(from);

    const crisis = isCrisis(speech);

    let resourcesText = "";
    if (crisis || isAskingForLocalHelp(speech)) {
      const city = extractCity(speech) || memory?.location || "";
      resourcesText = await snowflakeLookup(city || speech, city || undefined);
    }

    const textReply = crisis
      ? safeEscalationText()
      : await replyWithGemini({
          apiKey: GEMINI_API_KEY,
          userText: speech,
          memory,
          resourcesText
        });

    const id = crypto.randomUUID();

    if (ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID) {
      try {
        const audio = await elevenlabsTTS({
          apiKey: ELEVENLABS_API_KEY,
          voiceId: ELEVENLABS_VOICE_ID,
          text: textReply
        });
        cacheAudio(id, audio);
      } catch (e: any) {
        console.error("ElevenLabs TTS error:", e?.message || e);
      }
    }

    const vr = new twilio.twiml.VoiceResponse();
    const base = baseUrlNoSlash();

    if (BASE_URL && getCachedAudio(id)) {
      vr.play({}, `${base}/tts/${id}`);
    } else {
      vr.say({ voice: "alice" }, textReply);
    }

vr.gather({
  input: ["speech"],
  action: `${base}/voice/intent`,
  method: "POST",
  timeout: 10,
  speechTimeout: 2,
  actionOnEmptyResult: true,
  bargeIn: true
});

    res.type("text/xml").send(vr.toString());
  } catch (e: any) {
    console.error("VOICE intent error:", e?.message || e);
    const vr = new twilio.twiml.VoiceResponse();
    vr.say({ voice: "alice" }, "I’m here. I had a small glitch. Can you say that again?");
    res.type("text/xml").send(vr.toString());
  }
});

/** ---------- TTS serving ---------- **/

app.get("/tts/:id", (req, res) => {
  const id = String(req.params.id);
  const buf = getCachedAudio(id);
  if (!buf) {
    res.status(404).send("Not found");
    return;
  }
  res.setHeader("content-type", "audio/mpeg");
  // ✅ helps some hosts/Twilio behave nicely with streaming
  res.setHeader("content-length", String(buf.length));
  res.send(buf);
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(Number(PORT), () => {
  console.log(`MamaMode server running on :${PORT}`);
});