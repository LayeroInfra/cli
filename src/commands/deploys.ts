import readline from "node:readline/promises";
import chalk from "chalk";
import { ApiClient, ApiError, DeployOut } from "../api.js";
import { loadConfig } from "../config.js";
import { configForFolder } from "./claim.js";
import { loadProjectConfig } from "../project-config.js";
import { detectMode, LayeroError } from "../agent.js";

interface ListOptions {
  project?: string;
  branch?: string;
  limit?: number;
}

interface RollbackOptions {
  project?: string;
  branch?: string;
  deploy?: string;
  yes?: boolean;
}

async function resolveProjectId(
  api: ApiClient,
  cwd: string,
  override: string | undefined,
): Promise<string> {
  if (override) {
    // Accept slug or id; resolve via list to keep consistent error UX.
    const all = await api.listProjects();
    const match =
      all.find((p) => p.id === override) ?? all.find((p) => p.slug === override);
    if (!match) throw new Error(`no project with id/slug "${override}"`);
    return match.id;
  }
  const cfg = await loadProjectConfig(cwd);
  if (!cfg) {
    throw new Error(
      "no .layero/project.json found. run `layero deploy` to create one, or pass --project <slug>.",
    );
  }
  return cfg.project_id;
}

function shortSha(sha: string | undefined): string {
  return (sha ?? "").slice(0, 7);
}

function statusBadge(status: string): string {
  switch (status) {
    case "ready":
      return chalk.green("● ready");
    case "building":
    case "queued":
      return chalk.cyan(`● ${status}`);
    case "failed":
      return chalk.red("● failed");
    default:
      return chalk.dim(`● ${status}`);
  }
}

function fmtTime(iso: string | undefined | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  // YYYY-MM-DD HH:mm
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtSource(d: DeployOut): string {
  const t = d.source_type ?? "github";
  if (t === "cli") return chalk.dim("(cli)");
  if (d.triggered_by_user_id) return chalk.dim("(manual)");
  return chalk.dim("(push)");
}

export async function deploysListCmd(opts: ListOptions): Promise<void> {
  // Токеном песочницы тоже: совет при отменённой выкатке ведёт сюда, и агент
  // без аккаунта получал «not logged in» там, где `logs` и `diagnose` уже
  // работали (прогон evals 19.09).
  const cliCfg = await configForFolder(opts, process.cwd());
  const api = new ApiClient(cliCfg);
  const projectId = await resolveProjectId(api, process.cwd(), opts.project);
  const deploys = await api.listProjectDeploys(projectId, opts.branch);
  const limit = opts.limit ?? 20;
  const rows = deploys.slice(0, limit);

  // JSON mode (B6): emit one structured object per deploy on stdout instead
  // of the coloured human one-liner. One JSON object per line keeps it
  // consistent with the rest of the CLI's JSON-lines protocol.
  if (detectMode().json) {
    for (const d of rows) {
      process.stdout.write(
        JSON.stringify({
          event: "deploy",
          id: d.id,
          environment_id: d.environment_id,
          status: d.status,
          commit_sha: d.commit_sha,
          commit_message: (d.commit_message ?? "").split("\n")[0] ?? "",
          source_type: d.source_type ?? "github",
          created_at: d.created_at ?? null,
          finished_at: d.finished_at ?? null,
        }) + "\n",
      );
    }
    return;
  }

  if (rows.length === 0) {
    console.log(chalk.dim("no deploys yet."));
    return;
  }
  for (const d of rows) {
    const line = [
      statusBadge(d.status),
      chalk.bold(shortSha(d.commit_sha).padEnd(7)),
      fmtTime(d.created_at).padEnd(16),
      fmtSource(d),
      d.commit_message
        ? chalk.dim(((d.commit_message ?? "").split("\n")[0] ?? "").slice(0, 60))
        : "",
    ].join("  ");
    console.log(line);
  }
  if (deploys.length > rows.length) {
    console.log(chalk.dim(`  …${deploys.length - rows.length} more (use --limit to show)`));
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N]: `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export async function rollbackCmd(opts: RollbackOptions): Promise<void> {
  const cliCfg = await loadConfig();
  if (!cliCfg.token) throw new Error("not logged in. run `layero login` first.");
  const api = new ApiClient(cliCfg);
  const cwd = process.cwd();
  const projectId = await resolveProjectId(api, cwd, opts.project);

  // Show what we're rolling back from/to so the user can sanity-check
  // before confirming. The dashboard does this visually; the CLI shows
  // the equivalent: current deploy + the candidate target.
  const deploys = await api.listProjectDeploys(projectId, opts.branch);
  if (deploys.length === 0) {
    throw new Error("no deploys for this project/branch");
  }
  const current = deploys.find((d) => d.status === "ready");
  let target: DeployOut | undefined;
  if (opts.deploy) {
    target = deploys.find(
      (d) => d.id === opts.deploy || d.commit_sha.startsWith(opts.deploy!),
    );
    if (!target) throw new Error(`no deploy matching "${opts.deploy}"`);
  } else {
    // Find the latest ready deploy that isn't the current active one.
    const ready = deploys.filter((d) => d.status === "ready");
    target = ready.find((d) => d.id !== current?.id);
    if (!target) throw new Error("no eligible deploy to roll back to");
  }

  console.log(chalk.cyan("rollback plan:"));
  if (current) {
    console.log(`  from: ${shortSha(current.commit_sha)}  ${fmtTime(current.created_at)}  ${chalk.dim(current.commit_message?.split("\n")[0] ?? "")}`);
  }
  console.log(`  to:   ${shortSha(target.commit_sha)}  ${fmtTime(target.created_at)}  ${chalk.dim(target.commit_message?.split("\n")[0] ?? "")}`);

  if (!opts.yes) {
    const ok = await confirm("proceed with rollback?");
    if (!ok) {
      console.log(chalk.yellow("aborted."));
      return;
    }
  }

  try {
    const out = await api.rollbackProject(projectId, {
      branch: opts.branch,
      deploy_id: target.id,
    });
    console.log(chalk.green(`rolled back to ${shortSha(out.commit_sha)}.`));
    console.log(chalk.dim("  CDN cache purged; new requests serve the rolled-back artifact."));
  } catch (err) {
    if (err instanceof ApiError) {
      // 409 — цель отката не годится. Это НЕ сбой платформы, а ожидаемое
      // ограничение, и подавать его кодом `internal` (то есть «сообщите о
      // проблеме») нельзя: человек читает это в момент, когда у него уже
      // что-то сломалось на проде.
      //
      // С 21.08 бэкенд называет причину сам (`rollback_eligibility.py`):
      // сборка не готова, у неё нет результата или результат уже удалён по
      // окну хранения. Откат рантайм-приложений с тех пор работает, поэтому
      // про «SSR откатывать нельзя» больше не говорим.
      if (err.status === 409) {
        throw rollbackRefusal(err.body);
      }
      // 400 «target deploy is already the active one» — тоже штатный отказ:
      // цель отката уже раздаётся (типичный случай — второй `rollback`
      // подряд). Это неверный ввод, а не сбой платформы: выход 4, не 5.
      if (err.status === 400 && err.body.includes("already the active one")) {
        throw new LayeroError(
          "rollback_noop",
          "откатывать нечего: эта сборка уже на живом адресе",
          "точечно — `layero promote <sha>`; список — `layero deploys list`",
        );
      }
      throw new Error(`rollback failed (${err.status}): ${err.body.slice(0, 200)}`);
    }
    throw err;
  }
}


/**
 * Отказ отката (409) — человеческим текстом по причине, которую назвал бэкенд.
 * Незнакомую причину показываем как есть: молча подменить её общей фразой —
 * ровно то, что раньше прятало настоящую причину.
 */
export function rollbackRefusal(body: string): LayeroError {
  let detail = "";
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed?.detail === "string") detail = parsed.detail;
  } catch {
    detail = body.slice(0, 200);
  }
  if (detail.includes("only 'ready' deploys")) {
    return new LayeroError(
      "rollback_unsupported",
      "на эту сборку откатиться нельзя: она не завершилась успешно",
      "выбери готовую сборку в `layero deploys list` и укажи её: `layero rollback --deploy <id>`",
    );
  }
  if (detail.includes("purged")) {
    return new LayeroError(
      "rollback_unsupported",
      "на эту сборку откатиться нельзя: она уже не хранится",
      "пересобери нужный коммит через `layero deploy` или выбери более свежую сборку в `layero deploys list`",
    );
  }
  if (detail.includes("no artifact")) {
    return new LayeroError(
      "rollback_unsupported",
      "на эту сборку откатиться нельзя: у неё нет сохранённого результата",
      "пересобери нужный коммит через `layero deploy`",
    );
  }
  return new LayeroError(
    "rollback_unsupported",
    detail ? `на эту сборку откатиться нельзя: ${detail}` : "на эту сборку откатиться нельзя",
    "выбери другую готовую сборку в `layero deploys list` или пересобери коммит через `layero deploy`",
  );
}
