// `layero db` — базы организации из терминала (DX-03).
//
// 🚨 Зачем команда вообще. Продукт обещает «весь бэкенд — это база», но завести
// базу можно было только в панели или сырой ручкой `POST /organizations/<org>/
// databases`: у CLI существовала одна команда `data env`, показывающая ключ УЖЕ
// существующей базы. Сборка приложения из терминала упиралась в переход в
// браузер, а агент в CI — в чтение исходников платформы ради адреса ручки.
//
// ⚠️ Организация выбирается явно (`--org`) или единственная доступная. Угадывать
// «первую попавшуюся» из нескольких нельзя: базы стоят денег и живут в разных
// командах.
import chalk from "chalk";
import { ApiClient, DatabaseSummary } from "../api.js";
import { loadConfig } from "../config.js";
import { loadProjectConfig } from "../project-config.js";
import { LayeroError, detectMode, emit } from "../agent.js";

interface DbOptions {
  org?: string;
  json?: boolean;
  project?: string;
  gb?: number;
  /** `--empty`: не накатывать стартовое наполнение. */
  empty?: boolean;
  command?: string;
}

async function orgOf(api: ApiClient, opts: DbOptions): Promise<string> {
  if (opts.org) return opts.org;
  const orgs = await api.listOrganizations();
  if (orgs.length === 1) return orgs[0]!.slug;
  const own = orgs.filter((o) => o.kind === "personal");
  if (own.length === 1) return own[0]!.slug;
  throw new LayeroError(
    "org_unknown",
    `у вас несколько организаций: ${orgs.map((o) => o.slug).join(", ")}`,
    "укажите нужную: --org <slug>",
  );
}

/** База по имени, слагу или id — как её назвал человек. */
async function pick(api: ApiClient, org: string, ref: string): Promise<DatabaseSummary> {
  const list = await api.listDatabases(org);
  const needle = ref.trim().toLowerCase();
  const found = list.find(
    (d) =>
      d.id === ref ||
      (d.name_slug ?? "").toLowerCase() === needle ||
      d.name.toLowerCase() === needle,
  );
  if (!found) {
    throw new LayeroError(
      "database_unknown",
      `в организации «${org}» нет базы «${ref}»`,
      list.length
        ? `есть: ${list.map((d) => d.name_slug ?? d.name).join(", ")}`
        : "заведите базу: layero db create <имя>",
    );
  }
  return found;
}

function gb(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}

export async function dbListCmd(opts: DbOptions): Promise<void> {
  const mode = detectMode();
  const api = new ApiClient(await loadConfig());
  const org = await orgOf(api, opts);
  const list = await api.listDatabases(org);

  if (mode.json || opts.json) {
    emit({ event: "databases", org, databases: list });
    return;
  }
  if (!list.length) {
    console.log(chalk.dim(`в организации «${org}» баз нет — layero db create <имя>`));
    return;
  }
  for (const d of list) {
    const api_on = d.api_enabled ? chalk.green("API") : chalk.dim("без API");
    console.log(
      `${chalk.bold(d.name)}  ${chalk.dim(d.name_slug ?? "")}  ${d.status}  ` +
        `${api_on}  проектов: ${d.projects_count}  ${gb(d.size_bytes)} из ${gb(d.quota_bytes)}`,
    );
  }
}

/** Ждёт, пока база станет рабочей. `false` — не дождались за отведённое время.
 *
 * Опрос, а не подписка: ручки событий у нас нет, а держать соединение ради
 * одной строки состояния незачем. Потолок ожидания — своё число, а не «пока
 * не надоест»: выделенный кластер поднимается 7–13 минут, и повесить терминал
 * на всё это время нельзя. Не дождались — говорим об этом прямо.
 */
async function waitUntilReady(
  api: ApiClient,
  org: string,
  name: string,
  timeoutMs = 90_000,
): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const all = await api.listDatabases(org);
      const mine = all.find((d) => d.name === name);
      if (mine && mine.status === "active") return true;
      if (mine && mine.status === "failed") return false;
    } catch {
      // Сеть моргнула — это не повод объявлять базу несозданной.
    }
  }
  return false;
}


export async function dbCreateCmd(name: string, opts: DbOptions): Promise<void> {
  const mode = detectMode();
  const api = new ApiClient(await loadConfig());
  const org = await orgOf(api, opts);
  const created = await api.createDatabase(org, {
    name,
    quota_gb: opts.gb,
    // `--empty` — отказ от стартового наполнения. Сервер накатывает его по
    // умолчанию, и без этого флага у CLI не было способа сказать «не надо»:
    // человек, приносящий свою схему, получал чужие таблицы молча.
    preset: !opts.empty,
  });

  // Пароль отдаётся ОДИН РАЗ — второй раз его не покажет никто, только
  // ротация. Поэтому он и в JSON-режиме, и в терминале.
  if (mode.json || opts.json) {
    emit({ event: "database_created", org, name, ...created });
    return;
  }
  // 🚨 БАЗА ЕЩЁ НЕ ГОТОВА В ЭТОТ МОМЕНТ. Ручка стала асинхронной: она пишет
  // намерение и возвращается, подготовка идёт минуты. Печатать «заведена» и
  // строку подключения сразу значит отправить человека к `psql`, который
  // ответит «database does not exist», — и он пойдёт искать причину в пароле.
  process.stdout.write(`${chalk.dim("…")} готовим базу «${name}» в организации ${org}`);
  const ready = await waitUntilReady(api, org, name);
  process.stdout.write("\r\u001b[2K");
  if (ready) {
    console.log(`${chalk.green("✓")} база «${name}» готова в организации ${org}`);
  } else {
    console.log(
      `${chalk.yellow("!")} база «${name}» ещё готовится — строка подключения ниже ` +
        "заработает, как только она поднимется",
    );
  }
  console.log(`\n  ${created.connection_string}`);
  console.log(
    chalk.dim(
      "\n  Пароль показывается один раз — сохраните строку подключения.\n" +
        "  Ключи Data API для фронтенда: layero data env",
    ),
  );
}

export async function dbConnectCmd(ref: string, opts: DbOptions): Promise<void> {
  const mode = detectMode();
  const api = new ApiClient(await loadConfig());
  const org = await orgOf(api, opts);
  const linked = await loadProjectConfig(process.cwd());
  const projectRef = opts.project ?? linked?.project_id;
  if (!projectRef) {
    throw new LayeroError(
      "project_unknown",
      "не понятно, какой проект подключать к базе",
      "запустите из каталога проекта или передайте --project <id|slug>",
    );
  }
  const project = await api.getProject(projectRef);
  const db = await pick(api, org, ref);
  await api.connectDatabaseToProject(org, db.id, project.id);

  if (mode.json || opts.json) {
    emit({ event: "database_connected", org, database: db.name, project: project.slug });
    return;
  }
  console.log(
    `${chalk.green("✓")} проект «${project.slug}» подключён к базе «${db.name}»\n` +
      chalk.dim("  строка подключения приедет в переменные окружения проекта"),
  );
}

export async function dbSqlCmd(ref: string, opts: DbOptions): Promise<void> {
  const mode = detectMode();
  const sql = (opts.command ?? "").trim();
  if (!sql) {
    throw new LayeroError("sql_missing", "нечего выполнять", 'передайте запрос: -c "SELECT 1"');
  }
  const api = new ApiClient(await loadConfig());
  const org = await orgOf(api, opts);
  const db = await pick(api, org, ref);
  const result = await api.queryDatabase(org, db.id, sql);

  if (mode.json || opts.json) {
    emit({ event: "query_result", database: db.name, ...result });
    return;
  }
  // Скрипт из нескольких операторов отвечает по каждому — показываем все,
  // иначе миграция из десяти команд выглядит как «ничего не выполнилось».
  if (result.statements?.length) {
    for (const [i, one] of result.statements.entries()) {
      console.log(chalk.dim(`${i + 1}. ${one.sql.split("\n")[0]}`) + `  ${one.status ?? ""}`);
    }
  }
  if (result.columns.length) {
    console.log(chalk.bold(result.columns.join("\t")));
    for (const row of result.rows) console.log(row.map((c) => String(c ?? "")).join("\t"));
    console.log(chalk.dim(`\n${result.row_count} строк${result.truncated ? " (усечено)" : ""}`));
  } else if (!result.statements?.length) {
    console.log(result.status ?? "выполнено");
  }
}
