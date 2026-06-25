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
  // Loop until terminal — the server's per-stage timeouts bound duration.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const poll = await api.pollLogs(deployId, afterId);
    if (poll.current_stage && poll.current_stage !== lastStage) {
      lastStage = poll.current_stage;
      if (json) {
        emit({ event: "stage", name: poll.current_stage });
      } else {
        process.stderr.write(chalk.bold.blue(`▶ stage: ${poll.current_stage}\n`));
      }
    }
    for (const line of poll.lines) {
      afterId = Math.max(afterId, line.id);
      if (json) {
        emit({ event: "build_log", line: line.line, stream: line.stream });
      } else {
        const paint = colorForStream(line.stream);
        process.stdout.write(paint(line.line) + "\n");
      }
    }
    if (poll.terminal) {
      return poll;
    }
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
}
