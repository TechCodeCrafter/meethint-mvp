// Fuzzy de-duplication for questions detected in a live transcript.
// normalize → content tokens (stemmed, stopwords dropped) → fuzzy token overlap → time window.

const STOP = new Set(
  ("a an the is are was were be been am do does did doing done can could would should will shall may might must " +
  "what whats how hows where wheres when why who whom which whose that this these those it its it's there here " +
  "i me my we us our you your they them their he she his her of in on at to for from by with about into over as " +
  "and or but if so then than just like actually really basically kind sort um uh hmm okay ok right yeah please " +
  "tell explain show know mean let quick question again also get got go going have has had any some")
    .split(/\s+/),
);

function stem(w: string) {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Lowercase, split camelCase/snake/kebab, strip punctuation. */
export function normalizeQuestion(q: string): string {
  return q
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[_\-./]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function questionTokens(q: string): string[] {
  return [...new Set(normalizeQuestion(q).split(" ").filter((w) => w && !STOP.has(w)).map(stem))];
}

function lev(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Tokens match if equal, or close for longer words (speech recognition mis-hears: "maestro" ≈ "mastra"). */
export function tokensMatch(a: string, b: string) {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 4) return false;
  if (n >= 5 && (a.startsWith(b) || b.startsWith(a))) return true;
  return lev(a, b, n >= 6 ? 2 : 1) <= (n >= 6 ? 2 : 1);
}

/** 0..1: max of Jaccard and containment (shorter question mostly inside the longer one). */
export function questionSimilarity(a: string, b: string): number {
  const A = questionTokens(a), B = questionTokens(b);
  if (!A.length || !B.length) return normalizeQuestion(a) === normalizeQuestion(b) ? 1 : 0;
  const used = new Set<number>();
  let inter = 0;
  for (const x of A) {
    const j = B.findIndex((y, k) => !used.has(k) && tokensMatch(x, y));
    if (j >= 0) { used.add(j); inter++; }
  }
  const jaccard = inter / (A.length + B.length - inter);
  const small = Math.min(A.length, B.length);
  // Containment only counts when the shorter question has some substance.
  const containment = small >= 2 ? inter / small : 0;
  return Math.max(jaccard, containment * 0.95);
}

export type Recent = { q: string; at: number };

/** Index of the recent question this one duplicates (within the window), or -1. */
export function findDuplicate(q: string, recent: Recent[], now = Date.now(), opts: { windowMs?: number; threshold?: number } = {}): number {
  const windowMs = opts.windowMs ?? 90_000;
  const threshold = opts.threshold ?? 0.6;
  let best = -1, bestScore = 0;
  recent.forEach((r, i) => {
    if (now - r.at > windowMs) return;
    const s = questionSimilarity(q, r.q);
    if (s >= threshold && s > bestScore) { best = i; bestScore = s; }
  });
  return best;
}
