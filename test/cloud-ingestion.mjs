import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";

const bundled = await build({ entryPoints: ["server/codex-scanner.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { parseCodexTranscript, codexSessionDetail } = await import(
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
const detail = codexSessionDetail("00000000-0000-0000-0000-000000000001", path.dirname(file), "codex-cloud");
assert.equal(detail.session.cloudPlanUsage.weeklyLimitPercent, 14.97);
assert.equal(detail.timeline.filter(e => e.kind === "assistant").length, 1);
assert.equal(Object.keys(detail.session.dailyUsage).length, 1);
console.log("PASS: cloud history, cumulative snapshot, live-call costs and timeline stay distinct.");
