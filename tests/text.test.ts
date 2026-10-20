import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicate, questionSimilarity } from "../lib/dedupe";
import { splitTldr } from "../lib/tldr";
import { verifyCitations } from "../lib/verify";
import { partialAnswer } from "../lib/llm";
import { cleanCites } from "../lib/ai-core";
import { updateMomentum, momentumBoost } from "../lib/momentum";

const now = 1_000_000;
test("dedupe: re-transcribed variant of the same question is a duplicate", () => {
  const recent = [{ q: "What is the Maestro POC responsible for?", at: now - 20_000 }];
  assert.equal(findDuplicate("what's mastra-poc responsible for", recent, now), 0);
});
test("dedupe: filler words and punctuation don't matter", () => {
  assert.ok(questionSimilarity("So, um, how does the retry logic work?", "How does retry logic work") >= 0.9);
});
test("dedupe: different subjects are not duplicates", () => {
  const recent = [{ q: "How does billing retry work?", at: now - 5_000 }];
  assert.equal(findDuplicate("How does auth token refresh work?", recent, now), -1);
});
test("dedupe: same shape, different file is not a duplicate", () => {
  assert.ok(questionSimilarity("What does chat.py do?", "What does api.py do?") < 0.6);
});
test("dedupe: outside the 90s window it's a new question", () => {
  const recent = [{ q: "Where is BRIDGE_PORT set?", at: now - 120_000 }];
  assert.equal(findDuplicate("Where is BRIDGE_PORT set?", recent, now), -1);
});
test("dedupe: shorter restatement contained in the longer one", () => {
  const recent = [{ q: "Where do we store user preferences and how are they loaded?", at: now - 10_000 }];
  assert.equal(findDuplicate("Where do we store user preferences?", recent, now), 0);
});

test("tldr: short answers are not split", () => {
  assert.deepEqual(splitTldr("It uses `BRIDGE_PORT` [1]."), ["It uses `BRIDGE_PORT` [1].", ""]);
});
test("tldr: first sentence (with its citation) becomes the TL;DR", () => {
  const t = "The Lambda calls `POST /stream` on the EC2 bridge, which forwards to AgentCore over a WebSocket [1]. It uses the instance role because the SCP blocks direct calls from Lambda [2]. The port defaults to 8081 [1].";
  const [a, b] = splitTldr(t);
  assert.ok(a.endsWith("[1]."));
  assert.ok(b.startsWith("It uses"));
});
test("tldr: dots inside backticked file names don't split", () => {
  const t = "`api/routers/chat.py` is the front door for sessions, uploads, documents and results, and it picks the engine with a default of `mastra` [1]. Strands is the rollback path selected with `engine=strands` [2].";
  assert.ok(splitTldr(t)[0].startsWith("`api/routers/chat.py` is the front door"));
});

const SRC: Record<number, { path: string; content: string }> = {
  1: { path: "rdb/ec2_bridge.py", content: 'BRIDGE_PORT = int(os.getenv("BRIDGE_PORT", "8081"))\n@app.post("/stream")\nasync def stream(): ...' },
  2: { path: "rdb/mastra-poc/src/agentcore.ts", content: "app.post('/invocations', h); app.get('/ping', p);" },
};
test("verify: claims whose names appear in the cited source pass", () => {
  assert.deepEqual(verifyCitations(["The bridge listens on `BRIDGE_PORT` (default `8081`) and serves `POST /stream` [1]."], (n) => SRC[n]), []);
});
test("verify: a name missing from the cited source is flagged", () => {
  const u = verifyCitations(["The container serves `/invocations` and `/ws` on port `8080` [2]."], (n) => SRC[n]);
  assert.equal(u.length, 1);
  assert.deepEqual(u[0].terms, ["/ws", "8080"]);
});
test("verify: file paths match by suffix", () => {
  assert.deepEqual(verifyCitations(["See `mastra-poc/src/agentcore.ts` [2]."], (n) => SRC[n]), []);
});
test("verify: sentences without citations or backticks are not judged", () => {
  assert.deepEqual(verifyCitations(["It is a FastAPI proxy. It uses `nothing_here`."], (n) => SRC[n]), []);
});

test("partialAnswer: reads the answer field from an unfinished JSON stream", () => {
  assert.equal(partialAnswer('{"answer": "The bridge forwards \\"POST'), 'The bridge forwards "POST');
  assert.equal(partialAnswer('{"keyPoints": ['), "");
});
test("cleanCites: comma lists become separate markers; bracketed file lists drop", () => {
  assert.equal(cleanCites("Uses the bridge [1, 2]. [Sources: ec2_bridge.py]"), "Uses the bridge [1][2].");
});
test("momentum: repeated files build up, old ones decay away", () => {
  let m = updateMomentum(new Map(), ["a.py", "b.py"]);
  m = updateMomentum(m, ["a.py"]);
  assert.deepEqual([...momentumBoost(m)], ["a.py"]);
  for (let i = 0; i < 6; i++) m = updateMomentum(m, []);
  assert.equal(m.size, 0);
});
