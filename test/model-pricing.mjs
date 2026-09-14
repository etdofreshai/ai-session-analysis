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
