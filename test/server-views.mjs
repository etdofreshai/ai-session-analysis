// Server views must equal the old in-browser aggregation for the same data, pricing and time.
// STATS_FILE=<saved /api/stats JSON> runs it against real data; default is a small synthetic set.
import assert from "node:assert/strict";
import fs from "node:fs";
import { build } from "esbuild";

const out = await build({
  stdin: {
    contents: `export * from "./server/views.ts"; export * as agg from "./src/aggregate.ts"; export { DEFAULT_PRICING } from "./src/pricing.ts";`,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false,
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
const { agg } = m;

const now = Math.floor(Date.now() / 60_000) * 60_000;
const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13);
const usage = (n) => ({ calls: 1, input: n, output: n, cacheRead: n, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0 });
const stats = process.env.STATS_FILE ? JSON.parse(fs.readFileSync(process.env.STATS_FILE, "utf8")) : {
  generatedAt: "", scanMs: 0, root: "", hosts: [], sync: [],
  projects: [{ name: "p", host: "h", displayPath: "/x/p", sessions: [0, 3, 50, 400].map((ageH, i) => {
    const ts = new Date(now - ageH * 3_600_000).toISOString();
    const h = { [hourKey(now - ageH * 3_600_000)]: { "claude-opus-5": usage(1000 * (i + 1)) } };
    return {
      id: `s${i}`, host: "h", project: "p", file: "", source: i % 2 ? "codex" : "claude", sizeBytes: 1,
      title: `title ${i}`, lastPrompt: "x".repeat(i * 200), agentName: null, firstTs: ts, lastTs: ts,
      durationMs: i, version: null, gitBranch: null, cwd: null, entrypoint: null, permissionModes: [],
      effortModes: [], counts: { records: 1, userPrompts: i, toolResults: 0, assistantMsgs: 1, toolUses: i,
        attachments: 0, system: 0, apiErrors: 0, sidechain: 0 },
      models: h[hourKey(now - ageH * 3_600_000)], toolCalls: { Bash: i + 1 }, subagents: [], recordTypes: {},
      hourlyUsage: h, dailyUsage: { [ts.slice(0, 10)]: h[hourKey(now - ageH * 3_600_000)] },
    };
  }) }],
};
const edited = { ...m.DEFAULT_PRICING, "claude-opus-5": { input: 1, output: 2, cacheRead: 3, cacheWrite5m: 0, cacheWrite1h: 0 } };

for (const [pricingRaw, table] of [[null, m.DEFAULT_PRICING], [JSON.stringify(edited), edited]]) {
  const ctx = { snap: { stats, generation: "g" }, pricing: m.parsePricing(pricingRaw), now };
  const flat = agg.flatten(stats, table, now);
  for (const [gran, ranges] of [["day", agg.RANGES], ["hour", agg.HOUR_RANGES]]) for (const r of ranges) {
    const fromMs = r.windowMs == null ? null : now - r.windowMs;
    const got = m.overview(ctx, { gran, range: r.key });
    assert.deepEqual(got.totals, agg.windowTotals(flat, table, fromMs), `${gran} ${r.key} totals`);
    assert.deepEqual(got.buckets, gran === "hour" ? agg.byHour(flat, table, fromMs) : agg.byDay(flat, table, fromMs), `${gran} ${r.key} buckets`);
    assert.deepEqual(got.models, agg.costByModel(flat, table, fromMs), `${gran} ${r.key} models`);
    assert.deepEqual(got.projects, agg.costByProject(flat, table, fromMs).slice(0, 12), `${gran} ${r.key} projects`);
    assert.deepEqual(got.tools, agg.topTools(flat, 15, fromMs), `${gran} ${r.key} tools`);
    assert.equal(got.costLastHour, flat.reduce((a, s) => a + s.costLastHour, 0));
    if (gran === "day" && (r.key === "all" || r.key === "1m"))
      console.log(`${pricingRaw ? "edited" : "default"} ${r.key}: $${got.totals.cost.toFixed(2)}, ${got.totals.sessions} sessions, ${got.buckets.length} buckets, ${got.models.length} models`);
  }
  // Sessions page: same order as the old table sort, only the requested slice, truncated prompts.
  const page = m.sessionsPage(ctx, { sort: "cost", desc: true, q: "", windowMs: 3_600_000, offset: 0, limit: 50 });
  const expected = [...flat].sort((a, b) => (b.cost + b.subagentCost) - (a.cost + a.subagentCost)).slice(0, 50);
  assert.equal(page.total, flat.length);
  assert.deepEqual(page.rows.map((r) => agg.sessionIdentity(r)), expected.map(agg.sessionIdentity));
  assert.ok(page.rows.every((r) => !r.lastPrompt || r.lastPrompt.length <= 241));
}
assert.equal(m.parsePricing(JSON.stringify(m.DEFAULT_PRICING)).key, "default");
assert.throws(() => m.parsePricing('{"x":{"input":-1}}'));
console.log("PASS: server views match client aggregation for every range, default and edited pricing.");
