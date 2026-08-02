// Shared device-auth flow.
//
// Used by `layero login` (always) and by `layero deploy` when no token is
// saved yet (B5/I4 — the documented happy path is `deploy` kicking off the
// device login inline and polling, rather than erroring out to a separate
// `login` command).
import chalk from "chalk";
import open from "open";
import { CliConfig, saveConfig } from "./config.js";
import { ApiClient } from "./api.js";
import { LayeroError, detectMode, emit } from "./agent.js";
import { ensureUsername } from "./username.js";

const MAX_WAIT_MS = 15 * 60 * 1000;

/**
 * Run the browser device-auth flow against `cfg`, persist the resulting
 * token, and return the updated config. Emits `auth_required` (so agents can
 * render the link) and `authorized` in JSON mode; prints a friendly block and
 * auto-opens the browser in interactive mode.
 *
 * Throws LayeroError("auth_expired" | "auth_timeout") if the user doesn't
 * approve in time.
 */
export async function runDeviceLogin(cfg: CliConfig): Promise<CliConfig> {
  const mode = detectMode();
  const api = new ApiClient(cfg);

  const device = await api.startDeviceAuth();
  const { device_code, user_code, verification_url, poll_interval } = device;
  const pollMs = (poll_interval ?? 2) * 1000;

  if (mode.json) {
    emit({ event: "auth_required", url: verification_url, user_code });
  } else {
    console.log(chalk.cyan("\nOpen this URL to sign in:"));
    console.log(chalk.bold(`  ${verification_url}`));
    console.log(chalk.dim(`\n  Confirmation code: `) + chalk.white.bold(user_code));
    console.log(chalk.dim(`  (expires in ${device.expires_in}s)\n`));
    try {
      await open(verification_url);
    } catch {
      // non-fatal — user can paste the URL manually
    }
  }

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, pollMs));
    const poll = await api.pollDeviceAuth(device_code);
    if (poll.status === "approved" && poll.token) {
      cfg.token = poll.token;
      const probe = new ApiClient(cfg);
      const me = await probe.me();
      cfg.user = { id: me.id, username: me.username ?? null, email: me.email };
      await saveConfig(cfg);
      if (mode.json) {
        emit({ event: "authorized", user: me.username ?? me.email ?? me.id });
      } else {
        console.log(
          chalk.green(`Logged in as ${me.username ?? me.email ?? me.id}`),
        );
      }
      // Имя аккаунта спрашиваем здесь же, а не отправляем в браузер: без него
      // первый же деплой упрётся в 412, а CLI ровно затем и нужен, чтобы в
      // дашборд не ходить. В агентском режиме ensureUsername не спрашивает —
      // отдаёт `username_required` с командой, которую агент выполнит сам.
      if (!me.username) {
        try {
          const picked = await ensureUsername(probe, me);
          cfg.user = { ...cfg.user, username: picked };
          await saveConfig(cfg);
        } catch (err) {
          // Вход УЖЕ состоялся и токен сохранён — валить команду из-за
          // невыбранного имени нельзя. В агентском режиме ensureUsername
          // бросает `username_required`: показываем подсказку на stderr
          // (stdout занят JSON-строками) и выходим с успехом. Отказом это
          // станет на первом деплое, где действительно мешает.
          process.stderr.write(
            `\n  ${err instanceof Error ? err.message : String(err)}\n` +
              "  Задайте имя аккаунта: layero username <имя>\n\n",
          );
        }
      }
      return cfg;
    }
    if (poll.status === "expired") {
      throw new LayeroError(
        "auth_expired",
        "Login timed out — code expired. Run `layero login` again.",
        "run_login",
      );
    }
  }
  throw new LayeroError(
    "auth_timeout",
    "Login timed out. Run `layero login` again.",
    "run_login",
  );
}
