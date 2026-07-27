import chalk from "chalk";
import { ApiClient, ApiError } from "../api.js";
import { loadConfig } from "../config.js";
import { loadProjectConfig } from "../project-config.js";
import { LayeroError, detectMode, emit } from "../agent.js";

/**
 * `layero domains …` (AGENT-09).
 *
 * Доменное API готово давно и работает в панели, но в CLI не было ни одной
 * команды — привязать домен из терминала было нельзя вовсе.
 *
 * Главная особенность сценария: ПОСЕРЕДИНЕ СТОИТ ЧЕЛОВЕК. Между «добавили
 * домен» и «домен работает» пользователь идёт к регистратору и правит DNS,
 * а распространение записей занимает от минут до часов. Поэтому `add` не
 * ждёт готовности: он показывает, что именно вписать, и заканчивается.
 * Проверку делает `verify` — и она тоже не крутится в ожидании, потому что
 * у платформы есть свой sweeper, перепроверяющий раз в 15 минут.
 */

interface DomainOptions {
  project?: string;
  json?: boolean;
  yes?: boolean;
}

async function resolveProjectId(
  api: ApiClient,
  opts: DomainOptions,
  cwd: string,
): Promise<{ id: string; slug: string }> {
  const linked = await loadProjectConfig(cwd);
  const ref = opts.project ?? linked?.project_id;
  if (!ref) {
    throw new LayeroError(
      "project_unknown",
      "не понятно, к какому проекту привязывать домен",
      "запусти из каталога проекта или передай --project <id|slug>",
    );
  }
  try {
    const p = await api.getProject(ref);
    return { id: p.id, slug: p.slug };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new LayeroError(
        "project_not_found",
        `нет проекта с id/slug "${ref}"`,
        "посмотри список: layero projects list",
      );
    }
    throw err;
  }
}

function stateOf(d: { verified: boolean; ssl_status: string }): string {
  if (d.verified && d.ssl_status === "active") return chalk.green("работает");
  if (d.ssl_status === "dns_pending") return chalk.yellow("ждёт DNS");
  if (d.ssl_status === "issuing") return chalk.yellow("выпускается сертификат");
  if (d.ssl_status === "failed") return chalk.red("ошибка");
  return d.ssl_status;
}

export async function domainsListCmd(opts: DomainOptions): Promise<void> {
  const mode = detectMode();
  const api = new ApiClient(await loadConfig());
  const project = await resolveProjectId(api, opts, process.cwd());
  const rows = await api.listDomains(project.id);

  if (mode.json) {
    emit({ event: "domains", project: project.slug, domains: rows });
    return;
  }
  if (!rows.length) {
    console.log(chalk.dim(`у проекта "${project.slug}" нет своих доменов`));
    console.log(chalk.dim("добавить: layero domains add example.com"));
    return;
  }
  for (const d of rows) {
    const primary = d.is_primary ? chalk.cyan(" [основной]") : "";
    console.log(`${d.domain}${primary}  ${stateOf(d)}`);
    if (d.last_verification_error) {
      console.log(chalk.dim(`    ${d.last_verification_error}`));
    }
  }
}

export async function domainsAddCmd(domain: string, opts: DomainOptions): Promise<void> {
  const mode = detectMode();
  const api = new ApiClient(await loadConfig());
  const project = await resolveProjectId(api, opts, process.cwd());

  const created = await api.addDomain(project.id, domain);
  const instr = await api.getDomainInstructions(project.id, created.id);

  if (mode.json) {
    emit({
      event: "domain_added",
      domain: created.domain,
      domain_id: created.id,
      ssl_status: created.ssl_status,
      records: instr.records,
      // Ждать готовности здесь бессмысленно: DNS распространяется минутами,
      // а платформа сама перепроверяет фоном.
      next_action: "ask_user_to_add_dns_then_verify",
    });
    return;
  }

  console.log(chalk.green(`домен ${created.domain} добавлен к проекту "${project.slug}"`));
  console.log(`\n${chalk.bold("впиши эти записи у своего регистратора:")}\n`);
  for (const r of instr.records) {
    const opt = r.optional ? chalk.dim(" (необязательно)") : "";
    console.log(`  ${chalk.bold(r.type)}  ${r.name}${opt}`);
    for (const v of r.values) console.log(`       → ${v}`);
  }
  console.log(
    chalk.dim(
      "\nDNS расходится от нескольких минут до часа. Проверить: layero domains verify " +
        created.domain +
        "\nМожно и не проверять вручную — платформа перепроверяет сама.",
    ),
  );
}

export async function domainsVerifyCmd(domain: string, opts: DomainOptions): Promise<void> {
  const mode = detectMode();
  const api = new ApiClient(await loadConfig());
  const project = await resolveProjectId(api, opts, process.cwd());
  const rows = await api.listDomains(project.id);
  const found = rows.find((d) => d.domain === domain.toLowerCase().replace(/^https?:\/\//, ""));
  if (!found) {
    throw new LayeroError(
      "domain_not_found",
      `домен "${domain}" не привязан к проекту "${project.slug}"`,
      "список: layero domains list",
    );
  }

  const after = await api.verifyDomain(project.id, found.id);
  const instr = await api.getDomainInstructions(project.id, found.id);

  if (mode.json) {
    emit({
      event: "domain_verified",
      domain: after.domain,
      verified: after.verified,
      ssl_status: after.ssl_status,
      checks: instr.checks,
      next_check_at: after.next_check_at ?? undefined,
      error: after.last_verification_error ?? undefined,
    });
    return;
  }

  if (after.verified && after.ssl_status === "active") {
    console.log(chalk.green(`${after.domain} — работает`));
    return;
  }
  console.log(`${after.domain} — ${stateOf(after)}`);
  const c = instr.checks;
  const mark = (v: boolean | null | undefined) =>
    v === true ? chalk.green("✓") : v === false ? chalk.red("✗") : chalk.dim("—");
  console.log(
    `  A ${mark(c.a_ok)}   CNAME ${mark(c.cname_ok)}   TXT ${mark(c.txt_ok)}   владение ${mark(c.ownership_ok)}`,
  );
  if (after.last_verification_error) {
    console.log(chalk.dim(`  ${after.last_verification_error}`));
  }
  if (after.next_check_at) {
    console.log(chalk.dim(`  платформа перепроверит сама: ${after.next_check_at}`));
  }
}

export async function domainsPrimaryCmd(domain: string, opts: DomainOptions): Promise<void> {
  const api = new ApiClient(await loadConfig());
  const project = await resolveProjectId(api, opts, process.cwd());
  const rows = await api.listDomains(project.id);
  const found = rows.find((d) => d.domain === domain.toLowerCase());
  if (!found) {
    throw new LayeroError("domain_not_found", `домен "${domain}" не привязан`, "layero domains list");
  }
  const out = await api.makeDomainPrimary(project.id, found.id);
  if (detectMode().json) {
    emit({ event: "domain_primary", domain: out.domain });
    return;
  }
  console.log(chalk.green(`${out.domain} — теперь основной домен проекта`));
  console.log(chalk.dim("платформенный адрес будет 301-редиректить на него"));
}

export async function domainsRemoveCmd(domain: string, opts: DomainOptions): Promise<void> {
  const mode = detectMode();
  const api = new ApiClient(await loadConfig());
  const project = await resolveProjectId(api, opts, process.cwd());
  const rows = await api.listDomains(project.id);
  const found = rows.find((d) => d.domain === domain.toLowerCase());
  if (!found) {
    throw new LayeroError("domain_not_found", `домен "${domain}" не привязан`, "layero domains list");
  }

  // Снятие домена рвёт живой трафик и требует scope `admin` на стороне API.
  // Спрашиваем подтверждение — но только когда есть кому отвечать.
  if (!opts.yes && mode.interactive) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const a = (await rl.question(`снять ${found.domain} с проекта "${project.slug}"? [y/N]: `))
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

  try {
    await api.removeDomain(project.id, found.id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      throw new LayeroError(
        "forbidden",
        "у токена нет прав на удаление домена",
        "удаление необратимо и требует токена со scope `admin` — выпусти такой в настройках",
      );
    }
    throw err;
  }
  if (mode.json) {
    emit({ event: "domain_removed", domain: found.domain });
    return;
  }
  console.log(chalk.green(`${found.domain} снят с проекта`));
}
