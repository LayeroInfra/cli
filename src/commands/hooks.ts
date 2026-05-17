import chalk from "chalk";
import { ApiClient, ApiError } from "../api.js";
import { loadConfig } from "../config.js";
import { loadProjectConfig } from "../project-config.js";

async function resolveProjectId(opts: { project?: string }): Promise<string> {
  if (opts.project) {
    // Accepts an id directly; UUID format check is server-side.
    return opts.project;
  }
  const linked = await loadProjectConfig(process.cwd());
  if (linked?.project_id) {
    return linked.project_id;
  }
  throw new Error(
    "no project linked in cwd — pass --project <id> or run `layero deploy` "
      + "from a project directory once to link it.",
  );
}

async function makeClient(): Promise<ApiClient> {
  const cfg = await loadConfig();
  if (!cfg.token) {
    throw new Error("not logged in. run `layero login` first.");
  }
  return new ApiClient(cfg);
}

export async function hooksListCmd(opts: { project?: string }): Promise<void> {
  const api = await makeClient();
  const projectId = await resolveProjectId(opts);
  const hooks = await api.listDeployHooks(projectId);
  if (hooks.length === 0) {
    console.log("no deploy hooks yet — `layero hooks create <name>` to add one.");
    return;
  }
  for (const h of hooks) {
    const targetTag =
      h.target === "production" ? chalk.red("[prod]") : chalk.cyan("[preview]");
    const branchTag = h.branch ? chalk.dim(`branch=${h.branch}`) : chalk.dim("branch=default");
    const last = h.last_triggered_at
      ? `fired ${new Date(h.last_triggered_at).toISOString()}`
      : "never fired";
    console.log(
      `${targetTag} ${chalk.bold(h.name)}  ${branchTag}  ${chalk.dim("(" + last + ")")}`,
    );
    console.log(`        ${chalk.dim(h.id)}`);
    console.log(`        ${h.url}`);
  }
}

export async function hooksCreateCmd(
  name: string,
  opts: { project?: string; branch?: string; prod?: boolean },
): Promise<void> {
  if (!name || !name.trim()) {
    throw new Error("name is required: `layero hooks create <name>`");
  }
  const api = await makeClient();
  const projectId = await resolveProjectId(opts);
  const hook = await api.createDeployHook(projectId, {
    name: name.trim(),
    branch: opts.branch ?? null,
    target: opts.prod ? "production" : "preview",
  });
  const targetTag =
    hook.target === "production" ? chalk.red("[prod]") : chalk.cyan("[preview]");
  console.log(`${chalk.green("✓")} created ${targetTag} ${chalk.bold(hook.name)}`);
  console.log(`  ${chalk.dim(hook.id)}`);
  console.log(`  ${chalk.bold(hook.url)}`);
  console.log(
    chalk.dim(
      "\n  Paste this URL into your CMS / cron / external CI as a POST webhook. "
        + "Anyone with the URL can fire a build — treat it like a secret. "
        + "Rotate by deleting and creating a new one.",
    ),
  );
}

export async function hooksDeleteCmd(
  hookId: string,
  opts: { project?: string },
): Promise<void> {
  if (!hookId) {
    throw new Error("hook id is required: `layero hooks delete <id>`");
  }
  const api = await makeClient();
  const projectId = await resolveProjectId(opts);
  try {
    await api.deleteDeployHook(projectId, hookId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      console.error(chalk.yellow(`no hook ${hookId} on this project (already deleted?)`));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  console.log(`${chalk.green("✓")} hook ${chalk.dim(hookId)} revoked`);
}
