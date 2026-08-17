import { loadConfig } from "../config.js";
import { runDeviceLogin } from "../auth.js";

/**
 * `layero login` — device flow: печатает адрес и код, ждёт подтверждения.
 *
 * ⚠️ `--no-browser` нужен там, где браузера на этой машине нет вовсе — SSH,
 * контейнер, удалённая среда агента. Без флага CLI пытается открыть адрес
 * сам, и на такой машине это выглядит как зависание.
 *
 * Для CI и агентов вход человеком не годится в принципе: там нужен
 * долгоживущий токен — `layero token create <имя>` и `LAYERO_TOKEN` в
 * окружении.
 */
export async function loginCmd(opts: Record<string, unknown>): Promise<void> {
  const cfg = await loadConfig();
  await runDeviceLogin(cfg, { noBrowser: Boolean(opts.noBrowser) });
}
