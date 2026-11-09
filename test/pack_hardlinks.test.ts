// Files with several hard links must not stop the deploy (SUP-473).
//
// tar 7.5.22 (latest on 09.11.2026) deadlocks its async packer on files
// whose link count is above one: https://github.com/isaacs/node-tar/issues/460.
// In `create({ file })` mode the promise then never settles, the event loop
// drains, and Node exits with code 0 — `layero deploy` printed «Setup
// complete» and quietly returned to the shell, with a 10-byte archive left
// in the temp folder and nothing uploaded.
import { linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { list as tarList } from "tar";
import { describe, expect, it } from "vitest";
import { LayeroError } from "../src/agent.js";
import { packCwd, packDirectory, guardAgainstSilentStall, SlashAgnosticStatCache, statsWithoutHardlinks } from "../src/pack.js";

/** Astro-like folder: 450 names for one inode, interleaved with plain
 * files — deterministically wedged tar 7.5.22 on macOS (3/3 runs). */
function hardlinkTree(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "layero-pack-hl-"));
  mkdirSync(path.join(dir, "public"));
  writeFileSync(path.join(dir, "package.json"), '{"name":"x"}');
  writeFileSync(path.join(dir, "astro.config.mjs"), "export default {}");
  const src = path.join(dir, "public", "a0000.png");
  writeFileSync(src, Buffer.alloc(2048, 1));
  for (let i = 1; i < 450; i++) {
    const n = String(i).padStart(4, "0");
    linkSync(src, path.join(dir, "public", `a${n}.png`));
    if (i % 3 === 0) writeFileSync(path.join(dir, "public", `a${n}-p.txt`), `plain${i}`);
  }
  return dir;
}

async function entries(archive: string): Promise<{ path: string; type: string; size: number }[]> {
  const out: { path: string; type: string; size: number }[] = [];
  await tarList({ file: archive, onReadEntry: (e) => { out.push({ path: e.path, type: e.type, size: e.size }); } });
  return out;
}

describe("pack: hard links", () => {
  it("packs every hard-linked file in full", async () => {
    const dir = hardlinkTree();
    const res = await packCwd(dir, "t");
    const list = await entries(res.archivePath);
    unlinkSync(res.archivePath);
    const files = list.filter((e) => e.type === "File");
    // 450 links + 149 plain + 2 config files, all as regular files with
    // their content: a Link entry would point at a path the builder may
    // not have, and tar's link logic is what deadlocks.
    expect(res.fileCount).toBe(601);
    expect(files).toHaveLength(601);
    expect(list.filter((e) => e.type === "Link")).toHaveLength(0);
    expect(files.filter((e) => e.path.endsWith(".png")).every((e) => e.size === 2048)).toBe(true);
  }, 20_000);

  it("prebuilt folder with hard links packs too", async () => {
    const dir = hardlinkTree();
    const res = await packDirectory(dir, "t");
    const list = await entries(res.archivePath);
    unlinkSync(res.archivePath);
    expect(list.filter((e) => e.type === "File")).toHaveLength(601);
  }, 20_000);

  it("a hard link to a file outside the folder keeps its content", async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "layero-pack-hl-out-"));
    const dir = mkdtempSync(path.join(os.tmpdir(), "layero-pack-hl-in-"));
    writeFileSync(path.join(outside, "logo.svg"), "<svg/>");
    linkSync(path.join(outside, "logo.svg"), path.join(dir, "logo.svg"));
    writeFileSync(path.join(dir, "index.html"), "<h1>hi</h1>");
    const res = await packCwd(dir, "t");
    const list = await entries(res.archivePath);
    unlinkSync(res.archivePath);
    expect(list.find((e) => e.path.endsWith("/logo.svg"))).toMatchObject({ type: "File", size: 6 });
    expect(readFileSync(path.join(dir, "logo.svg"), "utf-8")).toBe("<svg/>");
  });
});

describe("pack: silent stall guard", () => {
  it("turns a drained event loop mid-pack into an error, not exit 0", async () => {
    const stuck = guardAgainstSilentStall(new Promise<void>(() => {}));
    // What Node does when nothing is left to wait for: it emits
    // `beforeExit`. Without the guard the process would end here with 0.
    process.emit("beforeExit", 0);
    await expect(stuck).rejects.toBeInstanceOf(LayeroError);
    await expect(stuck).rejects.toMatchObject({ code: "pack_stalled" });
  });

  it("passes a finished pack through and stops listening", async () => {
    const before = process.listenerCount("beforeExit");
    await expect(guardAgainstSilentStall(Promise.resolve())).resolves.toBeUndefined();
    expect(process.listenerCount("beforeExit")).toBe(before);
  });
});

describe("pack: stat cache keys", () => {
  const st = { nlink: 1 } as unknown as import("node:fs").Stats;

  it("on Windows both slash forms hit the same entry", () => {
    // tar asks with forward slashes, path.resolve gives backslashes.
    const c = new SlashAgnosticStatCache(true);
    c.set("C:\\Users\\u\\web\\public\\a.png", st);
    expect(c.get("C:/Users/u/web/public/a.png")).toBe(st);
    expect(c.has("C:\\Users\\u\\web\\public\\a.png")).toBe(true);
  });

  it("elsewhere a backslash stays part of the file name", () => {
    const c = new SlashAgnosticStatCache(false);
    c.set("/w/a\\b.png", st);
    expect(c.get("/w/a/b.png")).toBeUndefined();
    expect(c.get("/w/a\\b.png")).toBe(st);
  });

  it("every packed file is in the cache with nlink 1", async () => {
    const dir = hardlinkTree();
    const files = ["public/a0000.png", "public/a0001.png", "package.json"].map((f) => f.split("/").join(path.sep));
    const c = await statsWithoutHardlinks(dir, files);
    for (const f of files) expect(c.get(path.resolve(dir, f))?.nlink).toBe(1);
  });
});
