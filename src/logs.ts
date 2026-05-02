import chalk from "chalk";
import { ApiClient, LogsPollOut } from "./api.js";

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
  let afterId = 0;
  let lastStage: string | null = null;
  // Loop until terminal — the server's per-stage timeouts bound duration.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const poll = await api.pollLogs(deployId, afterId);
    if (poll.current_stage && poll.current_stage !== lastStage) {
      lastStage = poll.current_stage;
      process.stderr.write(chalk.bold.blue(`▶ stage: ${poll.current_stage}\n`));
    }
    for (const line of poll.lines) {
      afterId = Math.max(afterId, line.id);
      const paint = colorForStream(line.stream);
      process.stdout.write(paint(line.line) + "\n");
    }
    if (poll.terminal) {
      return poll;
    }
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
}
