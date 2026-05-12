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
import { detectProject } from "../detect.js";
import { LayeroError, detectMode, emit } from "../agent.js";

interface DeployOptions {
  // Legacy alias of "auto-detect framework + use .layero/project.json
  // values if present". Kept for backwards compat — auto-detect is now
  // the default whenever a project hits pending_setup.
  config?: boolean;
  type?: string;
  name?: string;
  project?: string;
  yes?: boolean;
  prod?: boolean;
  branch?: string;
  org?: string;
  json?: boolean;
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
  "docusaurus",
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

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await rl.question(`${question} [y/N]: `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function deployTargeting(opts: DeployOptions): {
  target: "preview" | "production";
  branch?: string;
} {
  if (opts.branch) {
    return { target: "preview", branch: opts.branch };
  }
  return { target: opts.prod ? "production" : "preview" };
}

async function resolveOrCreateProject(
  api: ApiClient,
  cwd: string,
  opts: DeployOptions,
  existing: ProjectConfig | null,
): Promise<{ project: ProjectSummary; createdNow: boolean }> {
  const mode = detectMode();

  if (opts.project) {
    const all = await api.listProjects();
    const match =
      all.find((p) => p.id === opts.project) ??
      all.find((p) => p.slug === opts.project);
    if (!match) {
      throw new LayeroError(
        "project_not_found",
        `no project with id/slug "${opts.project}"`,
        "run `layero projects list` to see available projects",
      );
    }
    return { project: match, createdNow: false };
  }

  if (existing) {
    try {
      const project = await api.getProject(existing.project_id);
      return { project, createdNow: false };
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        throw new LayeroError(
          "project_unlinked",
          `linked project ${existing.project_id} no longer exists or isn't on your account`,
          `delete ${projectConfigPath(cwd)} and re-run, or run \`layero link <id_or_slug>\``,
        );
      }
      throw err;
    }
  }

  const me = await api.me();
  if (!me.username) {
    throw new LayeroError(
      "username_missing",
      "no username set on your account",
      "open https://app.layero.ru/onboarding to pick one, then re-run",
    );
  }
  let organizationSlug: string | undefined = opts.org;
  if (organizationSlug) {
    const orgs = await api.listOrganizations();
    if (!orgs.some((o) => o.slug === organizationSlug)) {
      throw new LayeroError(
        "org_membership_missing",
        `you're not a member of organization "${organizationSlug}"`,
        `available: ${orgs.map((o) => o.slug).join(", ") || "(none)"}`,
      );
    }
  } else {
    const orgs = await api.listOrganizations();
    if (orgs.length === 0) {
      throw new LayeroError(
        "no_organization",
        "no organization found on your account",
        "finish onboarding at https://app.layero.ru/onboarding",
      );
    } else if (orgs.length === 1) {
      organizationSlug = orgs[0]!.slug;
    } else if (opts.yes || opts.config || !mode.interactive) {
      // Non-interactive: prefer personal, fall back to first.
      organizationSlug =
        orgs.find((o) => o.kind === "personal")?.slug ?? orgs[0]!.slug;
    } else {
      console.log(chalk.cyan("which organization?"));
      orgs.forEach((o, i) => {
        const tag = o.kind === "personal" ? "personal" : "team";
        console.log(`  ${i + 1}. ${o.slug} (${tag}, ${o.my_role})`);
      });
      const choiceRaw = await prompt("choose number", "1");
      const idx = Number(choiceRaw) - 1;
      if (Number.isNaN(idx) || idx < 0 || idx >= orgs.length) {
        throw new LayeroError(
          "invalid_choice",
          `invalid org choice "${choiceRaw}"`,
          "enter a number from the list",
        );
      }
      organizationSlug = orgs[idx]!.slug;
    }
  }

  const fallbackName = path.basename(cwd);
  const name =
    opts.name ??
    (opts.yes || opts.config || !mode.interactive
      ? fallbackName
      : await prompt("project name", fallbackName));
  const project = await api.createCliProject({
    name,
    framework_hint: opts.type,
    organization_slug: organizationSlug,
  });
  return { project, createdNow: true };
}

async function packAndUpload(
  api: ApiClient,
  cwd: string,
  project: ProjectSummary,
): Promise<{ archive_key: string; commit_sha: string; archivePath: string }> {
  const pack = await packCwd(cwd, project.slug);
  emit({
    event: "packing",
    files: pack.fileCount,
    bytes: pack.size,
    sha256: pack.sha256,
  });

  const init = await api.initUpload(project.id);
  emit({ event: "uploading" });
  await uploadArchive(init, pack.archivePath);
  emit({ event: "uploaded", archive_key: init.source_archive_key });

  return {
    archive_key: init.source_archive_key,
    commit_sha: pack.sha256,
    archivePath: pack.archivePath,
  };
}

// Resolve the framework / build / output config to send to completeSetup.
// Precedence: explicit CLI args > .layero/project.json > auto-detect.
async function resolveSetupConfig(
  cwd: string,
  opts: DeployOptions,
  existing: ProjectConfig | null,
): Promise<{
  framework_hint: string;
  build_cmd: string;
  output_dir: string;
  source: "config" | "detected" | "hybrid";
}> {
  const detected = await detectProject(cwd);
  emit({
    event: "detected",
    framework: detected.framework_hint,
    build_cmd: detected.build_cmd,
    output_dir: detected.output_dir,
    confident: detected.confident,
  });

  const framework_hint =
    opts.type ?? existing?.framework_hint ?? detected.framework_hint;
  const build_cmd = existing?.build_cmd ?? detected.build_cmd;
  const output_dir = existing?.output_dir ?? detected.output_dir;

  let source: "config" | "detected" | "hybrid";
  if (existing?.build_cmd || existing?.output_dir || existing?.framework_hint) {
    source =
      existing?.build_cmd && existing?.output_dir && existing?.framework_hint
        ? "config"
        : "hybrid";
  } else {
    source = "detected";
  }

  return { framework_hint, build_cmd, output_dir, source };
}

export async function deployCmd(opts: DeployOptions): Promise<void> {
  const mode = detectMode();

  if (opts.type && !VALID_TYPES.has(opts.type.toLowerCase())) {
    throw new LayeroError(
      "invalid_type",
      `unknown --type "${opts.type}"`,
      `valid types: ${[...VALID_TYPES].join(", ")}`,
    );
  }

  const cliCfg = await loadConfig();
  if (!cliCfg.token) {
    throw new LayeroError(
      "not_logged_in",
      "not authenticated",
      "run: layero login",
    );
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

  if (project.cli_deploys_enabled === false) {
    throw new LayeroError(
      "cli_deploys_disabled",
      `CLI deploys are disabled on project "${project.slug}"`,
      "enable them in project settings, or remove --project to use a different project",
    );
  }

  // Prompt before overwriting production — only in interactive mode.
  if (opts.prod && !opts.yes && !opts.branch && mode.interactive) {
    const ok = await confirm(
      `deploy to production (https://${project.apex_hostname})?`,
    );
    if (!ok) {
      console.log(chalk.yellow("aborted."));
      return;
    }
  }

  // Resolve setup config (auto-detect + overrides). Done eagerly so the
  // user sees what we detected before any network I/O.
  const setup = await resolveSetupConfig(cwd, opts, existing);

  const persistedCfg = await persistProjectLinking(
    cwd,
    {
      project_id: project.id,
      slug: project.slug,
      organization_slug: project.organization.slug,
      apex_hostname: project.apex_hostname,
    },
    setup.framework_hint,
  );

  if (createdNow) {
    emit({
      event: "project_created",
      project_id: project.id,
      slug: project.slug,
      organization: project.organization.slug,
    });
  } else {
    emit({
      event: "project_linked",
      project_id: project.id,
      slug: project.slug,
    });
  }

  // Apply setup if the project is still in pending_setup. After first
  // run, subsequent deploys reuse whatever was set then — the user can
  // edit .layero/project.json or use the dashboard to change it.
  if (project.status === "pending_setup") {
    project = await api.completeSetup(project.id, {
      framework_hint: setup.framework_hint,
      build_cmd: setup.build_cmd,
      output_dir: setup.output_dir,
      analytics_enabled: persistedCfg.analytics_enabled ?? false,
      env_vars: persistedCfg.env_vars ?? {},
    });
    emit({ event: "setup_applied" });
  }

  let upload: Awaited<ReturnType<typeof packAndUpload>> | null = null;
  try {
    upload = await packAndUpload(api, cwd, project);

    const targeting = deployTargeting(opts);
    const deploy = await api.triggerDeploy(project.id, {
      source_archive_key: upload.archive_key,
      commit_sha: upload.commit_sha,
      commit_message: "CLI deploy",
      framework_hint: setup.framework_hint,
      target: targeting.target,
      branch: targeting.branch,
    });
    emit({ event: "deploy_started", deploy_id: deploy.id });

    const final = await streamDeployLogs(api, deploy.id);
    if (final.status !== "ready") {
      throw new LayeroError(
        `deploy_${final.status}`,
        `deploy failed (${final.status})${
          final.error_message ? `: ${final.error_message}` : ""
        }`,
        `inspect logs at ${projectUrl(cliCfg.apiUrl, project.id)}`,
      );
    }
    const liveUrl =
      opts.prod && !opts.branch
        ? `https://${project.apex_hostname}`
        : projectUrl(cliCfg.apiUrl, project.id);
    emit({
      event: "ready",
      url: liveUrl,
      deploy_id: deploy.id,
      preview_url:
        opts.prod && !opts.branch ? undefined : projectUrl(cliCfg.apiUrl, project.id),
    });
  } finally {
    if (upload) {
      await fs.unlink(upload.archivePath).catch(() => undefined);
    }
  }
}
