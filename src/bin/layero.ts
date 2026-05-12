#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { whoamiCmd } from "../commands/whoami.js";
import { logoutCmd } from "../commands/logout.js";
import { projectsListCmd } from "../commands/projects.js";
import { linkCmd } from "../commands/link.js";
import { tokenSetCmd } from "../commands/token.js";
import { deployCmd } from "../commands/deploy.js";
import { deploysListCmd, rollbackCmd } from "../commands/deploys.js";
import { loginCmd } from "../commands/login.js";
import { orgsListCmd } from "../commands/orgs.js";
import { initCmd } from "../commands/init.js";
import { LayeroError, detectMode, emit } from "../agent.js";

// Read version from the shipped package.json (two levels up from dist/bin/).
const pkgPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "package.json",
);
const VERSION = (JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string }).version;

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("layero")
    .description(
      "Layero CLI — publish a local directory with one command. No git required.",
    )
    .version(VERSION)
    .option("--json", "emit machine-readable JSON-lines on stdout (for agents and CI)");

  program
    .command("login")
    .description("Authenticate via browser (GitHub / Google / Yandex).")
    .option(
      "-p, --provider <provider>",
      "OAuth provider hint (github | google | yandex)",
      "github",
    )
    .option("--port <port>", "fixed loopback port (default: random)", (v) => Number(v))
    .addHelpText(
      "after",
      "\nExamples:\n  $ layero login\n  $ layero login --provider google",
    )
    .action(async (opts) => {
      await loginCmd({ provider: opts.provider, port: opts.port });
    });

  program
    .command("logout")
    .description("Remove the saved auth token.")
    .action(logoutCmd);

  program
    .command("whoami")
    .description("Show the currently logged-in account.")
    .action(whoamiCmd);

  program
    .command("init")
    .description(
      "Scaffold .layero/project.json from auto-detected framework, and write a Layero deployment block into AGENTS.md / CLAUDE.md / .cursorrules so future chat sessions know how to deploy.",
    )
    .option("-y, --yes", "non-interactive: accept all defaults")
    .option("--skip-agent-docs", "do not touch AGENTS.md/CLAUDE.md/.cursorrules")
    .action(async (opts) => {
      await initCmd({ yes: opts.yes, skipAgentDocs: opts.skipAgentDocs });
    });

  const projects = program
    .command("projects")
    .description("Inspect projects on your account.");
  projects
    .command("list")
    .description("List your projects.")
    .action(projectsListCmd);

  const orgs = program
    .command("orgs")
    .description("Layero organizations on your account (personal + teams).");
  orgs
    .command("list")
    .description("Show every Layero organization you belong to.")
    .action(orgsListCmd);

  const deploys = program
    .command("deploys")
    .description("List and inspect deploys for the linked project.");
  deploys
    .command("list")
    .description("List recent deploys for the project's default branch (or --branch).")
    .option("--project <id_or_slug>", "target project (default: linked .layero/project.json)")
    .option("--branch <name>", "branch to list deploys from (default: project's default_branch)")
    .option("--limit <n>", "max entries to show (default 20)", (v) => Number(v))
    .action(async (opts) => {
      await deploysListCmd(opts);
    });

  program
    .command("rollback")
    .description("Re-activate the previous successful deploy on the project's default branch.")
    .option("--project <id_or_slug>", "target project (default: linked .layero/project.json)")
    .option("--branch <name>", "branch to roll back (default: project's default_branch)")
    .option("--deploy <id_or_sha>", "explicit deploy id or commit sha prefix to roll back to")
    .option("-y, --yes", "skip the confirmation prompt (CI)")
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  $ layero rollback                       # roll back default branch to previous ready deploy\n" +
        "  $ layero rollback --branch=staging      # roll back the staging branch\n" +
        "  $ layero rollback --deploy=a3f9c2b      # roll back to a specific commit/deploy\n" +
        "  $ layero rollback --yes                 # CI-friendly, no prompt",
    )
    .action(async (opts) => {
      await rollbackCmd(opts);
    });

  program
    .command("link <id_or_slug>")
    .description("Link the current directory to an existing project.")
    .action(linkCmd);

  const token = program
    .command("token")
    .description("Manage the auth token directly (advanced).");
  token
    .command("set <jwt>")
    .description(
      "Persist a JWT obtained out-of-band (e.g. from the web UI). " +
        "Use this until `layero login` is fully wired up.",
    )
    .action(tokenSetCmd);

  program
    .command("deploy")
    .description(
      "Pack the current directory and deploy it. Framework, build command and output directory are auto-detected.",
    )
    .option(
      "-t, --type <preset>",
      "framework override (vite | next | astro | cra | sveltekit | nuxt | gatsby | docusaurus | static)",
    )
    .option("--name <name>", "project name (only used on first deploy)")
    .option("--project <id_or_slug>", "deploy into an existing project, ignoring local config")
    .option("-y, --yes", "non-interactive: accept defaults and skip --prod confirmation")
    .option(
      "--config",
      "(legacy alias of the default behaviour — auto-detect + .layero/project.json values)",
    )
    .option(
      "--prod",
      "deploy to production (replaces apex_hostname's active deploy). Without this flag, deploys go to the project's CLI preview pseudo-branch.",
    )
    .option(
      "--branch <name>",
      "deploy to a specific branch's environment. Wins over --prod.",
    )
    .option(
      "--org <slug>",
      "Layero organization slug for first-time project creation. Defaults to personal; required when you're a member of multiple orgs and want a non-personal home.",
    )
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  $ layero deploy                      # preview deploy (CLI pseudo-branch), auto-detect framework\n" +
        "  $ layero deploy --prod               # production deploy (interactive confirm)\n" +
        "  $ layero deploy --prod --yes         # production deploy, no prompt (CI)\n" +
        "  $ layero deploy --branch=staging     # preview on a specific branch\n" +
        "  $ layero deploy --type vite          # force a framework preset\n" +
        "  $ layero deploy --json               # machine-readable output for agents",
    )
    .action(async (opts) => {
      await deployCmd(opts);
    });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  const mode = detectMode();
  if (err instanceof LayeroError) {
    emit({
      event: "error",
      code: err.code,
      next_action: err.next_action,
      message: err.message,
    });
  } else {
    // Anything else (network error, unexpected exception) — still emit
    // a structured error so agents have a consistent format to parse.
    const message = err?.message ?? String(err);
    if (mode.json) {
      emit({
        event: "error",
        code: "internal",
        next_action: "re-run with --debug for a stack trace, or report at https://github.com/layero/layero/issues",
        message,
      });
    } else {
      console.error(chalk.red(message));
    }
  }
  process.exit(1);
});
