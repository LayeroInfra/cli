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
import { looksLikeId } from "../project-ref.js";
import { dashboardOrigin } from "../urls.js";
import { CliConfig, loadConfig } from "../config.js";
import {
  ProjectConfig,
  loadProjectConfig,
  persistProjectLinking,
  projectConfigPath,
} from "../project-config.js";
import { packCwd, packDirectory } from "../pack.js";
import { streamDeployLogs } from "../logs.js";
import { Detected, detectProject, detectedEvent, type ValueSource } from "../detect.js";
import { runDeviceLogin } from "../auth.js";
import { LayeroError, detectMode, emit, isCiEnv } from "../agent.js";
import { ensureUsername } from "../username.js";
import { assertSandboxAlive, claimFor, claimTokenFor, createClaimable, keepLegacyClaim } from "./claim.js";

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
  // --claim: деплой без аккаунта (этап 13). Платформа заводит временный
  // проект на час и выдаёт токен на него; человек забирает сайт по
  // ссылке из события `claimable`. Только явным флагом (T-20260921).
  claim?: boolean;
  // --dry-run: показать, как платформа соберёт папку, и ничего не выгружать.
  // Входа не требует: читает только диск (и настройки проекта, если вход есть).
  dryRun?: boolean;
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

function projectUrl(apiUrl: string, projectId: string): string {
  return `${dashboardOrigin(apiUrl)}/projects/${projectId}`;
}

/**
 * After a deploy reaches `ready`, ask the backend for the canonical address
 * of its environment (apex for the production env, the env host otherwise).
 *
 * One request, not a poll. The probe used to be polled for up to 15 s until
 * its `available` flag turned true, and that flag also fed `edge_ready` — but
 * it is the API's own view of the host, and the simulation of 18.09.2026 saw
 * it stay false for 15 s on a static site that answered 200 at once. Whether
 * the address serves the site is now measured directly (`waitUntilServing`).
 * Best-effort: any error returns null and the caller falls back to the apex.
 */
async function resolveReachability(
  api: ApiClient,
  environmentId: string,
): Promise<ProbeOut | null> {
  try {
    return await api.probeEnvironment(environmentId);
  } catch {
    return null; // permission/network — caller falls back
  }
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

/**
 * Настройки проекта, которые деплой отправляет платформе, и то, что показал
 * детект.
 *
 * 🚨 В ПРОЕКТ УХОДИТ ТОЛЬКО НАЗВАННОЕ ЧЕЛОВЕКОМ: `--type`, поля
 * `.layero/project.json`, которые он написал сам. Догадка детекта не уходит.
 *
 * До 18.09.2026 первая выкатка сохраняла в проект всё, что угадал CLI, —
 * фреймворк, команду и каталог. Сборщик исполняет настройки проекта дословно
 * (`BUILD-CONFIG.md`: «значение есть — исполняем»), поэтому догадка
 * становилась решением на все следующие сборки: в логе она выглядела как
 * `(from hint)` и `(from dashboard)` у проекта, который никто не настраивал, а
 * `static`, угаданный для монорепо или своего скрипта сборки, глушил сборку
 * навсегда. Пусто — значит «решит сборщик по архиву»: он видит тот же код и
 * на первой сборке применяет правила, которых в CLI нет (T-20260918-7).
 */
interface SetupConfig {
  detected: Detected;
  framework_hint: string | null;
  build_cmd: string | null;
  output_dir: string | null;
  runtime_kind?: RuntimeKindHint;
  // Кто назвал тип приложения: `user` — флаг `--type`, `detected` — детект.
  // Платформа пишет его в источник типа: выбор человека сборщик не оспаривает,
  // а догадку уточняет по архиву. Без поля догадка CLI становилась «выбором
  // владельца» и запирала проект.
  runtime_kind_origin?: "user" | "detected";
}

/**
 * Заготовка `layero init` до 0.11: `static` / `true` / `.` без project_id.
 * Эту тройку писал CLI, а не человек, — и она та самая догадка, от которой
 * эта версия отказалась. Читать её как выбор значит тащить старую ошибку в
 * новый проект.
 */
function isLegacyInitGuess(cfg: ProjectConfig | null): boolean {
  return Boolean(
    cfg &&
      !cfg.project_id &&
      cfg.framework_hint === "static" &&
      cfg.build_cmd === "true" &&
      cfg.output_dir === ".",
  );
}

/**
 * 🚨 ПЕСОЧНИЦА — ТОЛЬКО СТАТИКА И SPA (T-20260919-10, решение владельца
 * 19.09.2026). Серверное приложение (SSR, fullstack, контейнер) без аккаунта
 * не выкладывается: это анонимный процесс с выходом в интернет на общем узле.
 * Проверка ДО того, как заведена песочница и уехал архив; платформа и сборщик
 * откажут и сами, но уже потратив чужую минуту.
 */
async function assertSandboxServesFiles(
  cwd: string,
  opts: DeployOptions,
  existing: ProjectConfig | null,
  detectFolder: Detector,
): Promise<void> {
  if (opts.prebuilt) return; // готовая сборка — это файлы по определению
  const h = hintsFor(cwd, opts, existing);
  const kind = h.asRuntime ?? (await detectFolder(h.detectCwd, h.hint, h.hintSource)).runtime_kind ?? null;
  if (!kind) return;
  throw new LayeroError(
    "claim_static_only",
    `деплой без аккаунта (--claim) выкладывает только статику и SPA, а эта папка — серверное приложение (${kind})`,
    "sign in and deploy from the account: `npx layero@latest login`, then run the same deploy without --claim",
  );
}

/** Детект папки: один на запуск, общий для проверки песочницы и плана сборки. */
type Detector = (detectCwd: string, hint: string | null, hintSource: ValueSource) => Promise<Detected>;

/**
 * 🚨 ДЕТЕКТ — ОДИН НА ВЫКАТКУ. Гейт core «входов анализа не становится
 * больше» считает запуски детекта в этом файле: каждый лишний — ещё один
 * снимок папки со своей полнотой, и два снимка рано или поздно разойдутся.
 * Проверка песочницы (до заявки) и план сборки (после входа) берут один
 * результат по одинаковым входам.
 */
function oneDetectionPerRun(): Detector {
  const memo = new Map<string, Promise<Detected>>();
  return (detectCwd, hint, hintSource) => {
    const key = `${detectCwd}\u0000${hint ?? ""}\u0000${hintSource}`;
    let run = memo.get(key);
    if (!run) {
      run = detectProject(detectCwd, { frameworkHint: hint, hintSource });
      memo.set(key, run);
    }
    return run;
  };
}

/** Входы детекта: папка (с `--root`) и подсказка фреймворка с её источником. */
function hintsFor(
  cwd: string,
  opts: DeployOptions,
  existing: ProjectConfig | null,
  projectFramework?: string | null,
) {
  // Honour --root when auto-detecting: the framework signals live in the
  // monorepo subdir, not the repo root.
  const detectCwd = opts.root ? path.join(cwd, opts.root) : cwd;
  // ⚠️ Runtime-тип в `framework_hint` не уходит: это разные вопросы. Хинт
  // отвечает «чем собирать» (vite, next, …), а runtime-kind — «запускать или
  // раздавать файлами». Положи мы сюда `node_web`, сборщик получил бы имя
  // фреймворка, которого не существует.
  const asRuntime = runtimeTypeOf(opts.type);
  const typeHint = asRuntime ? null : (opts.type ?? null);
  const own = isLegacyInitGuess(existing) ? null : existing;
  const fileHint = own?.framework_hint ?? null;
  const hint = typeHint ?? fileHint ?? projectFramework ?? null;
  const hintSource: ValueSource = typeHint ? "--type" : fileHint ? ".layero/project.json" : "project settings";
  return { detectCwd, asRuntime, typeHint, own, fileHint, hint, hintSource };
}

async function resolveSetupConfig(
  cwd: string,
  opts: DeployOptions,
  existing: ProjectConfig | null,
  projectFramework: string | null | undefined,
  detectFolder: Detector,
): Promise<SetupConfig> {
  const { detectCwd, asRuntime, typeHint, own, fileHint, hint, hintSource } = hintsFor(
    cwd, opts, existing, projectFramework,
  );
  const detected = await detectFolder(detectCwd, hint, hintSource);
  emit(detectedEvent(detected));

  return {
    detected,
    framework_hint: typeHint ?? fileHint,
    build_cmd: own?.build_cmd ?? null,
    output_dir: own?.output_dir ?? null,
    // Явный `--type` сильнее детекта: человек уже видел, как детект ошибся,
    // иначе бы не писал флаг.
    ...(asRuntime
      ? { runtime_kind: asRuntime as RuntimeKindHint, runtime_kind_origin: "user" as const }
      : detected.runtime_kind
        ? { runtime_kind: detected.runtime_kind, runtime_kind_origin: "detected" as const }
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

const RUNTIME_PROJECT_TYPES = new Set(["ssr_next", "streamlit", "gradio", "flask", "python_web", "node_web"]);

/** У проекта подключён репозиторий: выкатка архива без `--prod` ляжет в
 * окружение `cli`, а не на живой адрес. */
function hasRepo(p: ProjectSummary | null): boolean {
  return Boolean(p?.repo_full_name && p.repo_status !== "disconnected");
}

/**
 * `deploy --dry-run`: как платформа соберёт эту папку, если выкатить сейчас.
 * Ничего не пакуется, не выгружается и не создаётся.
 *
 * 🚨 До 0.11 сухого прогона не было: единственным доказательством того, что
 * платформа поняла папку, был лог настоящей сборки. Агент проверял форму
 * приложения выкатками — а у проекта без репозитория каждая из них заменяет
 * живой сайт (симуляция 18.09.2026, T-20260918-7).
 *
 * Порядок тот же, что у сборщика: `layero.json` > настройки проекта > детект.
 * Настройки читаются, только если папка привязана к проекту и вход есть; без
 * них план показывает то, что говорят файлы, и говорит об этом полем.
 */
async function dryRun(
  cwd: string,
  opts: DeployOptions,
  existing: ProjectConfig | null,
  cliCfg: CliConfig,
): Promise<void> {
  const ref = opts.project ?? (existing?.project_id || undefined);
  let project: ProjectSummary | null = null;
  let settings = "not linked";
  if (ref) {
    const token = cliCfg.token ?? claimTokenFor(cliCfg, existing?.project_id);
    if (!token) {
      settings = "not read: not logged in";
    } else {
      try {
        const api = new ApiClient({ ...cliCfg, token });
        project = opts.project ? await api.resolveProject(opts.project) : await api.getProject(ref);
        settings = "read";
      } catch (err) {
        settings = `not read: ${err instanceof ApiError ? `API ${err.status}` : "network error"}`;
      }
    }
  }
  const root = opts.root ?? project?.root_directory ?? null;
  const replacesLive = !project || !hasRepo(project) || Boolean(opts.prod || opts.promote);
  const branchNote = opts.branch
    ? `A real deploy refuses --branch (branch_unsupported): an upload always lands in the "cli" environment.`
    : "";
  const projectInfo = project
    ? { id: project.id, slug: project.slug, project_type: project.project_type, repo: project.repo_full_name ?? null }
    : null;

  const prebuiltDir = await resolvePrebuiltDir(cwd, opts.prebuilt);
  if (prebuiltDir) {
    emit({
      event: "plan",
      framework: "static",
      build_cmd: null,
      output_dir: prebuiltDir,
      runtime_kind: null,
      root: null,
      confident: true,
      sources: { framework: "--prebuilt", build_cmd: "none", output_dir: "--prebuilt" },
      project: projectInfo,
      project_settings: settings,
      creates_project: !ref,
      replaces_live_site: replacesLive,
      prebuilt_dir: prebuiltDir,
      ...(branchNote ? { hint: branchNote } : {}),
    });
    return;
  }

  const setup = await resolveSetupConfig(
    cwd,
    { ...opts, root: root ?? undefined },
    existing,
    project?.framework_hint ?? null,
    oneDetectionPerRun(),
  );
  const d = setup.detected;
  let buildCmd = d.build_cmd;
  let outputDir = d.output_dir;
  const sources: { framework: string; build_cmd: string; output_dir: string; runtime_kind?: string } = { ...d.sources };
  let runtimeKind: string | null = setup.runtime_kind ?? null;
  // Настройки проекта исполняются дословно — поверх детекта, но под файлом.
  // Статика не собирается, что бы ни лежало в поле команды.
  if (project && !d.runtime_kind) {
    if (project.build_cmd && d.framework_hint !== "static" && sources.build_cmd !== "layero.json") {
      buildCmd = project.build_cmd;
      sources.build_cmd = "project settings";
    }
    if (project.output_dir && sources.output_dir !== "layero.json") {
      outputDir = project.output_dir;
      sources.output_dir = "project settings";
    }
    if (RUNTIME_PROJECT_TYPES.has(project.project_type)) runtimeKind = project.project_type;
  }
  const hint = [d.hint, branchNote].filter(Boolean).join(" ");
  emit({
    event: "plan",
    framework: d.framework_hint,
    build_cmd: runtimeKind ? null : buildCmd,
    output_dir: runtimeKind ? null : outputDir,
    runtime_kind: runtimeKind,
    root,
    confident: d.confident,
    sources,
    project: projectInfo,
    project_settings: settings,
    creates_project: !ref,
    replaces_live_site: replacesLive,
    ...(hint ? { hint } : {}),
    ...(d.next_action ? { next_action: d.next_action } : {}),
    ...(d.candidates?.length ? { candidates: d.candidates } : {}),
    ...(d.layero_warnings?.length ? { layero_warnings: d.layero_warnings } : {}),
  });
}

// Сколько ждём, пока живой адрес начнёт отвечать приложением. Статика
// отвечает с первого запроса; контейнеру нужно до ~20 с на запуск, и
// симуляция 18.09.2026 видела 404-заглушку платформы уже после `ready`.
const SERVE_WAIT_MS = 90_000;
const SERVE_POLL_MS = 2_000;

/**
 * Дождаться, пока адрес перестанет отдавать экран платформы.
 *
 * Признак — заголовок `X-Layero-Screen`: его ставят ТОЛЬКО наши экраны
 * («запускается», «здесь пока ничего нет», …), ответ сайта его не несёт.
 * Тот же признак ждёт проба отклика платформы (`deploy_probe._await_edge`);
 * время само по себе ничего не доказывает. До 0.11 CLI отдавал `ready`, как
 * только сборка закончилась, и агенту приходилось опрашивать адрес самому —
 * он узнавал это только из навыка (T-20260918-8).
 */
export async function waitUntilServing(
  url: string,
  budgetMs = SERVE_WAIT_MS,
): Promise<{ serving: boolean; screen?: string }> {
  const deadline = Date.now() + budgetMs;
  let screen: string | undefined;
  for (;;) {
    try {
      const res = await fetch(url, {
        headers: { "cache-control": "no-cache" },
        redirect: "follow",
        signal: AbortSignal.timeout(10_000),
      });
      screen = res.headers.get("x-layero-screen") ?? undefined;
      await res.body?.cancel().catch(() => undefined);
      if (!screen) return { serving: true };
    } catch {
      screen = "no response";
    }
    if (Date.now() + SERVE_POLL_MS > deadline) return { serving: false, screen };
    await new Promise((r) => setTimeout(r, SERVE_POLL_MS));
  }
}

export async function deployCmd(opts: DeployOptions): Promise<void> {
  const mode = detectMode();
  const detectFolder = oneDetectionPerRun();

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

  const cwd = process.cwd();
  let existing = await loadProjectConfig(cwd);

  let cliCfg = await loadConfig();
  if (opts.dryRun) {
    await dryRun(cwd, opts, existing, cliCfg);
    return;
  }
  // Claimable-проект этого запуска (этап 13): событие `claimable` уходит
  // перед `ready`, когда адрес сайта уже известен.
  let claimable: { claim_url: string; expires_at: string; project_id: string; slug: string } | null = null;
  let reusedClaim: ProjectConfig["claim"] | null = null;
  // 🚨 ПЕСОЧНИЦА — ТОЛЬКО ДЛЯ НОВОГО ПРОЕКТА. `--project` или папка,
  // привязанная к проекту аккаунта, значат «выкатить в существующий», а у
  // токена песочницы прав на него нет: до 0.10.5 авто-режим всё равно
  // включался, и платформа отвечала `username_required` про держателя
  // песочницы — человек читал совет выбрать имя аккаунта, которого у него
  // нет. Теперь существующий проект без токена — это вход (`auth_required`).
  if (opts.claim && opts.project) {
    throw new LayeroError(
      "claim_with_project",
      `--claim вместе с --project ${opts.project}: песочница создаёт новый проект, в существующий она не выкатывает`,
      "песочница создаёт новый проект; для существующего войдите: `layero login` — и повторите без --claim",
    );
  }
  // Папка привязана к claimable-проекту, и `--project` (если задан) называет
  // его же. Любой другой `--project` — проект аккаунта, и токен песочницы
  // из конфига к нему не подходит.
  const projectIsLinkedOne =
    !opts.project ||
    (existing?.project_id !== undefined &&
      (opts.project === existing.project_id || opts.project === existing.slug));
  const linkedIsClaimable = Boolean(
    existing?.project_id && (claimFor(cliCfg, existing) || claimTokenFor(cliCfg, existing.project_id)),
  );
  const boundToAccountProject = opts.project
    ? !(projectIsLinkedOne && linkedIsClaimable)
    : Boolean(existing?.project_id) && !linkedIsClaimable;
  if (!cliCfg.token) {
    // Папка уже привязана к claimable-проекту — деплоим его же токеном,
    // пока заявка жива. Заявка забрана или истекла — платформа ответит 401,
    // и это станет `auth_expired`: честнее, чем молча завести ещё один.
    const reuse = projectIsLinkedOne
      ? claimTokenFor(cliCfg, existing?.project_id)
      : undefined;
    if (reuse) {
      await assertSandboxAlive(cliCfg, cwd, existing);
      await assertSandboxServesFiles(cwd, opts, existing, detectFolder);
      cliCfg = { ...cliCfg, token: reuse };
      // Повторная выкатка песочницы: ссылка «забрать» нужна агенту и здесь —
      // без неё он искал её в `.layero/project.json` (симуляция 18.09.2026).
      reusedClaim = claimFor(cliCfg, existing) ?? null;
    } else if (
      // 🚨 ТОЛЬКО ЯВНЫЙ `--claim` (T-20260921). До 0.11.8 режим включался сам —
      // нет токена, агентская среда, `--yes` — и агент молча публиковал папку
      // в открытый интернет: человек не решал публиковать и не принимал
      // условий. Теперь без флага — обычный вход (`auth_required`). С
      // `--project` флаг отклонён выше: песочница — только новый проект.
      opts.claim
    ) {
      // 🚨 CI СЮДА НЕ ПОПАДАЕТ НАМЕРЕННО. Раннер без LAYERO_TOKEN — это
      // забытый секрет, и правильный ответ ему — отказ, а не сайт на
      // временном адресе, который через час исчезнет вместе с «зелёным»
      // прогоном. Явный `--claim` в CI работает.
      await assertSandboxServesFiles(cwd, opts, existing, detectFolder);
      const r = await createClaimable(cliCfg, cwd, {
        name: opts.name ?? path.basename(cwd),
      });
      cliCfg = r.cfg;
      claimable = {
        claim_url: r.created.claim_url,
        expires_at: r.created.expires_at,
        project_id: r.created.project_id,
        slug: r.created.slug,
      };
      existing = await loadProjectConfig(cwd);
    } else if (isCiEnv()) {
      // In CI nobody can open a browser, so the device flow can only end one
      // way: fifteen minutes of a hung job and then `auth_expired`. Fail
      // immediately instead, and say what to do — burning a quarter of an hour
      // of someone's runner to reach a foregone conclusion is not acceptable.
      throw new LayeroError(
        "auth_required",
        "No credentials in CI. Create a token at https://app.layero.ru/settings/cli " +
          "and pass it as the LAYERO_TOKEN environment variable.",
        "set_layero_token",
      );
    } else {
      cliCfg = await runDeviceLogin(cliCfg);
    }
  } else if (opts.claim) {
    // 🚨 Совет НЕ предлагает `logout`. Агенты исполняют `next_action`
    // дословно, а `logout` стирает сохранённый вход и токены песочниц — войти
    // заново может только человек. Прогон evals 19.09: агент с чужим входом на
    // машине сделал ровно это и оставил владельца без CLI.
    throw new LayeroError(
      "bad_format",
      "--claim — деплой без аккаунта, а на этой машине уже выполнен вход",
      "run the same command without --claim: the project is created in the signed-in account " +
        "(`npx layero@latest whoami` shows which). Do not run `layero logout` for someone else — " +
        "it deletes the saved login, and only a person can sign in again",
    );
  }
  const api = new ApiClient(cliCfg);

  // 🚨 `--branch` У АРХИВНОЙ ЗАГРУЗКИ НЕ РАБОТАЕТ, И МОЛЧАТЬ ОБ ЭТОМ НЕЛЬЗЯ.
  // Платформа кладёт каждый архив в зарезервированное окружение `cli`, что
  // бы ни передали (`projects.py`, «Branch targeting»). До 0.10.0 флаг
  // принимался и игнорировался: агент читал в справке «deploy to a specific
  // branch's environment», делал `--branch=probe` и заменял живой сайт,
  // считая, что выложил превью. Теперь — отказ до упаковки, с разной
  // подсказкой для проекта без репозитория и с ним.
  if (opts.branch) {
    let linked: ProjectSummary | null = null;
    try {
      if (opts.project) linked = await api.resolveProject(opts.project);
      else if (existing?.project_id) linked = await api.getProject(existing.project_id);
    } catch {
      linked = null;
    }
    const repo = linked?.repo_full_name && linked.repo_status !== "disconnected" ? linked.repo_full_name : null;
    throw new LayeroError(
      "branch_unsupported",
      repo
        ? `--branch ${opts.branch}: архивная загрузка не попадает в ветку — платформа кладёт её в окружение «cli»`
        : `--branch ${opts.branch}: у проекта нет подключённого репозитория, а превью-ветки есть только у проектов с репозиторием`,
      repo
        ? `изолированное превью — push в ветку «${opts.branch}» репозитория ${repo}; \`layero deploy\` без --branch обновит окружение «cli»`
        : "превью-ветки есть только у проектов с репозиторием: подключите его — `layero projects create --repo <provider>:<owner/repo>` — и пушьте в ветку; папку без репозитория выкладывает `layero deploy` без --branch",
    );
  }

  // --- Всё, что требует файловой системы, делаем сами. Остальное — сервер.

  const prebuiltDir = await resolvePrebuiltDir(cwd, opts.prebuilt);

  // Готовая сборка настроек проекту не пишет: сборщик у такой выкатки не
  // запускается, а записанная `static` пережила бы её и заглушила следующую
  // выкатку из исходников.
  const setup: Omit<SetupConfig, "detected"> = prebuiltDir
    ? { framework_hint: null, build_cmd: null, output_dir: null }
    : await resolveSetupConfig(cwd, opts, existing, undefined, detectFolder);

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
      ? looksLikeId(opts.project)
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
    runtime_kind_origin: setup.runtime_kind_origin,
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
  } else if (
    setup.runtime_kind &&
    project.project_type === setup.runtime_kind &&
    (session.created_project || claimable !== null)
  ) {
    // Новый проект получил тип в самой сессии, флипать нечего — но событие
    // обещано документацией, и без него агент не узнаёт, что приложение будут
    // ЗАПУСКАТЬ, а не раздавать файлами (симуляция 18.09.2026, `--type node_web`).
    emit({ event: "runtime_type_applied", project_type: setup.runtime_kind });
  }

  // Только связка папки с проектом. Фреймворк сюда больше не пишется: поле
  // этого файла CLI читает как выбор человека (см. `resolveSetupConfig`).
  // Код забора старого CLI сначала уезжает в конфиг, потом файл
  // переписывается уже без него (T-20260921).
  await keepLegacyClaim(cliCfg, existing);
  await persistProjectLinking(cwd, {
    project_id: project.id,
    slug: project.slug,
    organization_slug: project.organization.slug,
    apex_hostname: project.apex_hostname,
  });

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
        "re-run `npx layero@latest deploy`; if it repeats, `npx layero@latest diagnose` shows the last deploy",
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
        "a newer deploy superseded this one — `npx layero@latest deploys list` shows it",
      );
    }
    if (final.status !== "ready") {
      // 🚨 Совет — КОМАНДА, а не ссылка на панель. Агенту без аккаунта
      // (песочница `--claim`) панель недоступна вовсе, а `diagnose` работает
      // и с токеном песочницы: причина словами плюс окрестность ошибки в логе
      // (T-20260918-8).
      throw new LayeroError(
        `deploy_${final.status}`,
        `deploy failed (${final.status})${
          final.error_message ? `: ${final.error_message}` : ""
        }`,
        `read the cause: \`npx layero@latest diagnose --deploy ${started.deploy_id}\` ` +
          `(full build log: \`npx layero@latest logs --deploy ${started.deploy_id}\`)`,
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
    // Сборка уже готова: сбой этих запросов не повод объявлять её упавшей
    // (`internal` при живом сайте, T-20260918-16). Без строки деплоя — адрес
    // апекса и никаких чужих превью.
    const deployRow = await api.getDeploy(started.deploy_id).catch(() => null);
    const probe = deployRow?.environment_id
      ? await resolveReachability(api, deployRow.environment_id)
      : null;

    const liveUrl =
      promoted || !opts.branch
        ? (probe?.canonical_url ?? apexUrl)
        : (probe?.preview_url ?? probe?.canonical_url ?? apexUrl);

    // V263: деплой мог занять слот превью и снять с раздачи чужую ветку.
    // Говорим об этом ДО `ready`: агент, увидевший итог, дальше не читает, а
    // здесь изменился чужой работающий адрес — тот, кому ссылку уже отдали,
    // узнает об этом иначе только открыв её.
    //
    // Пустой список — обычный случай и молчит. Поля может не быть вовсе, если
    // платформа старше него: `?? []` и никаких предупреждений о том, чего не
    // знаем.
    const evicted = deployRow?.preview_evicted ?? [];
    if (evicted.length > 0) {
      emit({ event: "preview_evicted", evicted });
    }

    // Claimable: ссылка «забрать» — ДО `ready`, потому что после `ready`
    // агент не читает, а без этой ссылки сайт исчезнет через 72 часа.
    if (claimable) {
      emit({
        event: "claimable",
        project_id: claimable.project_id,
        slug: claimable.slug,
        url: liveUrl,
        claim_url: claimable.claim_url,
        expires_at: claimable.expires_at,
      });
    } else if (reusedClaim) {
      emit({
        event: "claimable",
        project_id: project.id,
        slug: project.slug,
        url: liveUrl,
        claim_url: reusedClaim.claim_url,
        expires_at: reusedClaim.expires_at,
      });
    }

    // `ready` — когда адрес уже отвечает сайтом, а не когда кончилась сборка.
    // Выкатка в окружение `cli` проекта с репозиторием живой адрес не меняет —
    // ждать там нечего.
    const serving: { serving: boolean; screen?: string } =
      promoted || !hasRepo(project) || opts.prod
        ? await waitUntilServing(liveUrl)
        : { serving: probe ? probe.available : true };
    emit({
      event: "ready",
      url: liveUrl,
      deploy_id: started.deploy_id,
      preview_url: probe?.preview_url ?? undefined,
      dashboard_url: dashboardUrl,
      edge_ready: serving.serving,
      ...(serving.serving ? {} : { screen: serving.screen }),
    });
  } finally {
    if (archivePath) {
      await fs.unlink(archivePath).catch(() => undefined);
    }
  }
}
