import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-session-config-"));
try {
  const source = fs.readFileSync(new URL("../server/hosts.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const modulePath = path.join(root, "hosts.cjs");
  fs.writeFileSync(modulePath, compiled);
  function config(vars = {}) {
    const env = { ...process.env, HOME: root };
    for (const key of Object.keys(env))
      if (/^(AI_|CLAUDE_)/.test(key)) delete env[key];
    Object.assign(env, vars);
    return JSON.parse(execFileSync(process.execPath, ["-e", `
      const m = require(${JSON.stringify(modulePath)});
      console.log(JSON.stringify({root:m.remoteStageRoot(),hosts:m.hosts(),
        ttl:m.dashboardEnv("SYNC_TTL_MS")}));
    `], { env, encoding: "utf8" }));
  }
  assert.equal(config().root, path.join(root, ".ai-remotes"));
  fs.mkdirSync(path.join(root, ".claude-remotes"));
  assert.equal(config().root, path.join(root, ".claude-remotes"));
  const legacy = config({
    CLAUDE_REMOTE_CACHE: "/legacy", CLAUDE_DISABLE_LOCAL: "1",
    CLAUDE_REMOTE_HOSTS: "test=user@host", CLAUDE_SYNC_TTL_MS: "42",
  });
  assert.equal(legacy.root, "/legacy");
  assert.equal(legacy.hosts.length, 1);
  assert.equal(legacy.hosts[0].codexDir, "/legacy/test/codex");
  assert.equal(legacy.ttl, "42");
  const modern = config({
    CLAUDE_REMOTE_CACHE: "/legacy", AI_REMOTE_CACHE: "/modern",
    CLAUDE_REMOTE_HOSTS: "old=user@old", AI_REMOTE_HOSTS: "new=user@new",
    AI_LOCAL_LABEL: "local-name", CLAUDE_PROJECTS_DIR: "/claude-source",
    AI_SYNC_TTL_MS: "17", CLAUDE_SYNC_TTL_MS: "42",
  });
  assert.equal(modern.root, "/modern");
  assert.equal(modern.hosts[0].label, "local-name");
  assert.equal(modern.hosts[0].remoteProjects, "/claude-source/");
  assert.equal(modern.hosts[1].id, "new");
  assert.equal(modern.ttl, "17");
  assert.equal(JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url))).name,
    "ai-session-analysis");
  assert.match(fs.readFileSync(new URL("../index.html", import.meta.url), "utf8"),
    /<title>AI Session Analysis<\/title>/);
  const entrypoint = fs.readFileSync(new URL("../docker-entrypoint.sh", import.meta.url), "utf8");
  const defaults = entrypoint.split("\n").filter(line => line.startsWith("export AI_")).join("\n");
  function containerDefaults(env) {
    return execFileSync("sh", ["-c", defaults +
      '\nprintf "%s\\n%s" "$AI_REMOTE_CACHE" "$AI_DISABLE_LOCAL"'], {
      encoding: "utf8", env,
    });
  }
  assert.equal(containerDefaults({}), "/data/archive\n1");
  assert.equal(containerDefaults({ CLAUDE_REMOTE_CACHE: "/old", CLAUDE_DISABLE_LOCAL: "0" }),
    "/old\n0");
  assert.equal(containerDefaults({ CLAUDE_REMOTE_CACHE: "/old", AI_REMOTE_CACHE: "/new" }),
    "/new\n1");
  console.log("PASS: AI naming, env precedence, legacy configuration and archive preservation.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
