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
import { promoteCmd } from "../commands/promote.js";
import { hooksCreateCmd, hooksDeleteCmd, hooksListCmd } from "../commands/hooks.js";
import { loginCmd } from "../commands/login.js";
import { orgsListCmd } from "../commands/orgs.js";
import { initCmd } from "../commands/init.js";
import { diagnoseCmd, logsCmd } from "../commands/diagnose.js";
import { perfCheckCmd, perfShowCmd } from "../commands/perf.js";
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
import { notifyIfOutdated } from "../update-notifier.js";

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
    .option("--json", "emit machine-readable JSON-lines on stdout (for agents and CI)")
    .option("--debug", "print a full stack trace when a command errors");

  program
    .command("login")
    .description(
      "Authenticate via browser (GitHub / Yandex). Opens a one-time URL — no localhost server required.",
    )
    .addHelpText("after", "\nExamples:\n  $ layero login\n  $ npx layero login")
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
    .command("init")
    .description(
      "Scaffold .layero/project.json from the auto-detected framework, and write a Layero deployment block into your agent-instructions file so future chat sessions know how to deploy. Updates whichever of AGENTS.md / CLAUDE.md / .cursorrules already exist; if none do, creates AGENTS.md.",
    )
    .option("-y, --yes", "non-interactive: accept all defaults")
    .option("--skip-agent-docs", "do not touch AGENTS.md / CLAUDE.md / .cursorrules")
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

  const hooks = program
    .command("hooks")
    .description(
      "Manage deploy hooks — URL tokens that trigger builds from CMS / cron / external CI.",
    );
  hooks
    .command("list")
    .description("List deploy hooks for the linked project.")
    .option("--project <id>", "target project id (default: linked .layero/project.json)")
    .action(async (opts) => {
      try {
        await hooksListCmd(opts);
      } catch (err) {
        console.error(String((err as Error)?.message ?? err));
        process.exitCode = 1;
      }
    });
  hooks
    .command("create <name>")
    .description(
      "Create a new deploy hook. Prints a URL — paste it into Strapi / Sanity / "
        + "Contentful / GitHub Actions / cron as a POST webhook.",
    )
    .option("--project <id>", "target project id (default: linked .layero/project.json)")
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
      try {
        await hooksCreateCmd(name, opts);
      } catch (err) {
        console.error(String((err as Error)?.message ?? err));
        process.exitCode = 1;
      }
    });
  hooks
    .command("delete <id>")
    .description("Revoke a deploy hook. The URL stops working immediately.")
    .option("--project <id>", "target project id (default: linked .layero/project.json)")
    .action(async (id: string, opts) => {
      try {
        await hooksDeleteCmd(id, opts);
      } catch (err) {
        console.error(String((err as Error)?.message ?? err));
        process.exitCode = 1;
      }
    });

  program
    .command("promote [deploy]")
    .description(
      "Pin the project apex to a specific deploy (V071 production-pointer). " +
        "Without [deploy] picks the latest ready build on --branch (defaults to the 'cli' pseudo-branch).",
    )
    .option("--project <id_or_slug>", "target project (default: linked .layero/project.json)")
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

  const env = program
    .command("env")
    .description("Переменные окружения проекта. Значения не показываются — платформа их не отдаёт.");
  const envProject = (c: any) =>
    c.option("--project <id_or_slug>", "проект (по умолчанию — залинкованный)");
  envProject(env.command("list").description("Имена переменных и длина значений."))
    .action(async (opts: any) => envListCmd({ ...opts, json: program.opts().json }));
  envProject(
    env
      .command("set <pairs...>")
      .description("Задать переменные: KEY=value. Остальные остаются нетронутыми."),
  ).action(async (pairs: string[], opts: any) =>
    envSetCmd(pairs, { ...opts, json: program.opts().json }),
  );
  envProject(
    env
      .command("unset <keys...>")
      .description("Удалить переменные.")
      .option("-y, --yes", "не спрашивать подтверждение"),
  ).action(async (keys: string[], opts: any) =>
    envUnsetCmd(keys, { ...opts, json: program.opts().json }),
  );

  const analytics = program
    .command("analytics")
    .description("Яндекс.Метрика: подключение и статистика сайта.");
  const withProject = (c: any) =>
    c.option("--project <id_or_slug>", "проект (по умолчанию — залинкованный)");
  withProject(analytics.command("status").description("Подключена ли Метрика и к какой ветке."))
    .action(async (opts: any) => analyticsStatusCmd({ ...opts, json: program.opts().json }));
  withProject(
    analytics
      .command("connect")
      .description("Подключить Метрику. Печатает ссылку — открыть её и разрешить доступ должен человек.")
      .option("--branch <name>", "ветка, чей адрес получит счётчик (по умолчанию основная)"),
  ).action(async (opts: any) => analyticsConnectCmd({ ...opts, json: program.opts().json }));
  withProject(
    analytics
      .command("stats")
      .description("Посещаемость: итоги, тренд и топ источников/устройств/страниц.")
      .option("--period <7d|30d|90d>", "период (по умолчанию 7d)"),
  ).action(async (opts: any) => analyticsStatsCmd({ ...opts, json: program.opts().json }));
  withProject(
    analytics
      .command("disconnect")
      .description("Отключить Метрику от проекта.")
      .option("-y, --yes", "не спрашивать подтверждение"),
  ).action(async (opts: any) => analyticsDisconnectCmd({ ...opts, json: program.opts().json }));

  const perf = program
    .command("perf")
    .description("Замер производительности сайта со сравнением с предыдущим деплоем.");
  perf
    .command("check")
    .description("Запустить замер активного деплоя. Прогон асинхронный — с --wait команда дождётся результата.")
    .option("--project <id_or_slug>", "проект (по умолчанию — залинкованный)")
    .option("--wait", "дождаться результата (до 4 минут)")
    .action(async (opts) => perfCheckCmd({ ...opts, json: program.opts().json }));
  perf
    .command("show")
    .description("Показать последний замер и сравнение с предыдущим деплоем.")
    .option("--project <id_or_slug>", "проект (по умолчанию — залинкованный)")
    .action(async (opts) => perfShowCmd({ ...opts, json: program.opts().json }));

  const domains = program
    .command("domains")
    .description("Свои домены проекта: привязать, проверить DNS, сделать основным, снять.");
  const domainOpts = (c: any) =>
    c.option("--project <id_or_slug>", "проект (по умолчанию — залинкованный)");
  domainOpts(domains.command("list").description("Показать домены проекта."))
    .action(async (opts: any) => domainsListCmd({ ...opts, json: program.opts().json }));
  domainOpts(
    domains
      .command("add <domain>")
      .description(
        "Привязать домен. Печатает DNS-записи, которые нужно вписать у регистратора; "
          + "готовности НЕ ждёт — распространение DNS занимает от минут до часа.",
      ),
  ).action(async (domain: string, opts: any) =>
    domainsAddCmd(domain, { ...opts, json: program.opts().json }),
  );
  domainOpts(
    domains.command("verify <domain>").description("Проверить DNS сейчас, не дожидаясь фоновой перепроверки."),
  ).action(async (domain: string, opts: any) =>
    domainsVerifyCmd(domain, { ...opts, json: program.opts().json }),
  );
  domainOpts(
    domains.command("primary <domain>").description("Сделать домен основным: платформенный адрес станет 301-редиректом на него."),
  ).action(async (domain: string, opts: any) =>
    domainsPrimaryCmd(domain, { ...opts, json: program.opts().json }),
  );
  domainOpts(
    domains
      .command("remove <domain>")
      .description("Снять домен с проекта. Необратимо и рвёт живой трафик; требует токена со scope admin.")
      .option("-y, --yes", "не спрашивать подтверждение"),
  ).action(async (domain: string, opts: any) =>
    domainsRemoveCmd(domain, { ...opts, json: program.opts().json }),
  );

  program
    .command("diagnose")
    .description(
      "Разобрать, почему деплой в таком состоянии: причина человеческим языком, "
        + "окрестность ошибки в логе сборки и состояние приложения. Без --deploy берёт "
        + "последний неуспешный деплой проекта.",
    )
    .option("--project <id_or_slug>", "проект (по умолчанию — залинкованный в .layero/project.json)")
    .option("--deploy <id>", "конкретный деплой")
    .addHelpText("after", "\nПримеры:\n  $ layero diagnose\n  $ layero diagnose --deploy 8da10ee6")
    .action(async (opts) => {
      await diagnoseCmd({ ...opts, json: program.opts().json });
    });

  program
    .command("logs")
    .description(
      "Показать логи деплоя: сборки (по умолчанию) или приложения (--runtime).",
    )
    .option("--project <id_or_slug>", "проект (по умолчанию — залинкованный)")
    .option("--deploy <id>", "конкретный деплой")
    .option("--runtime", "логи запущенного приложения вместо логов сборки")
    .option("--tail <n>", "сколько последних строк приложения (по умолчанию 100)", (v) => Number(v))
    .addHelpText("after", "\nПримеры:\n  $ layero logs\n  $ layero logs --runtime --tail 200")
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
      "framework override (vite | vitepress | next | astro | cra | sveltekit | nuxt | gatsby | docusaurus | storybook | eleventy | hugo | static)",
    )
    .option("--name <name>", "project name (only used on first deploy)")
    .option("--project <id_or_slug>", "deploy into an existing project, ignoring local config")
    .option("-y, --yes", "non-interactive: accept defaults and skip --prod confirmation")
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
      "monorepo: subdirectory inside the repo that the builder treats as the app root (saved on the project; future GitHub-push and hook triggers use the same value)",
    )
    .option(
      "--prod",
      "deploy to production (replaces apex_hostname's active deploy). Without this flag, deploys go to the project's CLI preview pseudo-branch.",
    )
    .option(
      "--promote",
      "pin the project apex to this deploy after a successful build (V071). Works for any branch — e.g. `--promote` without --prod publishes a CLI preview straight to production.",
    )
    .option(
      "--branch <name>",
      "ACCEPTED BUT IGNORED for direct uploads: the backend files every " +
        "archive deploy under the reserved `cli` environment. Branch " +
        "environments come from pushes to a connected repository, not from " +
        "this flag. Kept for backwards compatibility.",
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
        "  $ layero deploy --promote            # preview deploy + pin apex (one-shot publish)\n" +
        "  $ layero deploy --branch=staging     # preview on a specific branch\n" +
        "  $ layero deploy --type vite          # force a framework preset\n" +
        "  $ layero deploy --json               # machine-readable output for agents",
    )
    .action(async (opts) => {
      await deployCmd(opts);
    });

  await program.parseAsync(process.argv);
  // AFTER the command, so the nag never delays real work — and on stderr, so
  // `--json` stdout stays parseable. Bounded + never-throwing by construction.
  await notifyIfOutdated(VERSION);
}

main().catch((err) => {
  const mode = detectMode();
  // `--debug` (real global flag) prints the full stack trace for any error,
  // structured or not, so the next_action hint that mentions it is honest.
  const debug = process.argv.includes("--debug") || process.env.LAYERO_DEBUG === "1";
  if (debug && err instanceof Error && err.stack) {
    console.error(chalk.dim(err.stack));
  }
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
  process.exit(1);
});
