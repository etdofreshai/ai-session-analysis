// Server-side view models: the browser receives only what the current view shows.
import { createHash } from "node:crypto";
import type { StatsResponse } from "../src/types";
import { DEFAULT_PRICING, type PricingTable } from "../src/pricing";
import {
  flatten, byDay, byHour, costByModel, costByProject, topTools, windowTotals,
  windowCost, RANGES, HOUR_RANGES, type FlatSession,
} from "../src/aggregate";
import { scanAll } from "./scanner";

const MINUTE = 60_000;

export interface Snapshot {
  stats: StatsResponse;
  generation: string;
}

function fingerprint(stats: StatsResponse): string {
  const h = createHash("sha1");
  for (const p of stats.projects)
    for (const s of p.sessions) {
      h.update(`${s.host}\0${s.source}\0${p.name}\0${p.displayPath}\0${s.id}\0${s.sizeBytes}\0${s.lastTs}\0${s.title}`);
      for (const sub of s.subagents) h.update(`\0${sub.id}\0${sub.sizeBytes}\0${sub.lastTs}`);
      h.update("\n");
    }
  return h.digest("base64url").slice(0, 16);
}

// ponytail: one page load fires several API calls; they share a scan taken in
// the last few seconds. Raise SCAN_REUSE_MS if scans get slower than refreshes.
const SCAN_REUSE_MS = 5_000;
let last: { at: number; snap: Snapshot } | null = null;
export function snapshot(): Snapshot {
  if (last && Date.now() - last.at < SCAN_REUSE_MS) return last.snap;
  const stats = scanAll();
  const snap = { stats, generation: fingerprint(stats) };
  last = { at: Date.now(), snap };
  return snap;
}

// ---- pricing from the query string ----

const PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const;

function canonical(table: PricingTable): string {
  return JSON.stringify(
    Object.keys(table).sort().map((k) => [k, PRICE_FIELDS.map((f) => table[k][f])])
  );
}
export const DEFAULT_PRICING_KEY = "default";

/** Validates a client pricing table (untrusted). Missing param means defaults. */
export function parsePricing(raw: string | null): { table: PricingTable; key: string } {
  if (!raw) return { table: DEFAULT_PRICING, key: DEFAULT_PRICING_KEY };
  if (raw.length > 20_000) throw new Error("pricing too large");
  const obj = JSON.parse(raw);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("pricing must be an object");
  const entries = Object.entries(obj);
  if (entries.length > 300) throw new Error("too many pricing rows");
  const table: PricingTable = {};
  for (const [k, v] of entries) {
    if (k.length > 200 || !v || typeof v !== "object") throw new Error("invalid pricing row");
    const row: any = {};
    for (const f of PRICE_FIELDS) {
      const n = Number((v as any)[f] ?? 0);
      if (!Number.isFinite(n) || n < 0) throw new Error(`invalid price ${k}.${f}`);
      row[f] = n;
    }
    table[k] = row;
  }
  const c = canonical(table);
  const key = c === canonical(DEFAULT_PRICING) ? DEFAULT_PRICING_KEY
    : createHash("sha1").update(c).digest("base64url").slice(0, 16);
  return { table, key };
}

// ---- small LRU caches keyed by scan generation + inputs ----

function lru<V>(max: number) {
  const m = new Map<string, V>();
  return (key: string, make: () => V): V => {
    let v = m.get(key);
    if (v !== undefined) { m.delete(key); m.set(key, v); return v; }
    v = make();
    m.set(key, v);
    if (m.size > max) m.delete(m.keys().next().value!);
    return v;
  };
}
const flatCache = lru<FlatSession[]>(3);
const anyCache = lru<unknown>(64);
const viewCache = <T,>(key: string, make: () => T): T => anyCache(key, make) as T;

export interface Filters { host?: string; source?: string; project?: string }

function filtered(sessions: FlatSession[], f: Filters): FlatSession[] {
  if (!f.host && !f.source && !f.project) return sessions;
  return sessions.filter((s) =>
    (!f.host || s.host === f.host) &&
    (!f.source || s.source === f.source) &&
    (!f.project || s.projectDisplay === f.project));
}

export interface ViewContext {
  snap: Snapshot;
  pricing: { table: PricingTable; key: string };
  /** Window anchor, rounded to the minute so repeat requests share results. */
  now: number;
}

export function context(pricingRaw: string | null, nowMs = Date.now()): ViewContext {
  return { snap: snapshot(), pricing: parsePricing(pricingRaw), now: Math.floor(nowMs / MINUTE) * MINUTE };
}

/** Cache key for a response: an ETag that changes with data, pricing, minute and params. */
export function viewKey(ctx: ViewContext, kind: string, params: unknown): string {
  return `${kind}:${ctx.snap.generation}:${ctx.pricing.key}:${ctx.now}:${JSON.stringify(params)}`;
}

function sessionsFor(ctx: ViewContext): FlatSession[] {
  return flatCache(`${ctx.snap.generation}:${ctx.pricing.key}:${ctx.now}`,
    () => flatten(ctx.snap.stats, ctx.pricing.table, ctx.now));
}

// ---- views ----

export function meta(ctx: ViewContext) {
  const { stats } = ctx.snap;
  const projects = new Set<string>();
  const hosts = new Set<string>();
  let sessions = 0;
  for (const s of sessionsFor(ctx)) { projects.add(s.projectDisplay); hosts.add(s.host); sessions++; }
  return {
    generation: ctx.snap.generation,
    generatedAt: stats.generatedAt,
    scanMs: stats.scanMs,
    hosts: stats.hosts,
    sync: stats.sync,
    sessionCount: sessions,
    projectCount: stats.projects.length,
    projectNames: [...projects].sort(),
    hostNames: [...hosts].sort(),
  };
}

export interface OverviewParams extends Filters { gran: "day" | "hour"; range: string }

export function overview(ctx: ViewContext, p: OverviewParams) {
  const range = p.gran === "hour"
    ? HOUR_RANGES.find((r) => r.key === p.range)
    : RANGES.find((r) => r.key === p.range);
  if (!range) throw new RangeError(`unknown range ${p.range}`);
  return viewCache(viewKey(ctx, "overview", p), () => {
    const all = sessionsFor(ctx);
    const sessions = filtered(all, p);
    const pricing = ctx.pricing.table;
    const fromMs = range.windowMs == null ? null : ctx.now - range.windowMs;
    return {
      now: ctx.now,
      generation: ctx.snap.generation,
      totals: windowTotals(sessions, pricing, fromMs),
      // "Last 1h" is a live metric across the selected sessions, independent of range.
      costLastHour: sessions.reduce((a, s) => a + s.costLastHour, 0),
      buckets: p.gran === "hour" ? byHour(sessions, pricing, fromMs) : byDay(sessions, pricing, fromMs),
      models: costByModel(sessions, pricing, fromMs),
      projects: costByProject(sessions, pricing, fromMs).slice(0, 12),
      tools: topTools(sessions, 15, fromMs),
    };
  });
}

export type SortKey = "date" | "cost" | "costWin" | "tokens" | "prompts" | "duration" | "subagents";
export const SORT_KEYS: SortKey[] = ["date", "cost", "costWin", "tokens", "prompts", "duration", "subagents"];

export interface SessionsParams extends Filters {
  sort: SortKey; desc: boolean; q: string; windowMs: number; offset: number; limit: number;
}

const PROMPT_PREVIEW = 240;

export function sessionsPage(ctx: ViewContext, p: SessionsParams) {
  const { offset, limit, ...query } = p;
  // The sorted, filtered id list is cached per query; pages slice it.
  const sorted = viewCache(viewKey(ctx, "sessions", query), () => {
    const pricing = ctx.pricing.table;
    let rows = filtered(sessionsFor(ctx), p);
    if (p.q) {
      const f = p.q.toLowerCase();
      rows = rows.filter((s) =>
        (s.title ?? "").toLowerCase().includes(f) ||
        (s.lastPrompt ?? "").toLowerCase().includes(f) ||
        s.id.includes(f) ||
        Object.keys(s.models).some((m) => m.toLowerCase().includes(f)) ||
        s.effortModes.some((e) => e.toLowerCase().includes(f)));
    }
    const win = new Map<FlatSession, number>();
    for (const s of rows) {
      let c = windowCost(s.hourlyUsage, pricing, p.windowMs, ctx.now);
      for (const sub of s.subagents) c += windowCost(sub.hourlyUsage, pricing, p.windowMs, ctx.now);
      win.set(s, c);
    }
    const key = (s: FlatSession): number => {
      switch (p.sort) {
        case "date": return Date.parse(s.lastTs ?? s.firstTs ?? "") || 0;
        case "cost": return s.cost + s.subagentCost;
        case "costWin": return win.get(s) ?? 0;
        case "tokens": return s.totalTokensAll;
        case "prompts": return s.counts.userPrompts;
        case "duration": return s.durationMs;
        case "subagents": return s.subagents.length;
      }
    };
    const ordered = [...rows].sort((a, b) => (p.desc ? key(b) - key(a) : key(a) - key(b)));
    return { ordered, win };
  });
  return {
    now: ctx.now,
    generation: ctx.snap.generation,
    total: sorted.ordered.length,
    offset,
    rows: sorted.ordered.slice(offset, offset + limit).map((s) => ({
      id: s.id,
      host: s.host,
      project: s.project,
      projectDisplay: s.projectDisplay,
      source: s.source,
      title: s.title,
      lastPrompt: s.lastPrompt && s.lastPrompt.length > PROMPT_PREVIEW
        ? s.lastPrompt.slice(0, PROMPT_PREVIEW) + "…" : s.lastPrompt,
      agentName: s.agentName,
      firstTs: s.firstTs,
      lastTs: s.lastTs,
      models: Object.keys(s.models),
      effortModes: s.effortModes,
      prompts: s.counts.userPrompts,
      tokens: s.totalTokensAll,
      subagents: s.subagents.length,
      durationMs: s.durationMs,
      costWin: sorted.win.get(s) ?? 0,
      cost: s.cost,
      subagentCost: s.subagentCost,
    })),
  };
}

export type SessionRow = ReturnType<typeof sessionsPage>["rows"][number];
export type OverviewResponse = ReturnType<typeof overview>;
export type MetaResponse = ReturnType<typeof meta>;
