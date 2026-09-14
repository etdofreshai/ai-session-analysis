import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const originalExecFile = childProcess.execFile;
const originalEnv = { ...process.env };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-sync-"));
const snapshot = {
  version: 1, database: "/source/swarm.sqlite", generatedAt: "2026-09-14T04:00:00Z",
  diagnostics: { usageRows: 0, duplicateRows: 0, invalidRows: 0, unmeteredRows: 0 },
  buckets: [],
};
let mode = "ok";
let command;
try {
  Object.assign(process.env, {
    AI_REMOTE_CACHE: root, AI_DISABLE_LOCAL: "1", AI_REMOTE_HOSTS: "test=user@host",
    AI_SWARM_DATABASES: JSON.stringify({ test: "/source/with ' quote/swarm.sqlite" }),
    AI_SYNC_TTL_MS: "0",
  });
  childProcess.execFile = (file, args, opts, cb) => {
    if (file === "rsync") { cb(null, "", ""); return {}; }
    command = { file, args, opts };
    if (mode === "error") cb(new Error("source unavailable"), "", "");
    else cb(null, mode === "invalid" ? '{"version":2}' : JSON.stringify(snapshot), "");
    return {};
  };
  childProcess.execFile[promisify.custom] = (file, args, opts) =>
    new Promise((resolve, reject) => childProcess.execFile(file, args, opts,
      (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
  await build({
    entryPoints: [new URL("../server/sync.ts", import.meta.url).pathname],
    outfile: path.join(root, "sync.cjs"), bundle: true, platform: "node", format: "cjs",
  });
  const sync = require(path.join(root, "sync.cjs"));
  const refresh = async () => {
    sync.ensureSynced();
    await new Promise(resolve => setImmediate(resolve));
    return sync.statusList().find(s => s.id === "test:swarm");
  };
  assert.equal((await refresh()).ok, true);
  assert.equal(command.file, "ssh");
  assert.match(command.args.at(-1), /--swarm-export/);
  assert.match(command.args.at(-1), /'\\''/);
  const file = path.join(root, "test", "swarm-usage.json");
  const saved = fs.readFileSync(file, "utf8");
  const successAt = sync.statusList().find(s => s.id === "test:swarm").lastSyncMs;
  mode = "error";
  const failure = await refresh();
  assert.equal(failure.ok, false);
  assert.equal(failure.lastSyncMs, successAt);
  assert.match(failure.error, /source unavailable/);
  assert.equal(fs.readFileSync(file, "utf8"), saved);
  assert.equal(sync.statusList().find(s => s.id === "test").ok, true);
  mode = "invalid";
  assert.equal((await refresh()).ok, false);
  assert.equal(fs.readFileSync(file, "utf8"), saved);
  mode = "ok";
  assert.equal((await refresh()).ok, true);
  assert.equal(fs.existsSync(file + ".tmp"), false);
  console.log("PASS: independent source health, quoting, snapshot replacement, failure retention and recovery.");
} finally {
  childProcess.execFile = originalExecFile;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(root, { recursive: true, force: true });
}
