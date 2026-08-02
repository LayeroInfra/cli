/**
 * Имя аккаунта (оно же слаг личной организации) — из терминала.
 *
 * WHY (02.08.2026): без имени бэкенд отвечает 412 на создание проекта, а CLI
 * умел только отправить в браузер: «откройте /onboarding и выберите имя». Для
 * инструмента, который весь смысл имеет в том, чтобы не ходить в дашборд, это
 * тупик — и в нём на момент правки сидело 14 активных аккаунтов. Ручка
 * `POST /auth/me/username` была всё это время, `setUsername` лежал в api.ts и
 * не вызывался ниоткуда.
 *
 * Имя НЕ подбирается молча: оно становится слагом личной организации и попадёт
 * в адреса, то есть это выбор человека, а не догадка программы. Мы только
 * предлагаем вариант по почте или логину GitHub — принять или заменить.
 */
import readline from "node:readline/promises";
import chalk from "chalk";
import { ApiClient, MeOut } from "./api.js";
import { LayeroError, detectMode, emit } from "./agent.js";

/** Правила совпадают с CHECK-ограничением в БД (V044). */
const MIN_LEN = 2;
const MAX_LEN = 32;

/**
 * Привести произвольную строку к допустимому виду: строчные, только
 * `[a-z0-9-]`, без ведущих/замыкающих и сдвоенных дефисов.
 *
 * Это ПОДСКАЗКА для приглашения ввода, а не валидация — последнее слово всегда
 * за сервером (`checkUsername`), иначе правила разъедутся молча.
 */
export function suggestUsername(me: Pick<MeOut, "email" | "github_login">): string {
  const raw = me.github_login || (me.email ?? "").split("@")[0] || "";
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_LEN)
    .replace(/-+$/g, "");
  return slug.length >= MIN_LEN ? slug : "";
}

async function ask(question: string, fallback: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const hint = fallback ? ` [${fallback}]` : "";
    const answer = (await rl.question(`${question}${hint}: `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

/** Человеческий текст на код отказа от `/auth/me/username/check`. */
function reasonText(reason: string | null, value: string): string {
  switch (reason) {
    case "taken":
      return `Имя «${value}» уже занято.`;
    case "reserved":
      return `Имя «${value}» зарезервировано платформой.`;
    case "too_short":
      return `Слишком коротко — нужно от ${MIN_LEN} символов.`;
    case "too_long":
      return `Слишком длинно — не больше ${MAX_LEN} символов.`;
    default:
      return `Имя «${value}» не подходит: только строчные латинские буквы, цифры и дефис.`;
  }
}

/**
 * Вернуть имя аккаунта, спросив его, если не задано.
 *
 * В агентском/неинтерактивном режиме НЕ спрашиваем — там некому отвечать, и
 * приглашение ввода просто повисло бы навсегда. Вместо этого понятный отказ с
 * кодом и командой, которую агент может выполнить сам.
 */
export async function ensureUsername(api: ApiClient, me?: MeOut): Promise<string> {
  const current = me ?? (await api.me());
  if (current.username) return current.username;

  const mode = detectMode();
  if (!mode.interactive) {
    throw new LayeroError(
      "username_required",
      "У аккаунта не выбрано имя — без него платформе некуда положить проект.",
      "задайте его: `layero username <имя>` (строчные латинские буквы, цифры и дефис)",
    );
  }

  console.log(
    chalk.cyan("\nУ аккаунта ещё нет имени.") +
      chalk.dim(
        "\n  Оно станет адресом вашей личной организации, поэтому выбираете вы.\n" +
          "  Строчные латинские буквы, цифры и дефис.\n",
      ),
  );

  let fallback = suggestUsername(current);
  for (let attempt = 0; attempt < 5; attempt++) {
    const value = await ask("Имя аккаунта", fallback);
    if (!value) continue;

    const check = await api.checkUsername(value);
    if (!check.available) {
      console.log(chalk.yellow(`  ${reasonText(check.reason, check.normalized || value)}`));
      // Занятое имя не предлагаем повторно — иначе Enter молча упрётся в то же.
      fallback = "";
      continue;
    }
    const saved = await api.setUsername(check.normalized);
    console.log(
      chalk.green(`✓ Имя аккаунта: ${saved.username}`) +
        chalk.dim(` (организация ${saved.organization_slug})`),
    );
    return saved.username;
  }

  throw new LayeroError(
    "username_required",
    "Имя аккаунта так и не выбрано.",
    "задайте его: `layero username <имя>`",
  );
}

/** `layero username <value>` — неинтерактивный путь для агентов и CI. */
export async function usernameSetCmd(value: string, api: ApiClient): Promise<void> {
  const check = await api.checkUsername(value);
  if (!check.available) {
    throw new LayeroError(
      "username_rejected",
      reasonText(check.reason, check.normalized || value),
      "выберите другое имя: строчные латинские буквы, цифры и дефис",
    );
  }
  const saved = await api.setUsername(check.normalized);
  emit({
    event: "username_set",
    username: saved.username,
    organization: saved.organization_slug,
  });
}
