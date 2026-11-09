import { createHash } from "node:crypto";
import { promises as fs, createReadStream, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { create as tarCreate } from "tar";
import ignore, { Ignore } from "ignore";
import { LayeroError } from "./agent.js";

const MAX_BYTES = 500 * 1024 * 1024;

const DEFAULT_IGNORE = [
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  ".cache",
  ".turbo",
  ".vercel",
  ".netlify",
  ".env",
  ".env.*",
  "*.log",
  ".DS_Store",
  "Thumbs.db",
  ".layero",
  // Сами файлы правил на сайте не нужны, а перечисляют они ровно то, что
  // автор прятал: опубликованный `.gitignore` со строкой `private-draft.html`
  // подсказывает, что искать. Проверено на проде — до этой правки оба
  // отдавались с кодом 200. Та же категория, что `.git` и `.env*` выше.
  ".gitignore",
  ".layeroignore",
];

async function readIgnoreFile(filePath: string): Promise<string[]> {
  try {
    const text = await fs.readFile(filePath, "utf-8");
    return text
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
}

// Lockfiles the server needs for a frozen/reproducible install. A gitignored
// (or .layeroignore'd) lockfile would otherwise be dropped from the upload →
// the builder falls back to a non-frozen install (re-resolves deps). Force them
// back in with negation patterns applied AFTER the ignore layers. They live at
// repo root, so no ignored parent dir can block the re-include.
const FORCE_INCLUDE_LOCKFILES = [
  "bun.lockb",
  "bun.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
];

// Env files carry secrets. In the `ignore` package the last matching rule
// wins, so a `.gitignore` written for git — `!.env.example`, or `!.env` in a
// monorepo that commits a shared one — used to pull env files back into the
// archive. The builder strips `.env*` before publishing, so they never reached
// the site, but the secrets still landed in the platform's source storage and
// the build context (checked on prod 08.11.2026).
//
// The exclusion is therefore re-applied after each user layer. The only way
// back in is an explicit negation in `.layeroignore` that names an env file
// (`!.env.production`): a deliberate, Layero-specific choice. `.gitignore`
// never overrides it, and neither do broad `.layeroignore` negations such as
// `!*`.
//
// The same broad negation would also have pulled back the other things that
// must never reach a site: VCS metadata (remote credentials live in
// `.git/config`), the CLI's own `.layero/` (claim tokens) and the rule files
// themselves. They get the same treatment, with no way back in at all.
const ENV_EXCLUDE = [".env", ".env.*"];
const ALWAYS_EXCLUDE = [
  ...ENV_EXCLUDE,
  ".git",
  ".svn",
  ".hg",
  ".layero",
  ".gitignore",
  ".layeroignore",
];

/** Negations from `.layeroignore` that explicitly name an env file. */
function explicitEnvNegations(lines: string[]): string[] {
  return lines.filter((l) => l.startsWith("!") && l.includes(".env"));
}

async function userLayers(cwd: string): Promise<Ignore> {
  const gitignore = await readIgnoreFile(path.join(cwd, ".gitignore"));
  const layeroignore = await readIgnoreFile(path.join(cwd, ".layeroignore"));
  const ig = ignore();
  ig.add(DEFAULT_IGNORE);
  ig.add(gitignore);
  ig.add(ALWAYS_EXCLUDE);
  ig.add(layeroignore);
  ig.add(ALWAYS_EXCLUDE);
  ig.add(explicitEnvNegations(layeroignore));
  return ig;
}

async function buildIgnore(cwd: string): Promise<Ignore> {
  const ig = await userLayers(cwd);
  // Negations last so they win over any ignore rule above.
  ig.add(FORCE_INCLUDE_LOCKFILES.map((f) => `!/${f}`));
  return ig;
}

async function walk(cwd: string, ig: Ignore): Promise<string[]> {
  const out: string[] = [];
  async function visit(rel: string): Promise<void> {
    const abs = rel === "" ? cwd : path.join(cwd, rel);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel === "" ? e.name : path.join(rel, e.name);
      // The ignore package wants forward slashes regardless of platform.
      const childPosix = childRel.split(path.sep).join("/");
      const isDir = e.isDirectory();
      const probe = isDir ? `${childPosix}/` : childPosix;
      if (ig.ignores(probe)) continue;
      if (isDir) {
        await visit(childRel);
      } else if (e.isFile() || e.isSymbolicLink()) {
        out.push(childRel);
      }
    }
  }
  await visit("");
  return out;
}

// --- Hard links and the silent exit (SUP-473, 09.11.2026)
//
// tar 7.5.22 — the latest release — deadlocks its async packer on files
// whose link count is above one (https://github.com/isaacs/node-tar/issues/460,
// fix in PR #461, not released). With `create({ file })` the promise then
// never settles, the event loop drains and Node exits with code 0: the
// deploy stopped after «Setup complete» with no error and a 10-byte archive
// in the temp folder. A user hit it on Windows three times in a row.
//
// Fix: we stat every file ourselves and hand tar the stats with `nlink`
// set to 1. tar's hard-link logic — the deferral that deadlocks, and the
// Link entries — is keyed on `nlink > 1`, so it never engages and each
// file goes into the archive in full. That is what the build needs anyway:
// a Link entry pointing outside the folder would be unusable, and on
// Windows distinct files can share a rounded inode number
// (isaacs/node-tar#431) and lose their content to a bogus Link.
//
// tar looks up its stat cache by the absolute path, with forward slashes on
// Windows (its `normalizeWindowsPath`). The cache below folds both slash
// forms into one key, so the lookup hits whichever form tar uses. If it
// still missed, tar would stat the file itself and the old behaviour would
// return; the guard further down turns that into an error, not a silent exit.

/** Stat cache that, on Windows, treats `C:\a\b` and `C:/a/b` as one key.
 * Elsewhere a backslash is a legal file-name character, so keys stay as is. */
export class SlashAgnosticStatCache extends Map<string, Stats> {
  constructor(private readonly fold: boolean = process.platform === "win32") {
    super();
  }
  private key(p: string): string {
    return this.fold ? p.replace(/\\/g, "/") : p;
  }
  override get(p: string): Stats | undefined {
    return super.get(this.key(p));
  }
  override set(p: string, st: Stats): this {
    return super.set(this.key(p), st);
  }
  override has(p: string): boolean {
    return super.has(this.key(p));
  }
  override delete(p: string): boolean {
    return super.delete(this.key(p));
  }
}

/** Stats for every file with `nlink` forced to 1, keyed for tar. */
export async function statsWithoutHardlinks(
  cwd: string,
  files: string[],
): Promise<SlashAgnosticStatCache> {
  const cache = new SlashAgnosticStatCache();
  for (const rel of files) {
    const abs = path.resolve(cwd, rel);
    const st = await fs.lstat(abs);
    if (st.isFile() && st.nlink > 1) {
      Object.defineProperty(st, "nlink", { value: 1, writable: true, configurable: true, enumerable: true });
    }
    cache.set(abs, st);
  }
  return cache;
}

/** Fail loudly if packing stops making progress and the event loop drains.
 *
 * Node emits `beforeExit` when there is nothing left to wait for. While a
 * pack is in flight that can only mean the packer is stuck with no pending
 * I/O; without this the CLI would exit with 0 and print nothing. Rejecting
 * here schedules more work, so the process stays alive long enough to
 * print the error and exit with a failure code. */
export function guardAgainstSilentStall<T>(work: Promise<T>): Promise<T> {
  let onDrain: () => void = () => undefined;
  const drained = new Promise<never>((_, reject) => {
    onDrain = () =>
      reject(
        new LayeroError(
          "pack_stalled",
          "упаковка файлов остановилась на середине: архив не собран, на сервер ничего не ушло",
          "обнови CLI и повтори: npx layero@latest deploy. Если повторится — пришли этот вывод в поддержку",
        ),
      );
    process.once("beforeExit", onDrain);
  });
  return Promise.race([work, drained]).finally(() => {
    process.off("beforeExit", onDrain);
  });
}

async function createArchive(
  cwd: string,
  files: string[],
  archivePath: string,
  prefix: string,
): Promise<void> {
  const statCache = await statsWithoutHardlinks(cwd, files);
  try {
    await guardAgainstSilentStall(
      tarCreate(
        {
          file: archivePath,
          gzip: { level: 6 },
          cwd,
          portable: true,
          prefix,
          // The option type is tar's own; a Map of fs.Stats is what it stores.
          statCache: statCache as never,
        },
        files,
      ),
    );
  } catch (err) {
    await fs.unlink(archivePath).catch(() => undefined);
    throw err;
  }
}

async function sha256OfFile(p: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(p);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

export interface PackResult {
  archivePath: string;
  sha256: string;
  size: number;
  fileCount: number;
  /** Lockfiles that exist on disk but were gitignored/.layeroignore'd — we
   * force-include them anyway (a frozen install needs them); the caller may
   * surface this so the user knows their ignore rule was overridden. */
  forcedLockfiles?: string[];
}

/** Lockfiles present on disk that WOULD have been dropped by the ignore rules
 * if not force-included. Built from the same ignore layers minus the lockfile
 * negations, so it reflects exactly what the user's .gitignore/.layeroignore
 * would have excluded. */
async function detectForcedLockfiles(cwd: string): Promise<string[]> {
  const probe = await userLayers(cwd);
  const forced: string[] = [];
  for (const lf of FORCE_INCLUDE_LOCKFILES) {
    if (!probe.ignores(lf)) continue; // not ignored → nothing forced
    try {
      const st = await fs.stat(path.join(cwd, lf));
      if (st.isFile()) forced.push(lf);
    } catch {
      // absent on disk — nothing to force-include
    }
  }
  return forced;
}

/** Pack only the contents of an already-built artifact directory.
 *
 * Used by `layero deploy --prebuilt`. We deliberately bypass DEFAULT_IGNORE
 * (no `dist`/`build`/`.next` filtering — those names might appear *inside*
 * a built artifact and they're now meaningful files, not source-tree
 * leftovers). We still apply a minimal safety filter so accidental clutter
 * doesn't blow up the archive: `.git/`, `node_modules/`, `.DS_Store`,
 * `.env*`. The caller resolves the directory; the archive's internal layout
 * is content-only (no source-tree prefix).
 */
export async function packDirectory(
  targetDir: string,
  projectName: string,
): Promise<PackResult> {
  const stat = await fs.stat(targetDir);
  if (!stat.isDirectory()) {
    throw new Error(`prebuilt path is not a directory: ${targetDir}`);
  }
  const minimalIgnore = ignore();
  minimalIgnore.add([
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    ".env",
    ".env.*",
    "*.log",
    ".DS_Store",
    "Thumbs.db",
    ".layero",
    // См. комментарий у DEFAULT_IGNORE: файлы правил перечисляют то, что
    // автор прятал, и на сайте им делать нечего. В каталоге сборки они
    // оказываются редко, но `--prebuilt .` на корне проекта — обычное дело.
    ".gitignore",
    ".layeroignore",
  ]);
  const files = await walk(targetDir, minimalIgnore);
  if (files.length === 0) {
    throw new Error(
      `no files to upload in ${targetDir} — check that the build produced output`,
    );
  }
  const stamp = Date.now();
  const safeName = projectName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const archivePath = path.join(tmpdir(), `layero-${safeName}-prebuilt-${stamp}.tgz`);
  const rootName = `layero-${safeName}-prebuilt-${stamp}`;
  await createArchive(targetDir, files, archivePath, rootName);
  const fst = await fs.stat(archivePath);
  if (fst.size > MAX_BYTES) {
    await fs.unlink(archivePath).catch(() => undefined);
    throw new Error(
      `archive is ${(fst.size / (1024 * 1024)).toFixed(1)}MB — over the ${MAX_BYTES / (1024 * 1024)}MB limit. ` +
        "Trim the build output or skip large files (`.layeroignore`).",
    );
  }
  const sha256 = await sha256OfFile(archivePath);
  return { archivePath, sha256, size: fst.size, fileCount: files.length };
}

export async function packCwd(
  cwd: string,
  projectName: string,
): Promise<PackResult> {
  const ig = await buildIgnore(cwd);
  const files = await walk(cwd, ig);
  if (files.length === 0) {
    throw new Error(
      "no files to upload after applying .gitignore/.layeroignore — " +
        "check that you're in the right directory",
    );
  }
  const forcedLockfiles = await detectForcedLockfiles(cwd);

  const stamp = Date.now();
  const safeName = projectName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const archivePath = path.join(tmpdir(), `layero-${safeName}-${stamp}.tgz`);
  // Single root directory inside the archive — matches the github_archive
  // contract on the builder side, which strips one root prefix.
  const rootName = `layero-${safeName}-${stamp}`;

  await createArchive(cwd, files, archivePath, rootName);

  const stat = await fs.stat(archivePath);
  if (stat.size > MAX_BYTES) {
    await fs.unlink(archivePath).catch(() => undefined);
    throw new Error(
      `archive is ${(stat.size / (1024 * 1024)).toFixed(1)}MB — over the ${MAX_BYTES / (1024 * 1024)}MB limit. ` +
        "Add large directories to .layeroignore.",
    );
  }

  const sha256 = await sha256OfFile(archivePath);
  return {
    archivePath,
    sha256,
    size: stat.size,
    fileCount: files.length,
    ...(forcedLockfiles.length ? { forcedLockfiles } : {}),
  };
}
