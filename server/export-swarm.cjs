// Executed on the database host over SSH. Keep dependency-free: no installation
// or source writes are required, and SQLite reads the live WAL consistently.
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const os = require("node:os");

function exportSwarm(database) {
  const dbPath = path.isAbsolute(database) ? database :
    path.join(os.homedir(), database.replace(/^~\//, ""));
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN");
    const rows = db.prepare(`
      SELECT c.requestId, c.attempt, c.swarmId, c.owner, c.kind, c.model,
        c.generationId, c.usage, c.createdAt, s.name board, a.name agent
      FROM provider_costs c
      LEFT JOIN swarms s ON s.id=c.swarmId
      LEFT JOIN agents a ON a.id=c.owner AND a.swarmId=c.swarmId
      WHERE c.usage IS NOT NULL
      ORDER BY c.createdAt, c.requestId, c.attempt
    `);
    const generations = new Map();
    const diagnostics = { usageRows: 0, duplicateRows: 0, invalidRows: 0, unmeteredRows: 0 };
    diagnostics.unmeteredRows = db.prepare(
      "SELECT count(*) n FROM provider_costs WHERE usage IS NULL"
    ).get().n;
    for (const row of rows.iterate()) {
      diagnostics.usageRows++;
      let u;
      try { u = JSON.parse(row.usage); } catch { diagnostics.invalidRows++; continue; }
      const input = u?.input_tokens ?? u?.prompt_tokens;
      const output = u?.output_tokens ?? u?.completion_tokens;
      const cache = u?.input_tokens_details?.cached_tokens ??
        u?.prompt_tokens_details?.cached_tokens ?? u?.cache_read_input_tokens ?? 0;
      const cache5m = u?.cache_creation?.ephemeral_5m_input_tokens ??
        u?.cache_creation_input_tokens ?? u?.input_tokens_details?.cache_write_tokens ?? 0;
      const cache1h = u?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      if (![input, output, cache, cache5m, cache1h].every(
        n => Number.isSafeInteger(n) && n >= 0
      ) || !Number.isFinite(Date.parse(row.createdAt))) {
        diagnostics.invalidRows++;
        continue;
      }
      // Responses/Chat include cache in input; Anthropic-compatible messages
      // report uncached input separately from cache reads/writes.
      const inclusive = u.input_tokens_details != null || u.prompt_tokens != null;
      const usage = {
        calls: 1,
        input: inclusive ? Math.max(0, input - cache - cache5m - cache1h) : input,
        output, cacheRead: cache, cacheWrite5m: cache5m, cacheWrite1h: cache1h,
        webSearch: u?.server_tool_use?.web_search_requests ?? 0,
      };
      const key = row.generationId
        ? JSON.stringify(["generation", row.model, row.generationId])
        : JSON.stringify(["attempt", row.requestId, row.attempt]);
      if (generations.has(key)) diagnostics.duplicateRows++;
      // The latest usage-bearing copy wins; empty retries never erase usage.
      generations.set(key, { ...row, usage });
    }
    const buckets = new Map();
    for (const row of generations.values()) {
      const ts = new Date(row.createdAt).toISOString();
      const hour = ts.slice(0, 13);
      const model = row.model || "unknown";
      const key = JSON.stringify([row.swarmId, row.owner, model, hour]);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          swarmId: row.swarmId, board: row.board || row.swarmId,
          owner: row.owner, agent: row.agent || row.owner, kind: row.kind,
          model, hour, firstTs: ts, lastTs: ts,
          usage: Object.fromEntries(Object.keys(row.usage).map(k => [k, 0])),
        };
        buckets.set(key, bucket);
      }
      if (ts < bucket.firstTs) bucket.firstTs = ts;
      if (ts > bucket.lastTs) bucket.lastTs = ts;
      for (const [k, v] of Object.entries(row.usage)) bucket.usage[k] += v;
    }
    db.exec("COMMIT");
    return {
      version: 1, generatedAt: new Date().toISOString(), database: dbPath,
      diagnostics, buckets: [...buckets.values()],
    };
  } finally {
    db.close();
  }
}

module.exports = { exportSwarm };
if (require.main === module || process.argv[1] === "--swarm-export") {
  process.stdout.write(JSON.stringify(exportSwarm(process.argv[2])));
}
