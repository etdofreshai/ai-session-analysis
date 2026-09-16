import assert from "node:assert/strict";
import { build } from "esbuild";

const result = await build({
  entryPoints: ["src/pricing.ts"], bundle: true, platform: "node",
  format: "esm", write: false,
});
const { DEFAULT_PRICING, pricingFor, usageCost, loadPricing } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
);
const glm = { input: 0.15, output: 0.50, cacheRead: 0.03, cacheWrite5m: 0, cacheWrite1h: 0 };
const muse = { input: 0.10, output: 0.20, cacheRead: 0.002, cacheWrite5m: 0, cacheWrite1h: 0 };
for (const name of ["glm-5.3-flash", "zai-coding/glm-5.3-flash", "opencode/glm-5.3-flash"]) {
  assert.deepEqual(pricingFor(name, DEFAULT_PRICING), glm);
}
for (const prefix of ["", "opencode/", "opencode-free-responses/"]) {
  for (const suffix of ["", "-free"]) {
    assert.deepEqual(pricingFor(`${prefix}muse-spark-1.3-contributor${suffix}`, DEFAULT_PRICING), muse);
  }
}
const usage = { calls: 1, input: 1e6, output: 1e6, cacheRead: 1e6,
  cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0 };
assert.ok(Math.abs(usageCost("glm-5.3-flash", usage, DEFAULT_PRICING) - 0.68) < 1e-12);
assert.ok(Math.abs(usageCost("muse-spark-1.3-contributor", usage, DEFAULT_PRICING) - 0.302) < 1e-12);
assert.deepEqual(pricingFor("glm-4.7", DEFAULT_PRICING), DEFAULT_PRICING["glm-"]);
// Claude 5-series rates, plain and as CLIProxyAPI records them in Codex sessions.
const opus5 = { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 };
const sonnet5 = { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 };
const fable51 = { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 };
for (const prefix of ["", "cliproxyapi/"]) {
  assert.deepEqual(pricingFor(`${prefix}claude-opus-5`, DEFAULT_PRICING), opus5);
  assert.deepEqual(pricingFor(`${prefix}claude-sonnet-5`, DEFAULT_PRICING), sonnet5);
  assert.deepEqual(pricingFor(`${prefix}claude-fable-5-1`, DEFAULT_PRICING), fable51);
  assert.deepEqual(pricingFor(`${prefix}claude-mythos-5-1`, DEFAULT_PRICING), fable51);
}
// 5.1 must win over the shorter "claude-fable-5" row, which keeps 0.1x cache reads.
assert.equal(pricingFor("claude-fable-5", DEFAULT_PRICING).cacheRead, 1);
assert.equal(pricingFor("claude-mythos-5", DEFAULT_PRICING).cacheRead, 1);
// Older families must not be captured by the new 5-series rows.
assert.deepEqual(pricingFor("claude-opus-4-8", DEFAULT_PRICING), DEFAULT_PRICING["claude-opus-4"]);
assert.deepEqual(pricingFor("claude-sonnet-4-6", DEFAULT_PRICING), DEFAULT_PRICING["claude-sonnet-4"]);
// An old saved full table must not mask new, model-specific defaults.
globalThis.localStorage = {
  getItem: () => JSON.stringify({ "glm-": DEFAULT_PRICING["glm-"], "*": DEFAULT_PRICING["*"] }),
};
assert.deepEqual(pricingFor("glm-5.3-flash", loadPricing()), glm);
assert.deepEqual(pricingFor("opencode-free-responses/muse-spark-1.3-contributor-free", loadPricing()), muse);
// Explicit user overrides retain precedence.
globalThis.localStorage.getItem = () => JSON.stringify({ "glm-5.3-flash": { ...glm, input: 2 } });
assert.equal(pricingFor("glm-5.3-flash", loadPricing()).input, 2);
console.log("PASS: GLM Flash and Muse contributor rates, provider aliases, costs and saved pricing.");
