// Client-side code retrieval: chunking + BM25 with code-aware tokenization.

export type CodeFile = { path: string; content: string };

export type Chunk = {
  id: number;
  path: string;
  start: number; // 1-based line
  end: number; // inclusive
  lines: string[];
  tf: Map<string, number>;
  len: number;
  pathTokens: Set<string>;
};

export type Index = {
  files: CodeFile[];
  chunks: Chunk[];
  df: Map<string, number>;
  avgLen: number;
  lineCount: number;
};

export type Hit = {
  path: string;
  start: number;
  end: number;
  code: string;
  score: number;
  matched: string[];
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
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("ing") && w.length > 6) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 5) return w.slice(0, -2);
  if (w.endsWith("es") && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Split identifiers into parts: getUserPrefs -> get, user, prefs, getuserprefs */
export function tokenize(text: string, keepStop = false): string[] {
  const out: string[] = [];
  const raw = text.match(/[A-Za-z_$][A-Za-z0-9_$]*|\d+/g);
  if (!raw) return out;
  for (const word of raw) {
    const whole = word.toLowerCase().replace(/\$/g, "");
    if (!whole) continue;
    const parts = word
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[_\s$]+/)
      .map((p) => p.toLowerCase())
      .filter(Boolean);
    if (parts.length > 1 && whole.length < 40) out.push(stem(whole.replace(/_/g, "")));
    for (const p of parts) {
      if (p.length < 2 && !/\d/.test(p)) continue;
      if (!keepStop && STOP.has(p)) continue;
      out.push(stem(p));
    }
  }
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

export function buildIndex(files: CodeFile[]): Index {
  const chunks: Chunk[] = [];
  const df = new Map<string, number>();
  let totalLen = 0;
  let lineCount = 0;
  let id = 0;
  for (const f of files) {
    const lines = f.content.split(/\r?\n/);
    lineCount += lines.length;
    const pathTokens = new Set(tokenize(f.path.replace(/\.[a-z0-9]+$/i, "")));
    for (let s = 0; s < lines.length; s += STEP) {
      const e = Math.min(lines.length, s + CHUNK);
      const slice = lines.slice(s, e);
      const toks = tokenize(slice.join("\n"));
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      for (const t of pathTokens) tf.set(t, (tf.get(t) || 0) + 2);
      for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
      chunks.push({ id: id++, path: f.path, start: s + 1, end: e, lines: slice, tf, len: toks.length, pathTokens });
      totalLen += toks.length;
      if (e >= lines.length) break;
    }
  }
  return { files, chunks, df, avgLen: totalLen / Math.max(1, chunks.length), lineCount };
}

function isTestPath(p: string) {
  return /(^|\/)(__tests__|tests?|test-d|testing|spec|e2e|fixtures?|mocks?|benchmarks?)(\/|$)|\.(test|spec)\.[a-z]+$/i.test(p);
}
function isDocPath(p: string) {
  return /\.(md|mdx|txt|rst)$/i.test(p);
}

export function search(index: Index, question: string, k = 6): Hit[] {
  const terms = expandQuery(question);
  if (!terms.length) return [];
  const N = index.chunks.length;
  const k1 = 1.3,
    b = 0.7;
  const wantsTests = /\btests?\b|\bspec\b/i.test(question);
  const wantsDocs = /\b(readme|docs?|documentation)\b/i.test(question);
  const scored: { c: Chunk; s: number; m: string[] }[] = [];
  for (const c of index.chunks) {
    let s = 0;
    const m: string[] = [];
    let origHits = 0;
    for (const qt of terms) {
      const f = c.tf.get(qt.term);
      if (!f) continue;
      const n = index.df.get(qt.term) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += qt.weight * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.len) / index.avgLen)));
      if (c.pathTokens.has(qt.term)) s += qt.weight * idf * 0.6;
      m.push(qt.term);
      if (qt.original) origHits++;
    }
    if (!s) continue;
    // reward chunks covering more distinct original terms
    const origCount = terms.filter((t) => t.original).length || 1;
    s *= 0.6 + 0.8 * (origHits / origCount);
    if (!wantsTests && isTestPath(c.path)) s *= 0.55;
    if (!wantsDocs && isDocPath(c.path)) s *= 0.7;
    scored.push({ c, s, m });
  }
  scored.sort((a, b) => b.s - a.s);

  const hits: Hit[] = [];
  const perFile = new Map<string, number>();
  const taken: { path: string; start: number; end: number }[] = [];
  const termSet = new Set(terms.map((t) => t.term));
  const weightOf = new Map(terms.map((t) => [t.term, t.weight]));
  for (const { c, s, m } of scored) {
    if (hits.length >= k) break;
    if ((perFile.get(c.path) || 0) >= 2) continue;
    const win = focusWindow(c, termSet, weightOf);
    if (taken.some((t) => t.path === c.path && !(win.end < t.start - 3 || win.start > t.end + 3))) continue;
    taken.push({ path: c.path, ...win });
    perFile.set(c.path, (perFile.get(c.path) || 0) + 1);
    const file = index.files.find((f) => f.path === c.path)!;
    const all = file.content.split(/\r?\n/);
    hits.push({
      path: c.path,
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
  return hits;
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
