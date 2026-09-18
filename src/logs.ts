import chalk from "chalk";
import { ApiClient, LogsPollOut } from "./api.js";
import { detectMode, emit } from "./agent.js";

const POLL_INTERVAL_MS = 1500;

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
  const announce = (name: string): void => {
    if (name === lastStage) return;
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
    const poll = await api.pollLogs(deployId, afterId);
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
    if (poll.terminal) {
      return poll;
    }
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
}
