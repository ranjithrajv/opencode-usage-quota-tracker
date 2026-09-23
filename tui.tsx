/** @jsxImportSource @opentui/solid */
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createSignal, createRoot } from "solid-js"
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
function readAuthFile(): Record<string,string> {
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
function readAuthDb(): Record<string,string> {
  try {
    const dbPath = join(homedir(), ".local/share/opencode/opencode.db")
    const { Database } = (Function('return require')() as any)("bun:sqlite")
    const db = new Database(dbPath, { readonly: true } as any)
    const rows = db.query("SELECT integration_id, value FROM credential").all() as any[]
    const out: Record<string,string> = {}
    for (const r of rows) {
      const id = String(r.integration_id ?? "").trim()
      if (!id) continue
      try {
        const parsed = JSON.parse(String(r.value ?? ""))
        const key = (parsed as any)?.key ?? parsed
        if (typeof key === "string" && key.trim()) out[id] = key.trim()
      } catch {
        const raw = String(r.value ?? "").trim()
        if (raw) out[id] = raw
      }
    }
    try { (db as any).close?.() } catch {}
    return out
  } catch { return {} }
}
function readAuth(): Record<string,string> {
  return { ...readAuthFile(), ...readAuthDb() }
}
function authKeys(ids: string[]): string[] {
  const a = readAuth()
  return ids.map(id=>a[id]).filter(Boolean) as string[]
}
function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n/1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n/1_000).toFixed(1)}k`
  return String(n)
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
function unwrap(m: any): any { return m?.info ?? m }
function isAssistant(m: any): boolean { return (m?.type ?? m?.role) === "assistant" }
function modelId(m: any): string { return m?.model?.modelID ?? m?.modelID ?? m?.model?.id ?? m?.id ?? "" }
function providerId(m: any): string { return m?.model?.providerID ?? m?.providerID ?? "" }
function isFreeModel(id: string): boolean { const m = String(id||"").toLowerCase(); return m.endsWith("-free") || m === "big-pickle" }
function parseCooldown(text: string): number | null {
  if (!text) return null
  const now = Date.now()
  const absolute = text.match(/reset[^.\d]*(\d{4}-\d{2}-\d{2}[\dT .:+-]*Z)/i)
  if (absolute) { const ms = Date.parse(absolute[1]); if (Number.isFinite(ms) && ms > now - 3600_000) return ms }
  const rel = text.match(/retry in (\d+)\s*(\w+)?s?/i)
  if (rel) { const mult: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 }; const unit = (rel[2] ?? "").toLowerCase().replace(/s$/, ""); const factor = mult[unit]; if (factor !== undefined) return now + Number(rel[1]) * factor }
  if (/limit (reached|exceeded)|usagelimiterror/i.test(text)) return now + 3600_000
  return null
}
interface FreeWindows { h5: number; week: number; month: number }
interface FreeModelUsage { totals: FreeWindows; byModel: Record<string, FreeWindows>; cooldowns: Record<string, number> }
function providerUsage(api: any, sessionID: string | undefined, providerID: string): FreeModelUsage {
  const totals: FreeWindows = { h5: 0, week: 0, month: 0 }
  const byModel: Record<string, FreeWindows> = {}
  const cooldowns: Record<string, number> = {}
  const now = Date.now()
  const h5Start = now - 5 * 3600_000
  const weekStart = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()))
  weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7))
  const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1)
  const bump = (model: string, ts: number, total: number) => {
    const w = (byModel[model] ??= { h5: 0, week: 0, month: 0 })
    if (ts >= h5Start) { w.h5 += total; totals.h5 += total }
    if (ts >= weekStart.getTime()) { w.week += total; totals.week += total }
    if (ts >= monthStart) { w.month += total; totals.month += total }
  }
  try {
    const sid = sessionID
    if (!sid) return { totals, byModel, cooldowns }
    const messages = api.state?.session?.messages?.(sid) ?? []
    for (const entry of messages) {
      const m = unwrap(entry)
      const model = modelId(m)
      for (const part of (m?.parts ?? []) as any[]) {
        const ptext = String(part?.error?.message ?? part?.error ?? part?.text ?? "")
        if (!/limit|usagelimiterror/i.test(ptext)) continue
        const untilMs = parseCooldown(ptext)
        const pmodel = String(part?.error?.modelID ?? part?.modelID ?? model)
        if (untilMs) cooldowns[pmodel] = Math.max(cooldowns[pmodel] ?? 0, untilMs)
      }
      if (!isAssistant(m) || providerId(m) !== providerID) continue
      if (providerID === ZEN_PROVIDER && !isFreeModel(model)) continue
      const tokens = m?.tokens ?? {}
      const read = tokens?.cache?.read
      const readTokens = Number(typeof read === "object" ? (read?.input ?? 0) : (read ?? 0)) || 0
      const total = (Number(tokens?.input ?? 0) || 0) + (Number(tokens?.output ?? 0) || 0) + (Number(tokens?.reasoning ?? 0) || 0) + readTokens
      if (total <= 0) continue
      const created = m?.time?.created ?? m?.timeCreated ?? m?.createdAt
      const ts = typeof created === "number" ? created : Date.parse(created ?? "")
      if (!Number.isFinite(ts)) continue
      bump(model, ts, total)
    }
  } catch {}
  return { totals, byModel, cooldowns }
}

export const tui: TuiPlugin = async (api) => {
  try { const t:any=(api as any).ui?.toast??(api as any).toast; if(t) t({message:"quota tracker db4bad3 loaded"}); else (api as any).ui?.toast?.({message:"quota tracker db4bad3 loaded"} as any) } catch {}
  try { const k=Object.keys(api as any).join(","); (api as any).ui?.toast?.({message:`api keys:${k.slice(0,120)}`} as any) } catch {}
  return createRoot((dispose) => {
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

    poll()
    timer = setInterval(poll, POLL_MS)
    try {
      const onDispose = (api as any)?.lifecycle?.onDispose
      if (typeof onDispose === "function") onDispose(() => { if (timer) clearInterval(timer); dispose() })
      else if ((api as any)?.lifecycle?.signal) (api as any).lifecycle.signal.addEventListener("abort", () => { if (timer) clearInterval(timer); dispose() }, { once: true } as any)
    } catch {}

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

    try {
      const footer = (ctx: any, props: any) => {
          const sid = (props as any)?.session_id ?? (props as any)?.sessionID
          const keys = authKeys([ZEN_PROVIDER, GO_PROVIDER])
          if (keys.length===0) {
            const fw = providerUsage(api, sid, ZEN_PROVIDER)
            const hasLocal = fw.totals.h5 > 0 || Object.keys(fw.byModel).length > 0
            if (!hasLocal) return <text>quota — no key · /connect</text> as any
            const localLines = [
              `free 5h ${fmt(fw.totals.h5)} tok`,
              `free 1w ${fmt(fw.totals.week)} tok`,
              `free 1mo ${fmt(fw.totals.month)} tok`,
              ...Object.entries(fw.byModel).filter(([,w])=>w.h5>0).sort((a,b)=>b[1].h5-a[1].h5).slice(0,3).map(([id,w])=>`${id} ${fmt(w.h5)}`)
            ]
            return <text>{localLines.join("\n")}</text> as any
          }
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
            const fw = providerUsage(api, sid, ZEN_PROVIDER)
            if (fw.totals.h5 > 0) {
              return <text>{`free 5h ${fmt(fw.totals.h5)} tok\nfree 1w ${fmt(fw.totals.week)} tok`}</text> as any
            }
            return <text>quota —</text> as any
          }
          const quotaLines = known.map(([label, w]) => {
            const p = w.percent ?? 0
            const b = bar(p)
            const eta = until(w.resetsAt)
            const warn = w.status && w.status !== "ok" ? " ⚠" : ""
            return `${label} ${b} ${p}%${warn}${eta ? ` · resets ${eta}` : ""}`
          })
          const fw = providerUsage(api, sid, ZEN_PROVIDER)
          const modelRows = Object.entries(fw.byModel)
            .filter(([,w])=>w.h5>0)
            .sort((a,b)=>b[1].h5-a[1].h5)
            .slice(0,5)
            .map(([id,w])=>{
              const cd = fw.cooldowns[id]
              const cdTxt = cd && cd > Date.now() ? ` ⏳${until(new Date(cd).toISOString())}` : ""
              return `${id} ${fmt(w.h5)}${cdTxt}`
            })
          const allLines = [...quotaLines, ...modelRows]
          return <text>{allLines.join("\n")}</text> as any
        }
      const a: any = api as any
      if (a.slots?.register) a.slots.register({ slots: { sidebar_footer: footer } })
      else if (a.ui?.slot) a.ui.slot({ slot: "sidebar_footer", render: footer } as any)
      else if (a.slot) a.slot({ slot: "sidebar_footer", render: footer } as any)
      try { a.ui?.toast?.({ message: "quota tracker loaded" } as any) } catch {}
    } catch {}
    return
  })
}
// V2 TUI loader expects default export – keep both tui and setup for VAt (id+setup) check
export default { id: "opencode-go.usage", tui, setup: tui } as any
