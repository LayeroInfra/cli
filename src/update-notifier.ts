/**
 * Tell the user when their CLI is behind the published version.
 *
 * WHY this exists (2026-07-27): a stale CLI silently withholds every fix we
 * ship. The `project_type` auto-flip for runtime apps landed 2026-05-26, yet
 * prod still logged 20 failed deploys across 16 projects over the following
 * month with "this repo looks like 'ssr_next' but the project is configured as
 * 'spa'" — the exact crash that fix prevents. The machine that found this was
 * itself running 0.5.3 against a published 0.8.11 and had never been told.
 *
 * A version nag is therefore not cosmetic: it is the delivery mechanism for
 * every stability fix that already exists.
 *
 * Constraints this respects, in order of importance:
 *   1. NEVER corrupt `--json`. Agents and CI parse stdout as JSON-lines, so the
 *      notice goes to STDERR, always, in every mode.
 *   2. NEVER slow a deploy down. One 1.5s-timeout request, at most once every
 *      CHECK_INTERVAL_MS, and the result is cached on disk.
 *   3. NEVER fail a command. Every path swallows its errors — an offline
 *      machine, a proxy, a corrupt cache file must all be silent no-ops.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const REGISTRY_URL = "https://registry.npmjs.org/layero/latest";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day is plenty
const FETCH_TIMEOUT_MS = 1500;

interface CacheShape {
  checked_at: number;
  latest: string;
}

function cachePath(): string {
  return path.join(os.homedir(), ".layero", "update-check.json");
}

/** -1 = a < b, 0 = equal, 1 = a > b. Plain numeric semver; a pre-release tag
 *  (1.2.3-beta.1) compares by its numeric core, which is all we need here. */
export function compareVersions(a: string, b: string): number {
  const core = (v: string) => (v.split("-")[0] ?? "").split(".").map((n) => parseInt(n, 10) || 0);
  const [x, y] = [core(a), core(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function readCache(): Promise<CacheShape | null> {
  try {
    const raw = await readFile(cachePath(), "utf-8");
    const parsed = JSON.parse(raw) as CacheShape;
    if (typeof parsed.checked_at !== "number" || typeof parsed.latest !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(latest: string): Promise<void> {
  try {
    await mkdir(path.dirname(cachePath()), { recursive: true });
    await writeFile(cachePath(), JSON.stringify({ checked_at: Date.now(), latest }), "utf-8");
  } catch {
    /* a read-only HOME must not break the CLI */
  }
}

async function fetchLatest(): Promise<string | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(REGISTRY_URL, {
        signal: ctl.signal,
        headers: { accept: "application/vnd.npm.install-v1+json" },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { version?: string };
      return typeof body.version === "string" ? body.version : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * Resolve the newest published version, using the on-disk cache when fresh.
 * Returns null when unknown (offline, throttled, first run with no network).
 */
export async function resolveLatest(now: number = Date.now()): Promise<string | null> {
  const cached = await readCache();
  if (cached && now - cached.checked_at < CHECK_INTERVAL_MS) return cached.latest;
  const latest = await fetchLatest();
  if (latest) await writeCache(latest);
  return latest ?? cached?.latest ?? null;
}

/** The notice text, or null when the CLI is current. Pure — unit-testable. */
export function updateNotice(current: string, latest: string | null): string | null {
  if (!latest) return null;
  if (compareVersions(current, latest) >= 0) return null;
  return (
    `\n  Доступна новая версия Layero CLI: ${current} → ${latest}\n` +
    `  Обновиться:  npm i -g layero@latest\n` +
    `  Старые версии не получают исправлений сборки и деплоя.\n`
  );
}

/**
 * Best-effort check + print to stderr. Awaiting this is safe: it is bounded by
 * FETCH_TIMEOUT_MS and never rejects. Opt out with LAYERO_NO_UPDATE_CHECK=1.
 */
export async function notifyIfOutdated(current: string): Promise<void> {
  try {
    if (process.env.LAYERO_NO_UPDATE_CHECK) return;
    const notice = updateNotice(current, await resolveLatest());
    // stderr on purpose — stdout is the JSON-lines channel for agents.
    if (notice) process.stderr.write(notice);
  } catch {
    /* a version nag must never be the reason a deploy fails */
  }
}
