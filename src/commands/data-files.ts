// `layero data buckets` и `layero data auth sender` — то, что раньше
// делалось только в панели (прогон 2 «Замечено», R2-04 и R2-08, 27.10.2026).
//
// Бакет создаётся тем же коротким ключом хранилища, что у раздела «Файлы»
// панели: выпускать секретный ключ ради одной настройки не нужно.
import chalk from "chalk";
import type { Command } from "commander";
import { LayeroError, detectMode, emit } from "../agent.js";
import { type DataApiOptions, target } from "./data-api.js";

interface BucketOptions extends DataApiOptions {
  public?: boolean;
  private?: boolean;
  max?: string;
  types?: string;
}

function asJson(opts: DataApiOptions): boolean {
  return detectMode().json || Boolean(opts.json);
}

/** «5MB», «512KB», «1.5 GB», «1048576» → байты. */
export function parseSize(raw: string): number {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(raw);
  if (!m) {
    throw new LayeroError("bad_format", `не понял размер «${raw}»`, "пишите так: 5MB, 512KB или число байт");
  }
  const n = parseFloat((m[1] ?? "0").replace(",", "."));
  const unit = (m[2] ?? "b").toLowerCase();
  const mult = unit === "gb" ? 1024 ** 3 : unit === "mb" ? 1024 ** 2 : unit === "kb" ? 1024 : 1;
  return Math.round(n * mult);
}

async function gateway<T>(url: string, key: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${url}/storage/v1${path}`, {
    ...init,
    headers: { apikey: key, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message = body?.message || body?.error || `${res.status}`;
    throw new LayeroError("storage_refused", `хранилище отказало: ${message}`, body?.hint ?? refusalAdvice(res.status, body));
  }
  return body as T;
}

/** Совет по отказу — по его причине. Раньше на любой отказ советовали
 *  включить файлы, и на «бакет уже есть» это был совет мимо (R2-04, 27.10). */
function refusalAdvice(status: number, body: any): string {
  const text = `${body?.error ?? ""} ${body?.message ?? ""} ${body?.statusCode ?? ""}`.toLowerCase();
  if (status === 409 || text.includes("already exists") || text.includes("duplicate")) {
    return "бакет с таким именем уже есть — посмотреть: layero data buckets list, или выберите другое имя";
  }
  if (status === 401 || status === 403) {
    return "ключ хранилища не подошёл — повторите команду; не помогло — проверьте, что файлы включены: layero data enable --storage";
  }
  if (status === 400 && text.includes("name")) {
    return "имя бакета — латиница, цифры, дефис и подчёркивание";
  }
  return "проверьте, что файлы включены: layero data enable --storage";
}

export async function dataBucketsListCmd(opts: DataApiOptions): Promise<void> {
  const { api, org, db, ref } = await target(opts);
  const s = await api.openStorageSession(org, db.id);
  const buckets = await gateway<any[]>(s.url, s.key, "/bucket");
  if (asJson(opts)) {
    emit({ event: "data_buckets", org, database: ref, buckets });
    return;
  }
  if (!buckets.length) {
    console.log(chalk.dim(`бакетов нет — создать: layero data buckets create uploads --db ${ref}`));
    return;
  }
  for (const b of buckets) {
    const limit = b.file_size_limit ? `, до ${b.file_size_limit} байт` : "";
    const types = b.allowed_mime_types?.length ? `, ${b.allowed_mime_types.join(" ")}` : "";
    console.log(`  ${b.id}  ${b.public ? "публичный" : "закрытый"}${limit}${types}`);
  }
}

export async function dataBucketsCreateCmd(name: string, opts: BucketOptions): Promise<void> {
  if (opts.public && opts.private) {
    throw new LayeroError("bad_format", "бакет либо публичный, либо закрытый", "оставьте один из флагов --public и --private");
  }
  const body = {
    id: name,
    name,
    public: Boolean(opts.public),
    file_size_limit: opts.max ? parseSize(opts.max) : null,
    allowed_mime_types: opts.types
      ? opts.types.split(",").map((t) => t.trim()).filter(Boolean)
      : null,
  };
  const { api, org, db, ref } = await target(opts);
  const s = await api.openStorageSession(org, db.id);
  await gateway(s.url, s.key, "/bucket", { method: "POST", body: JSON.stringify(body) });
  if (asJson(opts)) {
    emit({ event: "data_bucket_created", org, database: ref, bucket: name, public: body.public,
      file_size_limit: body.file_size_limit, allowed_mime_types: body.allowed_mime_types });
    return;
  }
  console.log(`${chalk.green("✓")} бакет ${name} создан — ${body.public ? "публичный" : "закрытый"}`);
  if (!body.public) {
    console.log(chalk.dim("  кто может читать и загружать — решают политики: раздел «Файлы» панели или SQL на storage.objects"));
  }
}

export async function dataAuthSenderCmd(name: string, opts: DataApiOptions & { replyTo?: string }): Promise<void> {
  const value = name.trim();
  if (!value) throw new LayeroError("bad_format", "пустое имя отправителя", 'пример: layero data auth sender "Замечено"');
  const emails: Record<string, string> = { sender_name: value };
  if (opts.replyTo) emails.reply_to = opts.replyTo;
  const { api, org, db, ref } = await target(opts);
  await api.setDataAuthSettings(org, db.id, { emails });
  if (asJson(opts)) {
    emit({ event: "data_auth_sender_set", org, database: ref, sender_name: value, reply_to: opts.replyTo ?? null });
    return;
  }
  console.log(`${chalk.green("✓")} письма входа уходят от имени «${value}»`);
}

export function registerDataFilesCommands(
  data: Command,
  withDb: (c: Command) => Command,
  json: (opts: any) => any,
): void {
  const buckets = data.command("buckets").description("Storage buckets: list and create without the dashboard or a secret key.");
  withDb(buckets.command("list").description("The database's buckets.")).action(async (opts: any) => dataBucketsListCmd(json(opts)));
  withDb(
    buckets
      .command("create <name>")
      .description("Create a bucket. Private by default: who reads and uploads is decided by policies.")
      .option("--public", "anyone with the link can download files")
      .option("--private", "private (the default)")
      .option("--max <size>", "file size limit: 5MB, 512KB or bytes")
      .option("--types <list>", "allowed MIME types, comma-separated: image/jpeg,image/png")
      .addHelpText("after", "\nExample:\n  $ layero data buckets create screenshots --private --max 5MB --types image/jpeg,image/png"),
  ).action(async (name: string, opts: any) => dataBucketsCreateCmd(name, json(opts)));

  const auth = data.command("auth").description("Sign-in settings that used to live only in the dashboard.");
  withDb(
    auth
      .command("sender <name>")
      .description("The sender name of sign-in emails (codes, links, password reset).")
      .option("--reply-to <email>", "address for replies"),
  ).action(async (name: string, opts: any) => dataAuthSenderCmd(name, json(opts)));
}
