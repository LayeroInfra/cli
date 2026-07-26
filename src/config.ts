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
