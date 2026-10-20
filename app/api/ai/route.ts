import { callLLM, parseJson } from "@/lib/llm";
import type { ProviderId } from "@/lib/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Snippet = { n: number; path: string; loc?: string; start: number; end: number; code: string };

const ANSWER_SYS = `You are a senior engineer answering a colleague's question live in a meeting, using ONLY the provided sources (code and documents from their project). The answer is read aloud-in-a-glance, so it must be SHORT.
Rules:
- Ground every statement in the sources. If they don't contain the answer, say so in one sentence and name the file/area to check.
- "answer": 1-2 sentences, max 45 words. Lead with the direct answer. Plain language, but precise (names, values, conditions).
- Wrap file paths, function names, config keys and values in backticks, e.g. \`api/routers/chat.py\`. Use short paths (drop leading folders that don't add meaning).
- Cite with bare numeric markers like [1] or [2][3] right after the claim. NEVER write "[Sources: ...]", "[See sources below]", "[Files: ...]", or file names inside square brackets.
- "keyPoints": 0-3 bullets, each max 18 words, concrete facts only, each ending with [n]. Don't repeat the answer.
- Ignore irrelevant sources (third-party/library code, unrelated files) and don't cite them.
Return ONLY JSON: {"answer": string, "keyPoints": string[], "cited": number[], "confidence": "High"|"Medium"|"Low"}`;

const EXPAND_SYS = `You help search a codebase / document set. Given a question and a list of file paths in the project, return search terms that would appear in the relevant code or docs (identifiers in camelCase/snake_case, function or table names, config keys, domain words, synonyms), and the paths most likely to contain the answer.
Return ONLY JSON: {"terms": string[] (8-20 items), "paths": string[] (0-8 items, copied exactly from the list)}`;

const DETECT_SYS = `You listen to a live meeting transcript. Find questions someone asked in the LATEST segment that could be answered from the team's codebase or project documents (how something works, where something lives, current values/limits/configs, behaviour, architecture, what a document says).
- Keep the speaker's own wording. Only fix transcription glitches and replace a vague "it"/"that" with the thing it refers to. Do NOT expand, elaborate, or add sub-questions.
- Each question must be max 20 words and end with "?".
- Skip small talk, scheduling, opinions, and questions already in the "already detected" list.
- Ignore garbled text, lists of words, or segments that are not natural speech.
- Only include a question if it's reasonably complete.
Return ONLY JSON: {"questions": string[]} (usually 0 or 1 items).`;

function cleanCites(t: string) {
  return t
    // [1, 2] -> [1][2]
    .replace(/\[(\d+(?:\s*,\s*\d+)+)\]/g, (_, g: string) => g.split(/\s*,\s*/).map((n) => `[${n}]`).join(""))
    // drop bracketed source lists / file names, e.g. [Sources: ...], [See sources below], [rule_generator.py, x.py]
    .replace(/\s*\[(?!\d+\])[^\[\]]*(?:source|see |files?:|refs?:|\.[a-z]{1,5}\b)[^\[\]]*\]/gi, "")
    .replace(/\s+([.,;])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

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
      return Response.json({ questions: (j.questions || []).map(String).map((q: string) => q.trim()).filter((q: string) => q.length > 8 && q.split(/\s+/).length <= 30).slice(0, 2) });
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
      answer: cleanCites(String(out.answer || "")),
      keyPoints: Array.isArray(out.keyPoints) ? out.keyPoints.map((k: unknown) => cleanCites(String(k))).filter(Boolean).slice(0, 3) : [],
      cited: Array.isArray(out.cited) ? out.cited.map(Number).filter(Number.isFinite) : [],
      confidence: ["High", "Medium", "Low"].includes(out.confidence) ? out.confidence : "Medium",
      model,
    });
  } catch (e: any) {
    return Response.json({ error: e?.message || "AI request failed" }, { status: 502 });
  }
}
