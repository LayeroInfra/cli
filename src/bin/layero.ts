#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { whoamiCmd } from "../commands/whoami.js";
import { logoutCmd } from "../commands/logout.js";
import { projectsCreateCmd, projectsDeleteCmd, projectsListCmd } from "../commands/projects.js";
import { sourcesConnectCmd, sourcesListCmd, sourcesReposCmd } from "../commands/sources.js";
import { envsListCmd } from "../commands/envs.js";
import { claimAcceptCmd, claimStatusCmd } from "../commands/claim.js";
import { exitCodeFor } from "../exit-codes.js";
import { linkCmd } from "../commands/link.js";
import { tokenCreateCmd, tokenListCmd, tokenRevokeCmd, tokenSetCmd } from "../commands/token.js";
import { deployCmd } from "../commands/deploy.js";
import { deploysListCmd, rollbackCmd } from "../commands/deploys.js";
import { promoteCmd } from "../commands/promote.js";
import { hooksCreateCmd, hooksDeleteCmd, hooksListCmd } from "../commands/hooks.js";
import { loginCmd } from "../commands/login.js";
import { orgsListCmd } from "../commands/orgs.js";
import { initCmd } from "../commands/init.js";
import { diagnoseCmd, logsCmd } from "../commands/diagnose.js";
import { perfCheckCmd, perfShowCmd } from "../commands/perf.js";
import { dataEnvCmd } from "../commands/data.js";
import { registerDataApiCommands } from "../commands/data-api.js";
import {
  dbConnectCmd,
  dbCreateCmd,
  dbDisconnectCmd,
  dbListCmd,
  dbSqlCmd,
} from "../commands/db.js";
import { envListCmd, envSetCmd, envUnsetCmd } from "../commands/env.js";
import {
  analyticsConnectCmd,
  analyticsDisconnectCmd,
  analyticsStatsCmd,
  analyticsStatusCmd,
} from "../commands/analytics.js";
import {
  domainsAddCmd,
  domainsListCmd,
  domainsPrimaryCmd,
  domainsRemoveCmd,
  domainsVerifyCmd,
} from "../commands/domains.js";
import { LayeroError, detectMode, emit } from "../agent.js";
import { ApiClient, ApiError } from "../api.js";
import { loadConfig } from "../config.js";
import { usernameSetCmd } from "../username.js";
import { notifyIfOutdated } from "../update-notifier.js";
import { CLI_VERSION } from "../version.js";

// Одно чтение package.json на процесс — версия нужна и здесь (`--version`,
// нагон обновления), и в каждом запросе к API (заголовок).
const VERSION = CLI_VERSION;

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("layero")
    .description(
      "Layero CLI — publish a local directory with one command. No git required.",
    )
    .version(VERSION)
    .option("--json", "emit machine-readable JSON-lines on stdout (for agents and CI)")
    .option("--debug", "print a full stack trace when a command errors");

  program
    .command("login")
    .description(
      "Sign in through the browser (an emailed code or Yandex ID): prints a one-time URL and code.",
    )
    .option("--no-browser", "do not open the browser — only print the URL and code")
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  $ layero login\n" +
        "  $ layero login --no-browser        # SSH, container, agent environment\n" +
        "\nA human sign-in does not work for CI and agents — they need a long-lived token:\n" +
        "  $ layero token create ci\n" +
        "  $ LAYERO_TOKEN=<token> npx layero@latest deploy",
    )
    .action(async (opts) => {
      await loginCmd(opts);
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
    .command("username <value>")
    .description(
      "Set the account username — it is also the address of your personal organization. " +
        "Without it the platform has nowhere to put a project. " +
        "In an interactive terminal `login` and `deploy` ask for it themselves; " +
        "this command is for agents and CI, where there is nobody to ask.",
    )
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  $ layero username alice\n" +
        "  $ layero username my-team-bot\n\n" +
        "Lowercase Latin letters, digits and hyphens; 2–32 characters.",
    )
    .action(async (value: string) => {
      const cfg = await loadConfig();
      await usernameSetCmd(value, new ApiClient(cfg));
    });

  program
    .command("init")
    .description(
      "Optional. Write a Layero deployment block into your agent-instructions file so future chat sessions know how to deploy (updates whichever of AGENTS.md / CLAUDE.md / .cursorrules already exist; if none do, creates AGENTS.md), and create .layero/project.json — this folder's link to its Layero project, filled in by the first deploy. No detected settings are recorded: build settings live in layero.json (committed with the code) or in the project settings. `deploy` links the folder by itself, so init is never required.",
    )
    .option("-y, --yes", "non-interactive: accept all defaults")
    .option("--skip-agent-docs", "do not touch AGENTS.md / CLAUDE.md / .cursorrules")
    .action(async (opts) => {
      await initCmd({ yes: opts.yes, skipAgentDocs: opts.skipAgentDocs });
    });

  const projects = program
    .command("projects")
    .description("The account's projects: list, create from a repository, delete.");
  projects
    .command("list")
    .description("List your projects.")
    .action(projectsListCmd);
  projects
    .command("create")
    .description(
      "Create a project from a repository of a connected Git provider — path (a): push to a branch = preview, push to main = production. " +
        "GitHub is connected through the installed Layero GitHub App, other providers through `layero sources connect`.",
    )
    .requiredOption("--repo <provider:owner/repo>", "repository: github:acme/site, gitverse:acme/site, gitlab:group/sub/project")
    .option("--branch <name>", "the project's main branch (default: the repository's default branch)")
    .option("--name <name>", "project name (default: the repository name)")
    .option("--org <slug>", "organization (default: your only one, otherwise your personal organization)")
    .option("--no-deploy", "do not finish the setup or start the first build — the project stays in the setup wizard in the dashboard (app.layero.ru)")
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  $ layero projects create --repo github:acme/site\n" +
        "  $ layero projects create --repo gitverse:acme/site --branch develop --json\n" +
        "\nOnce the repository is linked, the command finishes the setup and starts the first\n" +
        "build itself. The detected framework, build command and output directory are not\n" +
        "saved in the project: the builder detects them from the repository on every build\n" +
        "(layero.json overrides them). Saved are only the monorepo app folder and the\n" +
        "package manager from layero.json. With --no-deploy the project stays in the setup wizard.\n" +
        "\nEvents with --json: project_created, source_connected, webhook_installed | webhook_unavailable,\n" +
        "then setup_applied + deploy_started | setup_pending |\n" +
        "setup_failed (the project exists; finish the setup in the dashboard).\n" +
        "Without a webhook a push does not start a build — add the webhook by hand\n" +
        "using the URL from webhook_unavailable.",
    )
    .action(async (opts) => projectsCreateCmd({ ...opts, json: program.opts().json }));
  projects
    .command("delete <id_or_slug>")
    .description("Delete a project. IRREVERSIBLE; requires a token with the admin scope (`layero token create <name> --scope admin`).")
    .option("-y, --yes", "do not ask for confirmation (required outside a terminal)")
    .action(async (ref: string, opts) => projectsDeleteCmd(ref, { ...opts, json: program.opts().json }));

  const sources = program
    .command("sources")
    .description("The organization's Git providers: see which are available, connect one with a token, browse repositories.");
  sources
    .command("list")
    .description("Git providers the platform supports and the organization's connections.")
    .option("--org <slug>", "organization (default: your only one, otherwise your personal organization)")
    .action(async (opts) => sourcesListCmd({ ...opts, json: program.opts().json }));
  sources
    .command("connect <provider>")
    .description(
      "Connect a Git provider with a personal access token (PAT). The token is verified before it is saved and is never returned.",
    )
    .option("--token <pat>", "provider token (stays in the shell history — prefer --token-stdin)")
    .option("--token-stdin", "read the token from stdin: echo \"$PAT\" | layero sources connect gitverse --token-stdin")
    .option("--base-url <url>", "URL of a self-hosted instance (GitLab, GitFlic)")
    .option("--name <label>", "connection label")
    .option("--org <slug>", "organization (default: your only one, otherwise your personal organization)")
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  $ echo \"$GITVERSE_TOKEN\" | layero sources connect gitverse --token-stdin\n" +
        "  $ layero sources connect gitlab --token-stdin --base-url https://git.example.com < token.txt\n" +
        "\nProviders: `layero sources list`. GitHub is connected by installing\n" +
        "the Layero GitHub App in the dashboard (app.layero.ru).",
    )
    .action(async (provider: string, opts) =>
      sourcesConnectCmd(provider, { ...opts, json: program.opts().json }),
    );
  sources
    .command("repos <connection_id>")
    .description("Repositories visible to the connection's token.")
    .option("--org <slug>", "organization (default: your only one, otherwise your personal organization)")
    .action(async (id: string, opts) => sourcesReposCmd(id, { ...opts, json: program.opts().json }));

  const envs = program
    .command("envs")
    .description("The project's environments: branches and their addresses.");
  envs
    .command("list")
    .description("The project's environments with their addresses. A CLI project has one — `cli`; a project with a repository has one per branch.")
    .option("--project <id_or_slug>", "project (default: the linked project)")
    .action(async (opts) => envsListCmd({ ...opts, json: program.opts().json }));

  const claim = program
    .command("claim")
    .description("Project without an account (`layero deploy --claim`): the claim status and the link to take the site over.");
  claim
    .command("status [code]")
    .description("Claim state: alive, claimed or expired. Without a code, the code is taken from .layero/project.json.")
    .action(async (code: string | undefined) => claimStatusCmd(code, { json: program.opts().json }));
  claim
    .command("accept [code]")
    .description(
      "Open the claim page in the dashboard (app.layero.ru). Only a person signed in to the dashboard can accept the claim — the CLI only opens or prints the link.",
    )
    .option("--no-browser", "do not open the browser — only print the link")
    .action(async (code: string | undefined, opts) =>
      claimAcceptCmd(code, { ...opts, json: program.opts().json }),
    );

  const orgs = program
    .command("orgs")
    .description("The account's organizations: personal and team ones.");
  orgs
    .command("list")
    .description("All organizations you are a member of.")
    .action(orgsListCmd);

  const deploys = program
    .command("deploys")
    .description("List and inspect deploys for the linked project.");
  deploys
    .command("list")
    .description("List recent deploys for the project's default branch (or --branch).")
    .option("--project <id_or_slug>", "project (default: the one linked in .layero/project.json)")
    .option("--branch <name>", "branch to list deploys from (default: project's default_branch)")
    .option("--limit <n>", "max entries to show (default 20)", (v) => Number(v))
    .action(async (opts) => {
      await deploysListCmd(opts);
    });

  const hooks = program
    .command("hooks")
    .description(
      "Manage deploy hooks — URL tokens that trigger builds from CMS / cron / external CI.",
    );
  hooks
    .command("list")
    .description("List deploy hooks for the linked project.")
    .option("--project <id>", "project id (default: the one linked in .layero/project.json)")
    .action(async (opts) => {
      await hooksListCmd(opts);
    });
  hooks
    .command("create <name>")
    .description(
      "Create a new deploy hook. Prints a URL — paste it into Strapi / Sanity / "
        + "Contentful / GitHub Actions / cron as a POST webhook.",
    )
    .option("--project <id>", "project id (default: the one linked in .layero/project.json)")
    .option(
      "--branch <name>",
      "branch to deploy when fired (default: project default_branch, evaluated at fire time)",
    )
    .option("--prod", "fire the hook against the production environment (default: preview)")
    .addHelpText(
      "after",
      "\nExamples:\n"
        + "  $ layero hooks create strapi-content        # preview-target hook for default branch\n"
        + "  $ layero hooks create publish --prod        # production-target hook for default branch\n"
        + "  $ layero hooks create staging --branch=dev  # any branch, preview environment",
    )
    .action(async (name: string, opts) => {
      await hooksCreateCmd(name, opts);
    });
  hooks
    .command("delete <id>")
    .description("Revoke a deploy hook. The URL stops working immediately.")
    .option("--project <id>", "project id (default: the one linked in .layero/project.json)")
    .action(async (id: string, opts) => {
      await hooksDeleteCmd(id, opts);
    });

  program
    .command("promote [deploy]")
    .description(
      "Pin the project apex to a specific deploy (V071 production-pointer). " +
        "Without [deploy] picks the latest ready build on --branch (defaults to the 'cli' pseudo-branch).",
    )
    .option("--project <id_or_slug>", "project (default: the one linked in .layero/project.json)")
    .option("--branch <name>", "branch to pick latest ready deploy from (default: cli)")
    .option("-y, --yes", "skip the confirmation prompt (CI)")
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  $ layero promote                      # pin apex to latest ready deploy on `cli` branch\n" +
        "  $ layero promote --branch=main        # pin apex to latest ready deploy on main\n" +
        "  $ layero promote a3f9c2b              # pin apex to a specific commit sha\n" +
        "  $ layero promote --yes                # CI-friendly, no prompt",
    )
    .action(async (deploy, opts) => {
      await promoteCmd(deploy, opts);
    });

  program
    .command("rollback")
    .description(
      "Re-activate the previous successful deploy. Since 27 Jul 2026 it also " +
        "moves the production pointer, so the apex comes back too when it is " +
        "served by this branch. For a SPECIFIC older deploy use " +
        "`layero promote <commit-sha>`.",
    )
    .option("--project <id_or_slug>", "project (default: the one linked in .layero/project.json)")
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

  const env = program
    .command("env")
    .description("The project's environment variables. Values are not shown — the platform does not return them.");
  const envProject = (c: any) =>
    c.option("--project <id_or_slug>", "project (default: the linked project)");
  envProject(env.command("list").description("Variable names and value lengths."))
    .action(async (opts: any) => envListCmd({ ...opts, json: program.opts().json }));
  envProject(
    env
      .command("set <pairs...>")
      .description("Set variables as KEY=value. Other variables stay untouched."),
  ).action(async (pairs: string[], opts: any) =>
    envSetCmd(pairs, { ...opts, json: program.opts().json }),
  );
  envProject(
    env
      .command("unset <keys...>")
      .description("Delete variables.")
      .option("-y, --yes", "do not ask for confirmation"),
  ).action(async (keys: string[], opts: any) =>
    envUnsetCmd(keys, { ...opts, json: program.opts().json }),
  );

  const data = program
    .command("data")
    .description("A database's Data API: keys, allowed sites, methods and access; the URL and key for the frontend.");
  data
    .command("env")
    .description("Show the VITE_/NEXT_PUBLIC_ variables for the Data API; --write puts them in .env.local.")
    .option("--project <id_or_slug>", "project (default: the linked project)")
    .option("-w, --write", "write to the file instead of printing")
    .option("--file <path>", "file name (default .env.local)")
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  $ layero data env                       # view\n" +
        "  $ layero data env --write               # write to .env.local\n" +
        "\nOnly the PUBLIC key is returned — the one that ends up in the bundle anyway.\n" +
        "The platform neither stores nor returns the secret key: it is for the server.",
    )
    .action(async (opts: any) => dataEnvCmd({ ...opts, json: program.opts().json }));

  registerDataApiCommands(data, program);

  const db = program
    .command("db")
    .description("The organization's databases: create, list, connect to a project, run SQL.");
  const withOrg = (c: any) => c.option("--org <slug>", "organization (default: your only one, otherwise your personal organization)");
  withOrg(db.command("list").description("The organization's databases."))
    .action(async (opts: any) => dbListCmd({ ...opts, json: program.opts().json }));
  withOrg(
    db
      .command("create <name>")
      .description("Create a database. The connection string is printed ONCE.")
      // 🚨 ФЛАГ ОСТАВЛЕН РАДИ ЧЕСТНОГО ОТКАЗА, А НЕ РАДИ РАБОТЫ. Он обещал
      // «объём платной базы в гигабайтах» и не делал НИЧЕГО: сервер поле не
      // читает ни одним путём создания — у Shared объём задаёт тариф, у
      // выделенного диск ступени. Убрать его совсем значило бы отвечать
      // «неизвестный параметр» тому, кто им пользовался, и оставить человека
      // гадать, куда делся объём. Теперь команда говорит это словами (C9).
      .option("--gb <number>", "NO LONGER WORKS: the size is set by the plan or by the dedicated instance's tier", (v: string) => parseInt(v, 10))
      // 🚨 ТЕ ЖЕ ФЛАГИ РАДИ ЧЕСТНОГО ОТКАЗА. Выделенный инстанс из терминала
      // не заказать, и это осознанно: у заказа есть цена и заморозка денег, а
      // карту в терминале не привяжешь и сумму подтвердить негде. Но человек,
      // прочитавший про ступени в панели, попробует `--cpu 2` — и без этих
      // флагов получит «неизвестный параметр», то есть ответ про синтаксис
      // вместо ответа про причину.
      .option("--cpu <number>", "dedicated instance: ordered only in the dashboard", (v: string) => parseInt(v, 10))
      .option("--ram <mb>", "dedicated instance: ordered only in the dashboard", (v: string) => parseInt(v, 10))
      .option("--dedicated", "dedicated instance: ordered only in the dashboard"),
  ).action(async (name: string, opts: any) =>
    dbCreateCmd(name, { ...opts, json: program.opts().json }),
  );
  withOrg(
    db
      .command("connect <database>")
      .description("Connect a project to the database: the connection string goes into the project's "
        + "environment variables, and the project's domains become allowed origins of the Data API.")
      .option("--project <id_or_slug>", "project (default: the linked project)"),
  ).action(async (database: string, opts: any) =>
    dbConnectCmd(database, { ...opts, json: program.opts().json }),
  );
  withOrg(
    db
      .command("disconnect <database>")
      .description("Disconnect a project from the database: the variable goes away with the next deploy, "
        + "the project's role is deleted, and the project's domains stop being allowed origins of the Data API.")
      .option("--project <id_or_slug>", "project (default: the linked project)"),
  ).action(async (database: string, opts: any) =>
    dbDisconnectCmd(database, { ...opts, json: program.opts().json }),
  );
  withOrg(
    db
      // 🚨 ЗАПРОС МОЖНО ПИСАТЬ ПРОСТО СЛЕДОМ ЗА ИМЕНЕМ БАЗЫ. Раньше `-c` был
      // ОБЯЗАТЕЛЕН, и `layero db sql моя-база "select 1"` отвечал
      // «required option -c, --command not specified» — то есть отказывал на
      // самой очевидной форме записи. Так эта команда и записана в приёмке
      // (C6), и так её пишет всякий, кто помнит psql.
      .command("sql <database> [sql]")
      .description("Run SQL in a database. A script of several statements runs as one transaction.")
      .option("-c, --command <sql>", "query or script"),
  ).action(async (database: string, sql: string | undefined, opts: any) =>
    dbSqlCmd(database, {
      ...opts,
      // Явный `-c` выигрывает: он написан намеренно, а позиционный аргумент
      // мог прилететь из истории команд.
      command: opts.command ?? sql,
      json: program.opts().json,
    }),
  );

  const analytics = program
    .command("analytics")
    .description("Yandex Metrica: connect it and see the site's statistics.");
  const withProject = (c: any) =>
    c.option("--project <id_or_slug>", "project (default: the linked project)");
  withProject(analytics.command("status").description("Whether Yandex Metrica is connected, and to which branch."))
    .action(async (opts: any) => analyticsStatusCmd({ ...opts, json: program.opts().json }));
  withProject(
    analytics
      .command("connect")
      .description("Connect Yandex Metrica. Prints a link — a human must open it and grant access.")
      .option("--branch <name>", "branch whose address gets the counter (default: the main branch)"),
  ).action(async (opts: any) => analyticsConnectCmd({ ...opts, json: program.opts().json }));
  withProject(
    analytics
      .command("stats")
      .description("Traffic: totals, trend and top sources/devices/pages.")
      .option("--period <7d|30d|90d>", "period (default 7d)"),
  ).action(async (opts: any) => analyticsStatsCmd({ ...opts, json: program.opts().json }));
  withProject(
    analytics
      .command("disconnect")
      .description("Disconnect Yandex Metrica from the project.")
      .option("-y, --yes", "do not ask for confirmation"),
  ).action(async (opts: any) => analyticsDisconnectCmd({ ...opts, json: program.opts().json }));

  const perf = program
    .command("perf")
    .description("Measure site performance and compare it with the previous deploy.");
  perf
    .command("check")
    .description("Start a measurement of the active deploy. The run is asynchronous — with --wait the command waits for the result.")
    .option("--project <id_or_slug>", "project (default: the linked project)")
    .option("--wait", "wait for the result (up to 4 minutes)")
    .action(async (opts) => perfCheckCmd({ ...opts, json: program.opts().json }));
  perf
    .command("show")
    .description("Show the latest measurement and the comparison with the previous deploy.")
    .option("--project <id_or_slug>", "project (default: the linked project)")
    .action(async (opts) => perfShowCmd({ ...opts, json: program.opts().json }));

  const domains = program
    .command("domains")
    .description("The project's custom domains: attach, check DNS, make primary, remove.");
  const domainOpts = (c: any) =>
    c.option("--project <id_or_slug>", "project (default: the linked project)");
  domainOpts(domains.command("list").description("Show the project's domains."))
    .action(async (opts: any) => domainsListCmd({ ...opts, json: program.opts().json }));
  domainOpts(
    domains
      .command("add <domain>")
      .description(
        "Attach a domain. Prints the DNS records to add at your registrar; "
          + "does NOT wait until the domain is ready — DNS propagation takes from minutes to an hour.",
      ),
  ).action(async (domain: string, opts: any) =>
    domainsAddCmd(domain, { ...opts, json: program.opts().json }),
  );
  domainOpts(
    domains.command("verify <domain>").description("Check DNS now instead of waiting for the background re-check."),
  ).action(async (domain: string, opts: any) =>
    domainsVerifyCmd(domain, { ...opts, json: program.opts().json }),
  );
  domainOpts(
    domains.command("primary <domain>").description("Make the domain primary: the platform address becomes a 301 redirect to it."),
  ).action(async (domain: string, opts: any) =>
    domainsPrimaryCmd(domain, { ...opts, json: program.opts().json }),
  );
  domainOpts(
    domains
      .command("remove <domain>")
      .description("Remove the domain from the project. Irreversible and breaks live traffic; requires a token with the admin scope.")
      .option("-y, --yes", "do not ask for confirmation"),
  ).action(async (domain: string, opts: any) =>
    domainsRemoveCmd(domain, { ...opts, json: program.opts().json }),
  );

  program
    .command("diagnose")
    .description(
      "Explain why a deploy is in its current state: the cause in plain language, "
        + "the build log around the error, and the application's state. Without --deploy takes "
        + "the project's most recent deploy, whatever its status.",
    )
    .option("--project <id_or_slug>", "project (default: the one linked in .layero/project.json)")
    .option("--deploy <id>", "a specific deploy")
    .addHelpText("after", "\nExamples:\n  $ layero diagnose\n  $ layero diagnose --deploy 8da10ee6")
    .action(async (opts) => {
      await diagnoseCmd({ ...opts, json: program.opts().json });
    });

  program
    .command("logs")
    .description(
      "Show a deploy's logs: the build log (default) or the application log (--runtime).",
    )
    .option("--project <id_or_slug>", "project (default: the linked project)")
    .option("--deploy <id>", "a specific deploy")
    .option("--runtime", "the running application's logs instead of build logs")
    .option("--tail <n>", "how many recent application log lines to show (default 100)", (v) => Number(v))
    .addHelpText("after", "\nExamples:\n  $ layero logs\n  $ layero logs --runtime --tail 200")
    .action(async (opts) => {
      await logsCmd({ ...opts, json: program.opts().json });
    });

  program
    .command("link <id_or_slug>")
    .description("Link the current directory to an existing project.")
    .action(linkCmd);

  const token = program
    .command("token")
    .description("Manage the auth token directly (advanced).");
  token
    .command("create <name>")
    .description(
      "Issue a long-lived token for CI and agents. " +
        "It is shown ONCE. Default scopes: read+deploy, nothing irreversible.",
    )
    .option("--scope <list>", "comma-separated: read, deploy, admin")
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  $ layero token create ci                       # read+deploy\n" +
        "  $ layero token create ci --scope read          # read only\n" +
        "\nIn CI:  LAYERO_TOKEN=<token> npx layero@latest deploy",
    )
    .action(async (name: string, opts: any) =>
      tokenCreateCmd(name, { ...opts, json: program.opts().json }),
    );
  token
    .command("list")
    .description("Issued tokens: name, hint, scopes, last use.")
    .action(async () => tokenListCmd({ json: program.opts().json }));
  token
    .command("revoke <id>")
    .description("Revoke a token. Takes effect immediately.")
    .action(async (id: string) => tokenRevokeCmd(id, { json: program.opts().json }));
  token
    .command("set <jwt>")
    .description(
      "Save a token obtained elsewhere (for example, with `layero token create` on another machine).",
    )
    .action(tokenSetCmd);

  program
    .command("deploy")
    .description(
      "Pack the current directory and deploy it: the platform builds it and publishes it. " +
        "A project without a connected repository is published live — every deploy replaces the site at ready.url. " +
        "Framework, build command and output directory are detected by the platform; --dry-run shows the plan first.",
    )
    .option(
      "--dry-run",
      "show how the platform will build this folder (framework, build command, output folder, where each came from, " +
        "hints for monorepos / frontend+backend / custom build scripts) and exit; uploads nothing, needs no login",
    )
    .option(
      "-t, --type <preset>",
      "type override — static preset (vite | vitepress | next | astro | cra | sveltekit | nuxt | gatsby | docusaurus | storybook | eleventy | hugo | static | generic) " +
        "or runtime kind for apps the platform RUNS (node_web | python_web | flask | streamlit | gradio | ssr_next; aliases: express, fastapi, django, node, python). " +
        "`static` serves the files as they are and never runs a build; `generic` runs your own build command " +
        "(layero.json buildCommand or the package.json build script) and serves the folder with index.html",
    )
    .option("--name <name>", "project name (only used on first deploy)")
    .option("--project <id_or_slug>", "deploy into an existing project, ignoring local config")
    .option("-y, --yes", "non-interactive: accept defaults and skip the --prod confirmation")
    .option(
      "--config",
      "(legacy alias of the default behaviour — auto-detect + .layero/project.json values)",
    )
    .option(
      "--prebuilt [dir]",
      "ship an already-built artifact directory (default auto-pick: dist/build/public/out/_site/...)",
    )
    .option(
      "--root <dir>",
      "monorepo: the app's subfolder (e.g. apps/web) that the builder treats as the app root; the whole folder is still uploaded. " +
        "Saved on the project, so later deploys and git pushes use it too",
    )
    .option(
      "--prod",
      "only for a project WITH a connected repository: publish this upload at the live address. Without it such an upload " +
        "lands in the project's separate `cli` environment. A project without a repository is always published live",
    )
    .option(
      "--promote",
      "after a successful build, point the live address at this deploy (done by the CLI; same result as --prod). " +
        "Not needed for a project without a repository — it is published live anyway",
    )
    .option(
      "--branch <name>",
      "REFUSED (branch_unsupported, exit 4): archive uploads always land in the " +
        "reserved `cli` environment, so this flag cannot give you a preview. " +
        "Branch previews come from pushing to a connected repository.",
    )
    .option(
      "--claim",
      "deploy without an account: a temporary project for 72 hours plus a claim_url for a human to take it over. " +
        "Turns on by itself when there is no token, the run is non-interactive (agent, not CI), --yes is passed " +
        "and the project is new (no --project, folder not linked to an account project). " +
        "Refused together with --project (claim_with_project, exit 4).",
    )
    .option(
      "--org <slug>",
      "Layero organization slug for first-time project creation. Defaults to personal; required when you're a member of multiple orgs and want a non-personal home.",
    )
    // Осознанное подтверждение выкатки, когда предыдущие сборки подряд падают
    // с ОДНОЙ И ТОЙ ЖЕ ошибкой. Намеренно НЕ покрывается `--yes`: смысл стопа
    // в том, чтобы прервать автоматический цикл, а `--yes` в скриптах уже
    // стоит по умолчанию и снял бы стоп, ничего не остановив.
    .option(
      "--confirm-repeated-failure",
      "proceed even though recent deploys keep failing with the SAME error (the platform stops repeat deploys until you confirm you know what changed)",
    )
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  $ layero deploy --dry-run            # how the platform will build this folder; nothing is uploaded\n" +
        "  $ layero deploy                      # build and publish (no repository: replaces the live site)\n" +
        "  $ layero deploy --root apps/web      # monorepo: the app lives in a subfolder\n" +
        "  $ layero deploy --type generic       # own build script, no known framework: run it, serve the result\n" +
        "  $ layero deploy --type express       # Node backend: platform RUNS it, not serves files\n" +
        "  $ layero deploy --claim              # no account: temporary site + claim link\n" +
        "  $ layero deploy --prod --yes         # project with a connected repository: publish this upload live (CI)\n" +
        "  $ layero deploy --json               # machine-readable output for agents\n" +
        "\nIsolated previews come only from pushing a branch of a connected repository (layero projects create --repo).",
    )
    .action(async (opts) => {
      await deployCmd(opts);
    });

  await program.parseAsync(process.argv);
  // AFTER the command, so the nag never delays real work — and on stderr, so
  // `--json` stdout stays parseable. Bounded + never-throwing by construction.
  await notifyIfOutdated(VERSION);
}

/**
 * Ответы API, которые означают НОРМАЛЬНОЕ состояние аккаунта, а не поломку.
 *
 * До 02.08.2026 их не разбирал никто, и они доезжали до пользователя как
 * `code: "internal"` с советом «сообщите о баге»:
 *
 *   Error: internal
 *     API GET /auth/me → 401: {"detail":"Invalid token"}
 *     → re-run with --debug for a stack trace, or report at …/contacts/
 *
 * 401 здесь — не редкость, а расписание: TTL токена 168 часов, то есть КАЖДЫЙ
 * пользователь CLI упирается в это раз в неделю. На момент проверки токен был
 * протухшим у 66 из 115 человек, деплоивших через CLI за месяц. Ни один из них
 * не получил единственную нужную подсказку — «выполните layero login».
 *
 * 402 — лимит тарифа (например, `max_projects` на free). Тоже обычное дело, а
 * не сбой платформы: чинится сменой тарифа или удалением проекта, и текст
 * ошибки обязан говорить именно это.
 */
function asAccountStateError(err: unknown): LayeroError | null {
  if (!(err instanceof ApiError)) return null;

  if (err.status === 401) {
    return new LayeroError(
      "auth_expired",
      "Вход больше не действует — токен протух или сессия отозвана.",
      "выполните `layero login`",
    );
  }

  if (err.status === 402) {
    let detail: { feature?: string; limit?: number; observed?: number } = {};
    try {
      const parsed = JSON.parse(err.body) as { detail?: typeof detail };
      detail = parsed.detail ?? {};
    } catch {
      /* тело не JSON — обойдёмся общим текстом */
    }
    const limits: Record<string, string> = {
      max_projects: "проектов",
      custom_domains: "своих доменов",
      team_orgs: "командных организаций",
    };
    const what = detail.feature ? limits[detail.feature] ?? detail.feature : null;
    const counts =
      typeof detail.limit === "number" && typeof detail.observed === "number"
        ? ` (${detail.observed} при лимите ${detail.limit})`
        : "";
    return new LayeroError(
      "plan_limit",
      what
        ? `Тариф не позволяет больше ${what}${counts}.`
        : "Действие недоступно на текущем тарифе.",
      "смените тариф на app.layero.ru/billing или освободите место, удалив ненужное",
    );
  }

  // 🚨 Понятный отказ сервера не имеет права превращаться в нашу поломку.
  // 409 с `reason: reserved` и текстом «имя зарезервировано платформой»
  // печатался как `code: internal` с советом «re-run with --debug for a stack
  // trace» — человек шёл искать стек вместо того, чтобы сменить имя.
  //
  // Разбираем ЛЮБОЙ 4xx с телом, а не отдельные коды: заплатка на один код
  // означала бы, что следующий понятный отказ снова станет «внутренней
  // ошибкой». 5xx сюда не попадает намеренно — это как раз наша авария.
  if (err.status >= 400 && err.status < 500) {
    const detail = detailOf(err.body);
    if (detail) {
      return new LayeroError(
        detail.code ?? `http_${err.status}`,
        detail.message,
        detail.next_action ?? "исправьте запрос и повторите",
      );
    }
  }

  return null;
}

/**
 * Достаёт человеческую часть отказа из тела ответа.
 *
 * FastAPI кладёт её в `detail` — либо строкой, либо объектом с `code`,
 * `reason` и `message`. Обе формы живые, и обе должны доезжать до человека.
 */
function detailOf(
  body: string,
): { code?: string; message: string; next_action?: string } | null {
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const detail = parsed?.detail ?? parsed;
  if (typeof detail === "string" && detail.trim()) return { message: detail };
  if (detail && typeof detail === "object") {
    const message = detail.message ?? detail.detail ?? detail.reason;
    if (typeof message === "string" && message.trim()) {
      return {
        code: typeof detail.code === "string" ? detail.code : undefined,
        message,
        next_action: typeof detail.next_action === "string" ? detail.next_action : undefined,
      };
    }
  }
  return null;
}

main().catch((err) => {
  err = asAccountStateError(err) ?? err;
  const mode = detectMode();
  // `--debug` (real global flag) prints the full stack trace for any error,
  // structured or not, so the next_action hint that mentions it is honest.
  const debug = process.argv.includes("--debug") || process.env.LAYERO_DEBUG === "1";
  if (debug && err instanceof Error && err.stack) {
    console.error(chalk.dim(err.stack));
  }
  // Класс выхода — по коду ошибки (`exit-codes.ts`): 2 вход, 3 не найдено,
  // 4 неверный ввод, 5 удалённая ошибка, 1 прочее.
  let exitCode = 1;
  if (err instanceof LayeroError) {
    exitCode = exitCodeFor(err.code);
    emit({
      event: "error",
      code: err.code,
      next_action: err.next_action,
      message: err.message,
    });
  } else {
    exitCode = exitCodeFor("internal");
    // Anything else (network error, unexpected exception) — still emit
    // a structured error so agents have a consistent format to parse.
    const message = err?.message ?? String(err);
    if (mode.json) {
      emit({
        event: "error",
        code: "internal",
        next_action: debug
          ? "report at https://docs.layero.ru/contacts/"
          : "re-run with --debug for a stack trace, or report at https://docs.layero.ru/contacts/",
        message,
      });
    } else {
      console.error(chalk.red(message));
      if (!debug) {
        console.error(chalk.dim("  (re-run with --debug for a stack trace)"));
      }
    }
  }
  process.exit(exitCode);
});
