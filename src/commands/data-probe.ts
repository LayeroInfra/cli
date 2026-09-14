// `layero data probe` — проба метода Data API настоящим запросом через шлюз
// (T-20260911-9; ручка — T-20260911-1).
//
// 🚨 Зачем. Проверить, открыт ли метод посетителю и что увидит вошедший, можно
// было только кнопкой «Выполнить» в панели. Из скрипта, CI и терминала агента —
// никак. Ключ и токен выбранного пользователя подставляет платформа, запись
// откатывается по её подписи; права, правила строк и отказы — настоящие.
//
// 🚨 КОД ВЫХОДА — ОДНО ПРАВИЛО, ПО ПОРЯДКУ (`verdict`):
//   1. откат записи не подтверждён → `data_probe_not_rolled_back`, всегда;
//   2. статус совпал с `--expect` → 0;
//   3. шлюз ответил 5xx → `data_probe_gateway_failed`: проба не ответила на вопрос;
//   4. статус не совпал с `--expect` → `data_probe_unexpected_status`;
//   5. иначе 0 — в том числе на отказ 4xx. «Закрыт ли метод посетителю» —
//      главный вопрос пробы, и 403 на него — ответ, а не сбой.
// Событие `data_probe` приходит во всех случаях, когда шлюз ответил; ошибка —
// следом. Без `--expect` скрипту без `--json` нечем отличить 200 от 403: флаг
// заведён ради CI. Код 0 на неподтверждённом откате значил бы зелёный скрипт,
// который, возможно, записал в боевую базу.
//
// ⚠️ Проверки до запроса повторяют правила ручки (`userdb_api._probe_checked`)
// там, где её общий текст не объясняет, что исправить: `?` и косая черта в
// конце пути, метод функции и `/whoami`, тело не у того метода, `--user` не UUID,
// `--schema`, которую ручка молча проигнорировала бы. Остальные пределы — её.
import { readFile } from "node:fs/promises";
import chalk from "chalk";
import type { Command } from "commander";
import { ApiError, type DataApiProbe } from "../api.js";
import { LayeroError, detectMode, emit } from "../agent.js";
import { shellArg, target, type DataApiOptions } from "./data-api.js";

export interface DataProbeOptions extends DataApiOptions {
  as?: string;
  user?: string;
  query?: string[];
  body?: string;
  bodyFile?: string;
  schema?: string;
  expect?: string;
}

type ProbeBody = Record<string, unknown> | unknown[];

interface ProbeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: ProbeBody | null;
  as: "visitor" | "user" | "server";
  user_id: string | null;
  schema: string | null;
}

const METHODS = ["GET", "POST", "PATCH", "DELETE"];
const AS = ["visitor", "user", "server"];
/**
 * Схемы, для которых ручка ставит заголовок профиля (`_PROBE_SCHEMAS`). Любое
 * другое значение она молча игнорирует, и проба отвечала бы про таблицу, которую
 * шлюз выбрал сам по порядку api → public → app.
 */
const SCHEMAS = ["api", "public", "app"];
/** Заголовки ответа шлюза, которые пропускает ручка (`_PROBE_ANSWER_HEADERS`). */
const ANSWER_HEADERS = [
  "content-type",
  "content-range",
  "x-layero-caller",
  "x-layero-key",
  "x-layero-user",
  "x-layero-rolled-back",
];
/** Что откат пробы не возвращает — теми же словами, что панель. */
const NOT_UNDONE = "номера последовательностей, внешние вызовы из базы, сессионные блокировки и суточная квота вызовов";
/** Ручка ждёт UUID (`UUID(user_id)`). */
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const CONTACTS = "https://docs.layero.ru/contacts/";

/** Роль пробы и `x-layero-caller` шлюза — теми же словами, что в панели. */
const AS_WORD: Record<string, string> = { visitor: "посетитель", user: "вошедший", server: "сервер" };

function pluralRu(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  if (a >= 11 && a <= 14) return many;
  const b = a % 10;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

/**
 * Команда повтора со ВСЕМИ флагами, которые передал человек.
 *
 * 🚨 Агент выполняет `next_action` дословно. Подсказка без `--as` или `--schema`
 * повторила бы пробу посетителем в другой схеме — ответ на другой вопрос.
 */
function retryCommand(method: string, path: string, opts: DataProbeOptions, fromPath: string[] = []): string {
  const parts = ["layero data probe", method, shellArg(path)];
  const flag = (name: string, value: string | undefined) => {
    if (value !== undefined) parts.push(name, shellArg(value));
  };
  for (const q of [...fromPath, ...(opts.query ?? [])]) flag("--query", q);
  flag("--as", opts.as);
  flag("--user", opts.user);
  flag("--schema", opts.schema);
  flag("--body", opts.body);
  flag("--body-file", opts.bodyFile);
  flag("--expect", opts.expect);
  flag("--db", opts.db);
  flag("--org", opts.org);
  return parts.join(" ");
}

function queryOf(items: string[]): Record<string, string> {
  const out = new Map<string, string>();
  for (const item of items) {
    const eq = item.indexOf("=");
    if (eq <= 0) {
      throw new LayeroError(
        "data_probe_query",
        `параметр «${item}» — не пара имя=значение`,
        "--query select=id,title --query price=gt.100",
      );
    }
    const name = item.slice(0, eq);
    // Ручка принимает одно значение на имя: второе молча заменило бы первое, и
    // проба ответила бы не на тот запрос, который человек написал.
    if (out.has(name)) {
      throw new LayeroError(
        "data_probe_query",
        `параметр «${name}» указан дважды: проба передаёт одно значение на имя`,
        `объедините условия в одно, например --query 'or=(${name}.gte.1,${name}.lte.5)'`,
      );
    }
    out.set(name, item.slice(eq + 1));
  }
  // `fromEntries`, а не присваивание: имя `__proto__` станет параметром, а не прототипом.
  return Object.fromEntries(out);
}

/** Число JSON как значение: знак, значащие цифры без нулей по краям, порядок. */
function decimal(text: string): string | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!m) return null;
  const digits = (m[2]! + (m[3] ?? "")).replace(/^0+/, "");
  if (!digits) return "0";
  const trimmed = digits.replace(/0+$/, "");
  const exp = Number(m[4] ?? 0) - (m[3]?.length ?? 0) + (digits.length - trimmed.length);
  return `${m[1]}${trimmed}e${exp}`;
}

/**
 * Первое число тела, которое разбор в CLI передал бы не тем значением.
 *
 * 🚨 `JSON.parse` читает числа в double: `9007199254740993` становится
 * `9007199254740992`, и проба пишет или ищет другой id — молча. Сравниваем
 * значение литерала с тем, что уйдёт в запрос. Текст уже разобран без ошибок,
 * поэтому вне строк любая цифра или минус начинает число.
 */
function lossyNumber(raw: string): { text: string; sent: string } | null {
  const number = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  let i = 0;
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === '"') {
      i++;
      while (i < raw.length && raw[i] !== '"') i += raw[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      number.lastIndex = i;
      const text = number.exec(raw)?.[0] ?? c;
      const sent = String(Number(text));
      if (decimal(text) !== decimal(sent)) return { text, sent };
      i += text.length;
      continue;
    }
    i++;
  }
  return null;
}

async function bodyOf(opts: DataProbeOptions): Promise<ProbeBody | undefined> {
  if (opts.body !== undefined && opts.bodyFile !== undefined) {
    throw new LayeroError("data_probe_body", "заданы и --body, и --body-file", "оставьте один из флагов");
  }
  let raw: string;
  let from: string;
  if (opts.bodyFile !== undefined) {
    from = `из файла «${opts.bodyFile}»`;
    try {
      raw = await readFile(opts.bodyFile, "utf8");
    } catch (e: any) {
      throw new LayeroError(
        "data_probe_body",
        `не удалось прочитать файл тела «${opts.bodyFile}»: ${e?.code ?? e?.message ?? e}`,
        "проверьте путь: --body-file <файл с JSON>",
      );
    }
  } else if (opts.body !== undefined) {
    from = "из --body";
    raw = opts.body;
  } else {
    return undefined;
  }
  // BOM ставит Блокнот Windows; `JSON.parse` на нём падает «Unexpected token».
  raw = raw.replace(/^\uFEFF/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new LayeroError(
      "data_probe_body",
      `тело ${from} — не JSON: ${e?.message ?? e}`,
      `передайте объект или массив: --body '{"qty":1}'`,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new LayeroError(
      "data_probe_body",
      `тело ${from} — не объект и не массив JSON`,
      `передайте объект или массив: --body '{"qty":1}'`,
    );
  }
  const lossy = lossyNumber(raw);
  if (lossy) {
    throw new LayeroError(
      "data_probe_body",
      `число ${lossy.text} в теле ${from} не передаётся точно: в запрос ушло бы ${lossy.sent}`,
      `передайте его строкой в кавычках: "${lossy.text}"`,
    );
  }
  return parsed as ProbeBody;
}

function expectOf(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const items = String(value).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!items.length || items.some((s) => !/^[1-5](?:\d\d|xx)$/.test(s))) {
    throw new LayeroError(
      "data_probe_expect",
      `--expect «${value}» не разобран: нужен статус ответа или класс статусов`,
      "--expect 200, --expect 2xx или несколько через запятую: --expect 201,204",
    );
  }
  return items;
}

function expected(status: number, expect: string[]): boolean {
  return expect.some((e) => (e.endsWith("xx") ? Math.floor(status / 100) === Number(e[0]) : Number(e) === status));
}

/** Запрос пробы из аргументов. Всё, что отклоняется здесь, отклоняется до сети. */
async function requestOf(
  methodArg: string,
  pathArg: string,
  opts: DataProbeOptions,
): Promise<{ request: ProbeRequest; expect: string[] | null }> {
  const method = String(methodArg).trim().toUpperCase();
  if (!METHODS.includes(method)) {
    throw new LayeroError(
      "data_probe_method",
      `метод «${methodArg}» проба не умеет`,
      "GET, POST, PATCH или DELETE",
    );
  }
  const path = String(pathArg);
  const cut = path.indexOf("?");
  if (cut >= 0) {
    // Ручка принимает путь без строки запроса и отвечает общим «адрес пробы: …» —
    // из него не понять, что параметры надо было отдать отдельно.
    const fromPath = [...new URLSearchParams(path.slice(cut + 1)).entries()].map(([k, v]) => `${k}=${v}`);
    throw new LayeroError(
      "data_probe_path",
      `в пути «${path}» есть «?»: параметры запроса проба принимает только флагами --query`,
      retryCommand(method, path.slice(0, cut), opts, fromPath),
    );
  }
  if (path.length > 1 && path.endsWith("/")) {
    throw new LayeroError(
      "data_probe_path",
      `в пути «${path}» лишняя косая черта в конце: такой адрес ручка не примет`,
      retryCommand(method, path.replace(/\/+$/, ""), opts),
    );
  }
  const whoami = path === "/whoami";
  const rpc = path.startsWith("/rest/v1/rpc/");
  if (whoami && method !== "GET") {
    throw new LayeroError(
      "data_probe_method",
      "/whoami отвечает только на GET",
      retryCommand("GET", path, { ...opts, body: undefined, bodyFile: undefined }),
    );
  }
  if (rpc && method !== "GET" && method !== "POST") {
    throw new LayeroError(
      "data_probe_method",
      `функцию вызывают GET или POST, а метод — ${method}`,
      retryCommand("POST", path, opts),
    );
  }

  const as = String(opts.as ?? "visitor").trim().toLowerCase();
  if (!AS.includes(as)) {
    throw new LayeroError(
      "data_probe_as",
      `от чьего имени «${opts.as}» — неизвестно`,
      "--as visitor — посетитель, --as user --user <id> — вошедший, --as server — сервер",
    );
  }
  const user = opts.user?.trim();
  if (as === "user" && !user) {
    throw new LayeroError(
      "data_probe_user_required",
      "--as user пробует от имени вошедшего пользователя, а он не указан",
      "добавьте --user <id пользователя приложения>",
    );
  }
  // Без этой проверки `--user` при посетителе молча пропадал бы, и ответ посетителю
  // читался бы как ответ этому пользователю.
  if (as !== "user" && opts.user !== undefined) {
    throw new LayeroError(
      "data_probe_as",
      `--user работает только с --as user, а проба идёт от имени: ${as}`,
      "добавьте --as user или уберите --user",
    );
  }
  if (as === "user" && !UUID.test(user!)) {
    throw new LayeroError(
      "data_probe_user_invalid",
      `--user «${opts.user}» — не id пользователя: платформа ждёт UUID, например 7c8aa53d-3b61-40a7-bd2e-695058acd72f`,
      "возьмите id в панели базы, в списке пользователей приложения",
    );
  }

  let schema: string | null = null;
  if (opts.schema !== undefined) {
    if (whoami || rpc) {
      throw new LayeroError(
        "data_probe_schema",
        whoami
          ? "у /whoami нет схемы: --schema выбирает таблицу"
          : "у функции нет выбора схемы: шлюз зовёт функции только из схемы api, а --schema выбирает таблицу",
        retryCommand(method, path, { ...opts, schema: undefined }),
      );
    }
    schema = String(opts.schema).trim().toLowerCase();
    if (!SCHEMAS.includes(schema)) {
      throw new LayeroError(
        "data_probe_schema",
        `схемы «${opts.schema}» среди тех, что отдаёт шлюз, нет — флаг был бы молча проигнорирован`,
        "--schema api, public или app; без флага шлюз ищет таблицу в api, затем в public, затем в app",
      );
    }
  }

  const expect = expectOf(opts.expect);

  // Метод — до чтения файла: иначе GET с неверным путём к файлу жаловался бы на
  // файл, а не на то, что тела у GET не бывает.
  if ((opts.body !== undefined || opts.bodyFile !== undefined) && method !== "POST" && method !== "PATCH") {
    throw new LayeroError(
      "data_probe_body",
      `тело бывает только у POST и PATCH, а метод — ${method}`,
      retryCommand(method, path, { ...opts, body: undefined, bodyFile: undefined }),
    );
  }
  const body = await bodyOf(opts);
  return {
    request: {
      method,
      path,
      query: queryOf(opts.query ?? []),
      body: body ?? null,
      as: as as ProbeRequest["as"],
      user_id: as === "user" ? user! : null,
      schema,
    },
    expect,
  };
}

/**
 * Подсказки к отказу ручки — по его тексту (`userdb_api.probe_http`).
 *
 * ⚠️ Текст на сервере поменяется — подсказка упадёт в общую; сам текст отказа
 * всё равно дойдёт до человека как есть.
 */
const REFUSAL_HINTS: Array<[string, (ref: string) => string]> = [
  ["адрес пробы не собрался", (ref) => `проверьте имя таблицы или функции: layero data methods --db ${ref}`],
  ["адрес пробы", (ref) => `пути методов базы — layero data methods --db ${ref}`],
  ["больше 50 параметров", () => "оставьте не больше 50 флагов --query"],
  ["больше 64 КБ", () => "уменьшите тело до 64 КБ"],
  ["не включён вход", () => "у базы нет вошедших пользователей — пробуйте --as visitor или --as server"],
  ["не включён Data API", (ref) => `включите: layero data enable --db ${ref}`],
  ["роли Data API не заведены", () => "роли заводит включение Data API — включите его заново в панели базы, раздел «API»"],
  ["не найдена или не активна", () => "список баз и их состояние: layero db list"],
  ["ещё не умеет пробу", () => "запрос не выполнен, данные не тронуты — повторите пробу после выкатки шлюза данных"],
];

/**
 * Отказ ручки до запроса к шлюзу — ошибкой с кодом и подсказкой по случаю.
 *
 * 401 и 402 не трогаем: их переводит общий обработчик (`auth_expired`,
 * `plan_limit`). 5xx ручки — тоже: это авария платформы, а не отказ.
 */
function refusal(err: unknown, ref: string): LayeroError | null {
  if (!(err instanceof ApiError) || err.status < 400 || err.status >= 500) return null;
  if (err.status === 401 || err.status === 402) return null;
  let detail: unknown;
  try {
    detail = JSON.parse(err.body)?.detail;
  } catch {
    return null;
  }
  let message: string | null = null;
  if (typeof detail === "string" && detail.trim()) {
    message = detail;
  } else if (Array.isArray(detail)) {
    // 422 разбора тела: `[{loc: [...], msg: "..."}]`.
    const parts = detail
      .map((d: any) => (typeof d?.msg === "string" ? `${(d.loc ?? []).slice(1).join(".") || "запрос"}: ${d.msg}` : ""))
      .filter(Boolean);
    message = parts.length ? parts.join("; ") : null;
  }
  if (!message) return null;
  // Шлюз не ответил платформе — тот же сбой, что его 5xx: проба не дала ответа.
  if (message.includes("шлюз данных не ответил")) {
    return new LayeroError(
      "data_probe_gateway_failed",
      `проба не выполнена: ${message}`,
      `повторите пробу позже; сбой повторяется — сообщите: ${CONTACTS}`,
    );
  }
  const db = shellArg(ref);
  const found = REFUSAL_HINTS.find(([mark]) => message!.includes(mark));
  const hint = found
    ? found[1](db)
    : err.status === 403
      ? "проба доступна только администратору организации"
      : err.status === 422
        ? "исправьте флаги по тексту отказа"
        : `исправьте запрос по тексту отказа; пути методов базы — layero data methods --db ${db}`;
  return new LayeroError("data_probe_rejected", `проба не выполнена: ${message}`, hint);
}

/** Запись прошла, откат ждали, а подтверждения нет: данные могли измениться. */
export function notRolledBack(res: Pick<DataApiProbe, "status" | "rolled_back" | "rollback_expected">): boolean {
  return Boolean(res.rollback_expected) && res.status >= 200 && res.status < 400 && res.rolled_back !== true;
}

/** Код выхода пробы — правило из шапки файла, по порядку. `null` — код 0. */
function verdict(
  res: DataApiProbe,
  request: ProbeRequest,
  expect: string[] | null,
  dbName: string,
  ref: string,
): LayeroError | null {
  const what = `${request.method} ${request.path}`;
  if (notRolledBack(res)) {
    return new LayeroError(
      "data_probe_not_rolled_back",
      `${what}: шлюз ответил ${res.status} и не подтвердил откат — изменения могли записаться в базу «${dbName}»`,
      "проверьте данные базы и не повторяйте пробу записи, пока причина не найдена",
    );
  }
  if (expect && expected(res.status, expect)) return null;
  if (res.status >= 500) {
    const body = res.body as { error?: unknown } | null;
    const why = body && typeof body === "object" && typeof body.error === "string" ? ` (${body.error})` : "";
    return new LayeroError(
      "data_probe_gateway_failed",
      `${what}: шлюз ответил ${res.status}${why} — проба не дала ответа о доступе`,
      `повторите пробу позже; сбой повторяется — сообщите: ${CONTACTS}`,
    );
  }
  if (expect) {
    return new LayeroError(
      "data_probe_unexpected_status",
      `${what}: шлюз ответил ${res.status}, а ожидали ${expect.join(" или ")}`,
      `ответ шлюза — в выводе пробы; уровни доступа методов: layero data methods --db ${shellArg(ref)}`,
    );
  }
  return null;
}

/**
 * «N из M». Знаменатель — только счёт ВЛАДЕЛЬЦА.
 *
 * 🚨 `total` — это сколько строк видно самой роли; «3 из 3» по нему при закрытых
 * правилом строках читалось бы как «роли видна вся таблица».
 */
function outOf(res: DataApiProbe, tableGet: boolean): string | null {
  if (res.rows === null || res.rows === undefined) return null;
  if (res.owner_total !== null && res.owner_total !== undefined) return `${res.rows} из ${res.owner_total}`;
  const n = `${res.rows} ${pluralRu(res.rows, "строка", "строки", "строк")}`;
  return tableGet ? `${n}, сколько всего в таблице — не посчитали` : n;
}

/**
 * «Кто пришёл» — со слов шлюза. Пустой вызывающий значит «ключ или токен не
 * приняты», только если шлюз до них дошёл: у 404 неизвестной базы и у 5xx — нет.
 */
function callerOf(res: DataApiProbe): string | null {
  if (res.caller) return AS_WORD[res.caller] ?? res.caller;
  if (res.status < 400 || res.status === 401 || res.status === 403) return "никто — ключ или токен не приняты";
  return null;
}

/** Заголовки — только из списка: всё, что напечатал CLI, оседает в истории агента. */
function headersOf(headers: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([k]) => ANSWER_HEADERS.includes(k.toLowerCase())));
}

export async function dataProbeCmd(method: string, path: string, opts: DataProbeOptions): Promise<void> {
  const { request, expect } = await requestOf(method, path, opts);
  const { api, org, db, ref } = await target(opts);
  let res: DataApiProbe;
  try {
    res = await api.probeDataApi(org, db.id, request);
  } catch (err) {
    throw refusal(err, ref) ?? err;
  }
  const alarm = notRolledBack(res);
  const { body: _sent, ...shown } = request;

  if (detectMode().json || Boolean(opts.json)) {
    // Поля перечислены поимённо, не `...res`: лишнее поле ответа не уедет в
    // историю переписки агента.
    emit({
      event: "data_probe",
      org,
      database: ref,
      request: shown,
      status: res.status,
      elapsed_ms: res.elapsed_ms,
      caller: res.caller ?? null,
      rows: res.rows ?? null,
      total: res.total ?? null,
      owner_total: res.owner_total ?? null,
      rollback_expected: Boolean(res.rollback_expected),
      rolled_back: res.rolled_back === true,
      not_rolled_back: alarm,
      body_truncated: Boolean(res.body_truncated),
      headers: headersOf(res.headers),
      body: res.body ?? null,
    });
  } else {
    const tableGet = request.method === "GET" && /^\/rest\/v1\/(?!rpc\/)/.test(request.path);
    // У `/whoami` откатывать нечего — об откате ни слова.
    const rolledBack = Boolean(res.rollback_expected) && res.rolled_back === true;
    const who = `${AS_WORD[request.as]}${request.user_id ? ` ${request.user_id}` : ""}`;
    console.log(chalk.bold(`${request.method} ${request.path}`) + chalk.dim(`  база «${db.name}», от имени: ${who}`));
    const caller = callerOf(res);
    const facts = [
      res.status >= 400 ? chalk.red(String(res.status)) : chalk.green(String(res.status)),
      `${Math.round(res.elapsed_ms)} мс`,
      outOf(res, tableGet),
      caller ? `кто пришёл: ${caller}` : null,
      rolledBack ? "изменения откатились" : null,
    ].filter(Boolean);
    console.log(`Ответ ${facts.join(" · ")}`);
    if (alarm) {
      console.log(
        chalk.red.bold("🚨 изменения НЕ откатились: шлюз не подтвердил откат. Проверьте данные — запрос мог их изменить"),
      );
    }
    const answer = res.body === null || res.body === undefined
      ? chalk.dim("(пустое тело)")
      : typeof res.body === "string"
        ? res.body
        : JSON.stringify(res.body, null, 2);
    console.log(`\n${answer}`);
    if (res.body_truncated) console.log(chalk.yellow("\nответ длиннее 64 КБ, показано начало"));
    console.log(
      chalk.dim(
        "\nПроверены права и правила строк. Ваш ключ и сайт не проверялись: ключ подставила платформа, запрос шёл не из браузера",
      ),
    );
    if (rolledBack) console.log(chalk.dim(`Не откатываются: ${NOT_UNDONE}`));
  }

  const failure = verdict(res, request, expect, db.name, ref);
  if (failure) throw failure;
}

/** Регистрация `layero data probe`. Зовётся из `registerDataApiCommands`. */
export function registerDataProbeCommand(
  data: Command,
  withDb: (c: Command) => Command,
  json: (opts: any) => any,
): void {
  const collect = (value: string, prev: string[] = []) => [...prev, value];
  withDb(
    data
      .command("probe <method> <path>")
      .description("Проба метода настоящим запросом через шлюз: права и правила строк настоящие, запись откатывается.")
      .option("--as <who>", "от чьего имени: visitor — посетитель (по умолчанию), user — вошедший, server — сервер")
      .option("--user <id>", "для --as user: id пользователя приложения (UUID)")
      .option("--query <name=value>", "параметр запроса в синтаксисе PostgREST; флаг повторяется", collect)
      .option("--body <json>", "тело POST и PATCH: объект или массив JSON")
      .option("--body-file <file>", "тело из файла с JSON")
      .option("--schema <schema>", "схема таблицы: api, public или app; без флага шлюз ищет в api, затем в public, затем в app")
      .option("--expect <status>", "ожидаемый статус: 200, 2xx или несколько через запятую; не совпал — ошибка")
      .addHelpText(
        "after",
        "\nПути: /rest/v1/<таблица>, /rest/v1/rpc/<функция> (GET или POST), /whoami (только GET).\n" +
          "Параметры — флагами --query, не через «?» в пути.\n" +
          "\nПримеры:\n" +
          "  $ layero data probe GET /rest/v1/products --query select=id,title --query limit=5\n" +
          "  $ layero data probe POST /rest/v1/cart --as user --user <id> --body '{\"qty\":1}'\n" +
          "  $ layero data probe POST /rest/v1/rpc/order_create --body-file order.json --as server\n" +
          "  $ layero data probe GET /rest/v1/orders --expect 401,403   # закрыто ли посетителю\n" +
          "  $ layero data probe GET /whoami\n" +
          `\nЗапись откатывается. Не откатываются: ${NOT_UNDONE}.\n` +
          "\nКод выхода — по порядку:\n" +
          "  1. откат записи не подтверждён — ошибка data_probe_not_rolled_back;\n" +
          "  2. статус совпал с --expect — 0;\n" +
          "  3. шлюз ответил 5xx — ошибка data_probe_gateway_failed;\n" +
          "  4. статус не совпал с --expect — ошибка data_probe_unexpected_status;\n" +
          "  5. иначе 0, в том числе на отказ 4xx: 401, 403, 404 — ответ пробы, а не сбой.",
      ),
  ).action(async (method: string, path: string, opts: any) => dataProbeCmd(method, path, json(opts)));
}
