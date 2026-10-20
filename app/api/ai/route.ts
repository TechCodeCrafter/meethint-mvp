import { runTask, TaskError } from "@/lib/ai-core";
import { PROVIDERS, type ProviderId } from "@/lib/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Self-host relay: only uses keys configured in this server's environment.
// User-supplied keys are never accepted here — they go browser → provider directly.
export async function POST(req: Request) {
  try {
    const b = await req.json();
    if (b.apiKey) return Response.json({ error: "This server does not accept API keys. Keys are used directly from your browser." }, { status: 400 });
    const p = PROVIDERS[(b.provider || "openai") as ProviderId];
    if (!p) return Response.json({ error: "Unknown provider" }, { status: 400 });
    const key = process.env[p.env];
    if (!key) return Response.json({ error: `No ${p.label} key configured on this server.` }, { status: 400 });
    return Response.json(await runTask(b, { key }));
  } catch (e: any) {
    return Response.json({ error: e?.message || "AI request failed" }, { status: e instanceof TaskError ? e.status : 502 });
  }
}
