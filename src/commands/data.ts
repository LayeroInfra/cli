import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { ApiClient } from "../api.js";
import { loadConfig } from "../config.js";
import { loadProjectConfig } from "../project-config.js";
import { LayeroError, detectMode, emit } from "../agent.js";

/**
 * `layero data env` (DATA-07) — адрес и публичный ключ Data API на локальную
 * машину.
 *
 * 🚨 ЗДЕСЬ СОЗНАТЕЛЬНО НАРУШЕНО ПРАВИЛО СОСЕДНЕЙ КОМАНДЫ. `layero env` не
 * показывает значения вообще — ни в терминале, ни агенту: по началу строки
 * опознаётся и провайдер, и нередко сам ключ, а вывод агента оседает в
 * переписке. Публичный ключ Data API — другой случай по устройству: он уезжает
 * в бандл фронтенда и виден любому посетителю сайта. Прятать его от владельца
 * проекта — обряд, а не защита, и обряд с ценой: без ключа на машине человек
 * не напишет и первой строки фронтенда.
 *
 * Секретный `sk_` не отдаётся ни здесь, ни где-либо ещё: он для сервера, и
 * место ему не в файле, который лежит рядом с исходниками.
 *
 * ⚠️ Файл пишется рядом с кодом, поэтому команда проверяет `.gitignore`.
 * Ключ не секрет, но `.env.local` в репозитории — привычка, которая однажды
 * унесёт туда настоящий секрет.
 */

interface DataEnvOptions {
  project?: string;
  json?: boolean;
  write?: boolean;
  file?: string;
}

const DEFAULT_FILE = ".env.local";

async function projectRef(api: ApiClient, opts: DataEnvOptions): Promise<{ id: string; slug: string }> {
  const linked = await loadProjectConfig(process.cwd());
  const ref = opts.project ?? linked?.project_id;
  if (!ref) {
    throw new LayeroError(
      "project_unknown",
      "не понятно, у какого проекта брать переменные Data API",
      "запусти из каталога проекта или передай --project <id|slug>",
    );
  }
  const p = await api.getProject(ref);
  return { id: p.id, slug: p.slug };
}

/**
 * Дописывает переменные в файл, не трогая чужие строки.
 *
 * Перезапись файла целиком была бы проще и однажды стёрла бы чужую строку,
 * которую человек добавил руками. Свои ключи узнаём по имени и обновляем на
 * месте — остальное остаётся как было.
 */
function mergeEnvFile(previous: string, vars: Record<string, string>): string {
  const lines = previous ? previous.split("\n") : [];
  const remaining = new Map(Object.entries(vars));
  const out = lines.map((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const name = match?.[1];
    if (!name) return line;
    const value = remaining.get(name);
    if (value === undefined) return line;
    remaining.delete(name);
    return `${name}=${value}`;
  });
  if (remaining.size) {
    if (out.length && (out[out.length - 1] ?? "").trim() !== "") out.push("");
    out.push("# Layero Data API — адрес и публичный ключ (layero data env)");
    for (const [key, value] of remaining) out.push(`${key}=${value}`);
    out.push("");
  }
  return out.join("\n");
}

/** Прикрыт ли файл от коммита. Проверяем буквально то имя, которое пишем. */
function ignored(cwd: string, file: string): boolean {
  const gitignore = join(cwd, ".gitignore");
  if (!existsSync(gitignore)) return false;
  const patterns = readFileSync(gitignore, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  return patterns.some(
    (p) => p === file || p === `/${file}` || p === "*.local" || p === ".env*" || p === ".env.*",
  );
}

export async function dataEnvCmd(opts: DataEnvOptions): Promise<void> {
  const mode = detectMode();
  const api = new ApiClient(await loadConfig());
  const project = await projectRef(api, opts);
  const vars = await api.dataEnv(project.id);

  if (!Object.keys(vars).length) {
    if (mode.json) {
      emit({ event: "data_env", project: project.slug, vars: {} });
      return;
    }
    console.log(
      chalk.dim(
        `у проекта "${project.slug}" нет базы с включённым Data API\n` +
          "включить: панель → база → «API» → «Включить API»",
      ),
    );
    return;
  }

  if (mode.json) {
    emit({ event: "data_env", project: project.slug, vars });
    return;
  }

  const file = opts.file ?? DEFAULT_FILE;
  if (!opts.write) {
    // По умолчанию печатаем, а не пишем: команда, которая молча правит файлы в
    // каталоге, — неприятный сюрприз, особенно у агента.
    for (const [key, value] of Object.entries(vars)) console.log(`${key}=${value}`);
    console.log(chalk.dim(`\n записать в ${file}:  layero data env --write`));
    return;
  }

  const path = join(process.cwd(), file);
  const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, mergeEnvFile(previous, vars), "utf8");
  console.log(`${chalk.green("✓")} ${file}: ${Object.keys(vars).length} переменных`);

  if (!ignored(process.cwd(), file)) {
    console.log(
      chalk.yellow(`\n⚠ ${file} не закрыт .gitignore.`) +
        chalk.dim(
          `\n  Публичный ключ не секрет — он и так уезжает в бандл. Но файл с таким` +
            `\n  именем однажды примет настоящий секрет, и тогда будет поздно.` +
            `\n  Добавьте строку:  echo "${file}" >> .gitignore`,
        ),
    );
  }
}
