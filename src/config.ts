import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface CliConfig {
  apiUrl: string;
  token?: string;
  user?: {
    id: string;
    username: string | null;
    email?: string | null;
  };
  // Токены claimable-проектов (этап 13): проект → токен, выданный при
  // создании заявки. Живут здесь, а не в `.layero/project.json`: та папка
  // уходит в git, а токен даёт право деплоить в проект до конца срока.
  claim_tokens?: Record<string, string>;
  // Код и ссылка забора песочницы: проект → заявка. 🚨 ТОЖЕ ЗДЕСЬ, а не в
  // `.layero/project.json` (T-20260921): код забора в публичном репозитории —
  // это сайт, который заберёт первый встречный с аккаунтом. До 0.11.8 код
  // писался в project.json; такие файлы по-прежнему читаются.
  claims?: Record<string, SandboxClaim>;
}

/** Заявка песочницы: чем и где человек заберёт сайт в аккаунт. */
export interface SandboxClaim {
  code: string;
  claim_url: string;
  expires_at: string;
}

const CONFIG_DIR = path.join(homedir(), ".layero");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const DEFAULT_API_URL = process.env.LAYERO_API_URL ?? "https://api.layero.ru";

async function ensureDir(): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
}

// Долгоживущий токен для CI. Выпускается в дашборде, кладётся в секреты
// репозитория и попадает сюда через окружение — на раннере нет ни `layero
// login` (некому пройти device flow), ни конфиг-файла.
//
// Приоритет выше файла намеренно: если на машине есть и то и другое,
// окружение выигрывает. Иначе локальный конфиг разработчика молча
// перебивал бы токен, заданный в CI, и деплой уходил бы не в тот аккаунт.
const ENV_TOKEN = process.env.LAYERO_TOKEN?.trim() || undefined;

export async function loadConfig(): Promise<CliConfig> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    return {
      apiUrl: parsed.apiUrl ?? DEFAULT_API_URL,
      token: ENV_TOKEN ?? parsed.token,
      // Пользователя из файла не подставляем, когда токен пришёл из
      // окружения: файл мог остаться от другого аккаунта, и подпись в
      // выводе врала бы. Кто мы — узнаем у API.
      user: ENV_TOKEN ? undefined : parsed.user,
      claim_tokens: parsed.claim_tokens,
      claims: parsed.claims,
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { apiUrl: DEFAULT_API_URL, token: ENV_TOKEN };
    }
    throw err;
  }
}

export async function saveConfig(cfg: CliConfig): Promise<void> {
  await ensureDir();
  const data = JSON.stringify(cfg, null, 2);
  await fs.writeFile(CONFIG_FILE, data, { encoding: "utf-8", mode: 0o600 });
  // Re-chmod in case the file already existed with looser perms. On Windows
  // this is a no-op (NTFS ignores POSIX bits) — file ACLs default to the
  // user's profile, which is the right scope.
  if (process.platform !== "win32") {
    await fs.chmod(CONFIG_FILE, 0o600);
  }
}

/**
 * Записать заявку песочницы в файл конфига, не трогая остального.
 *
 * Читает и пишет САМ файл, а не результат `loadConfig`: тот подставляет
 * `LAYERO_TOKEN` из окружения, и запись через него унесла бы токен CI в
 * файл на диске.
 */
export async function saveClaim(projectId: string, claim: SandboxClaim): Promise<void> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await fs.readFile(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  const claims = { ...((raw.claims as Record<string, SandboxClaim> | undefined) ?? {}), [projectId]: claim };
  await ensureDir();
  await fs.writeFile(CONFIG_FILE, JSON.stringify({ ...raw, claims }, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  if (process.platform !== "win32") await fs.chmod(CONFIG_FILE, 0o600);
}

/**
 * Забыть песочницу: её токен и заявку (T-20260919-3). Зовётся, когда
 * песочницы больше нет или её забрали, — мёртвый токен иначе подхватывала бы
 * каждая следующая выкатка из этой папки. Пишет сам файл (см. `saveClaim`).
 */
export async function forgetSandbox(projectId: string): Promise<void> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await fs.readFile(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw err;
  }
  const tokens = { ...((raw.claim_tokens as Record<string, string> | undefined) ?? {}) };
  const claims = { ...((raw.claims as Record<string, SandboxClaim> | undefined) ?? {}) };
  delete tokens[projectId];
  delete claims[projectId];
  await fs.writeFile(CONFIG_FILE, JSON.stringify({ ...raw, claim_tokens: tokens, claims }, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  if (process.platform !== "win32") await fs.chmod(CONFIG_FILE, 0o600);
}

export async function clearConfig(): Promise<void> {
  try {
    await fs.unlink(CONFIG_FILE);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw err;
    }
  }
}

export function configPath(): string {
  return CONFIG_FILE;
}
