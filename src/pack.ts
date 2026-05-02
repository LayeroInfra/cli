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
