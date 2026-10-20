// Lexical citation check: a cited sentence's concrete claims (backticked names, paths, values)
// must actually appear in the source it cites. Free, instant, runs before any LLM re-check.

export type CitedSource = { path: string; content: string };
export type Unverified = { n: number; terms: string[]; text: string };

/** Split into sentences that keep their trailing [n] markers. */
export function claimSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?](?:\s*\[\d+\])*)\s+(?=[A-Z`(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function claimTerms(sentence: string): string[] {
  const out: string[] = [];
  for (const m of sentence.matchAll(/`([^`]+)`/g)) {
    let t = m[1].trim().replace(/\(\)$/, "").replace(/^["']|["']$/g, "");
    if (t.length < 2) continue;
    out.push(t);
  }
  return [...new Set(out)];
}

function found(term: string, srcs: CitedSource[]): boolean {
  const lc = term.toLowerCase();
  for (const s of srcs) {
    const p = s.path.toLowerCase();
    // paths: "routers/chat.py" ⊂ "api/routers/chat.py", or the path's basename is named
    if (/[/.]/.test(term) && !/\s/.test(term) && (p.endsWith(lc) || p.includes(lc) || lc.endsWith(p.split("/").pop()!))) return true;
    if (s.content.includes(term)) return true;
    // "POST /stream" → method + path both present; "BRIDGE_PORT=8081" → each side present
    const parts = term.split(/[\s=:]+/).filter((x) => x.length > 1);
    if (parts.length > 1 && parts.every((x) => s.content.includes(x) || s.content.toLowerCase().includes(x.toLowerCase()))) return true;
    if (s.content.toLowerCase().includes(lc)) return true;
  }
  return false;
}

/**
 * For each sentence with [n] citations and backticked terms, check every term appears in at least
 * one of the sources that sentence cites. Sentences without concrete terms aren't judged.
 */
export function verifyCitations(texts: string[], source: (n: number) => CitedSource | undefined): Unverified[] {
  const out: Unverified[] = [];
  for (const text of texts) {
    for (const sent of claimSentences(text)) {
      const cites = [...sent.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
      if (!cites.length) continue;
      const terms = claimTerms(sent);
      if (!terms.length) continue;
      const srcs = cites.map(source).filter(Boolean) as CitedSource[];
      if (!srcs.length) { out.push({ n: cites[0], terms, text: sent }); continue; }
      const missing = terms.filter((t) => !found(t, srcs));
      if (missing.length) out.push({ n: cites[0], terms: missing, text: sent });
    }
  }
  return out;
}
