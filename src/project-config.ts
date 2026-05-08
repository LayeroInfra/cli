import { promises as fs } from "node:fs";
import path from "node:path";

export interface ProjectConfig {
  // Linking — populated by CLI on first `layero deploy`. Don't hand-edit.
  project_id: string;
  slug: string;
  organization_slug: string;
  apex_hostname: string;
  api_url?: string;
  // Setup-wizard fields. Optional for plain `layero deploy` (where the
  // wizard runs in the browser). Required for `layero deploy --config`,
  // which short-circuits the wizard and ships these straight to the API.
  framework_hint?: string | null;
  build_cmd?: string;
  output_dir?: string;
  analytics_enabled?: boolean;
  env_vars?: Record<string, string>;
}

export function projectConfigPath(cwd: string): string {
  return path.join(cwd, ".layero", "project.json");
}

export async function loadProjectConfig(
  cwd: string,
): Promise<ProjectConfig | null> {
  try {
    const raw = await fs.readFile(projectConfigPath(cwd), "utf-8");
    const parsed = JSON.parse(raw) as ProjectConfig & { owner_slug?: string };
    // Backward-read: configs written before V050 stored the field as
    // `owner_slug`. Promote it to `organization_slug` in-memory so the
    // rest of the CLI doesn't have to handle both names. Disk file gets
    // rewritten on the next persistProjectLinking() call.
    if (!parsed.organization_slug && parsed.owner_slug) {
      parsed.organization_slug = parsed.owner_slug;
    }
    return parsed;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function saveProjectConfig(
  cwd: string,
  cfg: ProjectConfig,
): Promise<void> {
  const dir = path.join(cwd, ".layero");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    projectConfigPath(cwd),
    JSON.stringify(cfg, null, 2),
    "utf-8",
  );
}

/**
 * Persist linking fields without disturbing user-managed config.
 *
 * `layero deploy` runs every time the user ships code, but the only thing
 * it should ever write back to .layero/project.json is the linkage —
 * project_id / slug / organization_slug / apex_hostname. Hand-edited
 * fields (build_cmd, output_dir, env_vars, analytics_enabled,
 * framework_hint) and any unknown keys the user added must be preserved
 * verbatim, or we silently break the user's --config file on every
 * interactive deploy.
 *
 * Reads the file as raw JSON, overlays the linking subset, and writes it
 * back. Drops any legacy `owner_slug` key once the new name has been
 * written, so future reads see only `organization_slug`. Returns the
 * merged config the caller should treat as the new source of truth.
 */
export async function persistProjectLinking(
  cwd: string,
  linking: {
    project_id: string;
    slug: string;
    organization_slug: string;
    apex_hostname: string;
    api_url?: string;
  },
  fallbackHint?: string | null,
): Promise<ProjectConfig> {
  const file = projectConfigPath(cwd);
  let raw: Record<string, unknown> = {};
  try {
    const text = await fs.readFile(file, "utf-8");
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw err;
    }
  }

  // Strip the legacy owner_slug if it sneaks in from an older CLI write.
  delete raw.owner_slug;

  const merged: Record<string, unknown> = {
    ...raw,
    project_id: linking.project_id,
    slug: linking.slug,
    organization_slug: linking.organization_slug,
    apex_hostname: linking.apex_hostname,
  };
  if (linking.api_url !== undefined) merged.api_url = linking.api_url;
  // Only seed framework_hint if the user hasn't set one yet — once it's in
  // the file (manually or from a prior --type), leave it alone.
  if (
    fallbackHint != null &&
    (raw.framework_hint === undefined || raw.framework_hint === null)
  ) {
    merged.framework_hint = fallbackHint;
  }

  await fs.mkdir(path.join(cwd, ".layero"), { recursive: true });
  await fs.writeFile(file, JSON.stringify(merged, null, 2), "utf-8");
  return merged as unknown as ProjectConfig;
}
