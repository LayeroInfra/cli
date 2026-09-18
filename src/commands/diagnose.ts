import chalk from "chalk";
import { ApiClient, ApiError } from "../api.js";
import { CliConfig, loadConfig } from "../config.js";
import { loadProjectConfig } from "../project-config.js";
import { LayeroError, detectMode, emit } from "../agent.js";
import { claimTokenFor } from "./claim.js";

/**
 * `layero diagnose` и `layero logs` (AGENT-08).
 *
 * До этого логи были доступны только внутри `layero deploy` — по ходу
 * сборки. Стоило команде завершиться, и посмотреть, почему упало, можно
 * было лишь в панели: отдельной команды не существовало вовсе.
 *
 * `diagnose` намеренно не выгружает лог целиком. Платформа возвращает
 * ВЫЖИМКУ — окрестность фатальной строки плюс разобранную причину, — и
 * пересказывать её сырым дампом значило бы вернуть ровно ту проблему,
 * ради которой агрегат делался: человек (и агент) тонут в двух тысячах
 * строк, где нужная одна.
 */

interface DiagnoseOptions {
  project?: string;
  deploy?: string;
  json?: boolean;
}

interface LogsOptions extends DiagnoseOptions {
  runtime?: boolean;
  tail?: number;
}

async function resolveDeployId(
  api: ApiClient,
  opts: DiagnoseOptions,
  cwd: string,
): Promise<{ deployId: string; projectId: string }> {
  if (opts.deploy) {
    // Явно указанный деплой: проект знать не обязательно, ручка работает
    // по самому id.
    return { deployId: opts.deploy, projectId: "" };
  }

  const linked = await loadProjectConfig(cwd);
  const ref = opts.project ?? linked?.project_id;
  if (!ref) {
    throw new LayeroError(
      "project_unknown",
      "не понятно, какой проект смотреть",
      "запусти из каталога проекта, либо передай --project <id|slug> или --deploy <id>",
    );
  }

  const project = await api.getProject(ref).catch((err) => {
    if (err instanceof ApiError && err.status === 404) {
      throw new LayeroError(
        "project_not_found",
        `нет проекта с id/slug "${ref}"`,
        "посмотри список: layero projects list",
      );
    }
    throw err;
  });

  const deploys = await api.listProjectDeploys(project.id);
  if (!deploys.length) {
    throw new LayeroError(
      "no_deploys",
      `у проекта "${project.slug}" ещё нет ни одного деплоя`,
      "запусти `layero deploy`",
    );
  }
  // Берём САМЫЙ СВЕЖИЙ деплой — он и есть текущее состояние проекта.
  //
  // Соблазнительно искать «последний неуспешный»: вопрос-то звучит как
  // «почему упало». Но так команда врёт после починки: пользователь
  // исправил код, передеплоил успешно, спрашивает — и снова видит старую
  // ошибку, которой уже нет. Поймано живым прогоном.
  //
  // Разобрать конкретную старую сборку по-прежнему можно: --deploy <id>.
  const target = deploys[0]!;
  return { deployId: target.id, projectId: project.id };
}

/**
 * Конфиг с токеном, которым можно читать деплои этой папки.
 *
 * 🚨 Песочница (`deploy --claim`) — тоже вход. Её токен лежит в
 * `~/.layero/config.json` по id проекта и прав на чтение хватает; без этой
 * ветки агент без аккаунта получал на упавшей сборке совет «выполни
 * `layero login`» — то есть не мог узнать причину отказа ничем, кроме панели,
 * которая ему недоступна (T-20260918-8).
 */
async function configForFolder(opts: DiagnoseOptions, cwd: string): Promise<CliConfig> {
  const cfg = await loadConfig();
  if (cfg.token) return cfg;
  const linked = await loadProjectConfig(cwd);
  const sameProject =
    !opts.project || opts.project === linked?.project_id || opts.project === linked?.slug;
  const claim = sameProject ? claimTokenFor(cfg, linked?.project_id) : undefined;
  if (claim) return { ...cfg, token: claim };
  throw new LayeroError(
    "auth_required",
    "нужен вход",
    "выполни `layero login` или задай LAYERO_TOKEN",
  );
}

export async function diagnoseCmd(opts: DiagnoseOptions): Promise<void> {
  const mode = detectMode();
  const cfg = await configForFolder(opts, process.cwd());
  const api = new ApiClient(cfg);
  const { deployId } = await resolveDeployId(api, opts, process.cwd());

  const d = await api.getDeployDiagnosis(deployId);

  if (mode.json) {
    emit({ event: "diagnosis", ...d });
    return;
  }

  const head =
    d.status === "ready"
      ? chalk.green(`деплой ${deployId.slice(0, 8)} — успешен`)
      : chalk.red(`деплой ${deployId.slice(0, 8)} — ${d.status ?? "неизвестно"}`);
  console.log(head + (d.stage ? chalk.dim(`  (этап: ${d.stage})`) : ""));

  if (d.verdict) {
    console.log(`\n${chalk.bold("причина:")} ${d.verdict}`);
  }
  if (d.runtime_state) {
    const idle = d.runtime_state === "paused" || d.runtime_state === "suspended";
    console.log(
      `${chalk.bold("рантайм:")} ${d.runtime_state}` +
        (idle ? chalk.dim(" — приложение спит, это штатно (scale-to-zero)") : ""),
    );
  }

  if (d.build_log_excerpt?.length) {
    console.log(
      `\n${chalk.bold("лог сборки")}${
        d.build_error_found ? chalk.dim(" (вокруг ошибки)") : chalk.dim(" (хвост)")
      }:`,
    );
    for (const line of d.build_log_excerpt) console.log("  " + line);
  }
  if (d.runtime_log_excerpt?.length) {
    console.log(`\n${chalk.bold("лог приложения")}:`);
    for (const line of d.runtime_log_excerpt) console.log("  " + line);
  }
  if (d.truncated) {
    console.log(chalk.dim("\n(вывод укорочен; полный лог — в панели проекта)"));
  }
  if (d.status !== "ready") {
    console.log(chalk.dim(`\nчто дальше: ${(d.next_actions ?? []).join(", ")}`));
  }
}

export async function logsCmd(opts: LogsOptions): Promise<void> {
  const mode = detectMode();
  const cfg = await configForFolder(opts, process.cwd());
  const api = new ApiClient(cfg);
  const { deployId } = await resolveDeployId(api, opts, process.cwd());

  if (opts.runtime) {
    const rt = await api.getRuntimeLogs(deployId, opts.tail ?? 100);
    if (mode.json) {
      emit({ event: "runtime_logs", status: rt.status, lines: rt.lines });
      return;
    }
    if (!rt.lines.length) {
      console.log(
        chalk.dim(
          rt.status === "cold"
            ? "приложение ещё ни разу не запускалось — логов нет"
            : "логов нет",
        ),
      );
      return;
    }
    for (const l of rt.lines) {
      console.log(l.ts ? `${chalk.dim(l.ts)} ${l.text}` : l.text);
    }
    return;
  }

  // Лог сборки. Читаем разом, без long-poll: `layero deploy` уже стримит
  // живую сборку, а эта команда нужна, когда всё закончилось.
  const out = await api.pollLogs(deployId, 0);
  if (mode.json) {
    emit({ event: "build_logs", status: out.status, lines: out.lines });
    return;
  }
  if (!out.lines.length) {
    console.log(chalk.dim("логов нет"));
    return;
  }
  for (const l of out.lines) console.log(l.line);
  if (out.error_message) {
    console.log(chalk.red(`\n${out.error_message}`));
  }
}
