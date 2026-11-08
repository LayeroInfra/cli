// Env files stay out of the deploy archive whatever `.gitignore` says.
//
// User report (monorepo): `!.env` and `!.env.example` in `.gitignore` undid
// the built-in `.env*` exclusion, so `.env` was uploaded unless `.env*` was
// repeated in `.layeroignore`. Only an explicit `.layeroignore` negation that
// names an env file may bring one back.
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { list as tarList } from "tar";
import { describe, expect, it } from "vitest";
import { packCwd } from "../src/pack.js";

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "layero-pack-env-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

async function packed(files: Record<string, string>): Promise<string[]> {
  const res = await packCwd(project(files), "t");
  const names: string[] = [];
  await tarList({ file: res.archivePath, onReadEntry: (e) => { names.push(e.path); } });
  unlinkSync(res.archivePath);
  return names.map((n) => n.split("/").slice(1).join("/")).filter(Boolean).sort();
}

const base = { "index.html": "<h1>hi</h1>", ".env": "SECRET=1", ".env.example": "SECRET=" };

describe("pack: env files", () => {
  it("excluded by default", async () => {
    expect(await packed(base)).toEqual(["index.html"]);
  });

  it(".gitignore negations do not bring them back", async () => {
    const files = await packed({
      ...base,
      ".gitignore": ".env*\n!.env\n!.env.example\n",
      "apps/web/.env": "SECRET=2",
      "apps/web/.env.local": "SECRET=3",
      "apps/web/main.js": "",
    });
    expect(files).toEqual(["apps/web/main.js", "index.html"]);
  });

  it("broad .gitignore negation does not bring them back", async () => {
    expect(await packed({ ...base, ".gitignore": "!*\n" })).toEqual(["index.html"]);
  });

  it("broad .layeroignore negation does not bring them back", async () => {
    expect(await packed({ ...base, ".layeroignore": "!*\n!**/*\n" })).toEqual(["index.html"]);
  });

  it("broad negations keep VCS metadata and the CLI link out", async () => {
    const files = await packed({
      ...base,
      ".git/config": "[remote] url = https://token@host/r.git",
      ".layero/project.json": "{\"claim\":\"x\"}",
      ".gitignore": "!*\n!**/*\n",
      ".layeroignore": "!.git\n!.layero\n!*\n",
    });
    expect(files).toEqual(["index.html"]);
  });

  it("explicit .layeroignore negation naming the file does", async () => {
    const files = await packed({
      ...base,
      ".env.production": "VITE_PUBLIC=1",
      ".layeroignore": "!.env.production\n",
    });
    expect(files).toEqual([".env.production", "index.html"]);
  });

  it(".layeroignore can still exclude more", async () => {
    expect(await packed({ ...base, "draft.html": "", ".layeroignore": "draft.html\n" }))
      .toEqual(["index.html"]);
  });
});
