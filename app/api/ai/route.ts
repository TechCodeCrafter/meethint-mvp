import { callLLM, parseJson } from "@/lib/llm";
import type { ProviderId } from "@/lib/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Snippet = { n: number; path: string; loc?: string; start: number; end: number; code: string };

const ANSWER_SYS = `You are a senior engineer answering a colleague's question live in a meeting, using ONLY the provided sources (code and documents from their project).
Rules:
- Every statement must be grounded in the sources. If they don't contain the answer, say so plainly in one sentence and name what to check next.
- Answer first, directly: 1-3 sentences, plain language a PM or director can follow, but precise (function names, files, values, conditions).
- Cite sources inline with [n] markers matching source numbers.
- Key points: 2-5 short bullets with concrete facts (values, limits, conditions, flow steps, file names), each ending with [n].
- Ignore sources that are irrelevant (third-party library code, unrelated files) and don't cite them.
Return ONLY JSON: {"answer": string, "keyPoints": string[], "cited": number[], "confidence": "High"|"Medium"|"Low"}`;

const EXPAND_SYS = `You help search a codebase / document set. Given a question and a list of file paths in the project, return search terms that would appear in the relevant code or docs (identifiers in camelCase/snake_case, function or table names, config keys, domain words, synonyms), and the paths most likely to contain the answer.
Return ONLY JSON: {"terms": string[] (8-20 items), "paths": string[] (0-8 items, copied exactly from the list)}`;

const DETECT_SYS = `You listen to a live meeting transcript. Find questions someone asked in the LATEST segment that could be answered from the team's codebase or project documents (how something works, where something lives, current values/limits/configs, behaviour, architecture, status of a feature, what a document says).
- Rewrite each as a clear standalone question using context from earlier transcript (resolve "it", "that endpoint" etc).
- Skip small talk, scheduling, opinions, and questions already in the "already detected" list.
- Transcripts may be cut mid-sentence; only include a question if it's reasonably complete.
Return ONLY JSON: {"questions": string[]} (usually 0 or 1 items).`;

function sourcesBlock(snippets: Snippet[]) {
  let budget = 60000;
  return snippets
    .slice(0, 12)
    .map((s) => {
      const code = s.code.slice(0, Math.max(0, Math.min(9000, budget)));
      budget -= code.length;
      if (!code) return "";
      return `[${s.n}] ${s.path}${s.loc ? ` (${s.loc})` : ""} lines ${s.start}-${s.end}\n\`\`\`\n${code
        .split("\n")
        .map((l, i) => `${s.start + i}: ${l}`)
        .join("\n")}\n\`\`\``;
    })
    .filter(Boolean)
    .join("\n\n");
}

export async function POST(req: Request) {
  try {
    const b = await req.json();
    const common = { provider: (b.provider || "openai") as ProviderId, model: b.model, apiKey: b.apiKey };
    if (b.task === "expand") {
      const paths: string = (b.paths || []).join("\n").slice(0, 14000);
      const { text } = await callLLM({ ...common, system: EXPAND_SYS, user: `Question: ${b.question}\n\nFile paths:\n${paths}`, maxTokens: 400 });
      const j = parseJson(text);
      return Response.json({ terms: (j.terms || []).map(String).slice(0, 24), paths: (j.paths || []).map(String).slice(0, 8) });
    }
    if (b.task === "detect") {
      const { text } = await callLLM({
        ...common,
        system: DETECT_SYS,
        user: `Earlier transcript:\n${String(b.earlier || "").slice(-3000)}\n\nLATEST segment:\n${String(b.latest || "").slice(0, 2000)}\n\nAlready detected:\n${(b.already || []).join("\n")}`,
        maxTokens: 300,
      });
      const j = parseJson(text);
      return Response.json({ questions: (j.questions || []).map(String).filter((q: string) => q.length > 8).slice(0, 3) });
    }
    // answer
    if (!b.question || !Array.isArray(b.snippets) || !b.snippets.length) return Response.json({ error: "Missing question or sources" }, { status: 400 });
    const ctx = b.context ? `Recent meeting transcript (context only):\n${String(b.context).slice(-2500)}\n\n` : "";
    const { text, model } = await callLLM({
      ...common,
      system: ANSWER_SYS,
      user: `${ctx}Question: ${String(b.question).slice(0, 2000)}\n\nSources:\n\n${sourcesBlock(b.snippets)}`,
      maxTokens: 1000,
    });
    const out = parseJson(text);
    return Response.json({
      answer: String(out.answer || ""),
      keyPoints: Array.isArray(out.keyPoints) ? out.keyPoints.map(String).slice(0, 6) : [],
      cited: Array.isArray(out.cited) ? out.cited.map(Number).filter(Number.isFinite) : [],
      confidence: ["High", "Medium", "Low"].includes(out.confidence) ? out.confidence : "Medium",
      model,
    });
  } catch (e: any) {
    return Response.json({ error: e?.message || "AI request failed" }, { status: 502 });
  }
}
