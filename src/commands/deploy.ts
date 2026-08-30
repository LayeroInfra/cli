import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import chalk from "chalk";
import {
  ApiClient,
  ApiError,
  ProbeOut,
  ProjectSummary,
  uploadArchive,
} from "../api.js";
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
import { ensureUsername } from "../username.js";

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
  // Осознанное «да, я вижу, что предыдущие сборки падают с одной и той же
  // ошибкой». Отдельно от `--yes` намеренно: `--yes` в скриптах уже стоит,
  // и покрой мы стоп им — он не остановил бы ровно тех, ради кого заведён.
  confirmRepeatedFailure?: boolean;
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

/**
 * Runtime kinds — приложения, которые платформа ЗАПУСКАЕТ, а не раздаёт
 * файлами.
 *
 * 🚨 Их здесь не было вовсе, и это стоило переноса. `--type` принимал только
 * статические пресеты, а Express-репозиторий детект уверенно опознавал как
 * `vite` — из-за devDependency `vite`, которую тянет `vitest`. Первый деплой
 * умирал на «собранный сайт не содержит index.html», и единственным выходом
 * оставался curl в недокументированную ручку `/projects/<id>/runtime-type`.
 * Найдено переносом настоящего приложения 16.08.2026.
 *
 * Слева — то, что человек напишет, справа — то, что понимает платформа.
 * Синонимы не украшение: `--type express` пишут чаще, чем `--type node_web`,
 * и отказ на нём отправляет читать исходники, а не деплоить.
 */
const RUNTIME_TYPES: Record<string, string> = {
  node_web: "node_web",
  node: "node_web",
  express: "node_web",
  fastify: "node_web",
  nest: "node_web",
  nestjs: "node_web",
  koa: "node_web",
  python_web: "python_web",
  python: "python_web",
  fastapi: "python_web",
  django: "python_web",
  flask: "flask",
  streamlit: "streamlit",
  gradio: "gradio",
  ssr_next: "ssr_next",
  "next-ssr": "ssr_next",
};

/** То же множество, что принимает сессия деплоя (без `spa`). */
type RuntimeKindHint =
  | "ssr_next" | "streamlit" | "gradio" | "flask" | "python_web" | "node_web";

/** Каноничный runtime-kind по тому, что написал человек, либо `null`. */
export function runtimeTypeOf(raw: string | undefined): string | null {
  if (!raw) return null;
  return RUNTIME_TYPES[raw.trim().toLowerCase()] ?? null;
}

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
    const answer = (await rl.question(`${question} [y/N]: `))
      .trim()
      .toLowerCase();
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
  runtime_kind?:
    "ssr_next" | "streamlit" | "gradio" | "flask" | "python_web" | "node_web";
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

  // ⚠️ Runtime-тип в `framework_hint` не уходит: это разные вопросы. Хинт
  // отвечает «чем собирать» (vite, next, …), а runtime-kind — «запускать или
  // раздавать файлами». Положи мы сюда `node_web`, сборщик получил бы имя
  // фреймворка, которого не существует.
  const asRuntime = runtimeTypeOf(opts.type);
  const framework_hint =
    (asRuntime ? undefined : opts.type) ??
    existing?.framework_hint ??
    detected.framework_hint;
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
    // Явный `--type` сильнее детекта: человек уже видел, как детект ошибся,
    // иначе бы не писал флаг.
    ...(asRuntime
      ? { runtime_kind: asRuntime as RuntimeKindHint }
      : detected.runtime_kind
        ? { runtime_kind: detected.runtime_kind }
        : {}),
  };
}


/**
 * Тело ответа сервера, когда подряд идущие сборки падают с одной и той же
 * ошибкой (V224). Платформа отказывается выкатывать одиннадцатую вслепую.
 */
interface RepeatedFailureDetail {
  code: "repeated_failure";
  streak: number;
  threshold: number;
  // "project" — серия набрана этим проектом; "owner" — суммой по проектам
  // владельца (V225). Поля может не быть: сервер старее клиента.
  scope?: "project" | "owner" | null;
  failure_stage?: string | null;
  error?: string | null;
  message: string;
  confirm_field: string;
}

/**
 * Русская форма числительного. Шесть строк вместо зависимости: в CLI своего
 * плюрализатора нет, а «2 сборок» в стоп-сообщении читается как небрежность
 * ровно там, где нужно доверие. Порог настраивается платформой, поэтому
 * подставить одну форму нельзя — при пороге 2 и при пороге 5 они разные.
 */
function pluralRu(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  if (a >= 11 && a <= 14) return many;
  const b = a % 10;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

function parseRepeatedFailure(err: unknown): RepeatedFailureDetail | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  try {
    const detail = JSON.parse(err.body)?.detail;
    return detail?.code === "repeated_failure" ? (detail as RepeatedFailureDetail) : null;
  } catch {
    return null;
  }
}

/**
 * Запуск сборки со стопом на повторяющейся ошибке.
 *
 * СМЫСЛ СТОПА — ОСТАНОВИТЬ ТОГО, КТО ГОНИТ ВЫКАТКУ ВСЛЕПУЮ. Агент, десятый раз
 * собирающий одно и то же, ошибку обычно НЕ читает: она приходит в конце
 * длинного лога сборки, а он смотрит на код возврата и запускает снова. Поэтому
 * здесь текст ошибки печатается ПЕРВЫМ и отдельно от всего остального, и лишь
 * потом объясняется, что делать.
 *
 * В интерактивном терминале спрашиваем прямо; без TTY (агент, CI) — падаем с
 * отдельным кодом ошибки. Автоматически продолжать нельзя: это ровно тот цикл,
 * который правило и разрывает.
 */
async function startWithRepeatedFailureGuard(
  api: ApiClient,
  sessionId: string,
  commitSha: string,
  opts: DeployOptions,
) {
  try {
    return await api.startDeploySession(sessionId, {
      commit_sha: commitSha,
      confirm_repeated_failure: opts.confirmRepeatedFailure === true,
    });
  } catch (err) {
    const detail = parseRepeatedFailure(err);
    if (!detail) throw err;

    // Машиночитаемое событие — для агентов в режиме --json.
    // `scope` отвечает на вопрос, который агент задаст первым: «я собирал в
    // этом проекте три раза, откуда десять?». Серия могла набраться суммой по
    // нескольким его проектам — перенос в новый проект правило не обходит.
    const scope = detail.scope === "owner" ? "owner" : "project";
    emit({
      event: "repeated_failure_guard",
      streak: detail.streak,
      threshold: detail.threshold,
      scope,
      failure_stage: detail.failure_stage ?? undefined,
      error: detail.error ?? undefined,
    });

    const errorText = (detail.error || "").trim();
    console.error("");
    console.error(
      chalk.red.bold(
        `Стоп: ${detail.streak} ${pluralRu(detail.streak, "сборка", "сборки", "сборок")} ` +
          (scope === "owner"
            ? "в ваших проектах упали с одной и той же ошибкой."
            : "подряд упали с одной и той же ошибкой."),
      ),
    );
    if (errorText) {
      console.error("");
      console.error(chalk.red(errorText));
    }
    if (detail.failure_stage) {
      console.error(chalk.dim(`Стадия: ${detail.failure_stage}`));
    }
    console.error("");
    if (scope === "owner") {
      console.error(
        "Ошибка повторяется в разных проектах — значит, дело не в конкретном",
      );
      console.error("проекте, а в коде приложения или в настройках сборки.");
      console.error("");
    }
    console.error(
      "Повторная выкатка без изменений даст тот же результат. Исправьте причину —",
    );
    console.error("или подтвердите, что изменили что-то, влияющее на неё.");
    console.error("");

    const mode = detectMode();
    if (mode.interactive) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        const answer = (
          await rl.question("Всё равно выкатить? [y/N]: ")
        ).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          throw new LayeroError(
            "repeated_failure_declined",
            "deploy cancelled: the same error keeps failing the build",
            "fix the error above, then run `layero deploy` again",
          );
        }
      } finally {
        rl.close();
      }
      return await api.startDeploySession(sessionId, {
        commit_sha: commitSha,
        confirm_repeated_failure: true,
      });
    }

    throw new LayeroError(
      "repeated_failure",
      `deploy stopped: the last ${detail.streak} deploys failed with the SAME error` +
        (errorText ? ` — ${errorText}` : ""),
      "read the error above and fix its cause. Re-running the same deploy will " +
        "fail the same way. If you changed something that affects it, re-run with " +
        "`--confirm-repeated-failure`.",
    );
  }
}

export async function deployCmd(opts: DeployOptions): Promise<void> {
  const mode = detectMode();

  if (
    opts.type &&
    !VALID_TYPES.has(opts.type.toLowerCase()) &&
    !runtimeTypeOf(opts.type)
  ) {
    throw new LayeroError(
      "invalid_type",
      `unknown --type "${opts.type}"`,
      // Две группы, а не один список: у них разная судьба. Статический пресет
      // говорит, ЧЕМ собирать; runtime-тип — что приложение надо ЗАПУСКАТЬ.
      `static presets: ${[...VALID_TYPES].join(", ")}\n` +
        `runtime kinds: ${[...new Set(Object.values(RUNTIME_TYPES))].join(", ")} ` +
        `(aliases: ${Object.keys(RUNTIME_TYPES).join(", ")})`,
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
    runtime_kind?:
      "ssr_next" | "streamlit" | "gradio" | "flask" | "python_web" | "node_web";
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

  // Тело вынесено из вызова, чтобы повтор после выбора имени аккаунта уходил
  // РОВНО с тем же payload — собирать его второй раз значит однажды разойтись.
  const sessionPayload = {
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
  };

  let session;
  try {
    session = await api.createDeploySession(sessionPayload);
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
    // 412 = у аккаунта нет имени, и платформе некуда положить проект (имя
    // становится слагом личной организации). В интерактивном терминале
    // спрашиваем прямо здесь и повторяем — отправлять в браузер за одним
    // словом значит обрывать ровно тот сценарий, ради которого ставят CLI.
    if (err instanceof ApiError && err.status === 412) {
      await ensureUsername(api);
      session = await api.createDeploySession(sessionPayload);
    } else {
      throw err;
    }
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

  // 🚨 На ПЕРВОЙ настройке хватает `runtime_kind` в сессии, а у уже
  // существующего проекта побеждает его `project_type` — и `--type node_web`
  // молча не делал ничего. Ровно здесь человек и упирался: тип приходилось
  // менять curl'ом в `/projects/<id>/runtime-type`.
  //
  // Момент выбран не случайно: сессия создана (значит, id проекта известен),
  // но архив ещё не упакован и сборка не запущена — флип успевает повлиять на
  // ту же выкатку.
  // 🚨 И ОБРАТНАЯ дорога. Статический пресет (`--type next`) менял только
  // подсказку фреймворка, а проект оставался приложением: Next с
  // `output: "export"` собирал статику, а платформа искала, что запускать, и
  // сборка падала. Выйти из типа «приложение» было нечем — в панели
  // переключателя нет, у CLI была только дорога В рантайм. Живой клиент 30.08
  // прошёл этот тупик восемь раз (`T-20260830-1`).
  const wantRuntime = runtimeTypeOf(opts.type);
  const wantStatic =
    !wantRuntime && !!opts.type && project.project_type && project.project_type !== "spa"
      ? "spa"
      : null;
  const wantType = wantRuntime ?? wantStatic;
  if (wantType && project.project_type !== wantType) {
    try {
      await api.setRuntimeType(project.id, wantType as RuntimeKindHint);
    } catch (err) {
      // 409 — платформа возражает: репозиторий не похож на этот тип. Возражение
      // обязано быть заметным, но не запирающим: человек написал флаг явно, и
      // спорить с ним мы перестали намеренно (та же логика, что у панели).
      if (err instanceof ApiError && err.status === 409) {
        process.stderr.write(
          chalk.yellow(
            `! platform disagrees with --type ${wantType}: ${err.body.slice(0, 200)}\n` +
              `  applying anyway because you asked explicitly\n`,
          ),
        );
        await api.setRuntimeType(project.id, wantType as RuntimeKindHint, true);
      } else {
        throw err;
      }
    }
    emit({ event: "runtime_type_applied", project_type: wantType as RuntimeKindHint });
  }

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

    const started = await startWithRepeatedFailureGuard(
      api,
      session.session_id,
      pack.sha256,
      opts,
    );
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
    // Отмена — не отказ. С выделением 'cancelled' в отдельный статус
    // (08.08.2026) прежняя строка напечатала бы «deploy failed (cancelled)»:
    // деплой одновременно и упал, и отменён. Чаще всего причина — вытеснение
    // более новым пушем, и совет «посмотрите логи» тут не по адресу: смотреть
    // надо на деплой-преемник, а не на этот.
    if (final.status === "cancelled") {
      throw new LayeroError(
        "deploy_cancelled",
        `deploy cancelled${final.error_message ? `: ${final.error_message}` : ""}`,
        "a newer deploy superseded this one — check the latest deploy in the dashboard",
      );
    }
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
        ? (probe?.canonical_url ?? apexUrl)
        : (probe?.preview_url ?? probe?.canonical_url ?? apexUrl);

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
