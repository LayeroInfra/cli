import chalk from "chalk";
import { loadConfig, saveConfig } from "../config.js";
import { ApiClient } from "../api.js";
import { detectMode, emit } from "../agent.js";

export async function tokenSetCmd(jwt: string): Promise<void> {
  const cfg = await loadConfig();
  cfg.token = jwt.trim();
  // Probe /auth/me to validate the token before persisting.
  const probe = new ApiClient(cfg);
  try {
    const me = await probe.me();
    cfg.user = { id: me.id, username: me.username ?? null, email: me.email };
  } catch (err) {
    console.error(
      chalk.red(`token rejected by API: ${(err as Error).message}`),
    );
    process.exitCode = 1;
    return;
  }
  await saveConfig(cfg);
  console.log(
    chalk.green(
      `saved token for ${cfg.user?.username ?? cfg.user?.email ?? cfg.user?.id}`,
    ),
  );
  if (!cfg.user?.username) {
    console.log(
      chalk.yellow(
        "no username set — open https://app.layero.ru/onboarding to pick one " +
          "before `layero deploy`.",
      ),
    );
  }
}


/**
 * `layero token create <имя>` — долгоживущий токен для CI и агентов.
 *
 * 🚨 Это и есть неинтерактивный путь входа, которого не хватало. `layero login`
 * требует человека с браузером; в CI работать было нечем, а единственной
 * подсказкой была команда `token set <jwt>` — «раздобудьте токен где-нибудь
 * ещё». Ручка на сервере существовала, у CLI её не было.
 *
 * ⚠️ По умолчанию токен умеет читать и деплоить, но не умеет необратимого:
 * удалить проект, сменить адрес, передать владение, выписать себе новый
 * токен. `--scope admin` запрашивается явно.
 */
export async function tokenCreateCmd(
  name: string,
  opts: { scope?: string; json?: boolean },
): Promise<void> {
  const mode = detectMode();
  const api = new ApiClient(await loadConfig());
  const scopes = (opts.scope ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as Array<"read" | "deploy" | "admin">;
  const created = await api.createApiToken({ name, scopes: scopes.length ? scopes : undefined });

  if (mode.json || opts.json) {
    emit({ event: "token_created", id: created.id, name: created.name,
           token: created.token, scopes: created.scopes });
    return;
  }
  // Сырой токен показывается ЕДИНСТВЕННЫЙ раз: в базе лежит только хеш.
  console.log(`${chalk.green("✓")} токен «${created.name}» (${created.scopes.join(", ")})\n`);
  console.log(created.token);
  console.log(
    chalk.dim(
      "\n  Показывается один раз. В CI: LAYERO_TOKEN=<токен> npx layero@latest deploy",
    ),
  );
}

export async function tokenListCmd(opts: { json?: boolean }): Promise<void> {
  const mode = detectMode();
  const api = new ApiClient(await loadConfig());
  const list = await api.listApiTokens();
  if (mode.json || opts.json) {
    emit({ event: "tokens", tokens: list });
    return;
  }
  if (!list.length) {
    console.log(chalk.dim("токенов нет — layero token create <имя>"));
    return;
  }
  for (const t of list) {
    const used = t.last_used_at ? `использован ${t.last_used_at.slice(0, 10)}` : "не использован";
    console.log(`${chalk.bold(t.name)}  ${t.hint}  [${t.scopes.join(", ")}]  ${used}`);
    console.log(chalk.dim(`  id: ${t.id}`));
  }
}

export async function tokenRevokeCmd(id: string, opts: { json?: boolean }): Promise<void> {
  const mode = detectMode();
  const api = new ApiClient(await loadConfig());
  await api.revokeApiToken(id);
  if (mode.json || opts.json) {
    emit({ event: "token_revoked", id });
    return;
  }
  console.log(`${chalk.green("✓")} токен отозван`);
}
