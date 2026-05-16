import { createHash } from "node:crypto";
import { promises as fs, createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { create as tarCreate } from "tar";
import ignore, { Ignore } from "ignore";

const MAX_BYTES = 200 * 1024 * 1024;

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

async function buildIgnore(cwd: string): Promise<Ignore> {
  const ig = ignore();
  ig.add(DEFAULT_IGNORE);
  ig.add(await readIgnoreFile(path.join(cwd, ".gitignore")));
  ig.add(await readIgnoreFile(path.join(cwd, ".layeroignore")));
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
  await tarCreate(
    {
      file: archivePath,
      gzip: { level: 6 },
      cwd: targetDir,
      portable: true,
      prefix: rootName,
    },
    files,
  );
  const fst = await fs.stat(archivePath);
  if (fst.size > MAX_BYTES) {
    await fs.unlink(archivePath).catch(() => undefined);
    throw new Error(
      `archive is ${(fst.size / (1024 * 1024)).toFixed(1)}MB — over the 200MB limit. ` +
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

  const stamp = Date.now();
  const safeName = projectName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const archivePath = path.join(tmpdir(), `layero-${safeName}-${stamp}.tgz`);
  // Single root directory inside the archive — matches the github_archive
  // contract on the builder side, which strips one root prefix.
  const rootName = `layero-${safeName}-${stamp}`;

  await tarCreate(
    {
      file: archivePath,
      gzip: { level: 6 },
      cwd,
      portable: true,
      prefix: rootName,
    },
    files,
  );

  const stat = await fs.stat(archivePath);
  if (stat.size > MAX_BYTES) {
    await fs.unlink(archivePath).catch(() => undefined);
    throw new Error(
      `archive is ${(stat.size / (1024 * 1024)).toFixed(1)}MB — over the 200MB limit. ` +
        "Add large directories to .layeroignore.",
    );
  }

  const sha256 = await sha256OfFile(archivePath);
  return { archivePath, sha256, size: stat.size, fileCount: files.length };
}
