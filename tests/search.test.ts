import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndex, search, correctTerms, tokenize } from "../lib/search";

const idx = buildIndex([
  { path: "mastra-poc/src/agentcore.ts", content: "export async function runSupervisor(input) {\n  return supervisor.generate(input);\n}\napp.post('/invocations', handler);" },
  { path: "agentcore-spike/main.py", content: "def strands_agent():\n    return Agent(tools=tools)\n" },
  { path: "api/routers/chat.py", content: 'def rule_builder_message(engine: str = "mastra"):\n    return invoke_runtime(engine)\n' },
  { path: "ec2_bridge.py", content: 'BRIDGE_PORT = int(os.getenv("BRIDGE_PORT", "8081"))\n' },
]);

test("tokenize: splits camelCase (dropping stopwords like get) and snake_case and keeps the joined form", () => {
  const t = tokenize("getUserPrefs rule_builder");
  for (const w of ["user", "pref", "getuserpref", "rule", "builder", "rulebuilder"]) assert.ok(t.includes(w), w);
});
test("tokenize: cache returns the same result on repeat calls", () => {
  assert.deepEqual(tokenize("invokeRuntime invokeRuntime"), tokenize("invokeRuntime invokeRuntime"));
});
test("correctTerms: mis-heard project name maps to the folder name", () => {
  assert.deepEqual(correctTerms(idx, "What does Maestro POC do?").find((f) => f.from === "maestro"), { from: "maestro", to: "mastra" });
});
test("correctTerms: known words are left alone", () => {
  assert.deepEqual(correctTerms(idx, "How does the supervisor run?"), []);
});
test("correctTerms: short words are never corrected", () => {
  assert.deepEqual(correctTerms(idx, "Is the API on?"), []);
});
test("correctTerms: caps unknown words at 3 per question", () => {
  const out = correctTerms(idx, "zzqa zzqb zzqc zzqd mastrra");
  // the fifth (real) typo is past the cap, so it isn't corrected
  assert.equal(out.length, 0);
});
test("correctTerms: typo fixes land on real identifiers", () => {
  assert.deepEqual(correctTerms(idx, "where is the supervsor"), [{ from: "supervsor", to: "supervisor" }]);
});
test("search: finds the file that defines a mis-heard name", () => {
  assert.equal(search(idx, "What does Maestro POC run?", 3)[0].path, "mastra-poc/src/agentcore.ts");
});
test("search: vs-question returns sources for both sides", () => {
  const paths = search(idx, "mastra vs strands", 4).map((h) => h.path);
  assert.ok(paths.includes("mastra-poc/src/agentcore.ts"));
  assert.ok(paths.includes("agentcore-spike/main.py"));
});
test("search: config values are retrievable by name", () => {
  assert.equal(search(idx, "What is the BRIDGE_PORT default?", 2)[0].path, "ec2_bridge.py");
});
test("search: boost lifts a file over an equal match", () => {
  const plain = search(idx, "invoke runtime engine", 4).map((h) => h.path);
  assert.equal(plain[0], "api/routers/chat.py");
  const boosted = search(idx, "agent", 4, { boost: new Set(["agentcore-spike/main.py"]) });
  assert.equal(boosted[0].path, "agentcore-spike/main.py");
});
