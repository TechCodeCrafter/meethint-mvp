import { STT, transcribe, type SttProvider } from "@/lib/stt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Self-host relay: env keys only. User keys are used browser → provider directly.
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    if (form.get("apiKey")) return Response.json({ error: "This server does not accept API keys. Keys are used directly from your browser." }, { status: 400 });
    const provider = String(form.get("provider") || "openai") as SttProvider;
    const s = STT[provider] || STT.openai;
    const key = process.env[s.env];
    if (!key) return Response.json({ error: `No ${s.label} transcription key configured on this server.` }, { status: 400 });
    const file = form.get("file") as File | null;
    if (!file) return Response.json({ error: "No audio" }, { status: 400 });
    const text = await transcribe({ provider, key, file, language: String(form.get("language") || "") || undefined });
    return Response.json({ text });
  } catch (e: any) {
    return Response.json({ error: e?.message || "Transcription failed" }, { status: 502 });
  }
}
