import { PROVIDERS, type ProviderId } from "@/lib/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Snippet = { n: number; path: string; start: number; end: number; code: string };

const SYSTEM = `You are a senior engineer answering a teammate's question live in a meeting, using ONLY the code snippets provided.
Rules:
- Base every statement on the snippets. If the snippets don't contain the answer, say so plainly and say what you'd check next.
- Be concise: 1-3 sentences for the answer, plain language a PM can follow, but precise (name functions, files, values).
- Cite snippets inline with [n] markers that refer to the snippet numbers.
- Key points: 2-5 short bullets with concrete facts (values, conditions, function names, files), each with a [n] citation.
Return ONLY JSON: {"answer": string, "keyPoints": string[], "cited": number[], "confidence": "High"|"Medium"|"Low"}`;

function buildPrompt(question: string, snippets: Snippet[]) {
  const body = snippets
    .map((s) => `[${s.n}] ${s.path} (lines ${s.start}-${s.end})\n\`\`\`\n${s.code.split("\n").map((l, i) => `${s.start + i}: ${l}`).join("\n")}\n\`\`\``)
    .join("\n\n");
  return `Question: ${question}\n\nCode snippets from the repository:\n\n${body}`;
}

function parseJson(text: string) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Model did not return JSON");
  return JSON.parse(m[0]);
}

export async function POST(req: Request) {
  try {
    const { question, snippets, provider = "openai", model, apiKey } = (await req.json()) as {
      question: string; snippets: Snippet[]; provider?: ProviderId; model?: string; apiKey?: string;
    };
    const p = PROVIDERS[provider];
    if (!p) return Response.json({ error: "Unknown provider" }, { status: 400 });
    const key = apiKey?.trim() || process.env[p.env];
    if (!key) return Response.json({ error: "No API key available for this provider." }, { status: 400 });
    if (!question || !Array.isArray(snippets) || !snippets.length)
      return Response.json({ error: "Missing question or snippets" }, { status: 400 });

    let budget = 48000;
    const trimmed = snippets.slice(0, 10).map((s) => {
      const code = s.code.slice(0, Math.max(0, Math.min(8000, budget)));
      budget -= code.length;
      return { ...s, code };
    }).filter((s) => s.code.length);
    const prompt = buildPrompt(String(question).slice(0, 2000), trimmed);
    const useModel = model?.trim() || p.model;
    let text = "";

    if (provider === "anthropic") {
      const r = await fetch(`${p.base}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: useModel, max_tokens: 900, system: SYSTEM, messages: [{ role: "user", content: prompt }] }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message || `Anthropic error ${r.status}`);
      text = (j.content || []).map((c: any) => c.text || "").join("");
    } else {
      const r = await fetch(`${p.base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: useModel,
          messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
          response_format: { type: "json_object" },
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message || `${p.label} error ${r.status}`);
      text = j.choices?.[0]?.message?.content || "";
    }
    const out = parseJson(text);
    return Response.json({
      answer: String(out.answer || ""),
      keyPoints: Array.isArray(out.keyPoints) ? out.keyPoints.map(String).slice(0, 6) : [],
      cited: Array.isArray(out.cited) ? out.cited.map(Number).filter(Number.isFinite) : [],
      confidence: ["High", "Medium", "Low"].includes(out.confidence) ? out.confidence : "Medium",
      model: `${p.label} · ${useModel}`,
    });
  } catch (e: any) {
    return Response.json({ error: e?.message || "AI request failed" }, { status: 502 });
  }
}
