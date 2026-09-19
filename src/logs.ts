import chalk from "chalk";
import { ApiClient, ApiError, LogsPollOut } from "./api.js";
import { detectMode, emit, LayeroError } from "./agent.js";

const POLL_INTERVAL_MS = 1500;

// 🚨 ОДИН СБОЙ ОПРОСА — НЕ КОНЕЦ НАБЛЮДЕНИЯ. До 0.11.3 `fetch` шёл без
// таймаута, а цикл не переживал ни одной сетевой ошибки: 18.09.2026 деплой с
// токеном дважды подряд молчал 3 и 15 минут и падал с `internal: fetch failed`,
// хотя обе сборки на платформе дошли до ready (T-20260918-16). Для агента это
// худший исход: он считает деплой проваленным и запускает его заново.
// Теперь: таймаут на запрос (api.ts), до MAX_POLL_FAILURES сбоев ПОДРЯД с
// растущей паузой, и свой код ошибки с подсказкой, где смотреть итог.
const MAX_POLL_FAILURES = 8;
const QUEUED_EVERY_MS = 15_000;
const RETRY_BASE_MS = 1500;
const RETRY_CAP_MS = 10_000;

/** Сбой, который повторять бессмысленно: сервер ответил отказом по существу. */
/** Тестам не нужно ждать настоящие паузы. */
let delayScale = 1;
export function setRetryDelayScaleForTests(scale: number): void {
  delayScale = scale;
}
function retryDelayScale(): number {
  return delayScale;
}

function isFatal(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

function colorForStream(stream: string): (s: string) => string {
  switch (stream) {
    case "meta":
      return chalk.cyan;
    case "stderr":
      return chalk.red;
    default:
      return (s) => s;
  }
}

/**
 * Строки npm о каждом скачанном пакете (`npm http fetch …`, `npm http cache …`).
 *
 * На проде это почти четверть строк логов сборки: 92 тыс. из последних
 * 400 тыс. строк у 154 сборок (замер 18.09.2026). В `--json` каждая уходила
 * отдельным событием `build_log`, и агент тонул в них, не видя ошибки. Полный
 * лог по-прежнему у `layero logs`.
 */
const NPM_HTTP_RE = /^npm http (fetch|cache) /;

export async function streamDeployLogs(
  api: ApiClient,
  deployId: string,
): Promise<LogsPollOut> {
  // In JSON mode stdout must stay a clean JSON-lines stream: build logs go
  // out as structured `build_log` / `stage` events (N2), never as raw text
  // interleaved with the lifecycle events. In human mode we keep the
  // coloured stdout + stage banners on stderr.
  const json = detectMode().json;
  let afterId = 0;
  let lastStage: string | null = null;
  let hiddenNoted = false;
  let failures = 0;
  // Этап объявляется один раз: строки прошлого этапа приходят вперемешку с
  // началом нового, и `announce` по строке дублировал `clone`/`probe`
  // (чистая комната 19.09.2026).
  const announced = new Set<string>();
  const startedAt = Date.now();
  let lastQueuedAt = startedAt;
  const sleep = (ms: number): Promise<void> =>
    new Promise((res) => setTimeout(res, retryDelayScale() * ms));
  const announce = (name: string): void => {
    if (name === lastStage || announced.has(name)) return;
    announced.add(name);
    lastStage = name;
    if (json) {
      emit({ event: "stage", name });
    } else {
      process.stderr.write(chalk.bold.blue(`▶ stage: ${name}\n`));
    }
  };
  // Loop until terminal — the server's per-stage timeouts bound duration.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let poll: LogsPollOut;
    try {
      poll = await api.pollLogs(deployId, afterId);
      failures = 0;
    } catch (err) {
      if (isFatal(err)) throw err;
      failures += 1;
      if (failures >= MAX_POLL_FAILURES) {
        throw new LayeroError(
          "deploy_watch_lost",
          `lost connection to the build log after ${failures} attempts (${(err as Error).message}); the build itself keeps running on the platform`,
          `do NOT deploy again — check the result: \`npx layero@latest deploys list --json\`, then \`npx layero@latest logs --deploy ${deployId}\``,
        );
      }
      await sleep(Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_CAP_MS));
      continue;
    }
    // 🚨 Этап объявляем по СТРОКЕ, а не по текущему этапу деплоя. Опрос
    // приносит пачку строк, где хвост прошлого этапа идёт вперемешку с
    // началом нового, а `current_stage` — это уже новый: объявленный до
    // пачки, он приписывал ему строки прошлого (симуляция 18.09.2026).
    for (const line of poll.lines) {
      afterId = Math.max(afterId, line.id);
      if (line.stage) announce(line.stage);
      if (json) {
        if (NPM_HTTP_RE.test(line.line)) {
          if (!hiddenNoted) {
            hiddenNoted = true;
            emit({
              event: "build_log",
              line: `[layero] "npm http" download lines are hidden in --json; full log: npx layero@latest logs --deploy ${deployId}`,
              stream: "meta",
            });
          }
          continue;
        }
        emit({ event: "build_log", line: line.line, stream: line.stream });
      } else {
        const paint = colorForStream(line.stream);
        process.stdout.write(paint(line.line) + "\n");
      }
    }
    if (poll.current_stage) announce(poll.current_stage);
    if (
      json &&
      poll.status === "queued" &&
      announced.size === 0 &&
      Date.now() - lastQueuedAt >= QUEUED_EVERY_MS
    ) {
      lastQueuedAt = Date.now();
      emit({ event: "queued", waited_s: Math.round((Date.now() - startedAt) / 1000) });
    }
    if (poll.terminal) {
      return poll;
    }
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
}
