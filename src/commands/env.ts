import chalk from "chalk";
import { ApiClient, ApiError } from "../api.js";
import { loadConfig } from "../config.js";
import { loadProjectConfig } from "../project-config.js";
import { LayeroError, detectMode, emit } from "../agent.js";

/**
 * `layero env …` (AGENT-13) — переменные окружения проекта.
 *
 * ЗНАЧЕНИЯ НЕ ЧИТАЮТСЯ. Платформа их и не отдаёт: `GET /env` возвращает
 * маску, длину и короткий префикс. Префикс мы здесь ТОЖЕ не показываем —
 * он полезен человеку в панели, который узнаёт свой ключ в лицо, но в
 * терминале и тем более в контексте агента это часть секрета: по началу
 * строки опознаётся и провайдер, и нередко сам ключ, а всё, что попало в
 * вывод агента, оседает в истории переписки.
 *
 * Частичное обновление работает через сентинел: в `PUT /env` значение
 * `null` означает «оставить как есть». Поэтому добавить одну переменную
 * можно, не зная остальных, — читать чужие секреты для этого не нужно.
 */

interface EnvOptions {
  project?: string;
  json?: boolean;
  yes?: boolean;
}

async function projectRef(api: ApiClient, opts: EnvOptions): Promise<{ id: string; slug: string }> {
  const linked = await loadProjectConfig(process.cwd());
  const ref = opts.project ?? linked?.project_id;
  if (!ref) {
    throw new LayeroError(
      "project_unknown",
      "не понятно, у какого проекта смотреть переменные",
      "запусти из каталога проекта или передай --project <id|slug>",
    );
  }
  const p = await api.getProject(ref);
  return { id: p.id, slug: p.slug };
}

export async function envListCmd(opts: EnvOptions): Promise<void> {
  const mode = detectMode();
  const api = new ApiClient(await loadConfig());
  const project = await projectRef(api, opts);
  const rows = await api.listEnvVars(project.id);

  if (mode.json) {
    // Ни значения, ни префикса: только имя и длина. Длину отдаём, потому
    // что она отвечает на реальный вопрос «а он вообще заполнен» и при
    // этом ничего не выдаёт.
    emit({
      event: "env_vars",
      project: project.slug,
      vars: rows.map((r) => ({ key: r.key, length: r.length, managed: !!r.managed })),
    });
    return;
  }
  if (!rows.length) {
    console.log(chalk.dim(`у проекта "${project.slug}" нет переменных окружения`));
    console.log(chalk.dim("добавить: layero env set KEY=value"));
    return;
  }
  // 🚨 ПЕРЕМЕННЫЕ ПЛАТФОРМЫ ПОМЕЧЕНЫ, А НЕ ПЕРЕМЕШАНЫ СО СВОИМИ. Список
  // отвечает на вопрос «что получит моё приложение», и строка подключения к
  // базе — часть ответа. Но менять её нельзя: она пересобирается из связи
  // проекта с базой, и предложить правку значило бы пообещать несбыточное.
  for (const r of rows) {
    const tail = r.managed
      ? chalk.dim(`  (${r.length} симв., ставит платформа)`)
      : chalk.dim(`  (${r.length} симв.)`);
    console.log(`${r.key}${tail}`);
  }
  console.log(chalk.dim("\nзначения не показываются — платформа их не отдаёт"));
  if (rows.some((r) => r.managed)) {
    console.log(
      chalk.dim("помеченные «ставит платформа» задаются подключением базы к проекту:"),
    );
    console.log(chalk.dim("  layero db connect <база>  /  layero db disconnect <база>"));
  }
}

function parsePair(raw: string): { key: string; value: string } {
  const i = raw.indexOf("=");
  if (i <= 0) {
    throw new LayeroError(
      "bad_format",
      `ожидается KEY=value, получено "${raw.slice(0, 40)}"`,
      "например: layero env set DATABASE_URL=postgres://…",
    );
  }
  return { key: raw.slice(0, i).trim(), value: raw.slice(i + 1) };
}

export async function envSetCmd(pairs: string[], opts: EnvOptions): Promise<void> {
  const mode = detectMode();
  const api = new ApiClient(await loadConfig());
  const project = await projectRef(api, opts);

  const incoming = pairs.map(parsePair);
  if (!incoming.length) {
    throw new LayeroError("nothing_to_set", "не передано ни одной переменной", "layero env set KEY=value");
  }

  // Остальные ключи переносим как есть — сентинел `null` говорит платформе
  // «оставь значение». Читать чужие секреты для добавления одной своей не
  // нужно, и это принципиально: иначе команда требовала бы прав, которых
  // у неё быть не должно.
  const existing = await api.listEnvVars(project.id);
  const payload: Record<string, string | null> = {};
  for (const r of existing) payload[r.key] = null;
  for (const { key, value } of incoming) payload[key] = value;

  const after = await api.replaceEnvVars(project.id, payload);
  const names = incoming.map((x) => x.key);

  if (mode.json) {
    emit({ event: "env_set", project: project.slug, keys: names, total: after.length });
    return;
  }
  console.log(chalk.green(`сохранено: ${names.join(", ")}`));
  console.log(
    chalk.yellow("переменные подхватятся при следующей сборке — задеплой проект, чтобы применить"),
  );
}

export async function envUnsetCmd(keys: string[], opts: EnvOptions): Promise<void> {
  const mode = detectMode();
  const api = new ApiClient(await loadConfig());
  const project = await projectRef(api, opts);

  const existing = await api.listEnvVars(project.id);
  const known = new Set(existing.map((r) => r.key));
  const missing = keys.filter((k) => !known.has(k));
  if (missing.length) {
    throw new LayeroError(
      "env_not_found",
      `нет таких переменных: ${missing.join(", ")}`,
      "посмотри список: layero env list",
    );
  }

  if (!opts.yes && mode.interactive) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const a = (await rl.question(`удалить ${keys.join(", ")} из "${project.slug}"? [y/N]: `))
        .trim()
        .toLowerCase();
      if (a !== "y" && a !== "yes") {
        console.log(chalk.yellow("отменено."));
        return;
      }
    } finally {
      rl.close();
    }
  }

  const drop = new Set(keys);
  const payload: Record<string, string | null> = {};
  for (const r of existing) if (!drop.has(r.key)) payload[r.key] = null;

  await api.replaceEnvVars(project.id, payload);
  if (mode.json) {
    emit({ event: "env_unset", project: project.slug, keys });
    return;
  }
  console.log(chalk.green(`удалено: ${keys.join(", ")}`));
  console.log(chalk.yellow("изменение применится при следующей сборке"));
}
