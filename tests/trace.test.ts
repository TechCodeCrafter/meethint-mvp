import { test } from "node:test";
import assert from "node:assert/strict";
import { normUrl, matchScore, pyDefs, jsDefs, focusWindow, type Req, type Route } from "../lib/trace";

const req = (method: string, url: string, ws = false): Req => ({ key: "k", path: "ui/api.ts", line: 1, method, url: normUrl(url), raw: url, ws });
const route = (method: string, url: string): Route => ({ key: "r", path: "api/routes.py", line: 1, method, url: normUrl(url), framework: "fastapi" });
const file = (path: string) => ({ path, content: "" });

// ---------- normUrl ----------
test("normUrl: template literal params become {}", () => {
  assert.equal(normUrl("/api/v1/chat/${sessionId}/message"), "/api/v1/chat/{}/message");
});
test("normUrl: FastAPI {param} and Express :param both normalize", () => {
  assert.equal(normUrl("/chat/{session_id}/message"), "/chat/{}/message");
  assert.equal(normUrl("/chat/:sessionId/message"), "/chat/{}/message");
});
test("normUrl: strips origin, query string and hash", () => {
  assert.equal(normUrl("https://api.example.com/v1/items?limit=5#top"), "/v1/items");
  assert.equal(normUrl("wss://bridge.local/ws"), "/ws");
});
test("normUrl: Next.js [param] and [...slug] segments", () => {
  assert.equal(normUrl("/api/users/[id]"), "/api/users/{}");
  assert.equal(normUrl("/docs/[...slug]"), "/docs/{}");
});
test("normUrl: collapses slashes, drops trailing slash, adds leading slash", () => {
  assert.equal(normUrl("api//stream/"), "/api/stream");
  assert.equal(normUrl("/"), "/");
});
test("normUrl: a URL starting with a base variable keeps {} first", () => {
  assert.equal(normUrl("${BASE}/stream"), "{}/stream");
});

// ---------- matchScore ----------
test("matchScore: same method + identical path matches", () => {
  assert.ok(matchScore(req("POST", "/stream"), route("POST", "/stream")) > 0);
});
test("matchScore: different method never matches", () => {
  assert.equal(matchScore(req("GET", "/stream"), route("POST", "/stream")), 0);
});
test("matchScore: client base prefix still matches by suffix", () => {
  assert.ok(matchScore(req("POST", "${API}/chat/rule-builder/message"), route("POST", "/api/v1/chat/rule-builder/message")) > 0);
});
test("matchScore: exact-length match beats suffix-only", () => {
  const exact = matchScore(req("POST", "/api/v1/chat/x"), route("POST", "/api/v1/chat/x"));
  const suffix = matchScore(req("POST", "/chat/x"), route("POST", "/api/v1/chat/x"));
  assert.ok(exact > suffix && suffix > 0);
});
test("matchScore: all-wildcard routes don't match (no literal segment)", () => {
  assert.equal(matchScore(req("GET", "/users/${id}"), route("GET", "/{a}/{b}")), 0);
});
test("matchScore: a literal mismatch anywhere in the suffix fails", () => {
  assert.equal(matchScore(req("POST", "/chat/{}/message"), route("POST", "/chat/{}/messages")), 0);
});
test("matchScore: WebSocket requests only match WS routes", () => {
  assert.equal(matchScore(req("WS", "/ws", true), route("GET", "/ws")), 0);
  assert.ok(matchScore(req("WS", "/ws", true), route("WS", "/ws")) > 0);
});
test("matchScore: ANY method routes accept any request method", () => {
  assert.ok(matchScore(req("DELETE", "/items/{}"), route("ANY", "/items/{}")) > 0);
});

// ---------- pyDefs ----------
const py = (src: string) => pyDefs(file("a.py"), "a.py", src.split("\n"));
test("pyDefs: top-level def spans its indented body", () => {
  const d = py("import x\n\ndef handle(req):\n    a = 1\n    return a\n\nX = 2");
  assert.deepEqual(d.map((x) => [x.name, x.start, x.end]), [["handle", 3, 5]]);
});
test("pyDefs: async def and decorated routes", () => {
  const d = py('@router.post("/stream")\nasync def stream(body: Body):\n    return await go(body)\n');
  assert.equal(d[0].name, "stream");
  assert.equal(d[0].start, 2);
  assert.equal(d[0].end, 3);
});
test("pyDefs: methods inside a class are separate defs", () => {
  const d = py("class S:\n    def a(self):\n        return 1\n\n    def b(self):\n        return 2\n");
  assert.deepEqual(d.map((x) => [x.name, x.start, x.end]), [["a", 2, 3], ["b", 5, 6]]);
});
test("pyDefs: multi-line signature with closing paren at def indent", () => {
  const d = py("def build(\n    a,\n    b,\n):\n    return a + b\nNEXT = 1");
  assert.equal(d[0].end, 5);
});
test("pyDefs: blank lines inside the body don't end it", () => {
  const d = py("def f():\n    x = 1\n\n    y = 2\n    return x + y\n");
  assert.equal(d[0].end, 5);
});

// ---------- jsDefs (brace matching) ----------
const js = (src: string) => jsDefs(file("a.ts"), "a.ts", src.split("\n"));
test("jsDefs: function, arrow const and object method", () => {
  const d = js("export async function send(a) {\n  return a;\n}\nconst go = async (x) => {\n  return x;\n};\nconst api = {\n  run: async () => {\n    return 1;\n  },\n};");
  assert.deepEqual(d.map((x) => x.name), ["send", "go", "run"]);
  assert.deepEqual([d[0].start, d[0].end], [1, 3]);
});
test("jsDefs: braces inside strings don't break the body end", () => {
  const d = js('function f() {\n  const s = "}{";\n  return s;\n}\nfunction g() {}');
  assert.equal(d[0].end, 4);
});

// ---------- focusWindow ----------
test("focusWindow: short defs are shown whole", () => {
  assert.deepEqual(focusWindow(10, 40, [20]), { start: 10, end: 40 });
});
test("focusWindow: long defs narrow around the action lines", () => {
  assert.deepEqual(focusWindow(1, 200, [100, 104]), { start: 96, end: 110 });
});
test("focusWindow: window is clamped to the def and to 45 lines", () => {
  const w = focusWindow(50, 300, [52, 250]);
  assert.equal(w.start, 50);
  assert.ok(w.end - w.start <= 45);
});
test("focusWindow: no focus lines → starts at the def", () => {
  assert.deepEqual(focusWindow(5, 120, []), { start: 5, end: 11 });
});
