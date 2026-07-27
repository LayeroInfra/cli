import chalk from "chalk";
import { ApiClient, ApiError } from "../api.js";
import { loadConfig } from "../config.js";
import { loadProjectConfig } from "../project-config.js";
import { LayeroError, detectMode, emit } from "../agent.js";

/**
 * `layero analytics …` (AGENT-12) — Яндекс.Метрика.
 *
 * Особенность сценария: ПОДКЛЮЧЕНИЕ ИДЁТ ЧЕРЕЗ БРАУЗЕР. Метрика авторизует
 * по OAuth, редирект возвращается на наш бэкенд, и ни CLI, ни агент этот
 * шаг за пользователя не сделают. Поэтому `connect` печатает ссылку и
 * заканчивается — ровно как device-flow у `layero login`, где человек
 * тоже открывает страницу сам.
 *
 * Ждать в цикле здесь нечего: пользователь может уйти открывать ссылку на
 * час. Проверить результат — `layero analytics status`.
 */

interface AnalyticsOptions {
  project?: string;
  json?: boolean;
  period?: string;
  branch?: string;
  yes?: boolean;
}

async function projectRef(api: ApiClient, opts: AnalyticsOptions): Promise<{ id: string; slug: string }> {
  const linked = await loadProjectConfig(process.cwd());
  const ref = opts.project ?? linked?.project_id;
  if (!ref) {
    throw new LayeroError(
      "project_unknown",
      "не понятно, о каком проекте речь",
      "запусти из каталога проекта или передай --project <id|slug>",
    );
  }
  const p = await api.getProject(ref);
  return { id: p.id, slug: p.slug };
}

export async function analyticsStatusCmd(opts: AnalyticsOptions): Promise<void> {
  const mode = detectMode();
  const api = new ApiClient(await loadConfig());
  const project = await projectRef(api, opts);
  const s = await api.getMetrikaIntegration(project.id);

  if (mode.json) {
    emit({
      event: "analytics_status",
      connected: s.connected,
      counter_id: s.counter_id ?? undefined,
      status: s.status,
      injection_mode: s.injection_mode,
      tracked_branch: s.tracked_branch_name ?? undefined,
    });
    return;
  }
  if (!s.connected) {
    console.log(chalk.dim(`Метрика к "${project.slug}" не подключена`));
    console.log(chalk.dim("подключить: layero analytics connect"));
    return;
  }
  console.log(chalk.green(`Метрика подключена — счётчик ${s.counter_id}`));
  console.log(chalk.dim(`  ветка: ${s.tracked_branch_name ?? "—"}  ·  режим: ${s.injection_mode}`));
  if (s.injection_mode === "manual" && s.snippet) {
    console.log(
      chalk.yellow(
        "\n  это SSR-проект: счётчик не вшивается автоматически — вставь сниппет в разметку",
      ),
    );
  }
  if (s.metrika_url) console.log(chalk.dim(`  ${s.metrika_url}`));
}

export async function analyticsConnectCmd(opts: AnalyticsOptions): Promise<void> {
  const mode = detectMode();
  const api = new ApiClient(await loadConfig());
  const project = await projectRef(api, opts);

  let out;
  try {
    out = await api.connectMetrika(project.id, opts.branch);
  } catch (err) {
    if (err instanceof ApiError && err.status === 503) {
      throw new LayeroError(
        "oauth_unavailable",
        "вход через Яндекс сейчас недоступен",
        "это на нашей стороне — попробуй позже",
      );
    }
    if (err instanceof ApiError && err.status === 404) {
      throw new LayeroError(
        "branch_without_env",
        `у ветки нет окружения — счётчику некуда указывать`,
        "сначала задеплой эту ветку, потом подключай Метрику",
      );
    }
    throw err;
  }

  if (mode.json) {
    emit({
      event: "analytics_connect_started",
      oauth_url: out.oauth_url,
      // Ждать здесь нечего: между ссылкой и подключением стоит человек,
      // который открывает её в браузере и жмёт «Разрешить».
      next_action: "open_url_then_check_status",
    });
    return;
  }
  console.log("Открой ссылку и разреши доступ — Метрика подключится сама:\n");
  console.log("  " + chalk.cyan(out.oauth_url));
  console.log(chalk.dim("\nпотом проверь: layero analytics status"));
}

function trend(series: Array<{ date?: string; visits?: number }> | undefined): string | null {
  if (!series || series.length < 4) return null;
  const half = Math.floor(series.length / 2);
  const sum = (xs: typeof series) => xs.reduce((a, b) => a + (b.visits ?? 0), 0);
  const older = sum(series.slice(0, half));
  const newer = sum(series.slice(half));
  if (older === 0 && newer === 0) return null;
  if (older === 0) return "растёт";
  const ratio = newer / older;
  if (ratio >= 1.25) return `растёт (+${Math.round((ratio - 1) * 100)}%)`;
  if (ratio <= 0.8) return `падает (−${Math.round((1 - ratio) * 100)}%)`;
  return "ровно";
}

export async function analyticsStatsCmd(opts: AnalyticsOptions): Promise<void> {
  const mode = detectMode();
  const api = new ApiClient(await loadConfig());
  const project = await projectRef(api, opts);
  const period = opts.period ?? "7d";
  const s: any = await api.getMetrikaStats(project.id, period);

  if (s.state === "disconnected") {
    throw new LayeroError(
      "analytics_not_connected",
      `Метрика к "${project.slug}" не подключена`,
      "подключить: layero analytics connect",
    );
  }

  // Сжимаем для агента: временной ряд превращаем в направление, разбивки
  // режем до пятёрки. На периоде 90d сырой ответ — это девяносто точек и
  // десятки строк разбивок, то есть контекст, потраченный на данные,
  // которые всё равно нужно свернуть в вывод.
  const b = s.breakdowns ?? {};
  const top = (xs: any[] | undefined) => (xs ?? []).slice(0, 5);
  const compact = {
    period,
    state: s.state,
    totals: s.totals,
    trend: trend(s.series),
    sources: top(b.sources),
    devices: top(b.devices),
    pages: top(b.pages),
  };

  if (mode.json) {
    emit({ event: "analytics_stats", ...compact });
    return;
  }

  if (s.state === "no_data_yet") {
    console.log(chalk.dim("счётчик подключён, но визитов пока нет"));
    return;
  }
  const t = s.totals ?? {};
  console.log(`${chalk.bold(project.slug)} за ${period}`);
  console.log(
    `  ${t.visits} визитов · ${t.users} пользователей · ${t.pageviews} просмотров` +
      (compact.trend ? chalk.dim(`  (${compact.trend})`) : ""),
  );
  console.log(
    chalk.dim(`  отказы ${t.bounce_rate}%  ·  среднее время ${Math.round(t.avg_visit_duration)}с`),
  );
  const line = (label: string, xs: any[]) =>
    xs.length
      ? console.log(
          chalk.dim(`  ${label}: `) + xs.map((x) => `${x.name ?? x.label} ${x.visits ?? x.value}`).join(", "),
        )
      : undefined;
  line("источники", compact.sources);
  line("устройства", compact.devices);
  line("страницы", compact.pages);
  if (s.state === "stale") {
    console.log(chalk.yellow("\n  данные могут быть устаревшими: Метрика не ответила"));
  }
}

export async function analyticsDisconnectCmd(opts: AnalyticsOptions): Promise<void> {
  const mode = detectMode();
  const api = new ApiClient(await loadConfig());
  const project = await projectRef(api, opts);

  if (!opts.yes && mode.interactive) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const a = (await rl.question(`отключить Метрику от "${project.slug}"? счётчик перестанет собирать данные [y/N]: `))
        .trim()
        .toLowerCase();
      if (a !== "y" && a !== "yes") {
        console.log(chalk.yellow("отменено."));
        return;
      }
    } finally {
      rl.close();
    }
  }

  await api.disconnectMetrika(project.id);
  if (mode.json) {
    emit({ event: "analytics_disconnected", project: project.slug });
    return;
  }
  console.log(chalk.green("Метрика отключена"));
  console.log(chalk.dim("счётчик в Метрике остался — удалить его можно в её интерфейсе"));
}
