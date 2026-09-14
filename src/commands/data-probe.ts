// `layero data probe` — проба метода Data API настоящим запросом через шлюз
// (T-20260911-9; ручка — T-20260911-1).
//
// 🚨 Зачем. Проверить, открыт ли метод посетителю и что увидит вошедший, можно
// было только кнопкой «Выполнить» в панели. Из скрипта, CI и терминала агента —
// никак. Ключ и токен выбранного пользователя подставляет платформа, запись
// откатывается по её подписи; права, правила строк и отказы — настоящие.
//
// 🚨 ОТКАЗ ШЛЮЗА — РЕЗУЛЬТАТ ПРОБЫ, А НЕ ОШИБКА CLI. «Закрыт ли метод для
// посетителя» — главный вопрос пробы, и ответ 403 на него — успешный ответ.
// Поэтому 401, 403, 404 от шлюза приходят событием `data_probe` с кодом выхода
// 0. Ошибка CLI — только когда проба не состоялась: неверные флаги или отказ
// платформы до запроса к шлюзу (`data_probe_rejected`).
//
// 🚨 ЕДИНСТВЕННОЕ ИСКЛЮЧЕНИЕ — ОТКАТ НЕ ПОДТВЕРЖДЁН. Запись прошла (200–399),
// откат ждали, а шлюз его не подтвердил: данные могли измениться. Событие
// уходит как обычно, а следом — ошибка `data_probe_not_rolled_back` и ненулевой
// код. Код 0 здесь значил бы зелёный CI-скрипт, который, возможно, записал в
// боевую базу.
//
// ⚠️ Правила адреса, метода и размеров проверяет сервер (`userdb_api._probe_checked`).
// Здесь — только то, что сервер не может объяснить лучше: `?` в пути, тело не у
// того метода, `--as user` без пользователя, неразобранные флаги.
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
}

const METHODS = ["GET", "POST", "PATCH", "DELETE"];
const AS = ["visitor", "user", "server"];

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

type ProbeBody = Record<string, unknown> | unknown[];

async function bodyOf(opts: DataProbeOptions): Promise<ProbeBody | undefined> {
  if (opts.body !== undefined && opts.bodyFile !== undefined) {
    throw new LayeroError("data_probe_body", "заданы и --body, и --body-file", "оставьте один из флагов");
  }
  let raw: string;
  let from: string;
  if (opts.bodyFile !== undefined) {
    from = `файла «${opts.bodyFile}»`;
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
  return parsed as ProbeBody;
}

/** Запрос пробы из аргументов. Всё, что отклоняется здесь, отклоняется до сети. */
async function requestOf(methodArg: string, path: string, opts: DataProbeOptions) {
  const method = String(methodArg).trim().toUpperCase();
  if (!METHODS.includes(method)) {
    throw new LayeroError(
      "data_probe_method",
      `метод «${methodArg}» проба не умеет`,
      "GET, POST, PATCH или DELETE",
    );
  }
  const cut = path.indexOf("?");
  if (cut >= 0) {
    // Ручка принимает путь без строки запроса и отвечает общим «адрес пробы: …» —
    // из него не понять, что параметры надо было отдать отдельно.
    const flags = [...new URLSearchParams(path.slice(cut + 1)).entries()]
      .map(([k, v]) => `--query ${shellArg(`${k}=${v}`)}`)
      .join(" ");
    throw new LayeroError(
      "data_probe_path",
      `в пути «${path}» есть «?»: параметры запроса проба принимает только флагами --query`,
      `layero data probe ${method} ${shellArg(path.slice(0, cut))}${flags ? ` ${flags}` : ""}` +
        `${opts.db ? ` --db ${shellArg(opts.db)}` : ""}`,
    );
  }
  if (path === "/whoami" && method !== "GET") {
    throw new LayeroError("data_probe_method", "/whoami отвечает только на GET", "layero data probe GET /whoami");
  }
  const as = String(opts.as ?? "visitor").trim().toLowerCase();
  if (!AS.includes(as)) {
    throw new LayeroError(
      "data_probe_as",
      `от чьего имени «${opts.as}» — неизвестно`,
      "--as visitor — посетитель, --as user --user <id> — вошедший, --as server — сервер",
    );
  }
  if (as === "user" && !opts.user) {
    throw new LayeroError(
      "data_probe_user_required",
      "--as user пробует от имени вошедшего пользователя, а он не указан",
      "добавьте --user <id пользователя приложения>",
    );
  }
  // Без этой проверки `--user` при посетителе молча пропадал бы, и ответ посетителю
  // читался бы как ответ этому пользователю.
  if (as !== "user" && opts.user) {
    throw new LayeroError(
      "data_probe_as",
      `--user работает только с --as user, а проба идёт от имени: ${as}`,
      "добавьте --as user или уберите --user",
    );
  }
  const body = await bodyOf(opts);
  if (body !== undefined && method !== "POST" && method !== "PATCH") {
    throw new LayeroError(
      "data_probe_body",
      `тело бывает только у POST и PATCH, а метод — ${method}`,
      "уберите --body; условия для GET и DELETE — флагами --query имя=значение",
    );
  }
  return {
    method,
    path,
    query: queryOf(opts.query ?? []),
    body: body ?? null,
    as: as as "visitor" | "user" | "server",
    user_id: as === "user" ? opts.user! : null,
    schema: opts.schema ?? null,
  };
}

/**
 * Отказ платформы до запроса к шлюзу — ошибкой с кодом.
 *
 * 401 и 402 не трогаем: их переводит общий обработчик (`auth_expired`,
 * `plan_limit`). 5xx — тоже: это авария, а не отказ.
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
  return new LayeroError(
    "data_probe_rejected",
    `проба не выполнена: ${message}`,
    `исправьте запрос по тексту отказа; пути методов базы — layero data methods --db ${shellArg(ref)}`,
  );
}

/** Запись прошла, откат ждали, а подтверждения нет: данные могли измениться. */
export function notRolledBack(res: Pick<DataApiProbe, "status" | "rolled_back" | "rollback_expected">): boolean {
  return Boolean(res.rollback_expected) && res.status >= 200 && res.status < 400 && res.rolled_back !== true;
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

export async function dataProbeCmd(method: string, path: string, opts: DataProbeOptions): Promise<void> {
  const request = await requestOf(method, path, opts);
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
      headers: res.headers ?? {},
      body: res.body ?? null,
    });
  } else {
    const tableGet = request.method === "GET" && /^\/rest\/v1\/(?!rpc\/)/.test(request.path);
    const who = `${AS_WORD[request.as]}${request.user_id ? ` ${request.user_id}` : ""}`;
    console.log(chalk.bold(`${request.method} ${request.path}`) + chalk.dim(`  база «${db.name}», от имени: ${who}`));
    const caller = callerOf(res);
    const facts = [
      res.status >= 400 ? chalk.red(String(res.status)) : chalk.green(String(res.status)),
      `${Math.round(res.elapsed_ms)} мс`,
      outOf(res, tableGet),
      caller ? `кто пришёл: ${caller}` : null,
      // У `/whoami` откатывать нечего — об откате ни слова.
      res.rollback_expected && res.rolled_back === true ? "изменения откатились" : null,
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
  }

  if (alarm) {
    throw new LayeroError(
      "data_probe_not_rolled_back",
      `${request.method} ${request.path}: шлюз ответил ${res.status} и не подтвердил откат — изменения могли записаться в базу «${db.name}»`,
      "проверьте данные базы и не повторяйте пробу записи, пока причина не найдена",
    );
  }
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
      .option("--user <id>", "для --as user: id пользователя приложения")
      .option("--query <name=value>", "параметр запроса в синтаксисе PostgREST; флаг повторяется", collect)
      .option("--body <json>", "тело POST и PATCH: объект или массив JSON")
      .option("--body-file <file>", "тело из файла с JSON")
      .option("--schema <schema>", "схема таблицы, если имя есть в нескольких: api, public или app")
      .addHelpText(
        "after",
        "\nПути: /rest/v1/<таблица>, /rest/v1/rpc/<функция>, /whoami (только GET).\n" +
          "Параметры — флагами --query, не через «?» в пути.\n" +
          "\nПримеры:\n" +
          "  $ layero data probe GET /rest/v1/products --query select=id,title --query limit=5\n" +
          "  $ layero data probe POST /rest/v1/cart --as user --user <id> --body '{\"qty\":1}'\n" +
          "  $ layero data probe POST /rest/v1/rpc/order_create --body-file order.json --as server\n" +
          "  $ layero data probe GET /whoami\n" +
          "\nЗапись откатывается; не откатываются номера последовательностей, внешние вызовы из базы\n" +
          "и суточная квота. Отказ шлюза (401, 403) — результат пробы: код выхода 0.\n" +
          "Если шлюз не подтвердил откат записи — ошибка data_probe_not_rolled_back.",
      ),
  ).action(async (method: string, path: string, opts: any) => dataProbeCmd(method, path, json(opts)));
}
