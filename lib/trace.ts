/**
 * Trace mode: static call-path tracing across loaded repos.
 * UI function -> request it sends -> backend route -> handler -> service/runtime -> store.
 * Everything here is computed from the code itself (no model), so the hops are verifiable.
 */
import type { CodeFile, Hit, Index } from "./search";
import { tokenize, expandQuery } from "./search";

export type HopKind = "ui" | "client" | "api" | "service" | "runtime" | "store" | "prompt";

export type Def = { name: string; key: string; path: string; src?: string; start: number; end: number; py: boolean };
export type Req = { key: string; path: string; line: number; method: string; url: string; raw: string; fn?: Def; ws?: boolean };
export type Route = { key: string; path: string; line: number; method: string; url: string; handler?: Def; framework: string };

export type Hop = {
  kind: HopKind;
  key: string;
  path: string;
  src?: string;
  fn?: string;
  start: number;
  end: number;
  focus: number[]; // lines that perform the action
  label: string; // one-line summary computed from code
  calls?: { name: string; line: number; resolved: boolean }[];
};

export type Trace = {
  hops: Hop[];
  entry?: Req;
  route?: Route;
  selects: { key: string; path: string; line: number; text: string }[];
  uncalled: Route[];
  stops: string[];
  notes: string[];
  openFirst?: { path: string; why: string };
  uiLoaded?: boolean;
};

/* ---------------- language helpers ---------------- */

const JS_EXT = /\.(m?[jt]sx?|vue|svelte)$/i;
const PY_EXT = /\.py$/i;
const isCode = (p: string) => JS_EXT.test(p) || PY_EXT.test(p);
const UI_HINT = /(^|\/)(src\/)?(components?|pages|views|app|screens|features|ui|hooks|composables|stores?|routes)\/|\.(vue|svelte|tsx|jsx)$/i;
const BACKEND_HINT = /(^|\/)(api|routers?|routes|server|backend|handlers?|controllers?|services?|lambdas?|functions)\//i;

const KEYWORDS = new Set(
  ("if for while switch catch return function typeof new await async else elif with try except finally def class lambda yield import from export const let var " +
    "print len str int float dict list set tuple bool isinstance range enumerate zip map filter sorted min max sum any all open super type getattr setattr hasattr " +
    "console log warn error info debug json JSON Object Array Promise String Number Boolean Math Date Error Set Map require setTimeout clearTimeout setInterval " +
    "parseInt parseFloat encodeURIComponent decodeURIComponent fetch then catch finally resolve reject push pop shift slice splice join split replace trim includes " +
    "keys values items get append extend update format startswith endswith lower upper strip loads dumps uuid4 now utcnow isoformat ref computed reactive watch emit " +
    "useState useEffect useRef useMemo useCallback set setState toString toISOString assert raise HTTPException Depends Field Query Body Path BaseModel").split(/\s+/)
);

const RUNTIME_RE = /invoke_agent_runtime|InvokeAgentRuntime|agentcore|bedrock|lambda_client\.invoke|\.invoke\(\s*FunctionName|websockets?\.connect|new WebSocket|ws\.send|StreamingResponse|EventSource|openai|anthropic|chat\.completions|\.generate\(|\.stream\(|Agent\(|supervisor/i;
const STORE_RE = /put_item|update_item|get_item|delete_item|batch_write|\.query\(|\.scan\(|Table\(|dynamodb|s3\.|put_object|get_object|upload_fileobj|supabase|\.from\(['"]|\.insert\(|\.upsert\(|prisma\.|session\.add|session\.commit|\.execute\(|redis|localStorage\.setItem|indexedDB/i;
const PROMPT_FILE_RE = /["'`]([\w./-]*prompts?[\w./-]*\.(?:md|txt|prompt|j2|jinja2?|ya?ml))["'`]|["'`]([\w./-]+\.(?:md|prompt|j2))["'`]/gi;
const SELECT_RE = /\b(engine|runtime|provider|backend|mode|agent|use_\w+|USE_\w+|flag|variant|impl)\b[^\n]{0,60}(===?|!==?|\bin\b|\bif\b|\?)|\b(if|elif|case)\b[^\n]{0,80}\b(engine|runtime|provider|mode|agent)\b/i;
const NON_EVIDENCE = /^\s*(import\b|from\s+\S+\s+import\b|#|\/\/|\/\*|\*|"""|'''|export\s+\{|set[A-Z]\w*\(|this\.\w+\s*=|\w+\.value\s*=|loading\.value|state\.\w+\s*=)/;

export function isNonEvidence(line: string) {
  const t = line.trim();
  return !t || NON_EVIDENCE.test(line);
}

/* ---------------- definitions ---------------- */

function pyDefs(f: CodeFile, key: string, lines: string[]): Def[] {
  const out: Def[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/);
    if (!m) continue;
    const ind = m[1].length;
    let end = i;
    let opened = false;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) continue;
      const li = l.match(/^\s*/)![0].length;
      if (!opened) {
        if (/:\s*(#.*)?$/.test(lines[j - 1]) || li > ind) opened = true;
      }
      if (li <= ind && !/^\s*[)\]}]/.test(l)) break;
      end = j;
    }
    out.push({ name: m[2], key, path: f.path, src: f.src, start: i + 1, end: Math.max(i + 1, end + 1), py: true });
  }
  return out;
}

function braceEnd(lines: string[], i: number): number {
  let depth = 0;
  let seen = false;
  for (let j = i; j < Math.min(lines.length, i + 400); j++) {
    const l = lines[j].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$/, "");
    for (const ch of l) {
      if (ch === "{") { depth++; seen = true; }
      else if (ch === "}") depth--;
    }
    if (seen && depth <= 0) return j + 1;
    if (!seen && j > i + 3) return i + 1; // one-line arrow fn
  }
  return Math.min(lines.length, i + 40);
}

const JS_DEF_RES = [
  /(?:^|\s)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\(/,
  /(?:^|\s)(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|\w+\s*=>)/,
  /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|override\s+)*(\w+)\s*\([^)]*\)\s*(?::\s*[^={]+)?\{\s*$/,
  /^\s*(\w+)\s*:\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>)/,
];

function jsDefs(f: CodeFile, key: string, lines: string[]): Def[] {
  const out: Def[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    for (const re of JS_DEF_RES) {
      const m = l.match(re);
      if (m && !KEYWORDS.has(m[1]) && !/^(if|for|while|switch|catch|constructor)$/.test(m[1])) {
        out.push({ name: m[1], key, path: f.path, src: f.src, start: i + 1, end: braceEnd(lines, i), py: false });
        break;
      }
    }
  }
  return out;
}

/* ---------------- requests & routes ---------------- */

export function normUrl(raw: string): string {
  let u = raw.trim();
  u = u.replace(/\$\{[^}]*\}/g, "{}").replace(/\{[^}]*\}/g, "{}");
  u = u.replace(/^https?:\/\/[^/]+/i, "").replace(/^wss?:\/\/[^/]+/i, "");
  u = u.split("?")[0].split("#")[0];
  u = u.replace(/:\w+/g, "{}").replace(/\[\.{0,3}\w+\]/g, "{}").replace(/<[^>]+>/g, "{}");
  u = u.replace(/\/+/g, "/");
  if (!u.startsWith("/") && !u.startsWith("{}")) u = "/" + u;
  return u.replace(/\/$/, "") || "/";
}
const segs = (u: string) => u.split("/").filter(Boolean).filter((s, i) => !(i === 0 && s === "{}"));

const ROUTE_OBJ = /^(app|router|\w+_?router|\w+Router|api|server|fastify|bp|blueprint|\w+_bp)$/i;

function findRequests(f: CodeFile, key: string, lines: string[], defs: Def[]): Req[] {
  const out: Req[] = [];
  const py = PY_EXT.test(f.path);
  const enclosing = (line: number) => defs.filter((d) => d.start <= line && d.end >= line).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (isNonEvidence(l)) continue;
    let m: RegExpMatchArray | null;
    // fetch("/x", { method: "POST" })
    if ((m = l.match(/\bfetch\(\s*([`'"])(.*?)\1/))) {
      const win = lines.slice(i, i + 8).join(" ");
      const meth = win.match(/method\s*:\s*['"`](\w+)/i)?.[1]?.toUpperCase() || "GET";
      if (/^(\/|http|\$\{|\{)/.test(m[2])) out.push({ key, path: f.path, line: i + 1, method: meth, url: normUrl(m[2]), raw: l.trim(), fn: enclosing(i + 1) });
      continue;
    }
    // apiClient.post("/x"), axios.get(`...`), requests.post(f"...")
    if ((m = l.match(/([\w$.]+)\.(get|post|put|patch|delete|request|stream)\(\s*f?([`'"])(.*?)\3/i))) {
      const obj = m[1].split(".").pop() || m[1];
      const url = m[4];
      if (!/^(\/|http|\$\{|\{)/.test(url)) continue;
      // route definitions look like router.get("/x", handler) — skip on backend files
      if (ROUTE_OBJ.test(obj) && (py ? /^\s*@/.test(l) : /,\s*(async\s*)?(\(|function|\w+\s*\)|\w+\s*,)/.test(l.slice(l.indexOf(m[0]) + m[0].length)))) continue;
      out.push({ key, path: f.path, line: i + 1, method: m[2].toUpperCase().replace("REQUEST", "ANY").replace("STREAM", "POST"), url: normUrl(url), raw: l.trim(), fn: enclosing(i + 1) });
      continue;
    }
    // WebSocket clients
    if ((m = l.match(/new\s+WebSocket\(\s*([`'"])(.*?)\1|websockets?\.connect\(\s*f?([`'"])(.*?)\3/))) {
      const url = m[2] ?? m[4] ?? "";
      out.push({ key, path: f.path, line: i + 1, method: "WS", url: normUrl(url), raw: l.trim(), fn: enclosing(i + 1), ws: true });
    }
  }
  return out;
}

function findRoutes(f: CodeFile, key: string, lines: string[], defs: Def[], includePrefix: Map<string, string>): Route[] {
  const out: Route[] = [];
  const py = PY_EXT.test(f.path);
  const base = f.path.split("/").pop()!.replace(/\.\w+$/, "");
  let routerPrefix = "";
  for (const l of lines) {
    const m = l.match(/APIRouter\([^)]*prefix\s*=\s*["']([^"']+)["']/) || l.match(/Blueprint\([^)]*url_prefix\s*=\s*["']([^"']+)["']/);
    if (m) { routerPrefix = m[1]; break; }
  }
  const pre = (includePrefix.get(base) || "") + routerPrefix;
  const nextDef = (line: number) => defs.find((d) => d.start > line && d.start <= line + 8);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m: RegExpMatchArray | null;
    if (py && (m = l.match(/^\s*@([\w.]+)\.(get|post|put|patch|delete|websocket|api_route|route)\(\s*f?["']([^"']*)["']/i))) {
      let meth = m[2].toUpperCase();
      if (meth === "ROUTE" || meth === "API_ROUTE") meth = (l.match(/methods\s*=\s*\[\s*["'](\w+)/)?.[1] || "ANY").toUpperCase();
      if (meth === "WEBSOCKET") meth = "WS";
      out.push({ key, path: f.path, line: i + 1, method: meth, url: normUrl(pre + m[3]), handler: nextDef(i + 1), framework: "python" });
      continue;
    }
    if (!py && (m = l.match(/\b([\w$]+)\.(get|post|put|patch|delete|all|ws)\(\s*([`'"])(\/[^`'"]*)\3\s*,/i)) && ROUTE_OBJ.test(m[1])) {
      const rest = l.slice(l.indexOf(m[0]) + m[0].length);
      const named = rest.match(/^\s*(?:[\w$]+\s*,\s*)*([\w$.]+)\s*\)/);
      let handler: Def | undefined;
      if (named && !/^(async|function|\()/.test(rest.trim())) handler = defs.find((d) => d.name === named[1].split(".").pop());
      if (!handler) handler = { name: "(inline handler)", key, path: f.path, src: f.src, start: i + 1, end: braceEnd(lines, i), py: false };
      out.push({ key, path: f.path, line: i + 1, method: m[2].toUpperCase(), url: normUrl(m[4]), handler, framework: "express" });
      continue;
    }
    if (!py && (m = l.match(/new\s+WebSocketServer\(\s*\{[^}]*path\s*:\s*["'`]([^"'`]+)/))) {
      out.push({ key, path: f.path, line: i + 1, method: "WS", url: normUrl(m[1]), handler: { name: "WebSocket handler", key, path: f.path, src: f.src, start: i + 1, end: Math.min(lines.length, i + 30), py: false }, framework: "ws" });
    }
    // Next.js app router: app/**/route.ts  export async function POST
    if (!py && /(^|\/)app\/.*\/route\.(t|j)sx?$/.test(f.path) && (m = l.match(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/))) {
      const url = "/" + f.path.replace(/^.*?(^|\/)app\//, "").replace(/\/route\.\w+$/, "").replace(/\([^)]*\)\/?/g, "");
      out.push({ key, path: f.path, line: i + 1, method: m[1], url: normUrl(url), handler: defs.find((d) => d.start === i + 1), framework: "next" });
    }
    if (!py && /(^|\/)pages\/api\//.test(f.path) && /export\s+default\s+(async\s+)?function/.test(l)) {
      const url = "/" + f.path.replace(/^.*?pages\//, "").replace(/\.\w+$/, "").replace(/\/index$/, "");
      out.push({ key, path: f.path, line: i + 1, method: "ANY", url: normUrl(url), handler: defs.find((d) => d.start === i + 1), framework: "next" });
    }
  }
  return out;
}

/** How well a request URL matches a route URL. 0 = no match. Aligns from the end, so unknown prefixes are fine. */
export function matchScore(req: Req, route: Route): number {
  if (req.ws !== (route.method === "WS") && route.method !== "ANY" && req.method !== "ANY") {
    if (req.ws || route.method === "WS") return 0;
  }
  if (route.method !== "ANY" && req.method !== "ANY" && !req.ws && route.method !== req.method) return 0;
  const a = segs(req.url), b = segs(route.url);
  if (!a.length || !b.length) return 0;
  const n = Math.min(a.length, b.length);
  let lit = 0;
  for (let i = 1; i <= n; i++) {
    const x = a[a.length - i], y = b[b.length - i];
    if (x === "{}" || y === "{}") continue;
    if (x.toLowerCase() !== y.toLowerCase()) return 0;
    lit++;
  }
  if (!lit) return 0;
  // exact length match is better than suffix-only
  return lit + (a.length === b.length ? 1 : 0) + n / 10;
}

/* ---------------- graph ---------------- */

const calledCache = new WeakMap<Graph, Set<Route>>();
/** Routes that some request in the loaded code actually targets (each request counts only for its best match). */
export function calledRoutes(g: Graph): Set<Route> {
  const c = calledCache.get(g);
  if (c) return c;
  const out = new Set<Route>();
  for (const q of g.reqs) {
    let best: Route | undefined, bs = 0;
    for (const r of g.routes) { const sc = matchScore(q, r); if (sc > bs) { bs = sc; best = r; } }
    if (best) out.add(best);
  }
  calledCache.set(g, out);
  return out;
}

export type Graph = {
  defs: Def[];
  byName: Map<string, Def[]>;
  reqs: Req[];
  routes: Route[];
  lines: Map<string, string[]>;
  files: Map<string, CodeFile>;
};

const graphCache = new WeakMap<Index, Graph>();

export function getGraph(index: Index): Graph {
  const hit = graphCache.get(index);
  if (hit) return hit;
  const defs: Def[] = [];
  const reqs: Req[] = [];
  const routes: Route[] = [];
  const lines = new Map<string, string[]>();
  const files = new Map<string, CodeFile>();
  const includePrefix = new Map<string, string>();
  const code = index.files.filter((f) => isCode(f.path) && !f.doc);
  for (const f of code) {
    const key = f.key || f.path;
    const ls = f.content.split(/\r?\n/);
    lines.set(key, ls);
    files.set(key, f);
    for (const l of ls) {
      const m = l.match(/include_router\(\s*([\w.]+?)(?:\.router)?\s*,[^)]*prefix\s*=\s*["']([^"']+)["']/);
      if (m) includePrefix.set(m[1].split(".").pop()!, m[2]);
    }
  }
  const perFile = new Map<string, Def[]>();
  for (const f of code) {
    const key = f.key || f.path;
    const ls = lines.get(key)!;
    const d = PY_EXT.test(f.path) ? pyDefs(f, key, ls) : jsDefs(f, key, ls);
    perFile.set(key, d);
    defs.push(...d);
  }
  for (const f of code) {
    const key = f.key || f.path;
    const ls = lines.get(key)!;
    const d = perFile.get(key)!;
    routes.push(...findRoutes(f, key, ls, d, includePrefix));
    reqs.push(...findRequests(f, key, ls, d));
  }
  const byName = new Map<string, Def[]>();
  for (const d of defs) (byName.get(d.name) || byName.set(d.name, []).get(d.name)!).push(d);
  const g = { defs, byName, reqs, routes, lines, files };
  graphCache.set(index, g);
  return g;
}

/* ---------------- tracing ---------------- */

export function isFlowQuestion(q: string) {
  return /\b(how does|how do|how is|how are|walk me through|end[- ]to[- ]end|flow|trace|call(s|ed|ing)? (path|chain)|what calls|who calls|which (file|function|endpoint|route|service)|what (file|function|endpoint|route) (drives|handles|sends|calls|decides)|request path|where (is|does).{0,40}(handled|sent|called|processed|routed|stored|saved)|what happens when|drives?|handles?|entry ?point|send(s)? (the )?request)\b/i.test(q);
}

function qTerms(q: string) {
  return new Set(expandQuery(q).filter((t) => t.original).map((t) => t.term));
}
function overlap(terms: Set<string>, text: string) {
  const toks = new Set(tokenize(text));
  // adjacent word pairs, so "rule-builder" also matches the phrase "rule builder"
  const words = text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i + 1 < words.length; i++) toks.add(words[i] + words[i + 1]);
  let n = 0;
  for (const t of toks) if (terms.has(t)) n++;
  return n;
}

function callsIn(g: Graph, d: Def): { name: string; line: number }[] {
  const ls = g.lines.get(d.key)!;
  const out: { name: string; line: number }[] = [];
  const seen = new Set<string>();
  for (let i = d.start; i < d.end && i < ls.length; i++) {
    const l = ls[i];
    if (isNonEvidence(l)) continue;
    for (const m of l.matchAll(/(?:\.|\b)([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1];
      if (KEYWORDS.has(name) || name === d.name || /^[A-Z][A-Z0-9_]+$/.test(name)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, line: i + 1 });
    }
  }
  return out;
}

function importsOf(g: Graph, key: string): string[] {
  const ls = g.lines.get(key) || [];
  const out: string[] = [];
  for (const l of ls.slice(0, 120)) {
    let m = l.match(/^\s*from\s+([\w.]+)\s+import/);
    if (m) out.push(m[1].replace(/\./g, "/"));
    m = l.match(/from\s+['"]([^'"]+)['"]/) || l.match(/require\(\s*['"]([^'"]+)['"]/);
    if (m) out.push(m[1].replace(/^[@~]\//, "").replace(/^\.\.?\//, "").replace(/\.\w+$/, ""));
  }
  return out;
}

function resolve(g: Graph, name: string, fromKey: string): Def | undefined {
  const cands = g.byName.get(name);
  if (!cands?.length) return undefined;
  if (cands.length === 1) return cands[0];
  const imps = importsOf(g, fromKey);
  const fromSrc = g.files.get(fromKey)?.src;
  return [...cands].sort((a, b) => {
    const sa = (imps.some((i) => i && a.path.includes(i)) ? 4 : 0) + (a.key === fromKey ? 2 : 0) + (a.src === fromSrc ? 1 : 0);
    const sb = (imps.some((i) => i && b.path.includes(i)) ? 4 : 0) + (b.key === fromKey ? 2 : 0) + (b.src === fromSrc ? 1 : 0);
    return sb - sa;
  })[0];
}

function body(g: Graph, d: Def) {
  return (g.lines.get(d.key) || []).slice(d.start - 1, d.end).join("\n");
}

function kindOf(g: Graph, d: Def, fallback: HopKind): HopKind {
  const b = body(g, d);
  if (STORE_RE.test(b) && !RUNTIME_RE.test(b)) return "store";
  if (RUNTIME_RE.test(b) || /agentcore|runtime|mastra|strands|agent/i.test(d.path)) return "runtime";
  return fallback;
}

function actionLines(g: Graph, d: Def, extra: number[] = []): number[] {
  const ls = g.lines.get(d.key) || [];
  const out = new Set<number>(extra);
  for (let i = d.start - 1; i < d.end && i < ls.length; i++) {
    const l = ls[i];
    if (isNonEvidence(l)) continue;
    if (RUNTIME_RE.test(l) || STORE_RE.test(l) || SELECT_RE.test(l) || /\breturn\b.*\(|await\s+\w/.test(l)) out.add(i + 1);
  }
  return [...out].sort((a, b) => a - b).slice(0, 12);
}

function selects(g: Graph, d: Def) {
  const ls = g.lines.get(d.key) || [];
  const out: { key: string; path: string; line: number; text: string }[] = [];
  // include the def line (default params like engine: str = "mastra")
  for (let i = d.start - 1; i < d.end && i < ls.length; i++) {
    const l = ls[i];
    if (isNonEvidence(l)) continue;
    if (SELECT_RE.test(l) || (i === d.start - 1 && /\b(engine|runtime|mode|provider)\b\s*[:=]/.test(l))) out.push({ key: d.key, path: d.path, line: i + 1, text: l.trim().slice(0, 180) });
  }
  return out.slice(0, 4);
}

function promptFiles(g: Graph, index: Index, d: Def): CodeFile[] {
  const b = body(g, d) + "\n" + (g.lines.get(d.key) || []).slice(0, 60).join("\n");
  const out: CodeFile[] = [];
  const fromDir = d.path.split("/");
  for (const m of b.matchAll(PROMPT_FILE_RE)) {
    const ref = (m[1] || m[2]).replace(/^\.\/?/, "");
    const name = ref.split("/").pop()!;
    const cands = index.files.filter((x) => (x.src === d.src || !d.src) && (x.path === ref || x.path.endsWith("/" + ref) || x.path.endsWith("/" + name)));
    const rank = (x: CodeFile) => {
      let s = x.path.endsWith(ref) ? 10 : 0;
      const p = x.path.split("/");
      let k = 0;
      while (k < p.length && k < fromDir.length && p[k] === fromDir[k]) k++;
      return s + k;
    };
    const f = cands.sort((x, y) => rank(y) - rank(x))[0];
    if (f && !out.includes(f)) out.push(f);
  }
  return out.slice(0, 2);
}

function score(d: Def, terms: Set<string>, g: Graph, fromKey: string) {
  const b = body(g, d);
  let s = overlap(terms, d.name) * 2.5 + overlap(terms, d.path) * 0.8;
  if (RUNTIME_RE.test(b)) s += 2.5;
  if (STORE_RE.test(b)) s += 1.5;
  if (d.key !== fromKey) s += 1;
  if (d.end - d.start < 3) s -= 1;
  if (/^(log|debug|validate|format|serialize|to_dict|dict|json|parse|get_logger|now|uuid)/i.test(d.name)) s -= 2;
  return s;
}

function hopFromDef(g: Graph, d: Def, kind: HopKind, label: string, focusExtra: number[] = []): Hop {
  const focus = actionLines(g, d, [d.start, ...focusExtra]);
  return { kind, key: d.key, path: d.path, src: d.src, fn: d.name, start: d.start, end: d.end, focus, label };
}

/** Build a call-path trace for a question. Returns null if the code has nothing to trace. */
export function buildTrace(index: Index, q: string, hits: Hit[]): Trace | null {
  const g = getGraph(index);
  if (!g.reqs.length && !g.routes.length) return null;
  const terms = qTerms(q);
  const hitScore = new Map<string, number>();
  hits.forEach((h, i) => hitScore.set(h.key, Math.max(hitScore.get(h.key) || 0, h.score * (1 - i * 0.06))));

  // 1) entry: the request the current UI sends
  const rankReq = (r: Req) => {
    const ui = UI_HINT.test(r.path) && !PY_EXT.test(r.path) ? 2 : 0;
    const back = BACKEND_HINT.test(r.path) && PY_EXT.test(r.path) ? -1 : 0;
    const matchesRoute = g.routes.some((rt) => matchScore(r, rt) > 0) ? 1.5 : 0;
    return overlap(terms, r.url) * 3 + overlap(terms, r.fn?.name || "") * 2 + overlap(terms, r.path) + (hitScore.get(r.key) || 0) * 3 + ui + back + matchesRoute;
  };
  const isUI = (path: string) => UI_HINT.test(path) && !PY_EXT.test(path) && !BACKEND_HINT.test(path);
  const uiLoaded = [...g.files.values()].some((f) => isUI(f.path));
  const reqs = [...g.reqs].sort((a, b) => rankReq(b) - rankReq(a));
  const relevance = (r: Req) => overlap(terms, r.url + " " + (r.fn?.name || "") + " " + r.path) + (hitScore.get(r.key) || 0) * 2;
  // must be about the question, not just "some UI request"
  let entry: Req | undefined = reqs.find((r) => rankReq(r) >= 3 && relevance(r) >= 1.5);
  const rankRoute = (r: Route) => overlap(terms, r.url + " " + (r.handler?.name || "")) * 2 + (hitScore.get(r.key) || 0) * 3;
  const bestRoute = [...g.routes].sort((a, b) => rankRoute(b) - rankRoute(a))[0];
  // a backend-to-backend call shouldn't beat a route that clearly matches the question
  if (entry && bestRoute && rankRoute(bestRoute) > relevance(entry) * 2 + 1 && !isUI(entry.path)) entry = undefined;
  // a UI request that's weaker than a clearly matching route (and doesn't reach it) loses too
  if (entry && bestRoute && rankRoute(bestRoute) >= 2 && overlap(terms, entry.url + " " + (entry.fn?.name || "")) === 0 && matchScore(entry, bestRoute) === 0) entry = undefined;
  const entryIsUI = !!entry && isUI(entry.path);

  const hops: Hop[] = [];
  const stops: string[] = [];
  const notes: string[] = [];
  const sel: Trace["selects"] = [];
  let route: Route | undefined;

  if (entry) {
    const fn = entry.fn;
    // UI caller of the client function (component -> api wrapper)
    if (fn) {
      const keys = new Set([...g.lines.entries()].filter(([, ls]) => ls.some((l) => l.includes(fn.name))).map(([k]) => k));
      const callers = g.defs
        .filter((d) => keys.has(d.key) && (d.key !== fn.key || d.name !== fn.name))
        .filter((d) => {
          const b = body(g, d);
          return new RegExp(`(?:\\.|\\b)${fn.name}\\s*\\(`).test(b) && d.name !== fn.name;
        })
        .sort((a, b) => (UI_HINT.test(b.path) ? 2 : 0) + overlap(terms, b.name + " " + b.path) - ((UI_HINT.test(a.path) ? 2 : 0) + overlap(terms, a.name + " " + a.path)));
      const caller = callers[0];
      if (caller && caller.key !== fn.key && (isUI(caller.path) || !entryIsUI)) {
        const ls = g.lines.get(caller.key)!;
        const callLine = ls.findIndex((l, i) => i >= caller.start - 1 && i < caller.end && new RegExp(`(?:\\.|\\b)${fn.name}\\s*\\(`).test(l)) + 1;
        hops.push({ ...hopFromDef(g, caller, "ui", `${caller.name}() calls ${fn.name}()`, callLine ? [callLine] : []), focus: [caller.start, callLine].filter(Boolean) });
      }
      hops.push({
        kind: hops.length || !entryIsUI ? "client" : "ui",
        key: fn.key, path: fn.path, src: fn.src, fn: fn.name, start: fn.start, end: fn.end,
        focus: [fn.start, entry.line],
        label: `${fn.name}() sends ${entry.method} ${entry.url}`,
      });
    } else {
      const ls = g.lines.get(entry.key)!;
      hops.push({ kind: entryIsUI ? "ui" : "client", key: entry.key, path: entry.path, src: g.files.get(entry.key)?.src, start: Math.max(1, entry.line - 6), end: Math.min(ls.length, entry.line + 6), focus: [entry.line], label: `sends ${entry.method} ${entry.url}` });
    }

    // 2) API route that receives it
    const cands = g.routes.map((r) => ({ r, s: matchScore(entry!, r) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    route = cands[0]?.r;
    if (!route) stops.push(`No route in the loaded files matches ${entry.method} ${entry.url}. The backend that serves it may not be loaded.`);
  } else {
    // no UI request: start from the best matching route
    const rr = [...g.routes].sort((a, b) => overlap(terms, b.url + " " + (b.handler?.name || "")) * 2 + (hitScore.get(b.key) || 0) * 3 - (overlap(terms, a.url + " " + (a.handler?.name || "")) * 2 + (hitScore.get(a.key) || 0) * 3));
    if (!uiLoaded) notes.push("No frontend/UI files are loaded, so the UI entry point can't be traced. Load the frontend repo too.");
    if (rr[0] && overlap(terms, rr[0].url + " " + (rr[0].handler?.name || "") + " " + rr[0].path) + (hitScore.get(rr[0].key) || 0) >= 1.5) {
      route = rr[0];
      if (uiLoaded) notes.push("No UI code in the loaded files sends a request to this route.");
    }
  }

  // 3) handler, then follow calls one hop at a time
  let cur: Def | undefined;
  if (route) {
    const h = route.handler;
    if (h) {
      hops.push({ ...hopFromDef(g, h, "api", h.name.startsWith("(") ? `${route.method} ${route.url} lands in an inline handler` : `${route.method} ${route.url} → ${h.name}()`, [route.line]), start: Math.min(route.line, h.start), fn: h.name.startsWith("(") ? undefined : h.name });
      sel.push(...selects(g, h));
      cur = h;
    } else {
      const ls = g.lines.get(route.key)!;
      hops.push({ kind: "api", key: route.key, path: route.path, start: route.line, end: Math.min(ls.length, route.line + 12), focus: [route.line], label: `${route.method} ${route.url}` });
      stops.push(`Couldn't find the handler function for ${route.method} ${route.url}.`);
    }
  }

  const visited = new Set<string>(hops.map((h) => `${h.key}:${h.fn}`));
  let handedOff = false;
  for (let depth = 0; cur && depth < 6; depth++) {
    const here: Def = cur;
    const hereName = here.name.startsWith("(") ? `${route?.method} ${route?.url} handler` : `${here.name}()`;
    const calls = callsIn(g, here);
    const resolved = calls.map((c) => ({ c, d: resolve(g, c.name, here.key) })).filter((x) => x.d && !visited.has(`${x.d.key}:${x.d.name}`)) as { c: { name: string; line: number }; d: Def }[];
    const external = calls.filter((c) => !g.byName.has(c.name));
    const last = hops[hops.length - 1];
    last.calls = calls.slice(0, 12).map((c) => ({ ...c, resolved: !!g.byName.get(c.name) }));
    for (const pf of promptFiles(g, index, here)) {
      const key = pf.key || pf.path;
      if (visited.has(key)) continue;
      visited.add(key);
      const pls = pf.content.split(/\r?\n/);
      const focus = pls.map((l, i) => (/^\s*(\d+[).]|[-*]\s+\w+\(|#{1,3}\s|[A-Z][A-Z /]{6,}:?\s*$)/.test(l) ? i + 1 : 0)).filter(Boolean).slice(0, 14);
      const loadLine = (g.lines.get(here.key) || []).findIndex((l) => l.includes(pf.path.split("/").pop()!)) + 1;
      hops.push({ kind: "prompt", key, path: pf.path, src: pf.src, start: 1, end: Math.min(pls.length, 70), focus, label: `prompt loaded at ${here.path.split("/").pop()}:${loadLine || "?"} for ${here.name}() — it lists the steps` });
    }

    // runtime hand-off: invoke_agent_runtime / lambda invoke / ws connect -> the selected runtime's entry point
    const handoff = !handedOff && external.find((c) => /invoke_agent_runtime|InvokeAgentRuntime|invoke_runtime|lambda.*invoke|websockets?\.connect/i.test(c.name + " " + ((g.lines.get(here.key) || [])[c.line - 1] || "")));
    if (handoff) {
      last.focus = [...new Set([...last.focus, handoff.line])].sort((x, y) => x - y);
      const pick = selectedRuntime(g, sel);
      if (pick) {
        handedOff = true;
        const { chosen, other, reason } = pick;
        if (chosen) {
          visited.add(`${chosen.def.key}:${chosen.def.name}`);
          hops.push({ ...hopFromDef(g, chosen.def, "runtime", `${chosen.name} runtime entry (${chosen.how}) — reached via ${handoff.name}(); ${reason}`), fn: chosen.def.name });
          notes.push(`The hand-off from ${handoff.name}() to the ${chosen.name} runtime goes through the runtime ARN, so this link is matched by name, not by a direct function call.`);
          if (other) notes.push(`Other runtime: \`${other.name}\` (\`${other.def.path}\`${other.def.name ? `, \`${other.def.name}()\`` : ""}) is only used when the selection picks \`${other.name}\`.`);
          cur = chosen.def;
          continue;
        }
      }
      stops.push(`${here.name}() hands off at ${here.path}:${handoff.line} (\`${((g.lines.get(here.key) || [])[handoff.line - 1] || "").trim().slice(0, 100)}\`). Which runtime that reaches isn't visible in the loaded code, so the trace stops there.`);
      break;
    }

    if (!resolved.length) {
      const ext = external.filter((c) => /_|[a-z][A-Z]/.test(c.name) && (overlap(terms, c.name) > 0 || /invoke|send|call|run|stream|agent|runtime|generate/i.test(c.name)));
      if (ext.length) stops.push(`${here.name}() calls ${ext.slice(0, 2).map((c) => c.name + "()").join(", ")} at ${here.path}:${ext[0].line}, which isn't defined in the loaded files. The trace stops there.`);
      break;
    }
    resolved.sort((x, y) => score(y.d, terms, g, here.key) - score(x.d, terms, g, here.key));
    // stores touched here are side hops; keep following the strongest non-store call
    const stores = resolved.filter((x) => kindOf(g, x.d, "service") === "store").slice(0, 2);
    const main = resolved.find((x) => kindOf(g, x.d, "service") !== "store" && score(x.d, terms, g, here.key) >= (depth === 0 ? 0.5 : 1));
    for (const st of stores) {
      visited.add(`${st.d.key}:${st.d.name}`);
      last.focus = [...new Set([...last.focus, st.c.line])].sort((x, y) => x - y);
      hops.push(hopFromDef(g, st.d, "store", `${hereName} → ${st.d.name}() reads/writes storage`));
    }
    if (!main) break;
    last.focus = [...new Set([...last.focus, main.c.line])].sort((x, y) => x - y);
    visited.add(`${main.d.key}:${main.d.name}`);
    const kind = kindOf(g, main.d, "service");
    hops.push(hopFromDef(g, main.d, kind, `${hereName} → ${main.d.name}()`));
    sel.push(...selects(g, main.d));
    cur = main.d;
  }
  // keep hops in call order: stores that were side hops stay right after their caller

  // 4) related routes that exist but aren't called by any request in the loaded code
  const uncalled: Route[] = [];
  if (route) {
    const core = (u: string) => segs(u).filter((s) => s !== "{}" && s !== "api" && !/^v\d+$/.test(s));
    const rs = core(route.url);
    for (const r of g.routes) {
      if (r === route) continue;
      const s2 = core(r.url);
      const related = r.key === route.key || rs.slice(0, 2).some((s) => s2.includes(s)) || overlap(terms, r.url + " " + (r.handler?.name || "")) >= 2;
      if (!related) continue;
      if (overlap(terms, r.url + " " + (r.handler?.name || "")) === 0 && r.key !== route.key) continue;
      if (!calledRoutes(g).has(r)) uncalled.push(r);
    }
  }

  if (!hops.length) return null;
  // the trace must actually be about the question
  const hopText = hops.map((h) => `${h.fn || ""} ${h.path} ${h.label}`).join(" ");
  const rel = overlap(terms, hopText) + hops.reduce((a, h) => a + (hitScore.get(h.key) || 0), 0);
  if (rel < 1.5) return null;

  // 5) which file to open first: the deepest hop that decides behaviour (prompt > runtime/service with selection > api)
  // prompt that chooses the steps > code that selects the path > the hop most about the question > where the request lands
  const named = hops
    .filter((h) => h.kind !== "ui" && h.kind !== "client")
    .map((h) => ({ h, s: overlap(terms, `${h.fn || ""} ${h.path.split("/").pop()}`) }))
    .sort((a, b) => b.s - a.s)[0];
  const decider =
    hops.find((h) => h.kind === "prompt") ||
    hops.find((h) => sel.some((s) => s.key === h.key)) ||
    (named && named.s > 0 ? named.h : undefined) ||
    hops.find((h) => h.kind === "api") ||
    hops[0];
  const why =
    decider.kind === "prompt" ? "it's the prompt that chooses the steps" :
    sel.some((s) => s.key === decider.key) ? "it decides which path/runtime the call takes" :
    decider.kind === "api" ? "it's where the request lands" : `\`${decider.fn ? decider.fn + "()" : decider.path.split("/").pop()}\` decides this behaviour`;

  if (entry && !entryIsUI) notes.push(uiLoaded ? `No UI file sends this request; the closest caller is backend code (${entry.path}).` : "No frontend/UI files are loaded, so the trace starts at the closest backend caller. Load the frontend repo to trace from the UI.");
  return { hops, entry, route, selects: dedupeSel(sel), uncalled: uncalled.slice(0, 3), stops, notes, openFirst: { path: decider.path, why }, uiLoaded };
}

type RuntimeEntry = { name: string; def: Def; how: string };

/** Find a runtime's entry point by name (folder/file mentions): POST /invocations route, @app.entrypoint, or /ws handler. */
function runtimeEntry(g: Graph, name: string): RuntimeEntry | undefined {
  const n = name.toLowerCase();
  const fileMentions = (key: string) => {
    const f = g.files.get(key)!;
    return f.path.toLowerCase().includes(n) || (g.lines.get(key) || []).slice(0, 40).some((l) => l.toLowerCase().includes(n));
  };
  const inv = g.routes.find((r) => /\/invocations$/.test(r.url) && fileMentions(r.key));
  if (inv?.handler) return { name, def: inv.handler, how: `${inv.method} ${inv.url}` };
  for (const [key, ls] of g.lines) {
    if (!fileMentions(key)) continue;
    const i = ls.findIndex((l) => /@\w+\.entrypoint\b|BedrockAgentCoreApp|exports\.handler|def\s+(lambda_)?handler\s*\(/.test(l));
    if (i < 0) continue;
    const def = g.defs.find((d) => d.key === key && d.start > i && d.start <= i + 4) || g.defs.find((d) => d.key === key && /handler|invoke|entry/i.test(d.name));
    if (def) return { name, def, how: /entrypoint/.test(ls[i]) ? "@app.entrypoint" : "handler" };
  }
  return undefined;
}

/** From selection lines like `engine: str = "mastra"` and `X if engine == "strands" else Y`, work out which runtime is chosen by default. */
function selectedRuntime(g: Graph, sel: Trace["selects"]) {
  const text = sel.map((s) => s.text).join("\n");
  const names = new Set<string>();
  for (const m of text.matchAll(/["']([a-z][\w-]{2,})["']/gi)) names.add(m[1].toLowerCase());
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9]+)_(?:RUNTIME|AGENT|ENGINE|ARN)\w*/g)) names.add(m[1].toLowerCase());
  const def = text.match(/\b(?:engine|runtime|provider|mode|agent)\b\s*(?::\s*\w+)?\s*=\s*["']([\w-]+)["']/i)?.[1]?.toLowerCase();
  const entries = [...names].map((n) => runtimeEntry(g, n)).filter(Boolean) as RuntimeEntry[];
  if (!entries.length) return null;
  const chosen = (def && entries.find((e) => e.name === def)) || entries[0];
  const other = entries.find((e) => e !== chosen && e.def.key !== chosen.def.key);
  const reason = def ? `selected because the default is "${def}"` : "selected by the branch above";
  return { chosen, other, reason };
}

function dedupeSel(s: Trace["selects"]) {
  const seen = new Set<string>();
  return s.filter((x) => (seen.has(`${x.key}:${x.line}`) ? false : (seen.add(`${x.key}:${x.line}`), true))).slice(0, 5);
}

/** Convert hops into display/LLM sources with focused line ranges. */
export function traceHits(index: Index, t: Trace): Hit[] {
  const g = getGraph(index);
  return t.hops.map((h) => {
    const ls = g.lines.get(h.key) || index.byKey.get(h.key)?.content.split(/\r?\n/) || [];
    let start = h.start, end = h.end;
    if (end - start > 45) {
      const f = h.focus.length ? h.focus : [start];
      start = Math.max(h.start, Math.min(...f) - 4);
      end = Math.min(h.end, Math.max(...f) + 6, start + 45);
    }
    const f = index.byKey.get(h.key);
    return {
      key: h.key, path: h.path, src: h.src, origin: f?.origin, doc: false,
      start, end, code: ls.slice(start - 1, end).join("\n"), score: 1, matched: [],
      focus: h.focus.filter((x) => x >= start && x <= end), hop: h.kind,
    } as Hit;
  });
}

/** Plain-text trace for the model. */
export function traceText(t: Trace, hopIndex: (i: number) => number): string {
  const lines: string[] = [];
  lines.push("STATIC TRACE (computed from the code; each hop = one source):");
  t.hops.forEach((h, i) => {
    lines.push(`Hop ${i + 1} [${h.kind.toUpperCase()}] source [${hopIndex(i)}] ${h.path}${h.fn ? ` :: ${h.fn}()` : ""} — ${h.label}. Action lines: ${h.focus.join(", ") || "n/a"}`);
  });
  if (t.selects.length) {
    lines.push("Selection logic found (which branch/runtime the call takes):");
    for (const s of t.selects) lines.push(`  ${s.path}:${s.line}: ${s.text}`);
  }
  if (t.uncalled.length) {
    lines.push(t.uiLoaded ? "Related routes that exist but NO request in the loaded code calls them (the current UI does not call them):" : "Related routes that no request in the loaded code calls (frontend not loaded, so UI usage is unknown):");
    for (const r of t.uncalled) lines.push(`  ${r.method} ${r.url} → ${r.handler && !r.handler.name.startsWith("(") ? r.handler.name + "()" : "inline handler"} in ${r.path}:${r.line}`);
  }
  for (const s of t.stops) lines.push(`Trace stop: ${s}`);
  for (const n of t.notes) lines.push(`Note: ${n}`);
  if (t.openFirst) lines.push(`Suggested file to open first: ${t.openFirst.path} (${t.openFirst.why})`);
  return lines.join("\n");
}

/** Answer built purely from the trace (no AI). */
export function traceAnswer(t: Trace): { answer: string; keyPoints: string[] } {
  const parts: string[] = [];
  const n = (i: number) => `[${i + 1}]`;
  const ui = t.hops.findIndex((h) => h.kind === "ui" || h.kind === "client");
  const api = t.hops.findIndex((h) => h.kind === "api");
  if (t.entry && ui >= 0 && t.hops[0].kind === "ui") {
    const first = t.hops[0];
    parts.push(`The current UI entry is \`${first.fn ? first.fn + "()" : first.path.split("/").pop()}\` in \`${first.path}\`${first.kind === "ui" && t.hops[1]?.kind === "client" ? `, which calls \`${t.hops[1].fn}()\`` : ""} and sends \`${t.entry.method} ${t.entry.url}\` ${n(t.hops[1]?.kind === "client" ? 1 : 0)}.`);
  }
  if (api >= 0 && t.route) parts.push(`\`${t.route.method} ${t.route.url}\` is handled by ${t.route.handler && !t.route.handler.name.startsWith("(") ? `\`${t.route.handler.name}()\`` : "an inline handler"} in \`${t.route.path}\` ${n(api)}.`);
  const kp: string[] = [];
  for (const nt of t.notes) if (/Other runtime/.test(nt)) kp.push(nt);
  for (const s of t.selects.slice(0, 2)) kp.push(`Selection at \`${s.path.split("/").pop()}:${s.line}\`: \`${s.text.slice(0, 110)}\``);
  for (const r of t.uncalled.slice(0, 2)) kp.push(t.uiLoaded ? `\`${r.method} ${r.url}\` still exists in \`${r.path.split("/").pop()}\`, but the current UI does not call it.` : `\`${r.method} ${r.url}\` exists in \`${r.path.split("/").pop()}\`; no loaded code calls it (frontend not loaded).`);
  for (const nt of t.notes.slice(0, 2)) if (!/hand-off|Other runtime/.test(nt)) kp.push(nt);
  for (const s of t.stops.slice(0, 1)) kp.push(s);
  if (!parts.length) parts.push(`The closest traced path starts at \`${t.hops[0].path}\` ${n(0)}.`);
  return { answer: parts.join(" "), keyPoints: kp.slice(0, 6) };
}
