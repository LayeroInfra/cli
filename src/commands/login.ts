import chalk from "chalk";
import open from "open";
import { loadConfig, saveConfig } from "../config.js";
import { ApiClient } from "../api.js";
import { LayeroError, detectMode, emit } from "../agent.js";

const MAX_WAIT_MS = 15 * 60 * 1000;

export async function loginCmd(_opts: Record<string, unknown>): Promise<void> {
  const cfg = await loadConfig();
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
      cfg.user = { id: me.id, username: me.username, email: me.email };
      await saveConfig(cfg);
      if (mode.json) {
        emit({ event: "authorized", user: me.username ?? me.email ?? me.id });
      } else {
        console.log(
          chalk.green(`Logged in as ${me.username ?? me.email ?? me.id}`),
        );
        if (!me.username) {
          console.log(
            chalk.yellow(
              "No username set — open https://app.layero.ru/onboarding to pick one.",
            ),
          );
        }
      }
      return;
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
