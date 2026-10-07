import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const bundled = await build({ entryPoints: ["server/codex-scanner.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { parseCodexTranscript, codexSessionDetail, scanCodexAll } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);
const file = path.resolve("test/fixtures/rollout-cloud-00000000-0000-0000-0000-000000000001.jsonl");
const parsed = parseCodexTranscript(file);
assert.equal(parsed.title, "Cloud history");
assert.equal(parsed.assistantMsgs, 1);
assert.deepEqual(parsed.models["gpt-6.1-sol"], {
  calls: 1, input: 20, output: 10, cacheRead: 80, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0,
});
assert.equal(parsed.cloudUsageCoverage.total.totalTokens, 11000);
const detail = codexSessionDetail("00000000-0000-0000-0000-000000000001", path.dirname(file), "cloud");
// The fixture runs in a connected workspace, so it belongs to "cloud", not "dot".
assert.equal(codexSessionDetail("00000000-0000-0000-0000-000000000001", path.dirname(file), "dot"), null);
assert.equal(detail.session.cloudPlanUsage.weeklyLimitPercent, 14.97);
assert.equal(detail.timeline.filter(e => e.kind === "assistant").length, 1);
assert.equal(Object.keys(detail.session.dailyUsage).length, 1);
// Dot threads (hosted /workspace/scratch sandboxes) appear only under "dot".
const split = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-split-"));
try {
  fs.copyFileSync(file, path.join(split, path.basename(file)));
  const dot = fs.readFileSync(file, "utf8").replaceAll("00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002")
    .replace('"cwd":"/cloud/task"', '"cwd":"/workspace/scratch/bb67cde2a3d0"');
  fs.writeFileSync(path.join(split, "rollout-cloud-00000000-0000-0000-0000-000000000002.jsonl"), dot);
  const ids = (host) => scanCodexAll(split, host).flatMap((p) => p.sessions.map((s) => s.id.slice(-1)));
  assert.deepEqual([ids("cloud"), ids("dot")], [["1"], ["2"]]);
} finally {
  fs.rmSync(split, { recursive: true });
}
console.log("PASS: cloud/dot split, cloud history, cumulative snapshot, live-call costs and timeline stay distinct.");
