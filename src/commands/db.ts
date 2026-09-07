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
import { dashboardOrigin } from "../urls.js";
import { loadConfig } from "../config.js";
import { loadProjectConfig } from "../project-config.js";
import { LayeroError, detectMode, emit } from "../agent.js";

interface DbOptions {
  org?: string;
  json?: boolean;
  project?: string;
  gb?: number;
  command?: string;
  /** Флаги платного заказа. Существуют РАДИ ОТКАЗА, а не ради работы — см.
   *  `dbCreateCmd`. */
  cpu?: number;
  ram?: number;
  dedicated?: boolean;
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

/**
 * Что сказать про деньги у этой базы. Пусто — платить не за что.
 *
 * 🚨 КАЖДОМУ СОСТОЯНИЮ СВОЯ ФРАЗА, И ЭТО НЕ УКРАШЕНИЕ. У базы с закрытым
 * доступом «спишем 3 октября» — неправда: списывать уже пробовали и не вышло.
 * Одна строка на все состояния была бы верной ровно в одном из них.
 *
 * Даты приходят от сервера уже посчитанными: правила лестницы живут там, и
 * вторая их реализация в CLI разошлась бы с панелью молча.
 */
export function billingLine(d: DatabaseSummary): string | null {
  const b = d.billing;
  if (!b) return null;
  const rub = (b.price_month_kopecks / 100).toLocaleString("ru-RU");
  const when = (iso?: string | null) =>
    iso ? new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) : null;

  if (b.status === "suspended") {
    const gone = when(b.terminate_at);
    return chalk.red(
      gone
        ? `${rub} ₽/мес · доступ закрыт за неоплату, удалим ${gone}`
        : `${rub} ₽/мес · доступ закрыт за неоплату`,
    );
  }
  if (b.status === "past_due") {
    const till = when(b.paid_until);
    return chalk.yellow(
      till
        ? `${rub} ₽/мес · оплата не прошла, работает по ${till}`
        : `${rub} ₽/мес · оплата не прошла`,
    );
  }
  const next = when(b.next_charge_at);
  if (next) return chalk.dim(`${rub} ₽/мес · спишем ${next}`);
  const till = when(b.paid_until);
  return chalk.dim(till ? `${rub} ₽/мес · оплачено по ${till}` : `${rub} ₽/мес`);
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
    // 🚨 РАЗМЕЩЕНИЕ И ВЕРСИЯ — В СТРОКЕ, А НЕ ТОЛЬКО В `--json`. Их не было
    // вовсе: по выводу нельзя было отличить базу из тарифа от выделенного
    // инстанса за 7750 ₽ в месяц и узнать, какой там Postgres. Панель обе
    // вещи показывает, а приёмка (C2) спрашивает именно их.
    const place =
      d.placement === "dedicated"
        ? "выделенный"
        : d.placement === "external"
          ? "свой сервер"
          : "Shared";
    const version = d.pg_version ? `PG${d.pg_version}` : chalk.dim("PG—");
    console.log(
      `${chalk.bold(d.name)}  ${chalk.dim(d.name_slug ?? "")}  ${d.status}  ` +
        `${place}  ${version}  ` +
        `${api_on}  проектов: ${d.projects_count}  ${gb(d.size_bytes)} из ${gb(d.quota_bytes)}`,
    );
    // 🚨 СРОК ОПЛАТЫ — ОТДЕЛЬНОЙ СТРОКОЙ, А НЕ ХВОСТОМ ПЕРВОЙ. Строка и так
    // на пределе ширины терминала, а это единственное, что решает, будет база
    // работать через неделю. Хвост, уезжающий за край, — то же молчание.
    const money = billingLine(d);
    if (money) console.log(`  ${money}`);
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
  // 🚨 `--gb` НЕ ДЕЛАЛ НИЧЕГО, И МОЛЧАНИЕ БЫЛО ХУЖЕ ОТКАЗА. Поле уезжало на
  // сервер, а тот его не читает ни одним путём создания: у Shared объём задаёт
  // тариф, у выделенного — диск ступени. Человек называл число, получал базу
  // другого размера и не знал почему (приёмка C9).
  if (opts.gb != null) {
    throw new LayeroError(
      "gb_not_supported",
      "объём базы так не выбирается",
      "у базы из тарифа объём задан тарифом, у выделенного инстанса — диском " +
        "ступени: закажите нужную ступень в панели",
    );
  }
  // 🚨 ПЛАТНЫЙ ЗАКАЗ ИЗ ТЕРМИНАЛА НЕВОЗМОЖЕН, И СКАЗАТЬ ОБ ЭТОМ НАДО СЛОВАМИ.
  // Дело не в лени: у заказа выделенного инстанса есть цена и заморозка денег
  // на карте. Карту в терминале не привяжешь, сумму подтвердить негде, а
  // «списали, потому что вы набрали команду» — не тот способ брать деньги.
  //
  // Отказ называет причину и ведёт туда, где заказ возможен. Молчаливое
  // создание Shared вместо выделенного было бы хуже отказа: человек получил бы
  // не то, что просил, и узнал бы об этом по нехватке мощности.
  const config = await loadConfig();
  if (opts.dedicated || opts.cpu != null || opts.ram != null) {
    throw new LayeroError(
      "dedicated_needs_panel",
      "выделенный инстанс из терминала не заказывается",
      "у него есть цена и заморозка денег на карте, а подтвердить сумму в " +
        "терминале негде. Закажите в панели: " +
        `${dashboardOrigin(config.apiUrl)}/databases?new=1 — там видны ` +
        "ступени, цена и дата следующего списания",
    );
  }
  const api = new ApiClient(config);
  const org = await orgOf(api, opts);
  const created = await api.createDatabase(org, {
    name,
    // 🚨 ФЛАГА «БЕЗ НАПОЛНЕНИЯ» БОЛЬШЕ НЕТ. Он существовал, пока пресет
    // заводил три таблицы с примерами: человек со своей схемой получал чужие
    // таблицы молча, и отказаться было нечем. Тестовых таблиц в пресете не
    // осталось — он настраивает роли, функцию состояния и умолчания прав,
    // и вычищать после него нечего. Значит и отказываться не от чего.
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

export async function dbDisconnectCmd(ref: string, opts: DbOptions): Promise<void> {
  // 🚨 ОБРАТНОГО ДЕЙСТВИЯ НЕ БЫЛО ВОВСЕ. `db connect` существовал с самого
  // начала, а отвязать проект от базы можно было только в панели — при том
  // что подсказка `env list` прямо звала сделать это командой. Приёмка (A7.6)
  // спрашивает именно её.
  const mode = detectMode();
  const api = new ApiClient(await loadConfig());
  const org = await orgOf(api, opts);
  const linked = await loadProjectConfig(process.cwd());
  const projectRef = opts.project ?? linked?.project_id;
  if (!projectRef) {
    throw new LayeroError(
      "project_unknown",
      "не понятно, какой проект отвязывать от базы",
      "запустите из каталога проекта или передайте --project <id|slug>",
    );
  }
  const project = await api.getProject(projectRef);
  const db = await pick(api, org, ref);
  await api.disconnectDatabaseFromProject(org, db.id, project.id);

  if (mode.json || opts.json) {
    emit({ event: "database_disconnected", org, database: db.name, project: project.slug });
    return;
  }
  console.log(
    `${chalk.green("✓")} проект «${project.slug}» отвязан от базы «${db.name}»\n` +
      chalk.dim("  переменная уйдёт из окружения следующим деплоем, роль проекта удалена"),
  );
}

export async function dbSqlCmd(ref: string, opts: DbOptions): Promise<void> {
  const mode = detectMode();
  const sql = (opts.command ?? "").trim();
  if (!sql) {
    throw new LayeroError(
      "sql_missing",
      "нечего выполнять",
      'передайте запрос следом за именем базы: layero db sql моя-база "select 1"',
    );
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
