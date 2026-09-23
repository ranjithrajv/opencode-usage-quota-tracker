/** @jsxImportSource @opentui/solid */
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createSignal } from "solid-js"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const ZEN_PROVIDER = "opencode"
const GO_PROVIDER = "opencode-go"
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
const POLL_MS = 60_000

function bar(p: number): string {
  const filled = Math.round(Math.max(0, Math.min(100, p))/10)
  return "█".repeat(filled) + "░".repeat(10-filled)
}
function until(iso?: string): string | null {
  if (!iso) return null
  const ms = Date.parse(iso) - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return null
  const s = Math.floor(ms/1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s/60)}m`
  if (s < 86400) return `${Math.floor(s/3600)}h`
  return `${Math.floor(s/86400)}d`
}
function readAuth(): Record<string,string> {
  try {
    const p = join(homedir(), ".local/share/opencode/auth.json")
    const j = JSON.parse(readFileSync(p, "utf8"))
    const out: Record<string,string> = {}
    for (const [k,v] of Object.entries(j as any)) {
      const key = (v as any)?.key
      if (typeof key === "string" && key.trim()) out[k]=key.trim()
    }
    return out
  } catch { return {} }
}
function authKeys(ids: string[]): string[] {
  const a = readAuth()
  return ids.map(id=>a[id]).filter(Boolean) as string[]
}
interface Window { status?: string; percent?: number; resetsAt?: string }
interface GoUsage { usage?: { rolling?: Window; weekly?: Window; monthly?: Window } }
function parseUsage(j: any): GoUsage | null {
  if (!j || typeof j !== "object") return null
  if (j.usage) return j as GoUsage
  if (j.rolling || j.weekly || j.monthly) return { usage: j }
  return null
}
async function fetchUsage(): Promise<GoUsage | null> {
  const keys = authKeys([ZEN_PROVIDER, GO_PROVIDER])
  if (keys.length===0) return null
  for (const k of keys) {
    try {
      const r = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${k}` } })
      if (r.ok) {
        const j = await r.json()
        const p = parseUsage(j)
        if (p) return p
      }
    } catch {}
  }
  return null
}

export const tui: TuiPlugin = async (api) => {
  const [usage, setUsage] = createSignal<GoUsage | null>(null)
  const [err, setErr] = createSignal<string | null>(null)

  let timer: ReturnType<typeof setInterval> | null = null

  async function poll() {
    const u = await fetchUsage()
    if (u) {
      setUsage(u)
      setErr(null)
    } else {
      if (!usage()) setErr("quota —")
    }
  }

  await poll()
  timer = setInterval(poll, POLL_MS)
  api.lifecycle.onDispose(() => { if (timer) clearInterval(timer) })

  // optional command to refresh
  try {
    api.keymap.registerLayer(() => ({
      mode: "global",
      priority: 0,
      commands: [{
        id: "usage.view",
        title: "Usage footer: refresh",
        description: "Refresh Go quota",
        group: "Usage",
        slash: { name: "usage-view", aliases: ["usage"] },
        run: () => { poll(); api.ui.toast({ message: "Usage refreshed" }) }
      }]
    }))
  } catch {}

  api.slots.register({
    slots: {
      sidebar_footer: (ctx, props) => {
        const keys = authKeys([ZEN_PROVIDER, GO_PROVIDER])
        if (keys.length===0) return null as any

        const u = usage()
        if (!u?.usage) {
          return <text>{err() ?? "quota —"}</text> as any
        }

        const windows: Array<[string, Window | undefined]> = [
          ["5h", u.usage?.rolling],
          ["1w", u.usage?.weekly],
          ["1mo", u.usage?.monthly],
        ]
        const known = windows.filter(([,w]) => w && typeof w.percent === "number") as Array<[string, Window]>
        if (known.length===0) {
          return <text>quota —</text> as any
        }

        const lines = known.map(([label, w]) => {
          const p = w.percent ?? 0
          const b = bar(p)
          const eta = until(w.resetsAt)
          const warn = w.status && w.status !== "ok" ? " ⚠" : ""
          return `${label} ${b} ${p}%${warn}${eta ? ` · resets ${eta}` : ""}`
        })

        return <text>{lines.join("\n")}</text> as any
      }
    }
  })
}
