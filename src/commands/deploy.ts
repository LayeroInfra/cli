import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import chalk from "chalk";
import { ApiClient, ApiError, ProbeOut, ProjectSummary, uploadArchive } from "../api.js";
import { loadConfig } from "../config.js";
import {
  ProjectConfig,
  loadProjectConfig,
  persistProjectLinking,
  projectConfigPath,
} from "../project-config.js";
import { packCwd, packDirectory } from "../pack.js";
import { streamDeployLogs } from "../logs.js";
import { detectProject } from "../detect.js";
import { runDeviceLogin } from "../auth.js";
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
  // V071: promote the resulting deploy to production after a successful
  // build. Distinct from --prod (which targets the default branch and
  // relies on auto_promote_default_branch on the backend). --promote
  // explicitly pins the apex regardless of branch / auto-promote setting.
  promote?: boolean;
  branch?: string;
  org?: string;
  json?: boolean;
  // --prebuilt [dir]: ship an already-built artifact directory (dist/,
  // build/, public/, _site/, ...). CLI packs only that directory, backend
  // skips clone/detect/install/build. `true` (no arg) auto-picks the
  // first existing common output dir; a string path overrides explicitly.
  prebuilt?: boolean | string;
  // --root <dir>: monorepo support. Passed to backend's completeSetup as
  // the project's `root_directory`. Saved on the project row so a later
  // GitHub-push trigger or hook trigger uses the same subdir.
  root?: string;
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
  "hugo",
  "eleventy",
  "11ty",
  "vitepress",
  "storybook",
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

/**
 * After a deploy reaches `ready`, ask the backend where it's actually
 * reachable. The builder marks status=ready *before* calling /activate
 * (which runs auto-promote + schedules CDN warmup), so a probe fired the
 * instant we see `ready` can race ahead of the apex pointer being set.
 *
 * Poll the probe briefly (bounded) and return as soon as the env is
 * reachable (`available` — the preview host is up) or we learn the CDN
 * edge is already warm. Best-effort: any error returns null and the caller
 * falls back to apex/dashboard URLs.
 */
async function resolveReachability(
  api: ApiClient,
  environmentId: string,
): Promise<ProbeOut | null> {
  const deadline = Date.now() + 15_000;
  let last: ProbeOut | null = null;
  while (Date.now() < deadline) {
    try {
      last = await api.probeEnvironment(environmentId);
    } catch {
      return last; // permission/network — caller falls back
    }
    if (last.available || last.cdn_ready) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
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

  // Treat the local config as a real link only if it actually carries a
  // project_id. `layero init` scaffolds .layero/project.json with the
  // detected framework/build/output but NO project_id (the project isn't
  // created until the first deploy). Without this guard, deploy would treat
  // that scaffold as an existing link and call GET /projects/undefined → 422
  // (B1 — the documented init→deploy path was broken). When there's no id,
  // fall through to the create path below, which preserves the scaffold's
  // setup fields via persistProjectLinking().
  if (existing && existing.project_id) {
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
  prebuiltDir: string | null,
): Promise<{ archive_key: string; commit_sha: string; archivePath: string }> {
  const pack = prebuiltDir
    ? await packDirectory(path.resolve(cwd, prebuiltDir), project.slug)
    : await packCwd(cwd, project.slug);
  emit({
    event: "packing",
    files: pack.fileCount,
    bytes: pack.size,
    sha256: pack.sha256,
    ...(prebuiltDir ? { prebuilt_dir: prebuiltDir } : {}),
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

const PREBUILT_AUTO_DIRS = [
  "dist",
  "build",
  "public",
  "out",
  "_site",
  ".output/public",
  "docs/.vitepress/dist",
  ".vitepress/dist",
];

async function resolvePrebuiltDir(
  cwd: string,
  raw: boolean | string | undefined,
): Promise<string | null> {
  if (raw === undefined || raw === false) return null;
  if (typeof raw === "string" && raw.length > 0) {
    return raw;
  }
  // No explicit dir — pick the first existing common output directory.
  for (const candidate of PREBUILT_AUTO_DIRS) {
    try {
      const stat = await fs.stat(path.join(cwd, candidate));
      if (stat.isDirectory()) return candidate;
    } catch {
      // try next
    }
  }
  throw new LayeroError(
    "prebuilt_no_dir",
    "could not auto-detect a built artifact directory",
    `pass it explicitly: --prebuilt ./dist  (tried: ${PREBUILT_AUTO_DIRS.join(", ")})`,
  );
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
  // Auto-detected runtime kind (currently only `ssr_next`). When set,
  // deploy.ts flips the project's project_type before triggering the
  // first build so the platform routes it through runtime-builder
  // instead of crashing in detect with "looks like ssr_next but
  // configured as spa". Honoured only on first setup; on already-active
  // projects the existing project_type wins.
  runtime_kind?: "ssr_next" | "streamlit" | "gradio" | "flask" | "python_web" | "node_web";
}> {
  // Honour --root when auto-detecting: the framework signals live in the
  // monorepo subdir, not the repo root. Without this the detector sees
  // a bare workspace package.json and falls through to "static".
  const detectCwd = opts.root ? path.join(cwd, opts.root) : cwd;
  const detected = await detectProject(detectCwd);
  emit({
    event: "detected",
    framework: detected.framework_hint,
    build_cmd: detected.build_cmd,
    output_dir: detected.output_dir,
    confident: detected.confident,
    ...(detected.runtime_kind ? { runtime_kind: detected.runtime_kind } : {}),
    ...(detected.ssr_warning ? { ssr_warning: detected.ssr_warning } : {}),
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

  return {
    framework_hint,
    build_cmd,
    output_dir,
    source,
    ...(detected.runtime_kind ? { runtime_kind: detected.runtime_kind } : {}),
  };
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

  let cliCfg = await loadConfig();
  if (!cliCfg.token) {
    // Not authenticated yet. Kick off the browser device-login flow inline
    // and poll, exactly as the docs describe (B5/I4) — no separate `layero
    // login` step required. In JSON/agent mode this emits `auth_required`
    // so the caller can render the link and keep waiting.
    cliCfg = await runDeviceLogin(cliCfg);
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

  // Prebuilt deploys: caller has already built the artifact and points at
  // its directory. Setup-config detection is skipped (we report a synthetic
  // static setup so completeSetup gets *some* values and the dashboard
  // shows the project is configured).
  const prebuiltDir = await resolvePrebuiltDir(cwd, opts.prebuilt);

  // Resolve setup config (auto-detect + overrides). Done eagerly so the
  // user sees what we detected before any network I/O.
  const setup: {
    framework_hint: string;
    build_cmd: string;
    output_dir: string;
    source: "config" | "detected" | "hybrid" | "prebuilt";
    runtime_kind?: "ssr_next" | "streamlit" | "gradio" | "flask" | "python_web" | "node_web";
  } = prebuiltDir
    ? {
        framework_hint: "static",
        build_cmd: "true",
        output_dir: ".",
        source: "prebuilt",
      }
    : await resolveSetupConfig(cwd, opts, existing);

  if (prebuiltDir) {
    emit({ event: "prebuilt", dir: prebuiltDir });
  }

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
      root_directory: opts.root ?? null,
    });
    emit({ event: "setup_applied" });
    // Newly-created projects default to project_type='spa'. If detect
    // says the repo is SSR (Next.js without `output: 'export'`), flip
    // the type now — otherwise the first build crashes at the detect
    // stage with "looks like ssr_next but configured as spa", forcing
    // the user to open the dashboard and accept the suggestion. Only
    // applied on first setup; an explicitly-configured spa project
    // that drops a next.config later keeps user's choice.
    if (setup.runtime_kind) {
      try {
        project = await api.setRuntimeType(project.id, setup.runtime_kind);
        emit({ event: "runtime_type_applied", project_type: setup.runtime_kind });
      } catch (err) {
        // Non-fatal: the build will fall back to the dashboard suggestion
        // flow exactly as it did before this CLI fix. Tell the user what
        // happened so they don't burn a deploy on a surprise crash.
        const msg = err instanceof Error ? err.message : String(err);
        emit({ event: "runtime_type_apply_failed", error: msg });
      }
    }
  } else if (opts.root !== undefined) {
    // Active project: --root patches the existing row so the *next*
    // GitHub-pushed or hook-triggered build uses the new subdir.
    project = await api.updateProject(project.id, { root_directory: opts.root });
  }

  let upload: Awaited<ReturnType<typeof packAndUpload>> | null = null;
  try {
    upload = await packAndUpload(api, cwd, project, prebuiltDir);

    const targeting = deployTargeting(opts);
    const deploy = await api.triggerDeploy(project.id, {
      source_archive_key: upload.archive_key,
      commit_sha: upload.commit_sha,
      commit_message: prebuiltDir ? `CLI prebuilt deploy (${prebuiltDir})` : "CLI deploy",
      framework_hint: setup.framework_hint,
      target: targeting.target,
      branch: targeting.branch,
      prebuilt: prebuiltDir !== null,
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

    // --promote: pin apex_hostname to this deploy after a successful
    // build. Independent of --prod; --promote lets the typical "CLI
    // preview branch" deploy publish straight to production in one
    // command. Best-effort: a failure here doesn't fail the deploy
    // (the artifact is good; promote can be retried via `layero promote`).
    let promoted = false;
    if (opts.promote) {
      try {
        await api.promoteDeploy(project.id, deploy.id);
        promoted = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          chalk.yellow(
            `warning: deploy succeeded but promote failed — ${msg}.\n` +
              `  retry with: layero promote ${deploy.id.slice(0, 8)}`,
          ),
        );
      }
    }

    // Where is this build actually reachable? Ask the backend rather than
    // guessing — it knows the live public URL (apex once it's the production
    // pointer), the off-CDN preview URL that's reachable immediately, and
    // how far along CDN propagation is. Note: a plain `layero deploy` of a
    // CLI project auto-promotes to the apex on activate (no `--prod` /
    // `promote` needed), so the apex IS the destination for the common case.
    const dashboardUrl = projectUrl(cliCfg.apiUrl, project.id);
    const apexUrl = `https://${project.apex_hostname}`;
    const probe = await resolveReachability(api, deploy.environment_id);

    // Public site URL: prefer the backend's canonical_url; fall back to the
    // apex for the no-branch case (CLI auto-promote), else the dashboard.
    const liveUrl =
      probe?.canonical_url ??
      (promoted || !opts.branch ? apexUrl : dashboardUrl);

    emit({
      event: "ready",
      url: liveUrl,
      deploy_id: deploy.id,
      preview_url: probe?.preview_url ?? undefined,
      dashboard_url: dashboardUrl,
      edge_ready: probe ? probe.cdn_ready : undefined,
      edge_eta_seconds:
        probe && !probe.cdn_ready && probe.cdn_eta_seconds != null
          ? probe.cdn_eta_seconds
          : undefined,
    });
  } finally {
    if (upload) {
      await fs.unlink(upload.archivePath).catch(() => undefined);
    }
  }
}
