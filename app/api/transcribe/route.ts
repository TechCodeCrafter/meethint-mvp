export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STT = {
  openai: { url: "https://api.openai.com/v1/audio/transcriptions", model: "gpt-4o-mini-transcribe", env: "OPENAI_API_KEY" },
  groq: { url: "https://api.groq.com/openai/v1/audio/transcriptions", model: "whisper-large-v3-turbo", env: "GROQ_API_KEY" },
} as const;

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const provider = (String(form.get("provider") || "openai") as keyof typeof STT);
    const s = STT[provider] || STT.openai;
    const key = String(form.get("apiKey") || "").trim() || process.env[s.env];
    if (!key) return Response.json({ error: "No transcription key. Add an OpenAI or Groq key in AI settings." }, { status: 400 });
    const file = form.get("file") as File | null;
    if (!file) return Response.json({ error: "No audio" }, { status: 400 });
    const out = new FormData();
    const ext = /mp4/.test(file.type) ? "mp4" : /ogg/.test(file.type) ? "ogg" : "webm";
    out.append("file", file, `segment.${ext}`);
    out.append("model", s.model);
    out.append("response_format", "json");
    const prompt = String(form.get("prompt") || "");
    if (prompt) out.append("prompt", prompt.slice(0, 800));
    const lang = String(form.get("language") || "");
    if (lang) out.append("language", lang);
    let r = await fetch(s.url, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: out });
    let j = await r.json();
    if (!r.ok && provider === "openai" && /model/i.test(j?.error?.message || "")) {
      out.set("model", "whisper-1");
      r = await fetch(s.url, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: out });
      j = await r.json();
    }
    if (!r.ok) return Response.json({ error: j?.error?.message || `Transcription error ${r.status}` }, { status: 502 });
    return Response.json({ text: String(j.text || "") });
  } catch (e: any) {
    return Response.json({ error: e?.message || "Transcription failed" }, { status: 502 });
  }
}
