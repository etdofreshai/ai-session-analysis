import type { SessionDetail } from "./types";
import { DEFAULT_PRICING, type PricingTable } from "./pricing";
import type { MetaResponse, OverviewResponse, SessionRow } from "../server/views";

export type { MetaResponse, OverviewResponse, SessionRow };

/** The pricing query param: omitted for the defaults so the common case sends nothing. */
function pricingParam(pricing: PricingTable): string | null {
  const json = JSON.stringify(pricing);
  return json === JSON.stringify(DEFAULT_PRICING) ? null : json;
}

async function getJson<T>(path: string, params: Record<string, string | number | boolean | undefined | null>, pricing: PricingTable, signal?: AbortSignal): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const p = pricingParam(pricing);
  if (p) q.set("pricing", p);
  // no-cache lets the browser revalidate with the ETag and reuse its copy on 304.
  const res = await fetch(`${path}?${q.toString()}`, { cache: "no-cache", signal });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

export const fetchMeta = (pricing: PricingTable, signal?: AbortSignal) =>
  getJson<MetaResponse>("/api/meta", {}, pricing, signal);

export const fetchOverview = (
  params: { granularity: string; range: string },
  pricing: PricingTable,
  signal?: AbortSignal
) => getJson<OverviewResponse>("/api/overview", params, pricing, signal);

export const fetchSessions = (
  params: {
    sort: string; desc: boolean; q: string; windowMs: number; offset: number; limit: number;
    host?: string; source?: string; project?: string;
  },
  pricing: PricingTable,
  signal?: AbortSignal
) => getJson<{ total: number; offset: number; rows: SessionRow[] }>(
  "/api/sessions", { ...params, desc: params.desc ? 1 : 0 }, pricing, signal
);

export async function fetchSessionDetail(
  project: string,
  id: string,
  source?: string,
  host?: string
): Promise<SessionDetail> {
  const params = new URLSearchParams({ project, id });
  if (source) params.set("source", source);
  if (host) params.set("host", host);
  const res = await fetch(`/api/session?${params.toString()}`);
  if (!res.ok) throw new Error(`GET /api/session → ${res.status}`);
  return res.json();
}
