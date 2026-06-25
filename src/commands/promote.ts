import readline from "node:readline/promises";
import chalk from "chalk";
import { ApiClient, ApiError, DeployOut } from "../api.js";
import { loadConfig } from "../config.js";
import { loadProjectConfig } from "../project-config.js";
import { detectMode, emit } from "../agent.js";

interface PromoteOptions {
  project?: string;
  branch?: string;
  yes?: boolean;
}

async function resolveProjectId(
  api: ApiClient,
  cwd: string,
  override: string | undefined,
): Promise<string> {
  if (override) {
    const all = await api.listProjects();
    const match =
      all.find((p) => p.id === override) ?? all.find((p) => p.slug === override);
    if (!match) throw new Error(`no project with id/slug "${override}"`);
    return match.id;
  }
  const cfg = await loadProjectConfig(cwd);
  if (!cfg) {
    throw new Error(
      "no .layero/project.json found. cd into a linked project or pass --project <slug>.",
    );
  }
  return cfg.project_id;
}

function shortSha(sha: string | undefined): string {
  return (sha ?? "").slice(0, 7);
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await rl.question(`${question} [y/N]: `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * `layero promote [deploy]` — pin apex to a specific deploy.
 *
 * Without an argument: picks the latest ready deploy on --branch (or the
 * "cli" pseudo-branch when not specified). With an argument: takes either
 * a deploy id or a commit-sha prefix and promotes that one — same shape
 * as `layero rollback --deploy`.
 *
 * Requires production_pointer_enabled=true on the project. The server
 * returns 400 with a readable message if the flag is off; we surface it.
 */
export async function promoteCmd(
  deployArg: string | undefined,
  opts: PromoteOptions,
): Promise<void> {
  const mode = detectMode();
  const cliCfg = await loadConfig();
  if (!cliCfg.token) {
    throw new Error("not logged in. run `layero login` first.");
  }
  const api = new ApiClient(cliCfg);
  const projectId = await resolveProjectId(api, process.cwd(), opts.project);
  const project = await api.getProject(projectId);

  let target: DeployOut;
  if (deployArg) {
    // Search across all branches — the user may know the sha but not which
    // branch it came from. Behaviour mirrors `rollback --deploy`.
    const all = await api.listProjectDeploys(projectId, opts.branch);
    const m = all.find(
      (d) => d.id === deployArg || d.commit_sha.startsWith(deployArg),
    );
    if (!m) throw new Error(`no deploy matching "${deployArg}"`);
    target = m;
  } else {
    // No deploy arg → promote latest ready on the branch (defaults to "cli"
    // pseudo-branch, which is where `layero deploy` without --branch lands).
    const branch = opts.branch ?? "cli";
    const all = await api.listProjectDeploys(projectId, branch);
    const m = all.find((d) => d.status === "ready");
    if (!m) {
      throw new Error(`no ready deploy on branch "${branch}".`);
    }
    target = m;
  }

  if (target.status !== "ready") {
    throw new Error(
      `cannot promote deploy ${shortSha(target.commit_sha)}: status is "${target.status}", not ready.`,
    );
  }

  const apex = project.apex_hostname;
  // Human-only plan. In JSON mode we skip the chatter and emit a single
  // structured `promoted` event below.
  if (!mode.json) {
    console.log(chalk.cyan("promote plan:"));
    console.log(`  project: ${project.slug}`);
    console.log(`  apex:    https://${apex}`);
    console.log(
      `  deploy:  ${shortSha(target.commit_sha)}  ${chalk.dim(
        (target.commit_message ?? "").split("\n")[0] ?? "",
      )}`,
    );
    if (project.production_deploy_id) {
      console.log(
        chalk.dim(`  current: ${project.production_deploy_id.slice(0, 8)}  (will be replaceable via re-promote)`),
      );
    }
  }

  // Confirm only when there's a human at a TTY. In --json / agent / CI /
  // non-interactive mode, never block on a prompt (B6) — proceed, matching
  // `deploy --prod`'s non-interactive behaviour. `--yes` forces it anywhere.
  if (!opts.yes && mode.interactive) {
    const ok = await confirm("publish this build to production?");
    if (!ok) {
      console.log(chalk.yellow("aborted."));
      return;
    }
  }

  try {
    const updated = await api.promoteDeploy(projectId, target.id);
    const newPin = updated.production_deploy_id ?? target.id;
    if (mode.json) {
      emit({
        event: "promoted",
        url: `https://${updated.apex_hostname}`,
        deploy_id: target.id,
      });
    } else {
      console.log(
        chalk.green(
          `published. https://${updated.apex_hostname} now serves deploy ${newPin.slice(0, 8)}.`,
        ),
      );
      console.log(
        chalk.dim(
          "  edge cache flushes within a few seconds; visitors see the new build immediately.",
        ),
      );
    }
  } catch (err) {
    if (err instanceof ApiError) {
      throw new Error(`promote failed (${err.status}): ${err.body.slice(0, 200)}`);
    }
    throw err;
  }
}
