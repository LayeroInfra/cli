#!/usr/bin/env node
// Print a quick-start banner after `npm install -g layero`.
//
// npm 10+ buffers postinstall stdout AND stderr (foreground-scripts=false
// by default), so writing to either is invisible unless the script fails
// or the user passes --foreground-scripts. Workaround: write directly to
// the controlling terminal at /dev/tty, which bypasses npm's pipe.
//
// On Windows there's no /dev/tty; we fall back to stderr (which Windows
// npm doesn't buffer the same way) and silently skip on any error.

if (process.env.CI) return;
if (process.env.LAYERO_SKIP_POSTINSTALL) return;

// Only print when `layero` is the install target — not when it's pulled
// in as a transitive dep of another package.
const isGlobal = process.env.npm_config_global === "true";
const isDirect = process.env.npm_package_name === "layero";
if (!isGlobal && !isDirect) return;

const fs = require("node:fs");

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
};

// Whether the user installed globally (-g). With local/-D installs the
// `layero` binary isn't on PATH, so we prefix every command with `npx`
// in the banner so it copy-pastes correctly in both modes.
const useNpx = !isGlobal;
const cmd = (s) => (useNpx ? `npx ${s}` : s);

const lines = [
  "",
  `${c.green}${c.bold}✨ Layero CLI installed${c.reset}`,
  "",
  `  ${c.cyan}${cmd("layero login")}${c.reset}    ${c.dim}sign in (GitHub or Yandex)${c.reset}`,
  `  ${c.cyan}${cmd("layero init")}${c.reset}     ${c.dim}scaffold .layero/ + agent docs${c.reset}`,
  `  ${c.cyan}${cmd("layero deploy")}${c.reset}   ${c.dim}ship the current directory${c.reset}`,
  "",
  `  ${c.dim}Docs:    https://docs.layero.ru${c.reset}`,
  `  ${c.dim}Agents:  https://docs.layero.ru/cli/agents${c.reset}`,
  "",
];
const banner = lines.join("\n");

try {
  if (process.platform === "win32") {
    process.stderr.write(banner);
  } else {
    // Open the controlling tty directly. This bypasses npm's stdio pipes.
    const fd = fs.openSync("/dev/tty", "w");
    fs.writeSync(fd, banner);
    fs.closeSync(fd);
  }
} catch {
  // Headless install (no tty), or perms issue — give up silently.
}
