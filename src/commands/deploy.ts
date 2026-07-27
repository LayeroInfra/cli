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
import { LayeroError, detectMode, emit, isCiEnv } from "../agent.js";

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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  let dir: string | null = null;
  if (typeof raw === "string" && raw.length > 0) {
    dir = raw;
  } else {
    // No explicit dir — pick the first existing common output directory.
    for (const candidate of PREBUILT_AUTO_DIRS) {
      try {
        const stat = await fs.stat(path.join(cwd, candidate));
        if (stat.isDirectory()) {
          dir = candidate;
          break;
        }
      } catch {
        // try next
      }
    }
    if (dir === null) {
      throw new LayeroError(
        "prebuilt_no_dir",
        "could not auto-detect a built artifact directory",
        `pass it explicitly: --prebuilt ./dist  (tried: ${PREBUILT_AUTO_DIRS.join(", ")})`,
      );
    }
  }
  // Servability check (mirrors the builder-side gate, 2026-07-01 audit): a
  // prebuilt dir with no index.html at its root isn't a servable site — the
  // apex "/" would 404. Fail fast here, before packing + uploading, instead of
  // the deploy going "ready" but broken.
  let hasIndex = false;
  try {
    const entries = await fs.readdir(path.join(cwd, dir));
    hasIndex = entries.some((e) => e.toLowerCase() === "index.html");
  } catch {
    hasIndex = false;
  }
  if (!hasIndex) {
    throw new LayeroError(
      "prebuilt_no_index",
      `'${dir}' has no index.html — nothing to serve`,
      `point --prebuilt at the folder that contains your built index.html (e.g. --prebuilt ./dist)`,
    );
  }
  return dir;
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
    // In CI nobody can open a browser, so the device flow can only end one
    // way: fifteen minutes of a hung job and then `auth_expired`. Fail
    // immediately instead, and say what to do — burning a quarter of an hour
    // of someone's runner to reach a foregone conclusion is not acceptable.
    if (isCiEnv()) {
      throw new LayeroError(
        "auth_required",
        "No credentials in CI. Create a token at https://app.layero.ru/settings/cli " +
          "and pass it as the LAYERO_TOKEN environment variable.",
        "set_layero_token",
      );
    }
    cliCfg = await runDeviceLogin(cliCfg);
  }
  const api = new ApiClient(cliCfg);
  const cwd = process.cwd();
  const existing = await loadProjectConfig(cwd);

  // --- Всё, что требует файловой системы, делаем сами. Остальное — сервер.

  const prebuiltDir = await resolvePrebuiltDir(cwd, opts.prebuilt);

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

  // Организацию выбирает человек — но только когда есть из чего выбирать и
  // есть кому отвечать. В агентском режиме и в CI спрашивать некого, там
  // политику применяет сервер (одна организация → она, несколько → личная).
  const willCreate = !opts.project && !existing?.project_id;
  let organizationSlug: string | undefined = opts.org;
  if (willCreate && !organizationSlug && mode.interactive && !opts.yes) {
    const orgs = await api.listOrganizations();
    if (orgs.length > 1) {
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
    (willCreate && mode.interactive && !opts.yes && !opts.config
      ? await prompt("project name", fallbackName)
      : fallbackName);

  const targeting = deployTargeting(opts);

  // --- Одно обращение вместо пяти: резолв или создание проекта, настройка,
  // тип рантайма, root и выдача адреса для загрузки архива.

  let session;
  try {
    session = await api.createDeploySession({
      // `--project` ПЕРЕОПРЕДЕЛЯЕТ запись в .layero/project.json: пользователь
      // явно сказал, куда деплоить, и залинкованный проект тут не при чём.
      // Передать оба поля нельзя — сервер выберет project_id и молча уедет
      // не туда, куда просили.
      //
      // Флаг принимает И id, И слаг (так было до переноса оркестрации), а
      // на сервере это разные поля: `project_id` ищется по идентификатору,
      // `name` — по слагу. Отличаем по форме значения, иначе UUID уходит в
      // поиск по слагу и не находится — живой прогон это и показал.
      //
      // Опечатка в слаге при этом обязана дать 404, а не завести лишний
      // проект с похожим именем: `create_if_missing: false`.
      ...(opts.project
        ? UUID_RE.test(opts.project)
          ? { project_id: opts.project }
          : { name: opts.project, create_if_missing: false }
        : existing?.project_id
          ? { project_id: existing.project_id }
          : { name }),
      organization_slug: organizationSlug,
      target: targeting.target,
      branch: targeting.branch,
      promote: Boolean(opts.promote),
      prebuilt: prebuiltDir !== null,
      framework_hint: setup.framework_hint,
      build_cmd: setup.build_cmd,
      output_dir: setup.output_dir,
      runtime_kind: setup.runtime_kind,
      root_directory: opts.root ?? null,
      env_vars: existing?.env_vars ?? {},
      commit_message: prebuiltDir
        ? `CLI prebuilt deploy (${prebuiltDir})`
        : "CLI deploy",
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404 && opts.project) {
      // Явно указанный проект не найден. Код ошибки сохраняем прежним
      // (`project_not_found`): на него смотрят агенты и наш Action, и
      // подменять его на `internal` значит ломать их обработку.
      throw new LayeroError(
        "project_not_found",
        `no project with id/slug "${opts.project}"`,
        "run `layero projects list` to see available projects",
      );
    }
    if (err instanceof ApiError && err.status === 403) {
      throw new LayeroError(
        "forbidden",
        `access denied: ${err.body.slice(0, 200)}`,
        "check that your token has the required scope and that you're a member of the organization",
      );
    }
    throw err;
  }

  const project = session.project;
  if (project.cli_deploys_enabled === false) {
    throw new LayeroError(
      "cli_deploys_disabled",
      `CLI deploys are disabled on project "${project.slug}"`,
      "enable them in project settings, or remove --project to use a different project",
    );
  }

  emit(
    session.created_project
      ? {
          event: "project_created",
          project_id: project.id,
          slug: project.slug,
          organization: project.organization.slug,
        }
      : {
          event: "project_linked",
          project_id: project.id,
          slug: project.slug,
        },
  );
  emit({ event: "setup_applied" });

  await persistProjectLinking(
    cwd,
    {
      project_id: project.id,
      slug: project.slug,
      organization_slug: project.organization.slug,
      apex_hostname: project.apex_hostname,
    },
    setup.framework_hint,
  );

  // Подтверждение спрашиваем ЗДЕСЬ, а не раньше: адрес апекса известен
  // только от сервера, а сборка ещё не запущена — отказ ничего не стоит.
  // Для только что созданного проекта вопрос бессмыслен: перезаписывать
  // нечего.
  if (
    opts.prod &&
    !opts.yes &&
    !opts.branch &&
    mode.interactive &&
    !session.created_project
  ) {
    const ok = await confirm(
      `deploy to production (https://${project.apex_hostname})?`,
    );
    if (!ok) {
      console.log(chalk.yellow("aborted."));
      return;
    }
  }

  // --- Упаковка и загрузка: единственное, что клиент обязан делать сам.

  let archivePath: string | null = null;
  try {
    const pack = prebuiltDir
      ? await packDirectory(path.resolve(cwd, prebuiltDir), project.slug)
      : await packCwd(cwd, project.slug);
    archivePath = pack.archivePath;
    emit({
      event: "packing",
      files: pack.fileCount,
      bytes: pack.size,
      sha256: pack.sha256,
      ...(prebuiltDir ? { prebuilt_dir: prebuiltDir } : {}),
    });
    if (pack.forcedLockfiles?.length) {
      process.stderr.write(
        chalk.yellow(
          `! including gitignored lockfile(s) so the build uses a frozen install: ` +
            `${pack.forcedLockfiles.join(", ")}\n`,
        ),
      );
    }

    emit({ event: "uploading" });
    await uploadArchive(
      {
        upload_url: session.upload_url,
        headers: session.upload_headers,
        source_archive_key: session.source_archive_key,
        expires_in: session.expires_in,
      },
      pack.archivePath,
    );
    emit({ event: "uploaded", archive_key: session.source_archive_key });

    const started = await api.startDeploySession(session.session_id, {
      commit_sha: pack.sha256,
    });
    if (!started.deploy_id) {
      throw new LayeroError(
        "deploy_not_started",
        `deploy session ended as "${started.status}"${
          started.error ? `: ${started.error}` : ""
        }`,
        "re-run `layero deploy`; if it repeats, check the project in the dashboard",
      );
    }
    emit({ event: "deploy_started", deploy_id: started.deploy_id });

    const final = await streamDeployLogs(api, started.deploy_id);
    if (final.status !== "ready") {
      throw new LayeroError(
        `deploy_${final.status}`,
        `deploy failed (${final.status})${
          final.error_message ? `: ${final.error_message}` : ""
        }`,
        `inspect logs at ${projectUrl(cliCfg.apiUrl, project.id)}`,
      );
    }

    // --promote: пин апекса на эту сборку. Промоут остаётся на клиенте
    // осознанно — сборка асинхронна, а сервер применяет промоут только
    // после активации (см. AGENT-01, известные ограничения).
    let promoted = false;
    if (opts.promote) {
      try {
        await api.promoteDeploy(project.id, started.deploy_id);
        promoted = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          chalk.yellow(
            `warning: deploy succeeded but promote failed — ${msg}.\n` +
              `  retry with: layero promote ${started.deploy_id.slice(0, 8)}`,
          ),
        );
      }
    }

    const dashboardUrl = projectUrl(cliCfg.apiUrl, project.id);
    const apexUrl = `https://${project.apex_hostname}`;
    const deployRow = await api.getDeploy(started.deploy_id);
    const probe = deployRow.environment_id
      ? await resolveReachability(api, deployRow.environment_id)
      : null;

    const liveUrl =
      promoted || !opts.branch
        ? probe?.canonical_url ?? apexUrl
        : probe?.preview_url ?? probe?.canonical_url ?? apexUrl;

    emit({
      event: "ready",
      url: liveUrl,
      deploy_id: started.deploy_id,
      preview_url: probe?.preview_url ?? undefined,
      dashboard_url: dashboardUrl,
      edge_ready: probe ? probe.available : undefined,
    });
  } finally {
    if (archivePath) {
      await fs.unlink(archivePath).catch(() => undefined);
    }
  }
}
