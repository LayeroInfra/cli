/**
 * `layero team …` — участники команды: роли, доступ к проектам, места
 * (core docs/TEAMS.md). Только ветка alpha: методы команд не выпущены
 * (AGENTS.md, «Невыпущенные методы — только под alpha»).
 *
 * Роли для людей: владелец (owner), разработчик (developer), гость (guest).
 * В API — `admin`, `editor`, `viewer`. Права решает сервер; понятный отказ
 * (нет свободного места, гостю — только просмотр) доезжает его же текстом
 * через общий разбор отказов (`account-errors.ts`).
 */
import { ApiClient, ApiError, type TeamApiRole, type TeamLevel, type TeamMember } from "../api.js";
import { loadConfig } from "../config.js";
import { LayeroError, emit } from "../agent.js";

export type TeamRole = "owner" | "developer" | "guest";

const TO_API: Record<TeamRole, TeamApiRole> = { owner: "admin", developer: "editor", guest: "viewer" };
const LEVELS: TeamLevel[] = ["none", "view", "edit"];

export function teamRole(r: TeamApiRole): TeamRole {
  return r === "admin" ? "owner" : r === "viewer" ? "guest" : "developer";
}

function parseRole(raw: string | undefined): TeamRole {
  const r = (raw ?? "").trim().toLowerCase();
  if (r === "owner" || r === "developer" || r === "guest") return r;
  throw new LayeroError("invalid_choice", `роль «${raw ?? ""}» не знакома`,
    "роли: owner (владелец), developer (разработчик), guest (гость)");
}

function parseLevel(raw: string): TeamLevel {
  const l = raw.trim().toLowerCase() as TeamLevel;
  if (LEVELS.includes(l)) return l;
  throw new LayeroError("invalid_choice", `уровень «${raw}» не знаком`,
    "уровни: none (нет доступа), view (просмотр), edit (редактирование)");
}

async function client(): Promise<ApiClient> {
  const cfg = await loadConfig();
  if (!cfg.token) {
    throw new LayeroError("auth_required", "вход не выполнен", "выполните `layero login` или задайте LAYERO_TOKEN");
  }
  return new ApiClient(cfg);
}

/** Организация: `--org`, иначе личная. */
async function resolveOrg(api: ApiClient, org: string | undefined): Promise<string> {
  const orgs = await api.listOrganizations();
  if (org) {
    const hit = orgs.find((o) => o.slug === org.trim().toLowerCase());
    if (!hit) throw new LayeroError("org_unknown", `организации «${org}» нет среди ваших`, "список: `layero orgs list`");
    return hit.slug;
  }
  const personal = orgs.find((o) => o.kind === "personal");
  if (!personal) throw new LayeroError("org_unknown", "не нашлась личная организация", "укажите `--org <слаг>`");
  return personal.slug;
}

async function findMember(api: ApiClient, slug: string, email: string): Promise<TeamMember> {
  const want = email.trim().toLowerCase();
  const m = (await api.listTeamMembers(slug)).find((x) => (x.email ?? "").toLowerCase() === want);
  if (!m) {
    throw new LayeroError("member_not_found", `в «${slug}» нет участника ${email}`,
      "участники: `layero team list --org " + slug + "`");
  }
  return m;
}

function accessOf(m: TeamMember) {
  if (m.role === "admin" || !m.project_access) return { default_level: "edit" as TeamLevel, all: true, exceptions: [] };
  return { default_level: m.project_access.default_level, all: false,
    exceptions: m.project_access.exceptions.map((e) => ({ project: e.slug ?? e.project_id, level: e.level })) };
}

/** `layero team list` — участники, приглашения, места. */
export async function teamListCmd(opts: { org?: string }): Promise<void> {
  const api = await client();
  const slug = await resolveOrg(api, opts.org);
  const members = await api.listTeamMembers(slug);
  let invites: Awaited<ReturnType<ApiClient["listTeamInvites"]>> = [];
  let seats: Awaited<ReturnType<ApiClient["getTeamSeats"]>> | null = null;
  try {
    invites = await api.listTeamInvites(slug);
  } catch (err) {
    if (!(err instanceof ApiError && (err.status === 403 || err.status === 404))) throw err;  // не владелец
  }
  try {
    seats = await api.getTeamSeats(slug);
  } catch (err) {
    if (!(err instanceof ApiError && [403, 404, 409].includes(err.status))) throw err;  // не владелец или не на новых правах
  }
  emit({
    event: "team",
    organization: slug,
    members: members.map((m) => ({ email: m.email, username: m.username, role: teamRole(m.role), access: accessOf(m) })),
    invites: invites.filter((i) => i.status === "pending").map((i) => ({ email: i.email, role: teamRole(i.role), expires_at: i.expires_at })),
    seats: seats && { paid: seats.paid_seats, occupied: seats.occupied, unit_kopecks: seats.unit_kopecks,
      next_date: seats.next_date, add_one_kopecks: seats.add_one_kopecks },
  });
}

/** `layero team invite <email> --role developer` */
export async function teamInviteCmd(email: string, opts: { org?: string; role?: string }): Promise<void> {
  const role = parseRole(opts.role ?? "developer");
  const api = await client();
  const slug = await resolveOrg(api, opts.org);
  try {
    await api.createTeamInvite(slug, email.trim(), TO_API[role]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.body.includes("seat_required")) {
      throw new LayeroError("seat_required", "свободных платных мест нет",
        `добавьте место: \`layero team seats --add 1 --org ${slug}\` — или пригласите гостем (\`--role guest\`, бесплатно)`);
    }
    throw err;
  }
  emit({ event: "team_invited", organization: slug, email: email.trim(), role });
}

/** `layero team role <email> <owner|developer|guest>` */
export async function teamRoleCmd(email: string, roleRaw: string, opts: { org?: string }): Promise<void> {
  const role = parseRole(roleRaw);
  const api = await client();
  const slug = await resolveOrg(api, opts.org);
  const m = await findMember(api, slug, email);
  await api.updateTeamMemberRole(slug, m.user_id, TO_API[role]);
  emit({ event: "team_role_changed", organization: slug, email: m.email ?? email, role });
}

/** `layero team remove <email>` — участника или приглашение. */
export async function teamRemoveCmd(email: string, opts: { org?: string }): Promise<void> {
  const api = await client();
  const slug = await resolveOrg(api, opts.org);
  const want = email.trim().toLowerCase();
  const m = (await api.listTeamMembers(slug)).find((x) => (x.email ?? "").toLowerCase() === want);
  if (m) {
    await api.removeTeamMember(slug, m.user_id);
    emit({ event: "team_member_removed", organization: slug, email: m.email ?? email, invite: false });
    return;
  }
  const inv = (await api.listTeamInvites(slug)).find((i) => i.status === "pending" && i.email.toLowerCase() === want);
  if (!inv) {
    throw new LayeroError("member_not_found", `в «${slug}» нет участника или приглашения ${email}`,
      "участники: `layero team list --org " + slug + "`");
  }
  await api.revokeTeamInvite(slug, inv.id);
  emit({ event: "team_member_removed", organization: slug, email: inv.email, invite: true });
}

/** `layero team access <email> [--all view] [--project shop=edit …]` — без флагов показывает. */
export async function teamAccessCmd(email: string, opts: { org?: string; all?: string; project?: string[] }): Promise<void> {
  const api = await client();
  const slug = await resolveOrg(api, opts.org);
  const m = await findMember(api, slug, email);
  const cur = await api.getTeamProjectAccess(slug, m.user_id);
  let out = cur;
  const pairs = opts.project ?? [];
  if (opts.all !== undefined || pairs.length) {
    const projects = (await api.listProjects()).filter((p) => p.organization?.slug === slug);
    const bySlug = new Map(projects.map((p) => [p.slug, p.id]));
    const exceptions = new Map(cur.exceptions.map((e) => [e.project_id, e.level]));
    for (const raw of pairs) {
      const [pslug, lvl] = raw.split("=");
      if (!pslug || !lvl) throw new LayeroError("bad_format", `«${raw}» — ожидается проект=уровень`, "например: --project shop=edit");
      const id = bySlug.get(pslug.trim());
      if (!id) throw new LayeroError("project_not_found", `в «${slug}» нет проекта ${pslug}`, "проекты: `layero projects list`");
      exceptions.set(id, parseLevel(lvl));
    }
    out = await api.setTeamProjectAccess(slug, m.user_id, {
      default_level: opts.all !== undefined ? parseLevel(opts.all) : cur.default_level,
      exceptions: [...exceptions].map(([project_id, level]) => ({ project_id, level })),
    });
  }
  emit({ event: "team_access", organization: slug, email: m.email ?? email, default_level: out.default_level,
    exceptions: out.exceptions.map((e) => ({ project: e.slug ?? e.project_id, level: e.level })) });
}

/** `layero team seats [--add N | --remove N]` — без флагов показывает. */
export async function teamSeatsCmd(opts: { org?: string; add?: string; remove?: string }): Promise<void> {
  const api = await client();
  const slug = await resolveOrg(api, opts.org);
  const add = opts.add !== undefined ? Number(opts.add) : 0;
  const remove = opts.remove !== undefined ? Number(opts.remove) : 0;
  if ((opts.add !== undefined && !(add >= 1)) || (opts.remove !== undefined && !(remove >= 1)) || (add && remove)) {
    throw new LayeroError("invalid_type", "число мест — целое от 1", "одно из: --add N или --remove N");
  }
  let after = await api.getTeamSeats(slug);
  try {
    if (add) after = await api.changeTeamSeats(slug, { add });
    if (remove) after = await api.changeTeamSeats(slug, { remove });
  } catch (err) {
    if (err instanceof ApiError && err.status === 402) {
      throw new LayeroError("balance_short", "на балансе команды не хватает на место",
        `пополните баланс: https://app.layero.ru/orgs/${slug}/billing — и повторите`);
    }
    throw err;
  }
  emit({ event: "team_seats", organization: slug, paid: after.paid_seats, occupied: after.occupied,
    unit_kopecks: after.unit_kopecks, next_date: after.next_date, added: add, removed: remove });
}
