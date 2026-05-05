import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import chalk from "chalk";
import { ApiClient, ApiError, ProjectSummary, uploadArchive } from "../api.js";
import { loadConfig } from "../config.js";
import {
  ProjectConfig,
  loadProjectConfig,
  persistProjectLinking,
  projectConfigPath,
} from "../project-config.js";
import { packCwd } from "../pack.js";
import { streamDeployLogs } from "../logs.js";

interface DeployOptions {
  // `--config` flips the flow from "interactive (open the dashboard wizard)"
  // to "fully scripted from .layero/project.json" — required for CI.
  config?: boolean;
  type?: string;
  name?: string;
  project?: string;
  yes?: boolean;
}

const VALID_TYPES = new Set([
  "vite",
  "next",
  "nextjs",
  "astro",
  "cra",
  "sveltekit",
  "svelte",
  "nuxt",
  "gatsby",
  "static",
  "generic",
]);

function dashboardOrigin(apiUrl: string): string {
  const override = process.env.LAYERO_DASHBOARD_URL;
  if (override) return override.replace(/\/+$/, "");
  try {
    const u = new URL(apiUrl);
    u.hostname = u.hostname.replace(/^api\./, "app.");
    return u.origin;
  } catch {
    return "https://app.layero.ru";
  }
}

function setupUrl(apiUrl: string, projectId: string): string {
  return `${dashboardOrigin(apiUrl)}/projects/${projectId}/setup`;
}

function projectUrl(apiUrl: string, projectId: string): string {
  return `${dashboardOrigin(apiUrl)}/projects/${projectId}`;
}

async function prompt(question: string, fallback: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await rl.question(`${question} [${fallback}]: `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

async function resolveOrCreateProject(
  api: ApiClient,
  cwd: string,
  opts: DeployOptions,
  existing: ProjectConfig | null,
): Promise<{ project: ProjectSummary; createdNow: boolean }> {
  if (opts.project) {
    const all = await api.listProjects();
    const match =
      all.find((p) => p.id === opts.project) ??
      all.find((p) => p.slug === opts.project);
    if (!match) {
      throw new Error(`no project with id/slug "${opts.project}"`);
    }
    return { project: match, createdNow: false };
  }

  if (existing) {
    try {
      const project = await api.getProject(existing.project_id);
      return { project, createdNow: false };
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        throw new Error(
          `linked project ${existing.project_id} no longer exists or isn't on your account.\n` +
            `  fix: delete ${projectConfigPath(cwd)} and re-run \`layero deploy\` (creates a new project),\n` +
            `       or run \`layero link <id_or_slug>\` to point at an existing one.`,
        );
      }
      throw err;
    }
  }

  const me = await api.me();
  if (!me.owner_name) {
    throw new Error(
      "no Owner set on your account. open https://app.layero.ru/onboarding " +
        "and pick one, then re-run.",
    );
  }
  const fallbackName = path.basename(cwd);
  const name =
    opts.name ?? (opts.yes || opts.config ? fallbackName : await prompt("project name", fallbackName));
  const project = await api.createCliProject({
    name,
    framework_hint: opts.type,
  });
  return { project, createdNow: true };
}

async function packAndUpload(
  api: ApiClient,
  cwd: string,
  project: ProjectSummary,
): Promise<{ archive_key: string; commit_sha: string; archivePath: string }> {
  console.log(chalk.cyan("packing source..."));
  const pack = await packCwd(cwd, project.slug);
  console.log(
    chalk.dim(
      `  ${pack.fileCount} files, ${(pack.size / (1024 * 1024)).toFixed(2)} MB, sha256=${pack.sha256.slice(0, 12)}`,
    ),
  );

  console.log(chalk.cyan("requesting upload URL..."));
  const init = await api.initUpload(project.id);

  console.log(chalk.cyan("uploading archive..."));
  await uploadArchive(init, pack.archivePath);

  return {
    archive_key: init.source_archive_key,
    commit_sha: pack.sha256,
    archivePath: pack.archivePath,
  };
}

function ensureConfigComplete(
  cfg: ProjectConfig | null,
): asserts cfg is ProjectConfig & {
  framework_hint: string;
  build_cmd: string;
  output_dir: string;
} {
  if (!cfg) {
    throw new Error(
      "no .layero/project.json found. run `layero deploy` once without --config " +
        "to create the project, fill in framework_hint/build_cmd/output_dir there, " +
        "then re-run with --config.",
    );
  }
  const missing: string[] = [];
  if (!cfg.framework_hint) missing.push("framework_hint");
  if (!cfg.build_cmd) missing.push("build_cmd");
  if (!cfg.output_dir) missing.push("output_dir");
  if (missing.length > 0) {
    throw new Error(
      `.layero/project.json is missing required fields for --config: ${missing.join(", ")}`,
    );
  }
}

export async function deployCmd(opts: DeployOptions): Promise<void> {
  if (opts.type && !VALID_TYPES.has(opts.type.toLowerCase())) {
    throw new Error(
      `unknown --type "${opts.type}". valid: ${[...VALID_TYPES].join(", ")}`,
    );
  }

  const cliCfg = await loadConfig();
  if (!cliCfg.token) {
    throw new Error("not logged in. run `layero login` first.");
  }
  const api = new ApiClient(cliCfg);
  const cwd = process.cwd();

  const existing = await loadProjectConfig(cwd);
  const { project: created, createdNow } = await resolveOrCreateProject(
    api,
    cwd,
    opts,
    existing,
  );
  let project = created;

  if (project.source_type !== "cli") {
    throw new Error(
      `project "${project.slug}" is a GitHub-source project; ` +
        "use the dashboard's Deploy button or push to the linked repo.",
    );
  }

  // Persist linking metadata only — never touch hand-edited config fields
  // or unknown keys the user may have added (a --config file is the user's
  // source of truth, not ours). `persistProjectLinking` reads the file as
  // raw JSON, overlays just project_id/slug/owner_slug/apex_hostname, and
  // writes it back.
  const persistedCfg = await persistProjectLinking(
    cwd,
    {
      project_id: project.id,
      slug: project.slug,
      owner_slug: project.owner.slug,
      apex_hostname: project.apex_hostname,
    },
    opts.type ?? null,
  );

  if (createdNow) {
    console.log(chalk.green(`created project ${project.slug}`));
  }

  // ─────────────────────────────────────────────────────────────────────
  // Path A: --config — fully scripted, runs the setup endpoint with
  //                     fields from .layero/project.json, then deploys.
  // ─────────────────────────────────────────────────────────────────────
  if (opts.config) {
    ensureConfigComplete(persistedCfg);

    if (project.status === "pending_setup") {
      console.log(chalk.cyan("applying config..."));
      project = await api.completeSetup(project.id, {
        framework_hint: persistedCfg.framework_hint!,
        build_cmd: persistedCfg.build_cmd!,
        output_dir: persistedCfg.output_dir!,
        analytics_enabled: persistedCfg.analytics_enabled ?? false,
        env_vars: persistedCfg.env_vars ?? {},
      });
    }

    let upload: Awaited<ReturnType<typeof packAndUpload>> | null = null;
    try {
      upload = await packAndUpload(api, cwd, project);

      console.log(chalk.cyan("triggering deploy..."));
      const deploy = await api.triggerDeploy(project.id, {
        source_archive_key: upload.archive_key,
        commit_sha: upload.commit_sha,
        commit_message: "CLI deploy",
        framework_hint: persistedCfg.framework_hint ?? undefined,
      });
      console.log(chalk.dim(`  deploy_id=${deploy.id}`));

      const final = await streamDeployLogs(api, deploy.id);
      if (final.status !== "ready") {
        console.error(
          chalk.red(
            `deploy failed (${final.status})${
              final.error_message ? `: ${final.error_message}` : ""
            }`,
          ),
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        chalk.green(`deploy ready → ${projectUrl(cliCfg.apiUrl, project.id)}`),
      );
      console.log(
        chalk.dim(
          `  site: https://${project.apex_hostname} (CDN may take ~30-60s to propagate)`,
        ),
      );
    } finally {
      if (upload) {
        await fs.unlink(upload.archivePath).catch(() => undefined);
      }
    }
    return;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Path B: no flag — upload the source, stash it on the project row,
  //                    print the setup URL. The user finishes the flow
  //                    in the browser, exactly like a GitHub import.
  // ─────────────────────────────────────────────────────────────────────
  let upload: Awaited<ReturnType<typeof packAndUpload>> | null = null;
  try {
    upload = await packAndUpload(api, cwd, project);
    await api.finalizeUpload(project.id, {
      source_archive_key: upload.archive_key,
      commit_sha: upload.commit_sha,
    });

    if (project.status === "pending_setup") {
      const url = setupUrl(cliCfg.apiUrl, project.id);
      console.log("");
      console.log(chalk.green("source uploaded — finish setup in the browser:"));
      console.log(`  ${chalk.bold(url)}`);
      console.log("");
      console.log(
        chalk.dim(
          "  pick framework, build command, output dir, env vars and click Deploy.",
        ),
      );
      console.log(
        chalk.dim(
          "  to skip the browser next time, fill .layero/project.json and run `layero deploy --config`.",
        ),
      );
      return;
    }

    // Already-active project: behave like the old `layero deploy` — fire
    // a build straight from the freshly-uploaded archive.
    console.log(chalk.cyan("triggering deploy..."));
    const deploy = await api.triggerDeploy(project.id, {
      source_archive_key: upload.archive_key,
      commit_sha: upload.commit_sha,
      commit_message: "CLI deploy",
      framework_hint: opts.type,
    });
    console.log(chalk.dim(`  deploy_id=${deploy.id}`));

    const final = await streamDeployLogs(api, deploy.id);
    if (final.status !== "ready") {
      console.error(
        chalk.red(
          `deploy failed (${final.status})${
            final.error_message ? `: ${final.error_message}` : ""
          }`,
        ),
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      chalk.green(`deploy ready → ${projectUrl(cliCfg.apiUrl, project.id)}`),
    );
    console.log(
      chalk.dim(
        `  site: https://${project.apex_hostname} (CDN may take ~30-60s to propagate)`,
      ),
    );
  } finally {
    if (upload) {
      await fs.unlink(upload.archivePath).catch(() => undefined);
    }
  }
}
