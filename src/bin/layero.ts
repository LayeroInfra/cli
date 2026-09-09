#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { whoamiCmd } from "../commands/whoami.js";
import { logoutCmd } from "../commands/logout.js";
import { projectsListCmd } from "../commands/projects.js";
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
      "Вход через браузер (код из почты или Yandex ID): печатает одноразовый адрес и код.",
    )
    .option("--no-browser", "не открывать браузер — только напечатать адрес и код")
    .addHelpText(
      "after",
      "\nПримеры:\n" +
        "  $ layero login\n" +
        "  $ layero login --no-browser        # SSH, контейнер, среда агента\n" +
        "\nДля CI и агентов вход человеком не годится — нужен долгоживущий токен:\n" +
        "  $ layero token create ci\n" +
        "  $ LAYERO_TOKEN=<токен> npx layero@latest deploy",
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
      "Задать имя аккаунта — оно же адрес личной организации. " +
        "Без него платформе некуда положить проект. " +
        "В интерактивном терминале `login` и `deploy` спросят его сами; " +
        "эта команда нужна агентам и CI, где спрашивать некого.",
    )
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  $ layero username alice\n" +
        "  $ layero username my-team-bot\n\n" +
        "Строчные латинские буквы, цифры и дефис; 2–32 символа.",
    )
    .action(async (value: string) => {
      const cfg = await loadConfig();
      await usernameSetCmd(value, new ApiClient(cfg));
    });

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

  const data = program
    .command("data")
    .description("Data API: адрес и публичный ключ базы для фронтенда.");
  data
    .command("env")
    .description("Показать VITE_/NEXT_PUBLIC_ переменные Data API; --write кладёт их в .env.local.")
    .option("--project <id_or_slug>", "проект (по умолчанию — залинкованный)")
    .option("-w, --write", "записать в файл, а не печатать")
    .option("--file <path>", "имя файла (по умолчанию .env.local)")
    .addHelpText(
      "after",
      "\nПримеры:\n" +
        "  $ layero data env                       # посмотреть\n" +
        "  $ layero data env --write               # положить в .env.local\n" +
        "\nОтдаётся только ПУБЛИЧНЫЙ ключ — тот, что и так уезжает в бандл.\n" +
        "Секретный ключ платформа не хранит и не отдаёт: он для сервера.",
    )
    .action(async (opts: any) => dataEnvCmd({ ...opts, json: program.opts().json }));

  const db = program
    .command("db")
    .description("Базы организации: завести, посмотреть, подключить к проекту, выполнить SQL.");
  const withOrg = (c: any) => c.option("--org <slug>", "организация (по умолчанию единственная)");
  withOrg(db.command("list").description("Базы организации."))
    .action(async (opts: any) => dbListCmd({ ...opts, json: program.opts().json }));
  withOrg(
    db
      .command("create <name>")
      .description("Завести базу. Строка подключения печатается ОДИН раз.")
      // 🚨 ФЛАГ ОСТАВЛЕН РАДИ ЧЕСТНОГО ОТКАЗА, А НЕ РАДИ РАБОТЫ. Он обещал
      // «объём платной базы в гигабайтах» и не делал НИЧЕГО: сервер поле не
      // читает ни одним путём создания — у Shared объём задаёт тариф, у
      // выделенного диск ступени. Убрать его совсем значило бы отвечать
      // «неизвестный параметр» тому, кто им пользовался, и оставить человека
      // гадать, куда делся объём. Теперь команда говорит это словами (C9).
      .option("--gb <number>", "БОЛЬШЕ НЕ РАБОТАЕТ: объём задаёт тариф или ступень", (v: string) => parseInt(v, 10))
      // 🚨 ТЕ ЖЕ ФЛАГИ РАДИ ЧЕСТНОГО ОТКАЗА. Выделенный инстанс из терминала
      // не заказать, и это осознанно: у заказа есть цена и заморозка денег, а
      // карту в терминале не привяжешь и сумму подтвердить негде. Но человек,
      // прочитавший про ступени в панели, попробует `--cpu 2` — и без этих
      // флагов получит «неизвестный параметр», то есть ответ про синтаксис
      // вместо ответа про причину.
      .option("--cpu <number>", "выделенный инстанс: заказывается в панели", (v: string) => parseInt(v, 10))
      .option("--ram <mb>", "выделенный инстанс: заказывается в панели", (v: string) => parseInt(v, 10))
      .option("--dedicated", "выделенный инстанс: заказывается в панели"),
  ).action(async (name: string, opts: any) =>
    dbCreateCmd(name, { ...opts, json: program.opts().json }),
  );
  withOrg(
    db
      .command("connect <database>")
      .description("Подключить проект к базе: строка подключения приедет в его "
        + "переменные, а домены проекта станут разрешёнными для Data API.")
      .option("--project <id_or_slug>", "проект (по умолчанию — залинкованный)"),
  ).action(async (database: string, opts: any) =>
    dbConnectCmd(database, { ...opts, json: program.opts().json }),
  );
  withOrg(
    db
      .command("disconnect <database>")
      .description("Отвязать проект от базы: переменная уйдёт следующим деплоем, "
        + "роль проекта удалится, домены перестанут быть разрешёнными для Data API.")
      .option("--project <id_or_slug>", "проект (по умолчанию — залинкованный)"),
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
      .description("Выполнить SQL в базе. Скрипт из нескольких операторов — одной транзакцией.")
      .option("-c, --command <sql>", "запрос или скрипт"),
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
    .command("create <name>")
    .description(
      "Выпустить долгоживущий токен для CI и агентов. " +
        "Показывается ОДИН раз. По умолчанию read+deploy, без необратимого.",
    )
    .option("--scope <list>", "через запятую: read, deploy, admin")
    .addHelpText(
      "after",
      "\nПримеры:\n" +
        "  $ layero token create ci                       # read+deploy\n" +
        "  $ layero token create ci --scope read          # только чтение\n" +
        "\nВ CI:  LAYERO_TOKEN=<токен> npx layero@latest deploy",
    )
    .action(async (name: string, opts: any) =>
      tokenCreateCmd(name, { ...opts, json: program.opts().json }),
    );
  token
    .command("list")
    .description("Выпущенные токены: имя, подсказка, права, последнее использование.")
    .action(async () => tokenListCmd({ json: program.opts().json }));
  token
    .command("revoke <id>")
    .description("Отозвать токен. Действует немедленно.")
    .action(async (id: string) => tokenRevokeCmd(id, { json: program.opts().json }));
  token
    .command("set <jwt>")
    .description(
      "Сохранить токен, полученный иначе (например, `layero token create` на другой машине).",
    )
    .action(tokenSetCmd);

  program
    .command("deploy")
    .description(
      "Pack the current directory and deploy it. Framework, build command and output directory are auto-detected.",
    )
    .option(
      "-t, --type <preset>",
      "type override — static preset (vite | vitepress | next | astro | cra | sveltekit | nuxt | gatsby | docusaurus | storybook | eleventy | hugo | static) " +
        "or runtime kind for apps the platform RUNS (node_web | python_web | flask | streamlit | gradio | ssr_next; aliases: express, fastapi, django, node, python)",
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
        "  $ layero deploy                      # preview deploy (CLI pseudo-branch), auto-detect framework\n" +
        "  $ layero deploy --prod               # production deploy (interactive confirm)\n" +
        "  $ layero deploy --prod --yes         # production deploy, no prompt (CI)\n" +
        "  $ layero deploy --promote            # preview deploy + pin apex (one-shot publish)\n" +
        "  $ layero deploy --branch=staging     # preview on a specific branch\n" +
        "  $ layero deploy --type vite          # force a framework preset\n" +
        "  $ layero deploy --type express       # Node backend: platform RUNS it, not serves files\n" +
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
