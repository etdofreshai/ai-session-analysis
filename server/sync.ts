import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { HostSyncStatus } from "../src/types";
import { dashboardEnv, hosts, type HostSpec } from "./hosts";
import { parseSwarmSnapshot } from "./swarm-scanner";

const execFileP = promisify(execFile);

// A scan triggers a fresh rsync only if the last one finished more than
// TTL_MS ago; rapid refreshes within that window read the already-staged
// copy instead of paying SSH latency again.
const TTL_MS = Number(dashboardEnv("SYNC_TTL_MS") ?? 90_000);

const SSH_OPTS = [
  "-o", "BatchMode=yes",
  "-o", `ConnectTimeout=${process.env.SESSION_SSH_CONNECT_TIMEOUT ?? "20"}`,
  "-o", "StrictHostKeyChecking=accept-new",
];
if (process.env.SESSION_SSH_KEY_PATH) {
  SSH_OPTS.push("-i", process.env.SESSION_SSH_KEY_PATH, "-o", "IdentitiesOnly=yes");
}
if (process.env.SESSION_SSH_KNOWN_HOSTS) {
  SSH_OPTS.push("-o", `UserKnownHostsFile=${process.env.SESSION_SSH_KNOWN_HOSTS}`);
}

const status = new Map<string, HostSyncStatus>();
let lastSyncStart = 0;
let inFlight: Promise<void> | null = null;

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

async function syncSwarmHost(h: HostSpec): Promise<void> {
  if (!h.swarmDatabase || !h.swarmSnapshot) return;
  const t0 = Date.now();
  const id = `${h.id}:swarm`;
  try {
    const script = fs.readFileSync(path.resolve("server/export-swarm.cjs"), "utf8");
    const args = ["--input-type=commonjs", "-e", script, "--", "--swarm-export", h.swarmDatabase];
    const command = h.ssh ? "ssh" : process.execPath;
    const commandArgs = h.ssh
      ? [...SSH_OPTS, h.ssh, ["node", ...args].map(shellQuote).join(" ")]
      : args;
    const { stdout } = await execFileP(command, commandArgs, {
      timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
    });
    const snapshot = parseSwarmSnapshot(stdout);
    if (snapshot.diagnostics.invalidRows)
      throw new Error(`Swarm ledger has ${snapshot.diagnostics.invalidRows} invalid usage rows`);
    // Only a complete, validated export replaces the previous snapshot.
    fs.mkdirSync(path.dirname(h.swarmSnapshot), { recursive: true });
    const temp = h.swarmSnapshot + ".tmp";
    fs.writeFileSync(temp, stdout, { mode: 0o600 });
    fs.renameSync(temp, h.swarmSnapshot);
    status.set(id, { id, label: `${h.label} / swarm`, ssh: h.ssh, ok: true,
      error: null, lastSyncMs: Date.now(), durationMs: Date.now() - t0 });
  } catch (e: any) {
    status.set(id, { id, label: `${h.label} / swarm`, ssh: h.ssh, ok: false,
      error: String(e?.stderr || e?.message || e).trim().slice(0, 500),
      lastSyncMs: status.get(id)?.lastSyncMs ?? null, durationMs: Date.now() - t0 });
  }
}

async function rsyncPull(
  h: HostSpec,
  src: string,
  dest: string,
  filters: string[] = []
): Promise<void> {
  fs.mkdirSync(dest, { recursive: true });
  const args = ["-az", "--timeout=25", ...filters];
  // SSH transport only for remote hosts; the local host rsyncs filesystem→
  // filesystem with no -e and a bare (non-prefixed) source path.
  if (h.ssh) args.push("-e", `ssh ${SSH_OPTS.join(" ")}`);
  // Windows hosts have no native rsync — run it through WSL on the remote.
  if (h.rsyncPath) args.push("--rsync-path", h.rsyncPath);
  args.push(
    h.ssh ? `${h.ssh}:${src}` : src,
    dest.endsWith("/") ? dest : dest + "/"
  );
  await execFileP("rsync", args, {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function syncHost(h: HostSpec): Promise<void> {
  if (!h.remoteProjects && !h.remoteCodex && !h.remotePi && !h.remoteOpenCode) return;
  const t0 = Date.now();
  let ok = true;
  let error: string | null = null;
  // Claude remains the required/health-signalling source for existing host
  // status, but a failure there must not prevent Pi/OpenCode-only hosts from
  // syncing their available stores.
  if (h.remoteProjects) {
    try {
      await rsyncPull(h, h.remoteProjects, h.projectsDir);
    } catch (e: any) {
      ok = false;
      error = String(e?.stderr || e?.message || e).trim().slice(0, 500);
    }
  }
  if (h.remoteCodex) {
    try {
      await rsyncPull(h, h.remoteCodex, h.codexDir);
    } catch {
      /* no codex on this host — ignore */
    }
  }
  if (h.remotePi) {
    try {
      await rsyncPull(h, h.remotePi, h.piDir);
    } catch {
      /* no pi on this host — ignore */
    }
  }
  if (h.remoteOpenCode) {
    try {
      // OpenCode stores sessions in SQLite. Copy only the database and WAL
      // companions, not the often-huge snapshot and tool-output directories.
      await rsyncPull(h, h.remoteOpenCode, path.dirname(h.opencodeDb), [
        "--include=opencode.db",
        "--include=opencode.db-wal",
        "--include=opencode.db-shm",
        "--exclude=*",
      ]);
    } catch {
      /* no opencode on this host — ignore */
    }
  }
  status.set(h.id, {
    id: h.id,
    label: h.label,
    ssh: h.ssh,
    ok,
    error,
    lastSyncMs: Date.now(),
    durationMs: Date.now() - t0,
  });
}

async function doSync(): Promise<void> {
  const remotes = hosts().filter(
    (h) => h.remoteProjects || h.remoteCodex || h.remotePi || h.remoteOpenCode
  );
  await Promise.all([
    ...remotes.map((h) => syncHost(h)),
    ...hosts().filter(h => h.swarmDatabase).map(h => syncSwarmHost(h)),
  ]);
}

/**
 * Trigger a background refresh of the remote staging dirs if the cache is stale,
 * and return the per-host status immediately. The scan that calls this reads
 * whatever is currently staged — it never blocks on SSH/rsync (a full etzevox2
 * pull traverses thousands of files over WSL and can take ~20s). At most one
 * sync runs per TTL window; the fresh data lands on a subsequent scan.
 */
export function ensureSynced(): HostSyncStatus[] {
  const now = Date.now();
  if (!inFlight && (lastSyncStart === 0 || now - lastSyncStart >= TTL_MS)) {
    lastSyncStart = now;
    inFlight = doSync().finally(() => {
      inFlight = null;
    });
  }
  return statusList();
}

export function statusList(): HostSyncStatus[] {
  const hostStatuses = hosts().map((h) => {
    // Hosts with no rsync source (pure scan-in-place) have no sync status; they
    // always count as ok and are listed only so they appear in the dashboard's
    // host bar.
    if (!h.remoteProjects && !h.remoteCodex && !h.remotePi && !h.remoteOpenCode) {
      return {
        id: h.id,
        label: h.label,
        ssh: null,
        ok: true,
        error: null,
        lastSyncMs: null,
        durationMs: null,
      };
    }
    return (
      status.get(h.id) ?? {
        id: h.id,
        label: h.label,
        ssh: h.ssh,
        ok: false,
        error: "not yet synced",
        lastSyncMs: null,
        durationMs: null,
      }
    );
  });
  return [...hostStatuses, ...hosts().filter(h => h.swarmDatabase).map(h =>
    status.get(`${h.id}:swarm`) ?? {
      id: `${h.id}:swarm`, label: `${h.label} / swarm`, ssh: h.ssh,
      ok: false, error: "not yet synced", lastSyncMs: null, durationMs: null,
    }
  )];
}
