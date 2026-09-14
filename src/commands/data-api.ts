// `layero data keys | origins | methods | grant | enable` — раздел «API» панели
// из терминала (T-20260911-9).
//
// 🚨 Зачем. У CLI по Data API была одна команда — `data env`. Выпустить ключ при
// заведении проекта, открыть таблицу посетителям, пустить домен сайта — всё это
// делалось только кнопками, то есть из скриптов и CI не делалось вовсе.
//
// 🚨 УРОВНИ ДОСТУПА СЧИТАЕТ СЕРВЕР. `data grant` не собирает SQL сам: команды
// приходят из той же ручки, что у панели (`userdb_api_levels`), и применяются
// со сверкой «выполняется ровно показанное». Своя сборка в CLI была бы ещё
// одной копией правил прав и расходилась бы с кнопкой молча.
//
// ⚠️ Без `--yes` вне терминала `data grant`, отзыв ключа и удаление сайта
// ничего не меняют и завершаются ОШИБКОЙ `confirmation_required`. Код 0 здесь
// значил бы зелёный CI-скрипт, который ничего не открыл (ревью 13.09).
import readline from "node:readline/promises";
import chalk from "chalk";
import type { Command } from "commander";
import { ApiClient, type DataApiKey, type DataApiLevelsPlan, type DatabaseSummary } from "../api.js";
import { loadConfig } from "../config.js";
import { LayeroError, detectMode, emit } from "../agent.js";
import { orgOf, pick } from "./db.js";

export interface DataApiOptions {
  org?: string;
  db?: string;
  json?: boolean;
  yes?: boolean;
  kind?: string;
  label?: string;
  expiresIn?: string;
  note?: string;
  withSecret?: boolean;
  repair?: boolean;
  get?: string;
  post?: string;
  patch?: string;
  delete?: string;
  call?: string;
}

const LEVELS = ["closed", "visitor", "user", "server"];

const LEVEL_WORD: Record<string, string> = {
  closed: "закрыто",
  visitor: "любой посетитель",
  user: "вошедшие",
  server: "только сервер",
};

const KEY_EXPIRY_DAYS = [30, 90, 365];

interface Target {
  api: ApiClient;
  org: string;
  db: DatabaseSummary;
  /** Как база называется в событиях и подсказках. */
  ref: string;
}

function asJson(opts: DataApiOptions): boolean {
  return detectMode().json || Boolean(opts.json);
}

/**
 * База, с которой работает команда.
 *
 * Без `--db` — единственная подходящая база организации: с включённым Data API
 * для работы с ним и без него — для `enable`. Из нескольких не угадываем: ключ,
 * выпущенный не той базе, выглядит рабочим до первого запроса сайта.
 */
async function target(opts: DataApiOptions, purpose: "api" | "enable" = "api"): Promise<Target> {
  const api = new ApiClient(await loadConfig());
  const org = await orgOf(api, opts);
  let db: DatabaseSummary;
  if (opts.db) {
    db = await pick(api, org, opts.db);
  } else {
    const list = await api.listDatabases(org);
    // Для включения — только базы Layero в работе: внешнюю и остановленную
    // сервер всё равно не включит, а «единственная подходящая» не должна
    // оказаться ею (ревью 13.09).
    const candidates = list.filter((d) =>
      purpose === "api"
        ? d.api_enabled
        : !d.api_enabled && d.status === "active" && d.placement !== "external" && d.provider !== "external",
    );
    if (candidates.length !== 1) {
      throw new LayeroError(
        "database_unknown",
        candidates.length
          ? "не понятно, с какой базой работать"
          : purpose === "api"
            ? `в организации «${org}» нет баз с включённым Data API`
            : `в организации «${org}» нет баз без Data API`,
        candidates.length
          ? `укажите --db: ${candidates.map((d) => d.name_slug ?? d.name).join(", ")}`
          : purpose === "api"
            ? "включите: layero data enable --db <база>"
            : "укажите базу явно: --db <база>",
      );
    }
    db = candidates[0]!;
  }
  if (purpose === "api" && !db.api_enabled) {
    throw new LayeroError(
      "data_api_disabled",
      `у базы «${db.name}» не включён Data API`,
      `включите: layero data enable --db ${db.name_slug ?? db.id}`,
    );
  }
  return { api, org, db, ref: db.name_slug ?? db.id };
}

/**
 * Согласие человека. `null` — спросить некого: не терминал или `--json`.
 *
 * В `--json` не спрашиваем даже в терминале: вопрос уехал бы в stdout и
 * сломал бы разбор событий.
 */
async function confirmed(question: string, opts: DataApiOptions): Promise<boolean | null> {
  if (opts.yes) return true;
  const mode = detectMode();
  if (!mode.interactive || asJson(opts)) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N]: `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Аргумент подсказки, которую копируют в shell.
 *
 * `api.pick(integer)` без кавычек zsh читает как шаблон имён файлов и отвечает
 * «no matches found», bash — синтаксической ошибкой (ревью 13.09).
 */
export function shellArg(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function _capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function day(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}

// ── ключи ───────────────────────────────────────────────────────────────────

/**
 * Строка списка ключей — поля перечислены поимённо.
 *
 * 🚨 Не `...row`: ответ сервера может однажды принести лишнее поле, и всё, что
 * напечатал CLI в агентском режиме, оседает в истории переписки.
 */
function keyRow(k: DataApiKey) {
  return {
    id: k.id,
    kind: (k.is_public ? "public" : "secret") as "public" | "secret",
    prefix: k.key_prefix,
    label: k.label ?? null,
    created_at: k.created_at ?? null,
    last_used_at: k.last_used_at ?? null,
    expires_at: k.expires_at ?? null,
    in_build: Boolean(k.in_build),
    service: Boolean(k.is_service),
  };
}

export async function dataKeysListCmd(opts: DataApiOptions): Promise<void> {
  const { api, org, db, ref } = await target(opts);
  const keys = (await api.listDataKeys(org, db.id)).map(keyRow);
  if (asJson(opts)) {
    emit({ event: "data_keys", org, database: ref, keys });
    return;
  }
  if (!keys.length) {
    console.log(chalk.dim(`у базы «${db.name}» нет ключей — layero data keys issue --db ${ref}`));
    return;
  }
  for (const k of keys) {
    const kind = k.kind === "public" ? "публичный" : chalk.yellow("секретный");
    const marks = [
      k.in_build ? chalk.green("в сборке") : "",
      k.service ? chalk.dim("служебный") : "",
    ].filter(Boolean);
    console.log(
      `${chalk.bold(`${k.prefix}…`)}  ${kind}  ${k.label ?? ""}  ${marks.join(" ")}\n` +
        chalk.dim(
          `  срок: ${k.expires_at ? `до ${day(k.expires_at)}` : "без срока"}` +
            `  ·  последний вызов: ${k.last_used_at ? day(k.last_used_at) : "не было"}` +
            `  ·  ${k.id}`,
        ),
    );
  }
}

export async function dataKeysIssueCmd(opts: DataApiOptions): Promise<void> {
  const kind = (opts.kind ?? "public").toLowerCase();
  if (kind !== "public" && kind !== "secret") {
    throw new LayeroError(
      "data_key_kind",
      `вид ключа «${opts.kind}» неизвестен`,
      "--kind public — для сайта, --kind secret — для сервера",
    );
  }
  let days: number | null = null;
  const expiry = String(opts.expiresIn ?? "never").trim().toLowerCase();
  if (expiry !== "never") {
    days = Number(expiry.replace(/d$/, ""));
    if (!KEY_EXPIRY_DAYS.includes(days)) {
      throw new LayeroError(
        "data_key_expiry",
        `срок ключа «${opts.expiresIn}» не поддерживается`,
        `--expires-in ${KEY_EXPIRY_DAYS.join(", ")} или never`,
      );
    }
  }
  const { api, org, db, ref } = await target(opts);
  const issued = await api.issueDataKey(org, db.id, {
    kind,
    label: opts.label ?? null,
    expires_in_days: days,
  });
  if (asJson(opts)) {
    emit({
      event: "data_key_issued",
      org,
      database: ref,
      id: issued.id,
      kind,
      prefix: issued.prefix,
      key: issued.key,
      expires_at: issued.expires_at ?? null,
    });
    return;
  }
  console.log(
    `${chalk.green("✓")} ${kind === "public" ? "публичный" : "секретный"} ключ базы «${db.name}»` +
      `${days ? ` на ${days} дней` : ""}\n\n  ${issued.key}\n`,
  );
  console.log(
    kind === "secret"
      ? chalk.yellow("  Сохраните его сейчас: секретный ключ платформа не хранит и больше не покажет.\n") +
          chalk.dim("  Он для сервера — в код сайта и в браузер его не кладут.")
      : chalk.dim("  Публичный ключ уезжает в сборку сайта и секретом не является."),
  );
}

export async function dataKeysRevokeCmd(id: string, opts: DataApiOptions): Promise<void> {
  const { api, org, db, ref } = await target(opts);
  const rows = await api.listDataKeys(org, db.id);
  const needle = id.replace(/…$/, "");
  const matches = rows.filter((k) => k.id === needle || k.key_prefix === needle);
  if (!matches.length) {
    throw new LayeroError(
      "data_key_unknown",
      `у базы «${db.name}» нет действующего ключа ${id}`,
      `список: layero data keys list --db ${ref}`,
    );
  }
  // В префиксе всего несколько случайных знаков: молча взять первый из двух
  // значило бы отозвать не тот ключ.
  if (matches.length > 1) {
    throw new LayeroError(
      "data_key_ambiguous",
      `префикс ${needle} есть у нескольких ключей базы «${db.name}»`,
      `укажите id: ${matches.map((k) => k.id).join(", ")}`,
    );
  }
  const key = matches[0]!;
  const what = `${key.is_public ? "публичный" : "секретный"} ключ ${key.key_prefix}…`;
  const warn = key.in_build ? " Он в сборке сайта: сайт перестанет получать данные." : "";
  const ok = await confirmed(`отозвать ${what}?${warn}`, opts);
  if (ok === null) {
    throw new LayeroError(
      "confirmation_required",
      `отзыв ключа ${key.key_prefix}… не подтверждён.${warn}`,
      `убедитесь, что им никто не пользуется, и повторите с --yes: layero data keys revoke ${id} --db ${ref} --yes`,
    );
  }
  if (!ok) {
    console.log(chalk.yellow("отменено."));
    return;
  }
  await api.revokeDataKey(org, db.id, key.id);
  if (asJson(opts)) {
    emit({ event: "data_key_revoked", org, database: ref, id: key.id });
    return;
  }
  console.log(`${chalk.green("✓")} ${what} отозван`);
}

// ── сайты ───────────────────────────────────────────────────────────────────

export async function dataOriginsListCmd(opts: DataApiOptions): Promise<void> {
  const { api, org, db, ref } = await target(opts);
  const res = await api.listDataOrigins(org, db.id);
  const origins = (res.origins ?? []).map((o) => ({ origin: o.origin, note: o.note ?? null }));
  const fromProjects = res.from_projects ?? [];
  const localhost = res.localhost_allowed !== false;
  if (asJson(opts)) {
    emit({
      event: "data_origins",
      org,
      database: ref,
      origins,
      from_projects: fromProjects,
      localhost_allowed: localhost,
    });
    return;
  }
  console.log(chalk.bold("Адреса подключённых проектов") + chalk.dim(" — пускаются сами"));
  if (fromProjects.length) for (const o of fromProjects) console.log(`  ${o}`);
  else console.log(chalk.dim("  нет — подключите проект: layero db connect <база>"));
  console.log(chalk.bold("\nДобавленные вручную"));
  if (origins.length) for (const o of origins) console.log(`  ${o.origin}${o.note ? chalk.dim(`  ${o.note}`) : ""}`);
  else console.log(chalk.dim(`  нет — добавить: layero data origins add https://example.ru --db ${ref}`));
  console.log(`\nlocalhost: ${localhost ? "пускается" : chalk.yellow("не пускается")}`);
}

export async function dataOriginsAddCmd(origin: string, opts: DataApiOptions): Promise<void> {
  const { api, org, db, ref } = await target(opts);
  await api.addDataOrigin(org, db.id, origin, opts.note ?? null);
  if (asJson(opts)) {
    emit({ event: "data_origin_added", org, database: ref, origin });
    return;
  }
  console.log(
    `${chalk.green("✓")} ${origin} может звать базу «${db.name}» из браузера\n` +
      chalk.dim("  данных это не открывает: что можно читать и писать, решают уровни — layero data methods"),
  );
}

export async function dataOriginsRemoveCmd(origin: string, opts: DataApiOptions): Promise<void> {
  const { api, org, db, ref } = await target(opts);
  const ok = await confirmed(`убрать ${origin}? Запросы с этого сайта начнут получать отказ`, opts);
  if (ok === null) {
    throw new LayeroError(
      "confirmation_required",
      `удаление ${origin} не подтверждено: запросы с этого сайта начнут получать отказ`,
      `повторите с --yes: layero data origins remove ${origin} --db ${ref} --yes`,
    );
  }
  if (!ok) {
    console.log(chalk.yellow("отменено."));
    return;
  }
  await api.removeDataOrigin(org, db.id, origin);
  if (asJson(opts)) {
    emit({ event: "data_origin_removed", org, database: ref, origin });
    return;
  }
  console.log(`${chalk.green("✓")} ${origin} убран`);
}

// ── методы и уровни ─────────────────────────────────────────────────────────

export async function dataMethodsCmd(opts: DataApiOptions): Promise<void> {
  const { api, org, db, ref } = await target(opts);
  const res = await api.listDataMethods(org, db.id);
  const warnings = res.warnings ?? [];
  if (asJson(opts)) {
    emit({ event: "data_methods", org, database: ref, warnings, tables: res.tables, functions: res.functions });
    return;
  }
  for (const w of warnings) console.log(chalk.yellow(`⚠ ${w}\n`));
  if (!res.tables.length && !res.functions.length) {
    console.log(chalk.dim(`в базе «${db.name}» нет таблиц и функций, которые отдаёт Data API`));
    return;
  }
  if (res.tables.length) console.log(chalk.bold("REST"));
  for (const t of res.tables) {
    const levels = Object.entries(t.levels)
      .map(([m, l]) => `${m} ${l === "closed" ? chalk.dim(LEVEL_WORD[l]) : LEVEL_WORD[l] ?? l}`)
      .join(" · ");
    const view = t.kind === "view" ? chalk.dim(" (представление)") : "";
    const profile = t.shadowed_by
      ? chalk.yellow(`  без заголовка Accept-Profile: ${t.schema} путь ведёт на ${t.shadowed_by}`)
      : "";
    console.log(`  ${t.schema}.${t.name}${view}  ${chalk.dim(t.path)}${profile}\n    ${levels}`);
  }
  if (res.functions.length) console.log(chalk.bold(`${res.tables.length ? "\n" : ""}RPC`));
  for (const f of res.functions) {
    // Причина «не метод» — по виду: процедура лежит в api, но шлюз её не вызывает.
    const where = chalk.dim(
      f.path ??
        (f.kind === "procedure"
          ? "не метод: процедуру шлюз не вызывает — только функции"
          : "не метод: шлюз зовёт функции только из схемы api"),
    );
    const pub = f.public_only ? chalk.yellow("  доступна всем по умолчанию Postgres — шлюз её не пустит") : "";
    const twin = f.overloaded
      ? chalk.yellow("  в схеме api есть одноимённая функция или процедура — шлюз ищет по имени и может вызвать другую")
      : "";
    console.log(`  ${f.signature}  ${where}\n    POST ${LEVEL_WORD[f.level] ?? f.level}${pub}${twin}`);
  }
}

function checkLevel(flag: string, value: string): string {
  const v = String(value).trim().toLowerCase();
  if (!LEVELS.includes(v)) {
    throw new LayeroError(
      "data_level_unknown",
      `уровень «${value}» у ${flag} неизвестен`,
      "closed — закрыто, visitor — любой посетитель, user — вошедшие, server — только сервер",
    );
  }
  return v;
}

function planLines(plan: DataApiLevelsPlan): string[] {
  const o = plan.object;
  const name = o.kind === "function" || o.kind === "procedure"
    ? `${o.schema}.${o.name}(${o.args ?? ""})`
    : `${o.schema}.${o.name}`;
  const out = [chalk.bold(name)];
  for (const [method, to] of Object.entries(plan.next)) {
    const from = plan.current[method];
    out.push(
      `  ${method.padEnd(6)} ${from === to ? LEVEL_WORD[to] : `${LEVEL_WORD[from ?? ""] ?? from} → ${chalk.bold(LEVEL_WORD[to] ?? to)}`}`,
    );
  }
  out.push(chalk.dim("\nSQL:"), ...plan.sql.map((s) => `  ${s}`));
  // Причины блокировки печатает сам отказ — здесь их не повторяем.
  const blocked = new Set(plan.blocked ?? []);
  for (const w of plan.warnings) if (!blocked.has(w)) out.push(chalk.yellow(`⚠ ${w}`));
  return out;
}

function planEvent(org: string, ref: string, plan: DataApiLevelsPlan, applied: boolean) {
  return {
    event: "data_grant" as const,
    org,
    database: ref,
    object: plan.object,
    current: plan.current,
    next: plan.next,
    sql: plan.sql,
    warnings: plan.warnings,
    blocked: plan.blocked ?? [],
    applied,
  };
}

export async function dataGrantCmd(object: string, opts: DataApiOptions): Promise<void> {
  const levels: Record<string, string> = {};
  for (const [flag, method] of [["get", "GET"], ["post", "POST"], ["patch", "PATCH"], ["delete", "DELETE"]] as const) {
    const value = opts[flag];
    if (value !== undefined) levels[method] = checkLevel(`--${flag}`, value);
  }
  const level = opts.call !== undefined ? checkLevel("--call", opts.call) : undefined;
  if (!Object.keys(levels).length && level === undefined) {
    throw new LayeroError(
      "data_levels_missing",
      "не задан ни один уровень",
      "таблица: --get visitor --post server …; функция: --call visitor",
    );
  }
  const { api, org, db, ref } = await target(opts);
  const request = {
    object,
    levels: Object.keys(levels).length ? levels : null,
    level: level ?? null,
  };
  const flags = [
    ...Object.entries(levels).map(([method, value]) => `--${method.toLowerCase()} ${value}`),
    ...(level ? [`--call ${level}`] : []),
  ].join(" ");
  const retry = `layero data grant ${shellArg(object)} --db ${shellArg(ref)} ${flags} --yes`;
  const plan = await api.setDataLevels(org, db.id, { ...request, apply: false });
  const json = asJson(opts);
  const blocked = plan.blocked ?? [];
  if (!json && (!opts.yes || blocked.length)) console.log(planLines(plan).join("\n"));

  // 🚨 БЛОКИРОВКУ СЕРВЕР ПРИМЕНИТЬ НЕ ДАСТ. Спрашивать «применить?» и слать
  // применение с `--yes` значило бы задать вопрос с известным ответом и получить
  // http_409 с подсказкой «исправьте запрос и повторите» (ревью 13.09).
  if (blocked.length) {
    if (json) emit(planEvent(org, ref, plan, false));
    throw new LayeroError(
      "data_levels_blocked",
      `уровень доступа нельзя применить: ${blocked.join(" ")}`,
      `измените запрос по тексту отказа; текущие уровни: layero data methods --db ${shellArg(ref)}`,
    );
  }

  const ok = await confirmed("\nприменить?", opts);
  if (ok === null) {
    if (json) {
      emit({
        ...planEvent(org, ref, plan, false),
        next_action: `проверьте команды и предупреждения; применить: ${retry}`,
      });
    }
    throw new LayeroError(
      "confirmation_required",
      "уровень доступа не применён: команды нужно подтвердить",
      `проверьте команды и предупреждения и повторите: ${retry}`,
    );
  }
  if (!ok) {
    console.log(chalk.yellow("отменено."));
    return;
  }
  // `expected_sql` — сервер применит, только если команды не изменились с показа.
  const done = await api.setDataLevels(org, db.id, { ...request, apply: true, expected_sql: plan.sql });
  if (json) {
    emit(planEvent(org, ref, done, true));
    return;
  }
  if (opts.yes) console.log(planLines(done).join("\n"));
  console.log(`\n${chalk.green("✓")} доступ изменён`);
}

// Что снимает переприменение: агент узла при каждом включении API отзывает у
// ролей Data API всё в схеме `public` (`runtime/userdb-agent/agent.py`, `api_enable`).
const REPAIR_LOSS = "роли Data API потеряют USAGE на схему public и все права на её таблицы";

/**
 * Включение Data API.
 *
 * 🚨 У БАЗЫ, ГДЕ API УЖЕ ВКЛЮЧЁН, — ОТКАЗ. Сервер включение повторяет, а агент
 * узла при каждом включении снимает у ролей права на схему `public` и её таблицы:
 * `data enable --db X` «на всякий случай» молча закрывал открытые уровни (ревью
 * 13.09, 5-й круг).
 *
 * `--repair` оставлен осознанно: повторное включение — единственный путь вернуть
 * роли, схему `api` и права на очередь, если их удалили или испортили руками, и
 * именно его советуют отказы «роли Data API в базе нет — включите API заново». Он
 * требует явного `--db` и подтверждения с предупреждением о `public`.
 */
export async function dataEnableCmd(opts: DataApiOptions): Promise<void> {
  if (opts.repair && !opts.db) {
    throw new LayeroError(
      "database_unknown",
      `переприменение Data API снимает права ролей на схему public — базу нужно указать явно`,
      "layero data enable --db <база> --repair",
    );
  }
  const { api, org, db, ref } = await target(opts, "enable");
  if (db.api_enabled && !opts.repair) {
    throw new LayeroError(
      "data_api_already_enabled",
      `у базы «${db.name}» Data API уже включён — повторное включение ничего не выпускает, а ${REPAIR_LOSS}`,
      `ключи: layero data keys list --db ${shellArg(ref)}; методы: layero data methods --db ${shellArg(ref)}; ` +
        `переприменить роли и схему api: layero data enable --db ${shellArg(ref)} --repair`,
    );
  }
  if (opts.repair) {
    if (!db.api_enabled) {
      throw new LayeroError(
        "data_api_disabled",
        `у базы «${db.name}» не включён Data API — переприменять нечего`,
        `включите: layero data enable --db ${shellArg(ref)}`,
      );
    }
    const ok = await confirmed(`переприменить Data API у базы «${db.name}»? ${_capitalize(REPAIR_LOSS)}`, opts);
    if (ok === null) {
      throw new LayeroError(
        "confirmation_required",
        `переприменение Data API не подтверждено: ${REPAIR_LOSS}`,
        `если роли или схема api повреждены, повторите с --yes: layero data enable --db ${shellArg(ref)} --repair --yes`,
      );
    }
    if (!ok) {
      console.log(chalk.yellow("отменено."));
      return;
    }
  }
  const res = await api.enableDataApi(org, db.id, Boolean(opts.withSecret));
  const publicKey = res.key?.key ?? null;
  const secretKey = res.secret_key?.key ?? null;
  const reapplied = Boolean(opts.repair);
  if (asJson(opts)) {
    emit({
      event: "data_api_enabled",
      org,
      database: ref,
      slug: res.slug,
      public_key: publicKey,
      secret_key: secretKey,
      reapplied,
    });
    return;
  }
  console.log(
    reapplied
      ? `${chalk.green("✓")} Data API переприменён у базы «${db.name}»\n` +
          chalk.yellow(`  ${_capitalize(REPAIR_LOSS)}: откройте нужные таблицы заново — layero data methods`)
      : `${chalk.green("✓")} Data API включён у базы «${db.name}»`,
  );
  if (publicKey) console.log(`\n  публичный ключ:  ${publicKey}`);
  if (secretKey) {
    console.log(
      `  секретный ключ:  ${secretKey}\n` +
        chalk.yellow("\n  Сохраните секретный ключ сейчас: платформа его не хранит и больше не покажет."),
    );
  }
  if (!publicKey && !secretKey) console.log(chalk.dim(`  ключи уже были — список: layero data keys list --db ${ref}`));
  console.log(
    chalk.dim(
      "\n  Все методы закрыты, пока вы их не откроете: layero data methods, затем layero data grant",
    ),
  );
}

/**
 * Подкоманды `layero data`, кроме `env`. Отдельной функцией, а не в
 * `bin/layero.ts`: там разбор аргументов запускается при импорте, и проверить
 * регистрацию флагов тестом было бы нечем.
 */
export function registerDataApiCommands(data: Command, program: Command): void {
  const withDb = (c: Command) =>
    c
      .option("--db <name>", "база: имя, слаг или id (по умолчанию — единственная подходящая)")
      .option("--org <slug>", "организация (по умолчанию единственная)");
  const json = (opts: any) => ({ ...opts, json: program.opts().json });

  const keys = data.command("keys").description("Ключи Data API: список, выпуск, отзыв.");
  withDb(keys.command("list").description("Ключи базы: префикс, срок, последний вызов. Значений нет."))
    .action(async (opts: any) => dataKeysListCmd(json(opts)));
  withDb(
    keys
      .command("issue")
      .description("Выпустить ключ. Значение печатается один раз.")
      .option("--kind <kind>", "public — для сайта, secret — для сервера", "public")
      .option("--label <text>", "подпись, по которой ключ узнают в списке")
      .option("--expires-in <days>", "срок: 30, 90, 365 или never", "never"),
  ).action(async (opts: any) => dataKeysIssueCmd(json(opts)));
  withDb(
    keys
      .command("revoke <id>")
      .description("Отозвать ключ по id или префиксу. Запросы с ним сразу получают отказ.")
      .option("-y, --yes", "не спрашивать подтверждение"),
  ).action(async (id: string, opts: any) => dataKeysRevokeCmd(id, json(opts)));

  const origins = data.command("origins").description("Сайты, которым можно звать базу из браузера.");
  withDb(origins.command("list").description("Адреса проектов базы и добавленные вручную."))
    .action(async (opts: any) => dataOriginsListCmd(json(opts)));
  withDb(
    origins
      .command("add <url>")
      .description("Пустить сайт. Данных не открывает: это решают уровни доступа.")
      .option("--note <text>", "зачем добавлен"),
  ).action(async (url: string, opts: any) => dataOriginsAddCmd(url, json(opts)));
  withDb(
    origins
      .command("remove <url>")
      .description("Убрать сайт из списка.")
      .option("-y, --yes", "не спрашивать подтверждение"),
  ).action(async (url: string, opts: any) => dataOriginsRemoveCmd(url, json(opts)));

  withDb(data.command("methods").description("REST и RPC базы с уровнем доступа на каждый метод."))
    .action(async (opts: any) => dataMethodsCmd(json(opts)));

  withDb(
    data
      .command("grant <object>")
      .description("Уровень доступа к методам таблицы или функции: показывает SQL, применяет после подтверждения.")
      .option("--get <level>", "чтение таблицы")
      .option("--post <level>", "добавление строк")
      .option("--patch <level>", "изменение строк")
      .option("--delete <level>", "удаление строк")
      .option("--call <level>", "вызов функции")
      .option("-y, --yes", "применить без подтверждения")
      .addHelpText(
        "after",
        "\nУровни: closed — закрыто, visitor — любой посетитель, user — вошедшие, server — только сервер.\n" +
          "Неназванные методы таблицы сохраняют текущий уровень.\n" +
          "\nПримеры:\n" +
          "  $ layero data grant app.products --get visitor         # каталог виден сайту\n" +
          "  $ layero data grant app.orders --get user --post user  # заказы — вошедшим\n" +
          "  $ layero data grant api.order_create --call visitor     # функция для сайта\n" +
          "  $ layero data grant 'api.pick(integer)' --call server   # перегрузка — по типам\n" +
          "\nБез --yes вне терминала команда показывает SQL, ничего не меняет и завершается ошибкой.",
      ),
  ).action(async (object: string, opts: any) => dataGrantCmd(object, json(opts)));

  withDb(
    data
      .command("enable")
      .description("Включить Data API у базы: схема api, роли и публичный ключ. Методы закрыты.")
      .option("--with-secret", "выпустить и секретный ключ для сервера")
      .option(
        "--repair",
        "переприменить роли и схему api у базы с включённым Data API; снимает права ролей на схему public",
      )
      .option("-y, --yes", "не спрашивать подтверждение для --repair"),
  ).action(async (opts: any) => dataEnableCmd(json(opts)));
}
