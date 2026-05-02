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
import { loginCmd } from "../commands/login.js";

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
    .description("Layero CLI — publish a local site with one command.")
    .version(VERSION);

  program
    .command("login")
    .description("Authenticate via browser (GitHub / Google / Yandex).")
    .option(
      "-p, --provider <provider>",
      "OAuth provider to use (github | google | yandex)",
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

  const projects = program
    .command("projects")
    .description("Inspect projects on your account.");
  projects
    .command("list")
    .description("List your projects.")
    .action(projectsListCmd);

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
    .description("Pack the current directory and deploy it.")
    .option(
      "-t, --type <preset>",
      "framework hint (vite | next | astro | cra | sveltekit | nuxt | gatsby | static)",
    )
    .option("--name <name>", "project name (only used on first deploy)")
    .option("--project <id_or_slug>", "deploy into an existing project, ignoring local config")
    .option("-y, --yes", "non-interactive: accept defaults, fail if anything is missing")
    .option(
      "--config",
      "use framework/build settings + env vars from .layero/project.json (skips the browser setup wizard)",
    )
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  $ layero deploy                      # uploads source, opens setup wizard in the browser\n" +
        "  $ layero deploy --config             # uses .layero/project.json end-to-end (CI-friendly)\n" +
        "  $ layero deploy --type vite\n" +
        "  $ layero deploy --project my-site --yes",
    )
    .action(async (opts) => {
      await deployCmd(opts);
    });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(chalk.red(err.message ?? String(err)));
  process.exit(1);
});
