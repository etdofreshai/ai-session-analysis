import fs from "node:fs";
import { createHash } from "node:crypto";
import { ctDay } from "./ct-day";
import type { ModelUsage, ProjectStats, SessionDetail, SessionStats } from "../src/types";

interface SwarmBucket {
  swarmId: string; board: string; owner: string; agent: string; kind: string;
  model: string; hour: string; firstTs: string; lastTs: string; usage: ModelUsage;
}
export interface SwarmSnapshot {
  version: 1;
  generatedAt: string;
  database: string;
  diagnostics: { usageRows: number; duplicateRows: number; invalidRows: number; unmeteredRows: number };
  buckets: SwarmBucket[];
}

export function parseSwarmSnapshot(text: string): SwarmSnapshot {
  const value = JSON.parse(text);
  if (value.version !== 1 || !Array.isArray(value.buckets) ||
      !Number.isFinite(Date.parse(value.generatedAt)) ||
      typeof value.database !== "string" || !value.diagnostics)
    throw new Error("Invalid swarm snapshot");
  for (const b of value.buckets) {
    if (![b.swarmId, b.owner, b.board, b.agent, b.kind, b.model].every(v => typeof v === "string") ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(b.hour) ||
        !Number.isFinite(Date.parse(b.hour + ":00:00Z")) ||
        !Number.isFinite(Date.parse(b.firstTs)) || !Number.isFinite(Date.parse(b.lastTs)) ||
        !b.usage || !["calls", "input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h", "webSearch"]
          .every(k => Number.isSafeInteger(b.usage[k]) && b.usage[k] >= 0))
      throw new Error("Invalid swarm usage bucket");
  }
  return value;
}

function add(target: Record<string, ModelUsage>, model: string, usage: ModelUsage) {
  if (!target[model]) target[model] = { ...usage };
  else for (const key of Object.keys(usage) as Array<keyof ModelUsage>)
    target[model][key] += usage[key];
}

export function swarmProjects(snapshot: SwarmSnapshot, host: string): ProjectStats[] {
  const sessions = new Map<string, SessionStats>();
  for (const b of snapshot.buckets) {
    const id = "swarm-" + createHash("sha256").update(JSON.stringify([b.swarmId, b.owner])).digest("hex");
    let session = sessions.get(id);
    if (!session) {
      session = {
        id, host, project: `swarm:${b.swarmId}`, file: snapshot.database, source: "swarm",
        sizeBytes: 0, title: `${b.board} / ${b.agent}`, lastPrompt: null,
        agentName: b.agent, firstTs: b.firstTs, lastTs: b.lastTs, durationMs: 0,
        version: null, gitBranch: null, cwd: null, entrypoint: "swarm-direct-api",
        permissionModes: [], effortModes: [],
        counts: { records: 0, userPrompts: 0, toolResults: 0, assistantMsgs: 0,
          toolUses: 0, attachments: 0, system: 0, apiErrors: 0, sidechain: 0 },
        models: {}, toolCalls: {}, subagents: [], recordTypes: {},
        dailyUsage: {}, hourlyUsage: {},
      };
      sessions.set(id, session);
    }
    if (b.firstTs < session.firstTs!) session.firstTs = b.firstTs;
    if (b.lastTs > session.lastTs!) session.lastTs = b.lastTs;
    session.counts.records += b.usage.calls;
    session.recordTypes.provider_usage = session.counts.records;
    add(session.models, b.model, b.usage);
    add(session.hourlyUsage[b.hour] ??= {}, b.model, b.usage);
    add(session.dailyUsage[ctDay(b.hour + ":00:00Z")] ??= {}, b.model, b.usage);
  }
  const projects = new Map<string, ProjectStats>();
  for (const s of sessions.values()) {
    s.durationMs = Date.parse(s.lastTs!) - Date.parse(s.firstTs!);
    let project = projects.get(s.project);
    if (!project) {
      project = { name: s.project, host, displayPath: null, sessions: [] };
      projects.set(s.project, project);
    }
    project.sessions.push(s);
  }
  return [...projects.values()];
}

const cache = new Map<string, { mtime: number; size: number; projects: ProjectStats[] }>();
export function scanSwarmAll(file: string | undefined, host: string): ProjectStats[] {
  if (!file || !fs.existsSync(file)) return [];
  const st = fs.statSync(file);
  const key = `${host}\0${file}`;
  const hit = cache.get(key);
  if (hit?.mtime === st.mtimeMs && hit.size === st.size) return hit.projects;
  const projects = swarmProjects(parseSwarmSnapshot(fs.readFileSync(file, "utf8")), host);
  cache.set(key, { mtime: st.mtimeMs, size: st.size, projects });
  return projects;
}

export function swarmSessionDetail(id: string, file: string | undefined, host: string): SessionDetail | null {
  const session = scanSwarmAll(file, host).flatMap(p => p.sessions).find(s => s.id === id);
  return session ? { session, timeline: [] } : null;
}
