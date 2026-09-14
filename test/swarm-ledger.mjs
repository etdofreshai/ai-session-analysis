import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const { exportSwarm } = require("../server/export-swarm.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-ledger-"));
const database = path.join(root, "swarm.sqlite");
const db = new DatabaseSync(database);
try {
  db.exec(`
    CREATE TABLE swarms(id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE agents(id TEXT PRIMARY KEY, swarmId TEXT, name TEXT);
    CREATE TABLE provider_costs(requestId TEXT,attempt INTEGER,swarmId TEXT,
      owner TEXT,kind TEXT,model TEXT,generationId TEXT,usage TEXT,createdAt TEXT,
      PRIMARY KEY(requestId,attempt));
    INSERT INTO swarms VALUES('board-a','Board A'),('board-b','Board B');
    INSERT INTO agents VALUES('agent-a','board-a','Worker A');
  `);
  const insert = db.prepare("INSERT INTO provider_costs VALUES(?,?,?,?,?,?,?,?,?)");
  const usage = (input, cached, output) => ({
    input_tokens: input, input_tokens_details: { cached_tokens: cached }, output_tokens: output,
  });
  function row(id, attempt, generation, u, ts, board = "board-a", owner = "agent-a",
    model = "gpt-5.6-luna") {
    insert.run(id, attempt, board, owner, "peer", model, generation,
      u === null ? null : JSON.stringify(u), ts);
  }
  row("request-1", 1, "gen-1", usage(100, 40, 10), "2026-09-13T04:59:00Z");
  row("duplicate", 1, "gen-1", usage(200, 100, 20), "2026-09-13T04:59:30Z");
  row("request-1", 2, "gen-2", usage(300, 50, 30), "2026-09-13T05:00:00Z");
  row("empty", 1, "gen-1", null, "2026-09-13T05:01:00Z");
  row("fallback", 1, null, usage(50, 0, 2), "2026-09-13T06:00:00Z");
  row("fallback", 2, null, usage(70, 0, 3), "2026-09-13T07:00:00Z");
  row("other", 1, "gen-3", {
    input_tokens: 80, output_tokens: 8, cache_read_input_tokens: 20,
    cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 5 },
  }, "2026-09-13T08:00:00Z", "board-b", "setup", "deepseek/deepseek-v4.1-flash");

  const snapshot = exportSwarm(database);
  assert.deepEqual(snapshot.diagnostics, {
    usageRows: 6, duplicateRows: 1, invalidRows: 0, unmeteredRows: 1,
  });
  assert.equal(snapshot.buckets.length, 5);
  assert.equal(snapshot.buckets[0].usage.input, 100);
  const anthropic = snapshot.buckets.find(b => b.model.startsWith("deepseek"));
  assert.equal(anthropic.usage.input, 80);
  assert.equal(anthropic.usage.cacheRead, 20);
  assert.equal(anthropic.usage.cacheWrite5m, 10);
  assert.equal(anthropic.usage.cacheWrite1h, 5);

  const code = fs.readFileSync(new URL("../server/export-swarm.cjs", import.meta.url), "utf8");
  const cliSnapshot = JSON.parse(execFileSync(process.execPath,
    ["--input-type=commonjs", "-e", code, "--", "--swarm-export", database],
    { encoding: "utf8" }));
  assert.deepEqual(cliSnapshot.buckets, snapshot.buckets);
  await build({
    entryPoints: [new URL("../server/swarm-scanner.ts", import.meta.url).pathname],
    outfile: path.join(root, "scanner.cjs"), bundle: true, platform: "node", format: "cjs",
  });
  const { parseSwarmSnapshot, swarmProjects, scanSwarmAll, swarmSessionDetail } =
    require(path.join(root, "scanner.cjs"));
  const projects = swarmProjects(parseSwarmSnapshot(JSON.stringify(snapshot)), "test-host");
  assert.equal(projects.length, 2);
  const session = projects[0].sessions[0];
  assert.equal(session.source, "swarm");
  assert.equal(session.title, "Board A / Worker A");
  assert.equal(session.counts.userPrompts, 0);
  assert.equal(session.counts.assistantMsgs, 0);
  assert.equal(session.models["gpt-5.6-luna"].calls, 4);
  assert.equal(session.dailyUsage["2026-09-12"]["gpt-5.6-luna"].input, 100);
  assert.equal(session.dailyUsage["2026-09-13"]["gpt-5.6-luna"].input, 370);
  const file = path.join(root, "snapshot.json");
  fs.writeFileSync(file, JSON.stringify(snapshot));
  assert.equal(scanSwarmAll(file, "test-host")[0].sessions[0].id, session.id);
  assert.equal(swarmSessionDetail(session.id, file, "test-host").session.id, session.id);
  assert.equal(swarmSessionDetail("missing", file, "test-host"), null);
  assert.deepEqual(scanSwarmAll(undefined, "test-host"), []);
  assert.throws(() => parseSwarmSnapshot('{"version":2,"buckets":[]}'));
  const bad = structuredClone(snapshot);
  bad.buckets[0].usage.input = -1;
  assert.throws(() => parseSwarmSnapshot(JSON.stringify(bad)));

  // Refreshes replace snapshots, not accumulate them, and pick up late updates.
  db.prepare("UPDATE provider_costs SET usage=? WHERE requestId='fallback' AND attempt=2")
    .run(JSON.stringify(usage(90, 0, 4)));
  const updated = exportSwarm(database);
  const again = swarmProjects(updated, "test-host")[0].sessions[0];
  assert.equal(again.models["gpt-5.6-luna"].calls, 4);
  assert.equal(again.models["gpt-5.6-luna"].input, 490);
  assert.equal(db.prepare("SELECT count(*) n FROM provider_costs").get().n, 7);
  db.prepare("UPDATE provider_costs SET usage='not-json' WHERE requestId='other'").run();
  assert.equal(exportSwarm(database).diagnostics.invalidRows, 1);
  assert.throws(() => exportSwarm(path.join(root, "missing.sqlite")));
  assert.equal(fs.existsSync(path.join(root, "missing.sqlite")), false);
  console.log("PASS: read-only export, generation/attempt dedup, late updates, token formats, CT days, source separation and drill-down.");
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
