// Speech-to-text. Called from the browser with the user's own key (direct to the provider),
// or from the self-host relay route with an env key.
export const STT = {
  openai: { label: "OpenAI", host: "api.openai.com", url: "https://api.openai.com/v1/audio/transcriptions", model: "gpt-4o-mini-transcribe", env: "OPENAI_API_KEY" },
  groq: { label: "Groq", host: "api.groq.com", url: "https://api.groq.com/openai/v1/audio/transcriptions", model: "whisper-large-v3-turbo", env: "GROQ_API_KEY" },
} as const;
export type SttProvider = keyof typeof STT;

export async function transcribe(opts: { provider: SttProvider; key: string; file: Blob; language?: string }): Promise<string> {
  const s = STT[opts.provider] || STT.openai;
  const out = new FormData();
  const ext = /mp4/.test(opts.file.type) ? "mp4" : /ogg/.test(opts.file.type) ? "ogg" : "webm";
  out.append("file", opts.file, `segment.${ext}`);
  out.append("model", s.model);
  out.append("response_format", "json");
  if (opts.language) out.append("language", opts.language);
  const send = () => fetch(s.url, { method: "POST", headers: { authorization: `Bearer ${opts.key}` }, body: out });
  try {
    let r = await send();
    let j: any = await r.json().catch(() => ({}));
    if (!r.ok && opts.provider === "openai" && /model/i.test(j?.error?.message || "")) {
      out.set("model", "whisper-1");
      r = await send();
      j = await r.json().catch(() => ({}));
    }
    if (!r.ok) throw new Error(j?.error?.message || `Transcription error ${r.status}`);
    return String(j.text || "");
  } catch (e: any) {
    if (e?.name === "TypeError") throw new Error(`Couldn't reach ${s.label} for transcription. Check the key and your connection.`);
    throw e;
  }
}
