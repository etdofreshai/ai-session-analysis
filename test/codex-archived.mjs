// Archived Codex threads are scanned, and a thread copied from both sessions/
// and archived/ counts once (newest copy wins).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const out = await build({ entryPoints: ["server/codex-scanner.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { scanCodexAll } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-archived-"));
try {
  const write = (rel, prompts, mtime) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, prompts.map((m, i) => JSON.stringify({
      timestamp: new Date(Date.UTC(2026, 9, 1, 12, i)).toISOString(),
      type: "event_msg", payload: { type: "user_message", message: m },
    })).join("\n") + "\n");
    fs.utimesSync(file, mtime, mtime);
  };
  const a = "rollout-2026-10-01T12-00-00-aaaaaaaa-0000-0000-0000-000000000000.jsonl";
  const b = "rollout-2026-10-01T13-00-00-bbbbbbbb-0000-0000-0000-000000000000.jsonl";
  write(`2026/10/01/${a}`, ["one"], 1000);              // synced before archiving
  write(`archived/${a}`, ["one", "two"], 2000);         // same thread, archived later
  write(`archived/${b}`, ["only archived"], 1500);
  const sessions = scanCodexAll(root, "h").flatMap((p) => p.sessions);
  assert.deepEqual(sessions.map((s) => [s.id.slice(0, 8), s.counts.userPrompts]).sort(),
    [["aaaaaaaa", 2], ["bbbbbbbb", 1]]);
  console.log("PASS: archived Codex threads scanned once, newest copy wins.");
} finally {
  fs.rmSync(root, { recursive: true });
}
