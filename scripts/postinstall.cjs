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

const lines = [
  "",
  `${c.green}${c.bold}✨ Layero CLI installed${c.reset}`,
  "",
  `  ${c.cyan}layero login${c.reset}              ${c.dim}authenticate via browser${c.reset}`,
  `  ${c.cyan}cd your-site && layero deploy${c.reset}  ${c.dim}publish current dir${c.reset}`,
  `  ${c.cyan}layero --help${c.reset}             ${c.dim}all commands${c.reset}`,
  "",
  `  ${c.dim}Docs: https://layero.ru${c.reset}`,
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
