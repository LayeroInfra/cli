import chalk from "chalk";
import { ApiClient, ApiError } from "../api.js";
import { loadConfig } from "../config.js";
import { loadProjectConfig } from "../project-config.js";
import { LayeroError, detectMode, emit } from "../agent.js";

/**
 * `layero perf` (AGENT-11).
 *
 * Ценность не в «запусти прогон» — это один вызов и без нас, — а в связке
 * «задеплоил и знаешь, не стало ли хуже». Вердикт выносится по баллу с
 * порогом в 3 пункта: разброс повторных прогонов одного и того же деплоя в
 * проде оказался ≤1 пункта, тогда как тайминги на том же коде гуляли на
 * 37-40%. Судить о регрессии по таймингам значит ошибаться через раз.
 */

interface PerfOptions {
  project?: string;
  json?: boolean;
  wait?: boolean;
}

async function projectId(api: ApiClient, opts: PerfOptions): Promise<string> {
  const linked = await loadProjectConfig(process.cwd());
  const ref = opts.project ?? linked?.project_id;
  if (!ref) {
    throw new LayeroError(
      "project_unknown",
      "не понятно, какой проект мерить",
      "запусти из каталога проекта или передай --project <id|slug>",
    );
  }
  const p = await api.getProject(ref);
  return p.id;
}

function render(d: { verdict: string; message: string; score: number | null; timings: any }): void {
  const colour =
    d.verdict === "regressed" ? chalk.red : d.verdict === "improved" ? chalk.green : chalk.dim;
  console.log(colour(d.message));
  if (d.score !== null && d.score !== undefined) {
    const t = d.timings ?? {};
    const bits = [
      `балл ${d.score}`,
      t.lcp_ms ? `LCP ${t.lcp_ms} мс` : null,
      t.ttfb_ms ? `TTFB ${t.ttfb_ms} мс` : null,
    ].filter(Boolean);
    console.log(chalk.dim("  " + bits.join("  ·  ")));
    console.log(
      chalk.dim("  тайминги справочно: на одном и том же коде они гуляют на десятки процентов"),
    );
  }
}

export async function perfCheckCmd(opts: PerfOptions): Promise<void> {
  const mode = detectMode();
  const api = new ApiClient(await loadConfig());
  const id = await projectId(api, opts);

  let started;
  try {
    started = await api.startPerfCheck(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 429) {
      // Замер уже идёт — это не ошибка, а ответ на вопрос «когда будет».
      const current = await api.getPerfCheck(id).catch(() => null);
      if (current) {
        if (mode.json) {
          emit({ event: "perf_check", ...current });
          return;
        }
        console.log(chalk.dim("замер уже идёт — вот его состояние:"));
        render(current as any);
        return;
      }
    }
    if (err instanceof ApiError && err.status === 409) {
      throw new LayeroError(
        "no_deploy",
        "у проекта нет успешного деплоя — мерить нечего",
        "сначала `layero deploy`",
      );
    }
    throw err;
  }

  if (mode.json && !opts.wait) {
    emit({ event: "perf_check_started", ...started });
    return;
  }
  if (!opts.wait) {
    console.log(chalk.dim("замер запущен; результат — `layero perf show` через минуту-две"));
    return;
  }

  // --wait: опрашиваем, но с потолком. Прогон занимает десятки секунд;
  // висеть дольше нескольких минут смысла нет — лучше вернуть управление.
  const deadline = Date.now() + 240_000;
  let last = started;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8000));
    last = await api.getPerfCheck(id);
    if (last.verdict !== "pending") break;
  }
  if (mode.json) {
    emit({ event: "perf_check", ...last });
    return;
  }
  render(last as any);
}

export async function perfShowCmd(opts: PerfOptions): Promise<void> {
  const mode = detectMode();
  const api = new ApiClient(await loadConfig());
  const id = await projectId(api, opts);
  let out;
  try {
    out = await api.getPerfCheck(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new LayeroError(
        "no_runs",
        "замеров по этому проекту ещё не было",
        "запусти: layero perf check",
      );
    }
    throw err;
  }
  if (mode.json) {
    emit({ event: "perf_check", ...out });
    return;
  }
  render(out as any);
}
