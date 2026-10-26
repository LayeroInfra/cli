// `layero data secrets` — секреты базы для HTTP из SQL и входа (27.10.2026).
//
// Секрет подставляется шлюзом в `{{secrets.ИМЯ}}` в адресе, заголовках и теле
// запроса `net.http_post(...)` — значение в базу не попадает. Прежние команды
// `data hosts` и `data calls` («Исходящие») сняты: запрос теперь обычная
// функция базы.
//
//   printf %s "$BOT_TOKEN" | layero data secrets set TELEGRAM_BOT_TOKEN
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

export function registerDataSecretsCommands(
  data: Command,
  withDb: (c: Command) => Command,
  json: (opts: any) => any,
): void {
  const secrets = data.command("secrets").description("Secrets substituted into net.http_* requests as {{secrets.NAME}}. Values are never shown.");
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

}
