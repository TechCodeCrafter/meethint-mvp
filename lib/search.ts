// Client-side code retrieval: chunking + BM25 with code-aware tokenization.

export type Origin = { owner: string; repo: string; sha: string };
export type CodeFile = { path: string; content: string; origin?: Origin; doc?: boolean; src?: string; key?: string };

export type Chunk = {
  id: number;
  key: string;
  path: string;
  start: number; // 1-based line
  end: number; // inclusive
  lines: string[];
  tf: Map<string, number>;
  len: number;
  pathTokens: Set<string>;
  /** Precomputed path flags (test file / prose doc). */
  isTest?: boolean;
  isDoc?: boolean;
};

export type Index = {
  files: CodeFile[];
  byKey: Map<string, CodeFile>;
  chunks: Chunk[];
  df: Map<string, number>;
  avgLen: number;
  lineCount: number;
  pathVocab: Set<string>;
  /** Inverted index: term → flat [chunkId, tf, inPath(0/1), ...] triples. Search only scores these. */
  postings: Map<string, number[]>;
  /** Per-chunk BM25 length normaliser k1·(1 − b + b·len/avgLen). */
  norm: Float64Array;
};

export type Hit = {
  key: string;
  path: string;
  src?: string;
  origin?: Origin;
  doc?: boolean;
  loc?: string;
  start: number;
  end: number;
  code: string;
  score: number;
  matched: string[];
  focus?: number[]; // trace mode: lines that perform the action
  hop?: string; // trace mode: ui | client | api | service | runtime | store | prompt
};

const STOP = new Set(
  (
    "a an the and or but if then else of to in on at by for with from into onto about as is are was were be been being do does did done doing " +
    "how what where which who whom why when whose this that these those it its we our us you your they their them he she i me my mine " +
    "can could should would will shall may might must have has had having not no yes so than too very just also there here " +
    "current currently use used using uses work works working handle handled handles happen happens get gets got set " +
    "tell show explain find look see know logic code project repo app thing things way exactly actually right now please " +
    "any all some each every much many lot like"
  ).split(" ")
);

const SYNONYMS: Record<string, string[]> = {
  store: ["save", "persist", "storage", "db", "database", "write", "localstorage", "repository", "model", "schema", "table"],
  stored: ["save", "persist", "storage", "db", "database"],
  save: ["store", "persist", "write", "update", "upsert"],
  preference: ["settings", "setting", "prefs", "pref", "config", "options"],
  setting: ["preference", "prefs", "config", "options"],
  retry: ["retries", "attempt", "attempts", "backoff", "retrying", "maxretries"],
  rate: ["ratelimit", "limiter", "throttle", "quota"],
  limit: ["limiter", "ratelimit", "max", "throttle", "quota"],
  payment: ["payments", "stripe", "charge", "billing", "invoice", "checkout", "pay"],
  auth: ["authentication", "authorize", "login", "token", "jwt", "session", "oauth"],
  login: ["auth", "signin", "session", "authenticate"],
  user: ["users", "account", "profile", "member"],
  endpoint: ["route", "routes", "handler", "api", "controller", "router"],
  route: ["endpoint", "handler", "router", "path"],
  error: ["exception", "catch", "throw", "fail", "failure", "err"],
  config: ["configuration", "env", "settings", "options"],
  email: ["mail", "smtp", "sendgrid", "mailer", "resend"],
  cache: ["redis", "memo", "memoize", "ttl", "lru"],
  queue: ["job", "jobs", "worker", "task", "bull", "enqueue"],
  delete: ["remove", "destroy", "drop"],
  create: ["insert", "add", "new"],
  test: ["spec", "tests", "expect"],
  timeout: ["timeouts", "deadline", "ms", "delay"],
  webhook: ["webhooks", "event", "callback", "signature"],
  notification: ["notify", "push", "alert", "email"],
  permission: ["role", "roles", "acl", "policy", "authorize", "scope"],
  log: ["logger", "logging", "console"],
  deploy: ["deployment", "ci", "workflow", "docker", "vercel"],
  env: ["environment", "process", "config", "dotenv"],
  upload: ["file", "files", "multipart", "s3", "blob", "storage"],
  search: ["query", "find", "filter", "index"],
  price: ["pricing", "plan", "amount", "cost"],
  subscription: ["subscribe", "plan", "billing", "recurring"],
};

function stem(w: string): string {
  if (w.length <= 4) return w;
  if (w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.endsWith("es") && /(ss|x|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) w = w.slice(0, -1);
  if (w.endsWith("ing") && w.length > 6) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 5) return w.slice(0, -2);
  if (w.endsWith("ation") && w.length > 8) return w.slice(0, -5);
  if (/[ts]ion$/.test(w) && w.length > 7) return w.slice(0, -3);
  if (/(ate|ize|ise)$/.test(w) && w.length > 6) return w.slice(0, -3);
  return w;
}

// Identifiers repeat constantly across a codebase; cache each word's tokens.
const WORD_CACHE: [Map<string, string[]>, Map<string, string[]>] = [new Map(), new Map()];
const EMPTY: string[] = [];

function wordTokens(word: string, keepStop: boolean): string[] {
  const cache = WORD_CACHE[keepStop ? 1 : 0];
  const hit = cache.get(word);
  if (hit) return hit;
  const whole = word.toLowerCase().replace(/\$/g, "");
  let out: string[] = EMPTY;
  if (whole) {
    out = [];
    const parts = /[A-Z_$]/.test(word)
      ? word
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
          .split(/[_\s$]+/)
          .map((p) => p.toLowerCase())
          .filter(Boolean)
      : [whole];
    if (parts.length > 1 && whole.length < 40) out.push(stem(whole.replace(/_/g, "")));
    for (const p of parts) {
      if (p.length < 2 && !/\d/.test(p)) continue;
      if (!keepStop && STOP.has(p)) continue;
      out.push(stem(p));
    }
  }
  if (cache.size > 400_000) cache.clear();
  cache.set(word, out);
  return out;
}

/** Split identifiers into parts: getUserPrefs -> get, user, prefs, getuserprefs */
export function tokenize(text: string, keepStop = false): string[] {
  const raw = text.match(/[A-Za-z_$][A-Za-z0-9_$]*|\d+/g);
  if (!raw) return [];
  const out: string[] = [];
  for (const word of raw) for (const t of wordTokens(word, keepStop)) out.push(t);
  return out;
}

export type QueryTerm = { term: string; weight: number; original: boolean };

export function expandQuery(q: string): QueryTerm[] {
  const base = tokenize(q);
  const terms = new Map<string, QueryTerm>();
  for (const t of base) terms.set(t, { term: t, weight: 1, original: true });
  // join adjacent words: "rate limit" -> ratelimit, "user preferences" -> userpreference
  const words = (q.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOP.has(w));
  for (let i = 0; i < words.length - 1; i++) {
    const j = stem(words[i] + words[i + 1]);
    if (!terms.has(j)) terms.set(j, { term: j, weight: 1.2, original: true });
  }
  for (const t of base) {
    const syns = SYNONYMS[t] || SYNONYMS[t + "s"] || [];
    for (const s of syns) {
      const st = stem(s);
      if (!terms.has(st)) terms.set(st, { term: st, weight: 0.4, original: false });
    }
  }
  return [...terms.values()];
}

const CHUNK = 40;
const STEP = 25;

const K1 = 1.3, B = 0.7;
function lengthNorms(chunks: Chunk[], avg: number) {
  const out = new Float64Array(chunks.length);
  for (let i = 0; i < chunks.length; i++) out[i] = K1 * (1 - B + (B * chunks[i].len) / avg);
  return out;
}

export function buildIndex(files: CodeFile[]): Index {
  const chunks: Chunk[] = [];
  const df = new Map<string, number>();
  let totalLen = 0;
  let lineCount = 0;
  let id = 0;
  const byKey = new Map<string, CodeFile>();
  const pathVocab = new Set<string>();
  const postings = new Map<string, number[]>();
  for (const f of files) {
    f.key = f.key || (f.src ? f.src + "::" : "") + f.path;
    byKey.set(f.key, f);
    const lines = f.content.split(/\r?\n/);
    lineCount += lines.length;
    const pathTokens = new Set(tokenize(f.path.replace(/\.[a-z0-9]+$/i, "")));
    const isTest = isTestPath(f.path), isDoc = isDocPath(f.path);
    for (const t of pathTokens) pathVocab.add(t);
    // Chunks overlap (40 lines, step 25): tokenize each line once and reuse.
    const lineToks = lines.map((l) => tokenize(l));
    for (let s = 0; s < lines.length; s += STEP) {
      const e = Math.min(lines.length, s + CHUNK);
      const slice = lines.slice(s, e);
      const tf = new Map<string, number>();
      let len = 0;
      for (let i = s; i < e; i++) {
        const lt = lineToks[i];
        len += lt.length;
        for (const t of lt) tf.set(t, (tf.get(t) || 0) + 1);
      }
      for (const t of pathTokens) tf.set(t, (tf.get(t) || 0) + 2);
      const cid = id++;
      for (const t of tf.keys()) {
        df.set(t, (df.get(t) || 0) + 1);
        const f = tf.get(t)!, ip = pathTokens.has(t) ? 1 : 0;
        const pl = postings.get(t);
        if (pl) pl.push(cid, f, ip); else postings.set(t, [cid, f, ip]);
      }
      chunks.push({ id: cid, key: f.key, path: f.path, start: s + 1, end: e, lines: slice, tf, len, pathTokens, isTest, isDoc });
      totalLen += len;
      if (e >= lines.length) break;
    }
  }
  return { files, byKey, chunks, df, avgLen: totalLen / Math.max(1, chunks.length), lineCount, pathVocab, postings, norm: lengthNorms(chunks, totalLen / Math.max(1, chunks.length)) };
}

function isTestPath(p: string) {
  return /(^|\/)(__tests__|tests?|test-d|testing|spec|e2e|fixtures?|mocks?|benchmarks?)(\/|$)|\.(test|spec)\.[a-z]+$/i.test(p);
}
function isDocPath(p: string) {
  return /\.(md|mdx|txt|rst)$/i.test(p);
}

function lev(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Spoken questions often mis-hear project names ("Maestro POC" for mastra-poc).
 * For query words that never appear in the project, find close project words (paths first).
 */
const VOCAB_BUCKETS = new WeakMap<Index, { path: Map<string, string[]>; all: Map<string, string[]> }>();
/** Vocabulary bucketed by first letter (candidates must share it), built once per index. */
function vocabBuckets(index: Index) {
  let v = VOCAB_BUCKETS.get(index);
  if (v) return v;
  const bucket = (words: Iterable<string>) => {
    const m = new Map<string, string[]>();
    for (const w of words) {
      if (w.length < 4) continue;
      const a = m.get(w[0]);
      if (a) a.push(w); else m.set(w[0], [w]);
    }
    return m;
  };
  v = { path: bucket(index.pathVocab), all: bucket(index.df.keys()) };
  VOCAB_BUCKETS.set(index, v);
  return v;
}
const CORRECT_CACHE = new WeakMap<Index, Map<string, { from: string; to: string }[]>>();
/** Max unknown words per question we try to correct (each is a vocabulary scan). */
const MAX_UNKNOWN = 3;

export function correctTerms(index: Index, question: string): { from: string; to: string }[] {
  let memo = CORRECT_CACHE.get(index);
  if (!memo) CORRECT_CACHE.set(index, (memo = new Map()));
  const cached = memo.get(question);
  if (cached) return cached;
  const out: { from: string; to: string }[] = [];
  const buckets = vocabBuckets(index);
  let unknown = 0;
  const words = [...new Set((question.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || []).filter((w) => !STOP.has(w)))];
  for (const w of words) {
    const t = stem(w);
    if ((index.df.get(t) || 0) > 0 || (index.df.get(w) || 0) > 0) continue;
    if (++unknown > MAX_UNKNOWN) break;
    const max = w.length >= 6 ? 2 : 1;
    let best: string | null = null,
      bestD = max + 1,
      bestDf = 0;
    const tryPool = (pool: Iterable<string>, bonus: number) => {
      for (const v of pool) {
        if (Math.abs(v.length - w.length) > max) continue;
        const raw = lev(w, v, max);
        if (raw > max) continue;
        const d = raw - bonus;
        const df = index.df.get(v) || 0;
        if (d < bestD || (d === bestD && df > bestDf)) { best = v; bestD = d; bestDf = df; }
      }
    };
    tryPool(buckets.path.get(w[0]) || [], 0.5); // folder / file names are the most likely target
    if (!best) tryPool(buckets.all.get(w[0]) || [], 0);
    if (best && best !== t) out.push({ from: w, to: best });
  }
  if (memo.size > 200) memo.clear();
  memo.set(question, out);
  return out;
}

const COMPARE = /\s+(?:vs\.?|versus|compared (?:to|with)|as opposed to)\s+/i;

/** Merge hits from the same file that overlap or sit close together into one source. */
export function mergeAdjacent(index: Index, hits: Hit[], gap = 14): Hit[] {
  const out: Hit[] = [];
  for (const h of hits) {
    const near = out.find((o) => o.key === h.key && !(h.start > o.end + gap || h.end < o.start - gap));
    if (!near) { out.push({ ...h }); continue; }
    const start = Math.min(near.start, h.start), end = Math.max(near.end, h.end);
    if (end - start > 80) { out.push({ ...h }); continue; }
    const all = index.byKey.get(h.key)!.content.split(/\r?\n/);
    near.start = start; near.end = end;
    near.code = all.slice(start - 1, end).join("\n");
    near.matched = [...new Set([...near.matched, ...h.matched])];
    near.score = Math.max(near.score, h.score);
  }
  return out;
}

export function search(index: Index, question: string, k = 6, opts: { boost?: Set<string>; extra?: string; noSplit?: boolean; boostFactor?: number } = {}): Hit[] {
  // "What is X responsible for vs Y?" — make sure both sides get their own sources.
  if (!opts.noSplit) {
    const m = question.match(/^(.*?)\b(?:difference between|differ(?:ence)? from)\b(.*)$/i);
    const parts = question.split(COMPARE);
    let sides: string[] = [];
    if (parts.length === 2) sides = parts;
    else if (m && /\band\b/i.test(m[2])) sides = m[2].split(/\band\b/i);
    sides = sides.map((x) => x.replace(/[?.]/g, "").trim()).filter((x) => x.split(/\s+/).length >= 1 && x.length > 2);
    if (sides.length === 2) {
      const lists = sides.map((side) => search(index, side, Math.ceil(k / 2) + 1, { ...opts, noSplit: true }));
      const main = search(index, question, k, { ...opts, noSplit: true });
      const merged: Hit[] = [];
      const seen = new Set<string>();
      const add = (h?: Hit) => {
        if (!h) return;
        const key = `${h.key}:${Math.floor(h.start / 20)}`;
        if (seen.has(key)) return;
        seen.add(key);
        merged.push(h);
      };
      for (let i = 0; i < k; i++) { add(lists[0][i]); add(lists[1][i]); }
      for (const h of main) add(h);
      return mergeAdjacent(index, merged).slice(0, k + 2);
    }
  }
  const terms = expandQuery(question);
  for (const { from, to } of correctTerms(index, question)) {
    const ft = stem(from);
    for (const t of terms) if (t.term === ft || t.term === from) { t.weight = 0; t.original = false; }
    if (!terms.some((t) => t.term === to)) terms.push({ term: to, weight: 1.1, original: true });
  }
  if (opts.extra) {
    const have = new Set(terms.map((t) => t.term));
    for (const t of tokenize(opts.extra)) if (!have.has(t)) { have.add(t); terms.push({ term: t, weight: 0.6, original: false }); }
  }
  if (!terms.length) return [];
  const N = index.chunks.length;
  const k1 = 1.3,
    b = 0.7;
  const wantsTests = /\btests?\b|\bspec\b/i.test(question);
  const wantsDocs = /\b(readme|docs?|documentation)\b/i.test(question);
  const scored: { c: Chunk; s: number; m: string[] }[] = [];
  // Term-at-a-time BM25 over the inverted index: only chunks containing a query term are touched.
  const acc = new Float64Array(N);
  const orig = new Uint8Array(N);
  const touched: number[] = [];
  const origCount = terms.filter((t) => t.original).length || 1;
  const norm = index.norm;
  for (const qt of terms) {
    if (!(qt.weight > 0)) continue;
    const list = index.postings.get(qt.term);
    if (!list) continue;
    const n = list.length / 3;
    const w = qt.weight * Math.log(1 + (N - n + 0.5) / (n + 0.5));
    const isOrig = qt.original;
    for (let i = 0; i < list.length; i += 3) {
      const cid = list[i], f = list[i + 1];
      if (acc[cid] === 0) touched.push(cid);
      acc[cid] += (w * f * (k1 + 1)) / (f + norm[cid]) + (list[i + 2] ? w * 0.6 : 0);
      if (isOrig && orig[cid] < 255) orig[cid]++;
    }
  }
  for (const cid of touched) {
    const c = index.chunks[cid];
    // reward chunks covering more distinct original terms
    let sc = acc[cid] * (0.6 + 0.8 * (orig[cid] / origCount));
    if (!wantsTests && c.isTest) sc *= 0.55;
    if (!wantsDocs && c.isDoc) sc *= 0.7;
    if (opts.boost?.has(c.path)) sc *= opts.boostFactor ?? 1.8;
    acc[cid] = sc;
  }
  // Only the best few hundred candidates can make the final list; avoid sorting thousands.
  let cut = -Infinity;
  if (touched.length > 400) {
    const vals = new Float64Array(touched.length);
    for (let i = 0; i < touched.length; i++) vals[i] = acc[touched[i]];
    vals.sort();
    cut = vals[vals.length - 400];
  }
  for (const cid of touched) if (acc[cid] >= cut && acc[cid] > 0) scored.push({ c: index.chunks[cid], s: acc[cid], m: [] });
  scored.sort((a, b) => b.s - a.s || a.c.id - b.c.id);

  const hits: Hit[] = [];
  const perFile = new Map<string, number>();
  const taken: { path: string; start: number; end: number }[] = [];
  const termSet = new Set(terms.map((t) => t.term));
  const weightOf = new Map(terms.map((t) => [t.term, t.weight]));
  for (const { c, s } of scored) {
    if (hits.length >= k) break;
    const m = terms.filter((t) => c.tf.has(t.term)).map((t) => t.term);
    if ((perFile.get(c.key) || 0) >= 2) continue;
    const win = focusWindow(c, termSet, weightOf);
    if (taken.some((t) => t.path === c.key && !(win.end < t.start - 3 || win.start > t.end + 3))) continue;
    taken.push({ path: c.key, ...win });
    perFile.set(c.key, (perFile.get(c.key) || 0) + 1);
    const file = index.byKey.get(c.key)!;
    const all = file.content.split(/\r?\n/);
    let loc: string | undefined;
    if (file.doc) {
      const MARK = /^\[((Page|Slide|Sheet|Cell) ([^\]]+))\]$/;
      let first: RegExpMatchArray | null = null;
      for (let i = win.start - 1; i >= 0; i--) {
        const m = all[i].match(MARK);
        if (m) { first = m; break; }
      }
      let last: RegExpMatchArray | null = null;
      for (let i = win.start; i < win.end; i++) {
        const m = all[i]?.match(MARK);
        if (m) last = m;
      }
      if (!first && last) first = last;
      if (first) loc = last && last[1] !== first[1] && last[2] === first[2] ? `${first[2]}s ${first[3]}–${last[3]}` : first[1];
    }
    hits.push({
      key: c.key,
      path: c.path,
      src: file.src,
      origin: file.origin,
      doc: file.doc,
      loc,
      start: win.start,
      end: win.end,
      code: all.slice(win.start - 1, win.end).join("\n"),
      score: s,
      matched: [...new Set(m)],
    });
  }
  // Normalise scores to 0..1 relative to top
  const top = hits[0]?.score || 1;
  hits.forEach((h) => (h.score = h.score / top));
  return mergeAdjacent(index, hits);
}

/** Narrow a chunk to the densest ~22-line window around matching lines, expanded to block boundaries. */
function focusWindow(c: Chunk, terms: Set<string>, weightOf: Map<string, number>) {
  const scores = c.lines.map((l) => {
    let s = 0;
    for (const t of tokenize(l)) if (terms.has(t)) s += weightOf.get(t) || 0;
    return s;
  });
  const W = Math.min(22, c.lines.length);
  let best = 0,
    bestI = 0;
  for (let i = 0; i + W <= c.lines.length; i++) {
    let s = 0;
    for (let j = i; j < i + W; j++) s += scores[j];
    if (s > best) {
      best = s;
      bestI = i;
    }
  }
  let a = bestI,
    z = bestI + W - 1;
  // trim blank edges
  while (a < z && !c.lines[a].trim()) a++;
  while (z > a && !c.lines[z].trim()) z--;
  return { start: c.start + a, end: c.start + z };
}
