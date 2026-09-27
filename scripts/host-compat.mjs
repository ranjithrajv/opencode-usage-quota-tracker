// Runtime host-compatibility probe.
//
// Typecheck cannot catch a missing runtime dependency: the dev tree always has
// @opencode/plugin installed, so `import { Plugin } from "@opencode/plugin"`
// type-resolves even when the package is declared peer-only and a consumer
// would get ERR_MODULE_NOT_FOUND at load time. This script packs the real
// tarball, installs it into a throwaway project, and imports both entrypoints
// under Bun -- the runtime OpenCode's TUI plugin loader actually uses -- with
// nothing but the host's own @opentui peers supplied.
//
// It is the check that caught three real bugs: @opencode/plugin,
// opencode-plugin-kit and solid-js all declared peer-only (so never
// installed), and a missing @jsxImportSource pragma making Bun fall back to
// React's JSX runtime.
//
// Usage: node scripts/host-compat.mjs <dir> [...]
// Exits non-zero if any package fails to import.
//
// Vendored per-repo on purpose: each plugin is a standalone repository, so CI
// cannot reach a sibling checkout. Keep the copies in sync — the four plugin
// repos should hold byte-identical scripts/host-compat.mjs.

import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const dirs = process.argv.slice(2)
if (dirs.length === 0) {
  console.error("usage: node scripts/host-compat.mjs <dir> [...]")
  process.exit(2)
}

let bun
try {
  bun = execFileSync("which", ["bun"], { encoding: "utf8" }).trim()
} catch {
  console.warn("bun not installed; skipping runtime host-compat probe")
  process.exit(0)
}

let failed = 0

for (const dir of dirs) {
  const cwd = resolve(dir)
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"))
  const name = pkg.name
  const tmp = mkdtempSync(join(tmpdir(), "host-compat-"))

  try {
    const tgz = execFileSync("npm", ["pack", "--pack-destination", tmp, "--silent"], {
      cwd,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .pop()

    execFileSync(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--legacy-peer-deps",
        "--silent",
        join(tmp, tgz),
        // The host supplies these at runtime; they are peer-only by design.
        "@opentui/core@^0.5.11",
        "@opentui/solid@^0.5.11",
      ],
      { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )

    const probe = `
      const d = ${JSON.stringify(tmp)}, n = ${JSON.stringify(name)};
      const t = (f) => import(d + "/node_modules/" + n + f)
        .then(() => "OK")
        .catch((e) => "FAIL " + (e.code || "err") + " | " + String(e.message).split("\\n")[0]);
      (async () => {
        console.log("  index " + await t("/index.ts"));
        console.log("  tui   " + await t("/tui.tsx"));
      })();
    `

    const out = execFileSync(bun, ["--no-install", "-e", probe], {
      cwd: tmp,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })

    const lines = out.trim().split("\n")
    const ok = lines.length === 2 && lines.every((l) => l.includes("OK"))
    console.log(`${ok ? "pass" : "FAIL"} ${name}@${pkg.version}`)
    lines.forEach((l) => console.log(l))
    if (!ok) failed = 1
  } catch (err) {
    const detail = err.stderr ? String(err.stderr).trim().split("\n").slice(0, 3).join("\n      ") : String(err.message)
    console.log(`FAIL ${name}@${pkg.version}\n      ${detail}`)
    failed = 1
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

process.exit(failed)
