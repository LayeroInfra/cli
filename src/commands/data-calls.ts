// `layero data hosts | secrets | calls` — исходящие вызовы базы из терминала
// (G-12, 26.10.2026).
//
// 🚨 Зачем. Механизм был только у сервера: документация звала в раздел панели,
// которого не было, а CLI и MCP о нём не знали. Строки `api.outbox` у клиента
// ложились в `failed: вызов не описан`, и обещанные уведомления в Telegram без
// своего сервера не запускались. Теперь всё описывается кодом:
//
//   layero data hosts add api.telegram.org
//   layero data secrets set TELEGRAM_BOT_TOKEN        # значение — со stdin
//   layero data calls set --file telegram_notify.json
//
// ⚠️ Значение секрета НЕ принимается аргументом: аргумент оседает в истории
// shell и в списке процессов. Только stdin, переменная окружения или ввод без
// эха в терминале.
import { readFile } from "node:fs/promises";
import readline from "node:readline/promises";
import chalk from "chalk";
import type { Command } from "commander";
import type { Schemas } from "../api.js";
import { LayeroError, detectMode, emit } from "../agent.js";
import { type DataApiOptions, target } from "./data-api.js";

interface CallsOptions extends DataApiOptions {
  file?: string;
  fromEnv?: string;
  limit?: string;
}

function asJson(opts: DataApiOptions): boolean {
  return detectMode().json || Boolean(opts.json);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

/** Ввод без эха: символы не печатаются, как у `sudo`. */
async function askHidden(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let prompted = false;
  out._writeToOutput = (s: string) => {
    if (!prompted) {
      process.stdout.write(s);
      prompted = true;
    }
  };
  try {
    return await rl.question(question);
  } finally {
    rl.close();
    process.stdout.write("\n");
  }
}

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

function notConfirmed(what: string, command: string): LayeroError {
  return new LayeroError("confirmation_required", `${what} не подтверждено`, `повторите с --yes: ${command} --yes`);
}

// ── хосты ───────────────────────────────────────────────────────────────────

export async function dataHostsListCmd(opts: DataApiOptions): Promise<void> {
  const { api, org, db, ref } = await target(opts);
  const hosts = (await api.listDataHosts(org, db.id)).map((h) => h.host);
  if (asJson(opts)) {
    emit({ event: "data_hosts", org, database: ref, hosts });
    return;
  }
  console.log(chalk.bold("Разрешённые хосты") + chalk.dim(" — куда шлюзу можно ходить"));
  if (hosts.length) for (const h of hosts) console.log(`  ${h}`);
  else console.log(chalk.dim(`  нет — добавить: layero data hosts add api.telegram.org --db ${ref}`));
}

export async function dataHostsAddCmd(host: string, opts: DataApiOptions): Promise<void> {
  const { api, org, db, ref } = await target(opts);
  await api.addDataHost(org, db.id, host);
  if (asJson(opts)) {
    emit({ event: "data_host_added", org, database: ref, host });
    return;
  }
  console.log(`${chalk.green("✓")} шлюз базы «${db.name}» может ходить на ${host}`);
}

export async function dataHostsRemoveCmd(host: string, opts: DataApiOptions): Promise<void> {
  const { api, org, db, ref } = await target(opts);
  const ok = await confirmed(`убрать ${host}? Вызовы на этот хост начнут отказывать`, opts);
  if (ok === null) throw notConfirmed(`удаление хоста ${host}`, `layero data hosts remove ${host} --db ${ref}`);
  if (!ok) {
    console.log(chalk.yellow("отменено."));
    return;
  }
  await api.deleteDataHost(org, db.id, host);
  if (asJson(opts)) {
    emit({ event: "data_host_removed", org, database: ref, host });
    return;
  }
  console.log(`${chalk.green("✓")} ${host} убран`);
}

// ── секреты ─────────────────────────────────────────────────────────────────

export async function dataSecretsListCmd(opts: DataApiOptions): Promise<void> {
  const { api, org, db, ref } = await target(opts);
  const names = (await api.listDataSecrets(org, db.id)).map((s) => s.name);
  if (asJson(opts)) {
    emit({ event: "data_secrets", org, database: ref, secrets: names });
    return;
  }
  console.log(chalk.bold("Секреты") + chalk.dim(" — только имена, значения не показываются никогда"));
  if (names.length) for (const n of names) console.log(`  ${n}`);
  else console.log(chalk.dim(`  нет — задать: layero data secrets set TELEGRAM_BOT_TOKEN --db ${ref}`));
}

export async function dataSecretsSetCmd(name: string, opts: CallsOptions): Promise<void> {
  let value: string | undefined;
  if (opts.fromEnv) {
    value = process.env[opts.fromEnv];
    if (!value) throw new LayeroError("bad_format", `переменная окружения ${opts.fromEnv} пуста или не задана`, "задайте её или передайте значение через stdin");
  } else if (!process.stdin.isTTY) {
    value = await readStdin();
  } else {
    value = await askHidden(`значение ${name}: `);
  }
  if (!value) {
    throw new LayeroError(
      "bad_format",
      "пустое значение секрета",
      `передайте значение через stdin: printf %s "$TOKEN" | layero data secrets set ${name}`,
    );
  }
  const { api, org, db, ref } = await target(opts);
  await api.setDataSecret(org, db.id, name, value);
  if (asJson(opts)) {
    emit({ event: "data_secret_set", org, database: ref, name });
    return;
  }
  console.log(`${chalk.green("✓")} секрет ${name} сохранён — в вызове: {{secrets.${name}}}`);
}

export async function dataSecretsRemoveCmd(name: string, opts: DataApiOptions): Promise<void> {
  const { api, org, db, ref } = await target(opts);
  const ok = await confirmed(`удалить секрет ${name}? Вызовы, которые его подставляют, начнут отказывать`, opts);
  if (ok === null) throw notConfirmed(`удаление секрета ${name}`, `layero data secrets remove ${name} --db ${ref}`);
  if (!ok) {
    console.log(chalk.yellow("отменено."));
    return;
  }
  await api.deleteDataSecret(org, db.id, name);
  if (asJson(opts)) {
    emit({ event: "data_secret_removed", org, database: ref, name });
    return;
  }
  console.log(`${chalk.green("✓")} секрет ${name} удалён`);
}

// ── вызовы ──────────────────────────────────────────────────────────────────

/** Описание из файла → тело запроса. Те же поля, что на странице документации. */
export function parseCallSpec(text: string, source: string): Schemas["CallIn"] {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LayeroError("bad_format", `${source}: не JSON`, "описание вызова — JSON-объект с полями name и url_template");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LayeroError("bad_format", `${source}: ожидался JSON-объект`, "описание вызова — JSON-объект с полями name и url_template");
  }
  for (const field of ["name", "url_template"]) {
    if (typeof raw[field] !== "string" || !raw[field]) {
      throw new LayeroError("bad_format", `${source}: нет поля ${field}`, "описание вызова — JSON-объект с полями name и url_template");
    }
  }
  return {
    name: raw.name,
    method: typeof raw.method === "string" ? raw.method.toUpperCase() : "POST",
    url_template: raw.url_template,
    headers: raw.headers ?? null,
    body_template: raw.body_template ?? null,
    allow_anon: raw.allow_anon === true,
    hourly_limit: Number.isInteger(raw.hourly_limit) ? raw.hourly_limit : 600,
  };
}

export async function dataCallsListCmd(opts: DataApiOptions): Promise<void> {
  const { api, org, db, ref } = await target(opts);
  const calls = await api.listDataCalls(org, db.id);
  if (asJson(opts)) {
    emit({ event: "data_calls", org, database: ref, calls });
    return;
  }
  if (!calls.length) {
    console.log(chalk.dim(`вызовов нет — описать: layero data calls set --file call.json --db ${ref}`));
    return;
  }
  for (const c of calls) {
    console.log(`${chalk.bold(c.name)}  ${c.method} ${c.url_template}${c.allow_anon ? chalk.yellow("  публичный ключ") : ""}`);
    console.log(chalk.dim(`  из базы: INSERT INTO api.outbox (call_name, args) VALUES ('${c.name}', …); с сайта: POST /call/${c.name}`));
  }
}

export async function dataCallsSetCmd(opts: CallsOptions): Promise<void> {
  if (!opts.file) {
    throw new LayeroError("bad_format", "не указан файл описания", "layero data calls set --file telegram_notify.json");
  }
  const text = opts.file === "-" ? await readStdin() : await readFile(opts.file, "utf8");
  const call = parseCallSpec(text, opts.file === "-" ? "stdin" : opts.file);
  const { api, org, db, ref } = await target(opts);
  await api.saveDataCall(org, db.id, call);
  if (asJson(opts)) {
    emit({ event: "data_call_saved", org, database: ref, name: call.name });
    return;
  }
  console.log(
    `${chalk.green("✓")} вызов ${call.name} описан у базы «${db.name}»\n` +
      chalk.dim(`  из базы: INSERT INTO api.outbox (call_name, args) VALUES ('${call.name}', '{…}'::jsonb)\n`) +
      chalk.dim(`  журнал: layero data calls log --db ${ref}`),
  );
}

export async function dataCallsRemoveCmd(name: string, opts: DataApiOptions): Promise<void> {
  const { api, org, db, ref } = await target(opts);
  const ok = await confirmed(`удалить вызов ${name}? Новые строки api.outbox с этим именем будут отклонены`, opts);
  if (ok === null) throw notConfirmed(`удаление вызова ${name}`, `layero data calls remove ${name} --db ${ref}`);
  if (!ok) {
    console.log(chalk.yellow("отменено."));
    return;
  }
  await api.deleteDataCall(org, db.id, name);
  if (asJson(opts)) {
    emit({ event: "data_call_removed", org, database: ref, name });
    return;
  }
  console.log(`${chalk.green("✓")} вызов ${name} удалён`);
}

export async function dataCallsLogCmd(opts: CallsOptions): Promise<void> {
  const { api, org, db, ref } = await target(opts);
  const limit = Math.min(Math.max(Number(opts.limit ?? 20) || 20, 1), 200);
  const rows = await api.listDataCallLog(org, db.id, limit);
  if (asJson(opts)) {
    emit({ event: "data_call_log", org, database: ref, calls: rows });
    return;
  }
  if (!rows.length) {
    console.log(chalk.dim("вызовов ещё не было"));
    return;
  }
  for (const r of rows) {
    const verdict = r.error ? chalk.red(r.error) : r.status_code && r.status_code < 400 ? chalk.green(String(r.status_code)) : chalk.yellow(String(r.status_code ?? "—"));
    console.log(`${r.at}  ${r.call_name}  ${r.mode === "queue" ? "очередь" : "синхронно"}  ${verdict}`);
  }
}

export function registerDataCallsCommands(
  data: Command,
  withDb: (c: Command) => Command,
  json: (opts: any) => any,
): void {
  const hosts = data.command("hosts").description("Hosts the gateway may call for the database's outbound calls.");
  withDb(hosts.command("list").description("Allowed hosts.")).action(async (opts: any) => dataHostsListCmd(json(opts)));
  withDb(hosts.command("add <host>").description("Allow a host, e.g. api.telegram.org."))
    .action(async (host: string, opts: any) => dataHostsAddCmd(host, json(opts)));
  withDb(hosts.command("remove <host>").description("Remove a host.").option("-y, --yes", "do not ask for confirmation"))
    .action(async (host: string, opts: any) => dataHostsRemoveCmd(host, json(opts)));

  const secrets = data.command("secrets").description("Secrets substituted into outbound calls as {{secrets.NAME}}. Values are never shown.");
  withDb(secrets.command("list").description("Secret names.")).action(async (opts: any) => dataSecretsListCmd(json(opts)));
  withDb(
    secrets
      .command("set <name>")
      .description("Set a secret. The value is read from stdin, from --from-env, or typed without echo.")
      .option("--from-env <var>", "take the value from this environment variable")
      .addHelpText("after", '\nExample:\n  $ printf %s "$BOT_TOKEN" | layero data secrets set TELEGRAM_BOT_TOKEN'),
  ).action(async (name: string, opts: any) => dataSecretsSetCmd(name, json(opts)));
  withDb(secrets.command("remove <name>").description("Delete a secret.").option("-y, --yes", "do not ask for confirmation"))
    .action(async (name: string, opts: any) => dataSecretsRemoveCmd(name, json(opts)));

  const calls = data.command("calls").description("Outbound calls: webhooks and Telegram from the database (api.outbox) or the site (POST /call/<name>).");
  withDb(calls.command("list").description("Described calls.")).action(async (opts: any) => dataCallsListCmd(json(opts)));
  withDb(
    calls
      .command("set")
      .description("Create or replace a call from a JSON description: name, method, url_template, headers, body_template, allow_anon.")
      .option("--file <path>", "JSON file with the description, - for stdin")
      .addHelpText(
        "after",
        "\nThe host of url_template must be allowed first: layero data hosts add <host>.\n" +
          "\nExample (telegram_notify.json):\n" +
          '  {"name": "telegram_notify", "method": "POST",\n' +
          '   "url_template": "https://api.telegram.org/bot{{secrets.TELEGRAM_BOT_TOKEN}}/sendMessage",\n' +
          '   "body_template": {"chat_id": "{{args.chat_id}}", "text": "{{args.text}}"}}',
      ),
  ).action(async (opts: any) => dataCallsSetCmd(json(opts)));
  withDb(calls.command("remove <name>").description("Delete a call.").option("-y, --yes", "do not ask for confirmation"))
    .action(async (name: string, opts: any) => dataCallsRemoveCmd(name, json(opts)));
  withDb(calls.command("log").description("Recent calls: status code and refusal reason.").option("--limit <n>", "how many, up to 200", "20"))
    .action(async (opts: any) => dataCallsLogCmd(json(opts)));
}
