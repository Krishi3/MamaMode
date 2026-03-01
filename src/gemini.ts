// src/gemini.ts
import { SYSTEM_STYLE, buildUserContext } from "./prompts.js";

const MODEL = "models/gemini-2.5-flash"; // ✅ confirmed in your /debug-models output

export async function listGeminiModels(apiKey: string) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models?key=" +
    encodeURIComponent(apiKey);

  const res = await fetch(url);
  const json = await res.json();

  return (json.models || []).map((m: any) => ({
    name: m.name,
    methods: m.supportedGenerationMethods
  }));
}

async function geminiGenerate(apiKey: string, prompt: string) {
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

  const url =
    `https://generativelanguage.googleapis.com/v1beta/${MODEL}:generateContent?key=` +
    encodeURIComponent(apiKey);

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    // ✅ shorter for voice so Twilio calls don't feel long / cut off
    generationConfig: { temperature: 0.6, maxOutputTokens: 260 }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini error ${res.status}: ${t}`);
  }

  const json = await res.json();
  const text: string =
    json?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "";

  return String(text).trim();
}

/**
 * MamaMode reply: always supportive + practical (no triage modes).
 * Crisis/escalation is handled outside (index.ts) via isCrisis().
 */
export async function replyWithGemini(opts: {
  apiKey: string;
  userText: string;
  memory: any | null;
  resourcesText?: string; // optional local resources from Snowflake
}) {
  const ctx = buildUserContext(opts.memory);
  const resources = opts.resourcesText
    ? `\n(Optional local resources the user asked for):\n${opts.resourcesText}\n`
    : "";

  const prompt = `
${SYSTEM_STYLE}

Context:
${ctx}

Instructions (MamaMode voice):
- Be warm, reassuring, and practical — like a supportive mom.
- Give comfort/validation first (1 short sentence).
- Then give next steps (at most 2 bullets, very short).
- Keep it short for voice: 2–4 short sentences total, under ~35 words.
- Ask at most ONE gentle follow-up question if needed.
- Do NOT mention hotlines/emergency services unless the user explicitly asks for urgent/crisis help.
- If (AND ONLY IF) the user asks for resources near them, include 1–3 from the resources section (if present).

${resources}

User message:
"""${opts.userText}"""

Write MamaMode's reply (voice-friendly, short):
`;

  return await geminiGenerate(opts.apiKey, prompt);
}