// 9gate combo turns ("auto") are attributed to the model 9gate says it routed to.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const out = await build({ entryPoints: ["server/codex-scanner.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { parseCodexTranscript } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const usage = (n) => ({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: n, output_tokens: 1 } } } });
const turn = (model) => ({ type: "turn_context", payload: { model } });
const notice = (text) => ({ type: "response_item", payload: { type: "message", role: "assistant", id: "msg_9gate_jev_x", content: [{ type: "output_text", text }] } });
const lines = [
  turn("auto"), usage(1),                                  // before any notice: stays "auto"
  notice("Auto: cc/claude-opus-5 · high · Claude only"), usage(10),
  turn("auto"), usage(100),                                // silent repeat keeps the pick
  notice("Jev: cx/gpt-5.6-sol · medium · d1.2 c81% waiting"), usage(1000),
  turn("gpt-5.5"), usage(10000),                           // declared model change clears the pick
].map((o, i) => JSON.stringify({ timestamp: new Date(Date.UTC(2026, 8, 23, 12, i)).toISOString(), ...o })).join("\n");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-routed-"));
try {
  const file = path.join(dir, "rollout-2026-09-23T12-00-00-00000000-0000-0000-0000-000000000000.jsonl");
  fs.writeFileSync(file, lines + "\n");
  const s = parseCodexTranscript(file);
  const inputs = Object.fromEntries(Object.entries(s.models).map(([m, u]) => [m, u.input]));
  assert.deepEqual(inputs, { auto: 1, "claude-opus-5": 110, "gpt-5.6-sol": 1000, "gpt-5.5": 10000 });
  console.log("PASS: 9gate routed models replace combo names; picks carry over and reset on model change.");
} finally {
  fs.rmSync(dir, { recursive: true });
}
