// `layero data auth …` — вход пользователей приложения из терминала (R2-18, 27.10.2026).
//
// Раньше провайдеры (Яндекс, VK ID, Сбер ID), их адреса возврата и способы
// входа включались только в панели — единственный шаг эталонного приложения
// без команды. Ручки сервера те же, что у панели.
//
// ⚠️ Секрет провайдера НЕ принимается аргументом: аргумент оседает в истории
// shell и в списке процессов. Только stdin или переменная окружения.
import chalk from "chalk";
import type { Command } from "commander";
import { LayeroError, detectMode, emit } from "../agent.js";
import { type DataApiOptions, target } from "./data-api.js";

const PROVIDERS = ["yandex", "vkid", "sber"] as const;
const TITLE: Record<string, string> = { yandex: "Яндекс", vkid: "VK ID", sber: "Сбер ID" };

interface ProviderOptions extends DataApiOptions {
  clientId?: string;
  secretFromEnv?: string;
}

interface MethodsOptions extends DataApiOptions {
  password?: string;
  link?: string;
  signup?: string;
  confirmEmail?: string;
}

function asJson(opts: DataApiOptions): boolean {
  return detectMode().json || Boolean(opts.json);
}

function provider(name: string): string {
  const p = name.trim().toLowerCase();
  if (!(PROVIDERS as readonly string[]).includes(p)) {
    throw new LayeroError("invalid_choice", `провайдер «${name}» не поддержан`, `доступны: ${PROVIDERS.join(", ")}`);
  }
  return p;
}

function onOff(flag: string, value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (["on", "yes", "true", "1"].includes(v)) return true;
  if (["off", "no", "false", "0"].includes(v)) return false;
  throw new LayeroError("invalid_choice", `${flag}: ждали on или off, а пришло «${value}»`, `пример: ${flag} on`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function dataAuthStatusCmd(opts: DataApiOptions): Promise<void> {
  const { api, org, db, ref } = await target(opts);
  const s = await api.getDataAuthState(org, db.id);
  const providers = (s.providers ?? []).map((p: any) => ({
    provider: p.provider, configured: Boolean(p.configured), enabled: Boolean(p.enabled),
    checked_at: p.checked_at ?? null, return_urls: p.return_urls ?? [],
  }));
  const methods = {
    password: s.password_enabled ?? null, link: s.magiclink_enabled ?? null,
    signup_open: s.signup_open ?? null, confirm_email: s.confirm_email ?? null,
  };
  if (asJson(opts)) {
    emit({ event: "data_auth_status", org, database: ref, callback_url: s.callback_url ?? null,
      providers, methods, email_return_urls: s.email_return_urls ?? [] });
    return;
  }
  const yn = (v: boolean | null) => (v === null ? "—" : v ? "да" : "нет");
  console.log(chalk.bold("Способы входа"));
  console.log(`  по паролю: ${yn(methods.password)}, по ссылке из письма: ${yn(methods.link)}, ` +
    `регистрация открыта: ${yn(methods.signup_open)}, подтверждение почты: ${yn(methods.confirm_email)}`);
  console.log(chalk.bold("\nПровайдеры"));
  for (const p of providers) {
    const state = p.enabled ? chalk.green("включён") : p.configured ? chalk.yellow("ключи есть, выключен") : chalk.dim("не подключён");
    console.log(`  ${TITLE[p.provider] ?? p.provider}: ${state}`);
  }
  if (s.callback_url) console.log(chalk.dim(`\nАдрес возврата для консоли провайдера: ${s.callback_url}`));
}

export async function dataAuthProviderSetCmd(name: string, opts: ProviderOptions): Promise<void> {
  const p = provider(name);
  if (!opts.clientId) {
    throw new LayeroError("bad_format", "не задан Client ID", `layero data auth provider set ${p} --client-id <id>`);
  }
  let secret = "";
  if (p !== "vkid") {
    if (opts.secretFromEnv) {
      secret = process.env[opts.secretFromEnv] ?? "";
      if (!secret) throw new LayeroError("bad_format", `переменная окружения ${opts.secretFromEnv} пуста или не задана`, "задайте её или передайте секрет через stdin");
    } else if (!process.stdin.isTTY) {
      secret = await readStdin();
    }
    if (!secret) {
      throw new LayeroError("bad_format", `у ${TITLE[p]} нужен секрет`,
        `передайте его через stdin или --secret-from-env: printf %s "$SECRET" | layero data auth provider set ${p} --client-id <id>`);
    }
  }
  const { api, org, db, ref } = await target(opts);
  await api.setDataAuthProvider(org, db.id, { provider: p, client_id: opts.clientId, client_secret: secret });
  const s = await api.getDataAuthState(org, db.id);
  if (asJson(opts)) {
    emit({ event: "data_auth_provider_set", org, database: ref, provider: p, callback_url: s.callback_url ?? null });
    return;
  }
  console.log(`${chalk.green("✓")} вход через ${TITLE[p]} подключён`);
  if (s.callback_url) console.log(chalk.dim(`  впишите в консоли провайдера адрес возврата: ${s.callback_url}`));
  console.log(chalk.dim("  проверьте вход в панели: Авторизация → Способы входа → «Проверить вход»"));
}

export async function dataAuthProviderToggleCmd(name: string, enabled: boolean, opts: DataApiOptions): Promise<void> {
  const p = provider(name);
  const { api, org, db, ref } = await target(opts);
  await api.setDataAuthProviderOptions(org, db.id, p, { enabled });
  if (asJson(opts)) {
    emit({ event: "data_auth_provider_toggled", org, database: ref, provider: p, enabled });
    return;
  }
  console.log(`${chalk.green("✓")} вход через ${TITLE[p]} ${enabled ? "включён" : "выключен, ключи сохранены"}`);
}

export async function dataAuthProviderRemoveCmd(name: string, opts: DataApiOptions): Promise<void> {
  const p = provider(name);
  const { api, org, db, ref } = await target(opts);
  if (!opts.yes) {
    throw new LayeroError("confirmation_required", `удаление ключей ${TITLE[p]} не подтверждено`,
      `повторите с --yes: layero data auth provider remove ${p} --yes`);
  }
  await api.deleteDataAuthProvider(org, db.id, p);
  if (asJson(opts)) {
    emit({ event: "data_auth_provider_removed", org, database: ref, provider: p });
    return;
  }
  console.log(`${chalk.green("✓")} ключи ${TITLE[p]} удалены, вход через него закрыт`);
}

/** `email` — адреса возврата писем входа, иначе — провайдера. */
export async function dataAuthRedirectsCmd(
  action: "list" | "add" | "remove", method: string, url: string | undefined, opts: DataApiOptions,
): Promise<void> {
  const m = method.trim().toLowerCase() === "email" ? "email" : provider(method);
  if (action !== "list" && !url) {
    throw new LayeroError("bad_format", "не задан адрес", `layero data auth redirects ${action} ${m} https://shop.example/auth`);
  }
  if (url && !/^https?:\/\//i.test(url)) {
    throw new LayeroError("bad_format", `адрес «${url}» должен начинаться с http:// или https://`, "пример: https://shop.example/auth");
  }
  const { api, org, db, ref } = await target(opts);
  const s = await api.getDataAuthState(org, db.id);
  const current: string[] = m === "email"
    ? (s.email_return_urls ?? [])
    : ((s.providers ?? []).find((p: any) => p.provider === m)?.return_urls ?? []);
  let next = current;
  if (action === "add") next = current.includes(url!) ? current : [...current, url!];
  if (action === "remove") next = current.filter((u) => u !== url);
  if (action !== "list") {
    if (m === "email") await api.setDataAuthSettings(org, db.id, { email_return_urls: next });
    else await api.setDataAuthProviderOptions(org, db.id, m, { return_urls: next });
  }
  if (asJson(opts)) {
    emit({ event: "data_auth_redirects", org, database: ref, method: m, urls: next });
    return;
  }
  console.log(chalk.bold(`Адреса возврата: ${m === "email" ? "письма входа" : TITLE[m]}`));
  for (const u of next) console.log(`  ${u}`);
  if (!next.length) console.log(chalk.dim("  нет — после входа человек вернётся на адрес подключённого проекта"));
}

export async function dataAuthMethodsCmd(opts: MethodsOptions): Promise<void> {
  const patch: Record<string, boolean> = {};
  const set = (key: string, flag: string, value: string | undefined) => {
    const v = onOff(flag, value);
    if (v !== undefined) patch[key] = v;
  };
  set("password_enabled", "--password", opts.password);
  set("magiclink_enabled", "--link", opts.link);
  set("signup_open", "--signup", opts.signup);
  set("confirm_email", "--confirm-email", opts.confirmEmail);
  if (!Object.keys(patch).length) {
    throw new LayeroError("nothing_to_set", "не задан ни один способ",
      "пример: layero data auth methods --password on --link off --signup on");
  }
  const { api, org, db, ref } = await target(opts);
  await api.setDataAuthSettings(org, db.id, patch);
  if (asJson(opts)) {
    emit({ event: "data_auth_methods_set", org, database: ref, changed: patch });
    return;
  }
  console.log(`${chalk.green("✓")} способы входа обновлены: ${Object.entries(patch).map(([k, v]) => `${k}=${v ? "on" : "off"}`).join(", ")}`);
}

export function registerDataAuthCommands(
  auth: Command,
  withDb: (c: Command) => Command,
  json: (opts: any) => any,
): void {
  withDb(auth.command("status").description("Sign-in methods, providers and the callback URL for the provider console."))
    .action(async (opts: any) => dataAuthStatusCmd(json(opts)));

  const prov = auth.command("provider").description("External providers: yandex, vkid, sber.");
  withDb(
    prov
      .command("set <provider>")
      .description("Save the provider's keys and enable it. The secret is read from stdin or --secret-from-env (VK ID has none).")
      .requiredOption("--client-id <id>", "Client ID from the provider's console")
      .option("--secret-from-env <var>", "take the secret from this environment variable")
      .addHelpText("after", '\nExample:\n  $ printf %s "$YANDEX_SECRET" | layero data auth provider set yandex --client-id 1a2b3c'),
  ).action(async (name: string, opts: any) => dataAuthProviderSetCmd(name, json(opts)));
  withDb(prov.command("on <provider>").description("Enable a provider whose keys are saved."))
    .action(async (name: string, opts: any) => dataAuthProviderToggleCmd(name, true, json(opts)));
  withDb(prov.command("off <provider>").description("Disable a provider, keeping its keys."))
    .action(async (name: string, opts: any) => dataAuthProviderToggleCmd(name, false, json(opts)));
  withDb(prov.command("remove <provider>").description("Delete the provider's keys.").option("-y, --yes", "do not ask for confirmation"))
    .action(async (name: string, opts: any) => dataAuthProviderRemoveCmd(name, json(opts)));

  const red = auth.command("redirects").description("Where the app may send people back after sign-in: per provider, or `email` for sign-in emails.");
  withDb(red.command("list <method>").description("Return addresses of a provider or of `email`."))
    .action(async (method: string, opts: any) => dataAuthRedirectsCmd("list", method, undefined, json(opts)));
  withDb(red.command("add <method> <url>").description("Allow a return address."))
    .action(async (method: string, url: string, opts: any) => dataAuthRedirectsCmd("add", method, url, json(opts)));
  withDb(red.command("remove <method> <url>").description("Remove a return address."))
    .action(async (method: string, url: string, opts: any) => dataAuthRedirectsCmd("remove", method, url, json(opts)));

  withDb(
    auth
      .command("methods")
      .description("Turn sign-in methods on or off.")
      .option("--password <on|off>", "email and password")
      .option("--link <on|off>", "link or code from an email")
      .option("--signup <on|off>", "new users may register")
      .option("--confirm-email <on|off>", "require email confirmation"),
  ).action(async (opts: any) => dataAuthMethodsCmd(json(opts)));
}
