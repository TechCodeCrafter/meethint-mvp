// Shared AI task logic. Runs in the browser (user key → provider directly) or on the
// server (self-hosted env key). No process.env access here.
import { callLLM, parseJson, partialAnswer } from "./llm";
import type { ProviderId } from "./providers";

export class TaskError extends Error {
  constructor(msg: string, public status = 400) { super(msg); }
}

export type Snippet = { n: number; path: string; loc?: string; start: number; end: number; code: string; also?: { line: number; text: string }[]; focus?: number[]; hop?: string };

const ANSWER_SYS = `You are a senior engineer answering a colleague's question live in a meeting, using ONLY the provided sources (code and documents from their project). The answer is read aloud-in-a-glance, so it must be SHORT.
Rules:
- Ground every statement in the sources. If they don't contain the answer, say so in one sentence and name the file/area to check.
- "answer": 1-2 sentences, max 45 words. Lead with the direct answer. Plain language, but precise (names, values, conditions).
- Wrap file paths, function names, config keys and values in backticks, e.g. \`api/routers/chat.py\`. Use short paths (drop leading folders that don't add meaning).
- Cite with bare numeric markers like [1] or [2][3] right after the claim. NEVER write "[Sources: ...]", "[See sources below]", "[Files: ...]", or file names inside square brackets.
- "keyPoints": 0-3 bullets, each max 18 words, concrete facts only, each ending with [n]. Don't repeat the answer.
- Ignore irrelevant sources (third-party/library code, unrelated files) and don't cite them.
Accuracy rules (most important):
- Different top-level folders / services / languages are usually DIFFERENT components (e.g. a TypeScript container vs a Python app, a new runtime vs an older/rollback one). Describe each component ONLY from its own files. Never say component A "runs", "uses" or "contains" B unless a source shows it (an import, a call, a config value, or a doc sentence saying so).
- If the question compares X and Y, answer for each side from the sources under that side's own folder, then state the relationship only if a source shows it (e.g. a router choosing between engines).
- If a setting/default appears more than once (see "Other lines in this file"), say which value applies where instead of giving one value.
- The question may come from speech recognition and mis-hear names; use the project's real names (see "Name corrections" and the folder map).
- If the sources don't cover one part of the question, say that part isn't in the sources rather than guessing.
Return ONLY JSON: {"answer": string, "keyPoints": string[], "cited": number[], "confidence": "High"|"Medium"|"Low"}`;

const EXPAND_SYS = `You help search a codebase / document set. Given a question and a list of file paths in the project, return search terms that would appear in the relevant code or docs (identifiers in camelCase/snake_case, function or table names, config keys, domain words, synonyms), and the paths most likely to contain the answer.
Return ONLY JSON: {"terms": string[] (8-20 items), "paths": string[] (0-8 items, copied exactly from the list)}`;

const DETECT_SYS = `You listen to a live meeting transcript. Find questions someone asked in the LATEST segment that could be answered from the team's codebase or project documents (how something works, where something lives, current values/limits/configs, behaviour, architecture, what a document says).
- Keep the speaker's own wording. Only fix transcription glitches (especially mis-heard project names: map them to the closest name from the project names list, e.g. "Maestro POC" -> "mastra-poc") and replace a vague "it"/"that" with the thing it refers to. Do NOT expand, elaborate, or add sub-questions.
- Each question must be max 20 words and end with "?".
- Skip small talk, scheduling, opinions, and questions already in the "already detected" list.
- Ignore garbled text, lists of words, or segments that are not natural speech.
- Only include a question if it's reasonably complete.
Return ONLY JSON: {"questions": string[]} (usually 0 or 1 items).`;

const TRACE_SYS = `You answer "how does this work / what calls what / which file drives it" questions about the user's repos, live in a meeting. You are given a STATIC TRACE computed from the code (hops: UI -> client -> API route -> service/runtime -> store/prompt) plus the source for each hop. Lines marked ▶ are the action lines found by the tracer.
Answer ONLY from the attached sources. Rules:
- Follow the trace one hop at a time: UI function, request it sends, API route, runtime, store. Stop where the code stops; if the trace says it stops, say so instead of guessing.
- Name the current entry function and the request it sends (method + path) in the first sentence.
- If an older/other endpoint still exists (listed under "Related routes that exist but NO request ... calls"), mention it in a SEPARATE sentence and say the current UI does not call it. If the frontend isn't loaded, say UI usage is unknown instead.
- The file that drives a feature is the prompt or caller that chooses the steps, NOT the CRUD/REST wrapper those steps use.
- Cite only lines that perform the action (calls, requests, route decorators, selection logic, prompt steps). Never cite imports, docstrings, comments, file headers, or UI state updates as proof of the request path. If the only evidence is a stale header/docstring, say the code doesn't show a live call.
- If more than one runtime/implementation exists, say which one the current call selects (and why, e.g. a default parameter) and what the other is for. Hand-offs through an ARN/URL are matched by name — say "selected via" rather than "calls".
- Wrap paths, functions, routes and values in backticks. Cite with bare [n] markers only.
Return ONLY JSON:
{"answer": "1-2 sentences (max 55 words): entry function + request, and where it lands",
 "path": [{"step": "UI"|"Client"|"API"|"Runtime"|"Service"|"Store"|"Prompt", "text": "max 22 words: what this hop does, with the action", "cite": n}],
 "other": "one sentence about the old endpoint and/or other runtime, or empty string",
 "openFirst": {"file": "path", "why": "max 14 words"},
 "cited": number[], "confidence": "High"|"Medium"|"Low"}`;

function fixText(f: unknown) {
  if (!Array.isArray(f) || !f.length) return "";
  return `\nName corrections (speech recognition likely mis-heard): ${f.map((x: any) => `"${x.from}" means "${x.to}"`).join(", ")}`;
}

export function cleanCites(t: string) {
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
      return `[${s.n}]${s.hop ? ` (hop: ${s.hop})` : ""} ${s.path}${s.loc ? ` (${s.loc})` : ""} lines ${s.start}-${s.end}\n\`\`\`\n${code
        .split("\n")
        .map((l, i) => `${s.focus?.includes(s.start + i) ? "▶" : " "}${s.start + i}: ${l}`)
        .join("\n")}\n\`\`\`${
        s.also?.length ? `\nOther lines in this file using the same names:\n${s.also.map((a) => `${a.line}: ${a.text}`).join("\n")}` : ""
      }`;
    })
    .filter(Boolean)
    .join("\n\n");
}


export type TaskOpts = { key: string; onText?: (partialAnswer: string) => void };

export async function runTask(b: any, opts: TaskOpts): Promise<any> {
    const common = { provider: (b.provider || "openai") as ProviderId, model: b.model, key: opts.key };
  if (b.task === "trace") {
    if (!b.question || !Array.isArray(b.snippets)) throw new TaskError("Missing question or sources", 400);
    const { text, model } = await callLLM({
      ...common,
      system: TRACE_SYS,
      user: `${b.layout ? `Project folder map (file counts):\n${String(b.layout).slice(0, 3000)}\n\n` : ""}Question: ${String(b.question).slice(0, 2000)}${fixText(b.fixes)}\n\n${String(b.trace || "").slice(0, 6000)}\n\nSources:\n\n${sourcesBlock(b.snippets)}`,
      maxTokens: 1400,
      onText: opts.onText && ((raw: string) => opts.onText!(cleanCites(partialAnswer(raw)))),
    });
    const out = parseJson(text);
    const n = b.snippets.length;
    const okN = (x: unknown) => (typeof x === "number" && x >= 1 && x <= n ? x : undefined);
    const path = Array.isArray(out.path)
      ? out.path.slice(0, 9).map((p: any) => ({ step: String(p.step || "").slice(0, 12), text: cleanCites(String(p.text || "")), cite: okN(Number(p.cite)) })).filter((p: any) => p.text)
      : [];
    return ({
      answer: cleanCites(String(out.answer || "")),
      keyPoints: [],
      path,
      other: cleanCites(String(out.other || "")),
      openFirst: out.openFirst && out.openFirst.file ? { file: String(out.openFirst.file).replace(/`/g, ""), why: String(out.openFirst.why || "") } : undefined,
      cited: Array.isArray(out.cited) ? out.cited.map(Number).filter((x: number) => okN(x)) : [],
      confidence: ["High", "Medium", "Low"].includes(out.confidence) ? out.confidence : "Medium",
      model,
    });
  }
  if (b.task === "expand") {
    const paths: string = (b.paths || []).join("\n").slice(0, 14000);
    const { text } = await callLLM({ ...common, system: EXPAND_SYS, user: `Question: ${b.question}${fixText(b.fixes)}\n\nFile paths:\n${paths}`, maxTokens: 400 });
    const j = parseJson(text);
    return ({ terms: (j.terms || []).map(String).slice(0, 24), paths: (j.paths || []).map(String).slice(0, 8) });
  }
  if (b.task === "detect") {
    const { text } = await callLLM({
      ...common,
      system: DETECT_SYS,
      user: `${b.vocab ? `Project names (folders/files):\n${String(b.vocab).slice(0, 3000)}\n\n` : ""}Earlier transcript:\n${String(b.earlier || "").slice(-3000)}\n\nLATEST segment:\n${String(b.latest || "").slice(0, 2000)}\n\nAlready detected:\n${(b.already || []).join("\n")}`,
      maxTokens: 300,
    });
    const j = parseJson(text);
    return ({ questions: (j.questions || []).map(String).map((q: string) => q.trim()).filter((q: string) => q.length > 8 && q.split(/\s+/).length <= 30).slice(0, 2) });
  }
  // answer
  if (!b.question || !Array.isArray(b.snippets) || !b.snippets.length) throw new TaskError("Missing question or sources", 400);
  const ctx = b.context ? `Recent meeting transcript (context only):\n${String(b.context).slice(-2500)}\n\n` : "";
  const { text, model } = await callLLM({
    ...common,
    system: ANSWER_SYS,
    user: `${ctx}${b.layout ? `Project folder map (file counts):\n${String(b.layout).slice(0, 4000)}\n\n` : ""}Question: ${String(b.question).slice(0, 2000)}${fixText(b.fixes)}\n\nSources:\n\n${sourcesBlock(b.snippets)}`,
    maxTokens: 1000,
    onText: opts.onText && ((raw: string) => opts.onText!(cleanCites(partialAnswer(raw)))),
  });
  const out = parseJson(text);
  return ({
    answer: cleanCites(String(out.answer || "")),
    keyPoints: Array.isArray(out.keyPoints) ? out.keyPoints.map((k: unknown) => cleanCites(String(k))).filter(Boolean).slice(0, 3) : [],
    cited: Array.isArray(out.cited) ? out.cited.map(Number).filter(Number.isFinite) : [],
    confidence: ["High", "Medium", "Low"].includes(out.confidence) ? out.confidence : "Medium",
    model,
  });
}
