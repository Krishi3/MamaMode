export async function elevenlabsTTS(opts: {
  apiKey: string;
  voiceId: string;
  text: string;
}) {
  if (!opts.apiKey || !opts.voiceId) {
    throw new Error("Missing ElevenLabs apiKey or voiceId");
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "xi-api-key": opts.apiKey,
      accept: "audio/mpeg"
    },
    body: JSON.stringify({
      text: opts.text,
      model_id: "eleven_turbo_v2_5",
      voice_settings: { stability: 0.45, similarity_boost: 0.85 }
    })
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`ElevenLabs error ${res.status}: ${t}`);
  }

  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}