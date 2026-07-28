import readline from "node:readline/promises";
import chalk from "chalk";
import { ApiClient, ApiError, DeployOut } from "../api.js";
import { loadConfig } from "../config.js";
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
  const cliCfg = await loadConfig();
  if (!cliCfg.token) throw new Error("not logged in. run `layero login` first.");
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
      // 409 «not in a rollback-eligible state» — это НЕ сбой платформы, а
      // ожидаемое ограничение, и подавать его кодом `internal` (то есть
      // «сообщите о проблеме») нельзя: человек читает это в момент, когда у
      // него уже что-то сломалось на проде.
      //
      // Две причины дают один и тот же ответ API. Runtime-проекты (SSR,
      // Streamlit, Gradio) не откатываются вообще: их артефакт лежит в
      // реестре образов, а проверка пригодности требует s3_path. У статики
      // артефакт мог быть вычищен по ретенции. Различить их здесь нечем,
      // поэтому называем оба и даём общий выход — пересборку коммита.
      if (err.status === 409 && err.body.includes("rollback-eligible")) {
        throw new LayeroError(
          "rollback_unsupported",
          "этот деплой нельзя переактивировать: у него нет раздаваемого артефакта",
          "runtime-проекты (SSR, Streamlit, Gradio) откатывать пока нельзя, " +
            "а у статики артефакт мог быть вычищен по ретенции — " +
            "пересобери нужный коммит через `layero deploy`",
        );
      }
      throw new Error(`rollback failed (${err.status}): ${err.body.slice(0, 200)}`);
    }
    throw err;
  }
}
