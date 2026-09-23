import { Plugin } from "@opencode-ai/plugin/tui"
import {
  availableProviders,
  authKeys,
  bar,
  createCachedStore,
  createConnectedProviders,
  createPollingFetcher,
  createViewPicker,
  fmt,
  fmtCost,
  GO_PROVIDER,
  isAssistant,
  modelId,
  parseUsage,
  providerId,
  providerLabel,
  providerTitle,
  resolveCurrentModel,
  sumProviderTokens,
  until,
  unwrap,
  ZEN_PROVIDER,
} from "opencode-plugin-kit"

// This plugin shows provider quota and usage for the OpenCode workspace
// (go/zen plan quota; usage + model breakdown for every authenticated
// provider via local message history).
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
const POLL_MS = 60_000
const STALE_AFTER_MS = 2 * POLL_MS

interface Window {
  status?: string
  percent?: number
  resetsAt?: string
}

interface GoUsage {
  usage?: {
    rolling?: Window
    weekly?: Window
    monthly?: Window
  }
}

interface GoTotals {
  input: number
  output: number
  cost: number
}

// The usage endpoint accepts any workspace key. Try the Zen (opencode)
// provider key first, then fall back to the Go provider key, so the widget
// also works for users who only have a Zen key.
export function apiKeys(): string[] {
  return authKeys([ZEN_PROVIDER, GO_PROVIDER])
}

// Sum tokens/cost across the session's assistant messages that used the
// given provider. Delegates to the kit's defensive message walker.
export function providerTotals(context: any, providerID: string, sessionID?: string): GoTotals {
  const t = sumProviderTokens(context, sessionID, providerID)
  return { input: t.input, output: t.output, cost: t.cost }
}

// Free Zen models: explicit -free suffixes plus the known always-free
// standbys. The server does not expose free-tier quota, so usage here is a
// local estimate from message history — useful for pace, not an authority.
export function isFreeModel(id: string): boolean {
  const m = String(id || "").toLowerCase()
  return m.endsWith("-free") || m === "big-pickle"
}

interface FreeWindows {
  h5: number
  week: number
  month: number
}

interface FreeModelUsage {
  totals: FreeWindows
  byModel: Record<string, FreeWindows>
  // Per-model cooldowns parsed from limit errors found in message history
  // ("Try again in N hours" / resetsAt), keyed by model id.
  cooldowns: Record<string, number> // model id -> epoch ms when the window frees up
}

let providerUsageCache: { at: number; value: Record<string, FreeModelUsage> } | null = null

// Test-only: clear the module-level provider usage cache between tests.
export function __resetProviderUsageCache(): void {
  providerUsageCache = null
}

// Extract a retry/cooldown epoch from a limit-error payload. The Zen API is
// the only place per-model free limits surface; the TUI persists those
// errors as message parts, so history doubles as our cooldown ledger.
export function parseCooldown(text: string): number | null {
  if (!text) return null
  const now = Date.now()
  const absolute = text.match(/reset[^.\d]*(\d{4}-\d{2}-\d{2}[\dT .:+-]*Z)/i)
  if (absolute) {
    const ms = Date.parse(absolute[1])
    if (Number.isFinite(ms) && ms > now - 3600_000) return ms
  }
  const rel = text.match(/retry in (\d+)\s*(\w+)?s?/i)
  if (rel) {
    const mult: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 }
    const unit = (rel[2] ?? "").toLowerCase().replace(/s$/, "")
    const factor = mult[unit]
    if (factor !== undefined) return now + Number(rel[1]) * factor
  }
  if (/limit (reached|exceeded)|usagelimiterror/i.test(text)) return now + 3600_000 // unknown window: assume ≥1h
  return null
}

// Sum tokens per model over the rolling 5h window, the current UTC week
// (Mon 00:00, matching the server's weekly window), and the current calendar
// month, scoped to one provider's assistant messages. The zen view tracks
// free-tier models; other providers track all of their models. Walks every
// cached session; throttled because it is O(sessions × messages). Local
// estimate only — the server keeps no per-provider quota API outside the
// go/zen plan endpoint.
export function providerUsage(context: any, providerID: string): FreeModelUsage {
  const cached = providerUsageCache?.value[providerID]
  if (providerUsageCache && Date.now() - providerUsageCache.at < 30_000 && cached) return cached
  const totals: FreeWindows = { h5: 0, week: 0, month: 0 }
  const byModel: Record<string, FreeWindows> = {}
  const cooldowns: Record<string, number> = {}
  const now = Date.now()
  const h5Start = now - 5 * 3600_000
  const weekStart = new Date(
    Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()),
  )
  weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7)) // Monday
  const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1)
  const bump = (model: string, ts: number, total: number) => {
    const w = (byModel[model] ??= { h5: 0, week: 0, month: 0 })
    if (ts >= h5Start) {
      w.h5 += total
      totals.h5 += total
    }
    if (ts >= weekStart.getTime()) {
      w.week += total
      totals.week += total
    }
    if (ts >= monthStart) {
      w.month += total
      totals.month += total
    }
  }
  try {
    for (const s of context.data.session.list() ?? []) {
      const sid = (s as any)?.id ?? (s as any)?.info?.id
      if (!sid) continue
      for (const entry of context.data.session.message.list(sid) ?? []) {
        const m = unwrap(entry)
        const model = modelId(m)
        // Limit errors ride along as message parts; harvest their cooldown.
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
        const total =
          (Number(tokens?.input ?? 0) || 0) +
          (Number(tokens?.output ?? 0) || 0) +
          (Number(tokens?.reasoning ?? 0) || 0) +
          readTokens
        if (total <= 0) continue
        const created = m?.time?.created ?? m?.timeCreated ?? m?.createdAt
        const ts = typeof created === "number" ? created : Date.parse(created ?? "")
        if (!Number.isFinite(ts)) continue
        bump(model, ts, total)
      }
    }
  } catch {
    // Keep whatever was accumulated.
  }
  providerUsageCache = {
    at: Date.now(),
    value: { ...providerUsageCache?.value, [providerID]: { totals, byModel, cooldowns } },
  }
  return { totals, byModel, cooldowns }
}

// Plan quota from the same endpoint the console uses. The fetch/caching
// closures live in setup() because the durable cache needs the plugin
// context (see usageCache below).
type UsageCache = ReturnType<typeof createUsageStore>
let usageCache: UsageCache

// Fetch usage, trying each workspace key in order. Returns the parsed
// usage on success, null to keep the last-known-good cache on failure.
export async function fetchUsage(): Promise<GoUsage | null> {
  const keys = apiKeys()
  if (keys.length === 0) return null
  for (const key of keys) {
    try {
      const res = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${key}` } })
      if (res.ok) {
        // Parse, don't cast: an unrecognized shape degrades to the last
        // known-good cache instead of poisoning it.
        const parsed = parseUsage(await res.json())
        if (parsed) return parsed
      }
    } catch {
      // Try the next key; keep the last known usage on total failure.
    }
  }
  return null
}

// Durable cache: the slot render is synchronous, so the latest successful
// fetch is what gets displayed and a background timer keeps it fresh —
// including instantly after a TUI restart, from storage.
export function createUsageStore(context: any) {
  return createCachedStore<GoUsage | null>(context, "usage", { initial: null, staleAfterMs: STALE_AFTER_MS })
}

// ---------------------------------------------------------------------------
// Shared row vocabulary — the common UI every view renders through.
// ---------------------------------------------------------------------------

/** A window row: label + value, with an optional server-reported percent
 * (renders the bar) and reset countdown. */
interface WindowRow {
  kind: "window"
  label: string
  value: string
  percent?: number
  resetsAt?: string
  warn?: boolean
}

/** A provider usage line: `label usage <tokens> tok · $<cost>`. */
interface UsageRow {
  kind: "usage"
  label: string
  providerID: string
}

/** Free-form line (model breakdown, status notes). */
interface TextRow {
  kind: "text"
  text: string
}

type Row = WindowRow | UsageRow | TextRow

export function renderUsageRow(context: any, row: UsageRow, sessionID?: string): string {
  const t = providerTotals(context, row.providerID, sessionID)
  const active = t.input + t.output > 0 || t.cost > 0
  return active ? `${row.label} usage ${fmt(t.input + t.output)} tok · ${fmtCost(t.cost)}` : `${row.label} usage —`
}

export function renderWindowRow(row: WindowRow): string {
  const value = typeof row.percent === "number" ? `${bar(row.percent)} ${row.percent}%` : row.value
  const line = `${row.label} ${value}${row.warn ? " ⚠" : ""}`
  const eta = until(row.resetsAt)
  return eta ? `${line} · resets ${eta}` : line
}

export function renderRow(context: any, row: Row, sessionID?: string): string {
  switch (row.kind) {
    case "usage":
      return renderUsageRow(context, row, sessionID)
    case "window":
      return renderWindowRow(row)
    case "text":
      return row.text
  }
}

// Owns the sidebar footer via `replace` — the built-in aggregate USAGE block
// (cost/sessions/streak) is not shown; only the provider quota line is.
// Never touches sidebar content or session messages.
export default Plugin.define({
  id: "opencode-go.usage.tui",
  setup(context: any) {
    usageCache = createUsageStore(context)

    // Polling fetcher: throttles, guards concurrent fetches, and keeps the
    // last-known-good value on failure. Replaces manual setInterval + flags.
    const polling = createPollingFetcher({
      fetch: fetchUsage,
      intervalMs: POLL_MS,
      throttleMs: POLL_MS,
      onResult: (usage) => usageCache.set(usage),
    })

    const compact = context.options?.compact === true

    // Footer view selection. VIEWS is the single extension point: each entry
    // owns its rows() builder, so adding a provider means appending one entry
    // here — the picker, slash command, persistence, and footer renderer all
    // derive from the registry. The active view is persisted across restarts
    // and held in a signal so switching re-renders the footer.
    type ViewID = string
    interface ProviderView {
      readonly id: ViewID
      readonly title: string
      readonly description: string
      /** Provider whose key gates this view (like /connect's list). */
      readonly providerID: string
      readonly rows: (sessionID?: string) => Row[]
    }

    // A view is available only when its provider is connected — read from
    // the same source /connect uses: the integration list, where an entry
    // with a non-empty `connections` array means an added key/credential.
    // The kit's createConnectedProviders polls the integration list and
    // falls back to availableProviders() (auth.json + HF_TOKEN) when the
    // client is unavailable.
    const connected = createConnectedProviders(context, { pollMs: POLL_MS })
    const hasKey = (providerID: string): boolean => connected.has(providerID)
    const availableViews = () => VIEWS.filter((v) => hasKey(v.providerID))

    // Plan quota rows (shared workspace quota; aggregates all providers).
    // Server-reported percents → bars. Never fetched: distinguish pending
    // from fetch failure. Compact mode keeps only the tightest window.
    const planQuotaRows = (): Row[] => {
      const windows: Array<[string, Window | undefined]> = [
        ["5h", usageCache.value?.usage?.rolling],
        ["1w", usageCache.value?.usage?.weekly],
        ["1mo", usageCache.value?.usage?.monthly],
      ]
      const known = windows.filter(([, w]) => w && typeof w.percent === "number") as Array<[string, Window]>
      if (known.length === 0) {
        const failed =
          usageCache.lastSet > 0 && Date.now() - usageCache.lastSet >= STALE_AFTER_MS && !polling.inFlight()
        return [{ kind: "text", text: failed ? "quota ✗ (fetch failed)" : "quota —" }]
      }
      const tightestIdx = known.reduce(
        (best, [, w], i) => ((w.percent as number) > (known[best][1].percent as number) ? i : best),
        0,
      )
      const shown = compact ? [known[tightestIdx]] : known
      const rows: Row[] = shown.map(([label, w]) => ({
        kind: "window",
        label,
        value: "",
        percent: w.percent,
        resetsAt: w.resetsAt,
        warn: !!w.status && w.status !== "ok",
      }))
      if (usageCache.lastSet > 0 && usageCache.stale) rows.push({ kind: "text", text: "· stale" })
      return rows
    }

    // One view per authenticated provider (plus go's plan-quota rows and
    // zen's free-tier breakdown). Built from the same discovery the picker
    // and tool use, so new providers appear without edits. Go stays first —
    // it was the original default view, so persisted picks keep matching.
    const buildViews = (): ProviderView[] => {
      const priority = new Map<string, number>([
        [GO_PROVIDER, 0],
        [ZEN_PROVIDER, 1],
      ])
      return availableProviders()
        .map((pid): ProviderView => {
          const label = providerLabel(pid)
          if (pid === GO_PROVIDER) {
            return {
              id: label,
              title: providerTitle(pid),
              description: "Go plan usage line and quota windows",
              providerID: pid,
              rows: (_sessionID) => [{ kind: "usage", label, providerID: pid }, ...planQuotaRows()],
            }
          }
          // zen = free-tier breakdown; any other provider = its model usage.
          const zenLike = pid === ZEN_PROVIDER
          return {
            id: label,
            title: providerTitle(pid),
            description: `${providerTitle(pid)} usage and model breakdown`,
            providerID: pid,
            rows: (_sessionID) => {
              const fw = providerUsage(context, pid)
              const wl = (s: string) => (zenLike ? `free ${s}` : s)
              const freeRows: Row[] = [
                { kind: "window", label: wl("5h"), value: `${fmt(fw.totals.h5)} tok` },
                { kind: "window", label: wl("1w"), value: `${fmt(fw.totals.week)} tok` },
                { kind: "window", label: wl("1mo"), value: `${fmt(fw.totals.month)} tok` },
              ]
              // Per-model breakdown: models active in the 5h window, with any
              // known cooldown countdown appended. Server limits are not
              // queryable, so the cooldown only appears after a limit error.
              const modelRows: Row[] = Object.entries(fw.byModel)
                .filter(([id, w]) => w.h5 > 0 || (fw.cooldowns[id] ?? 0) > Date.now())
                .sort((a, b) => b[1].h5 - a[1].h5)
                .map(([id, w]) => {
                  const cd = fw.cooldowns[id]
                  const cdTxt = cd && cd > Date.now() ? ` ⏳${until(new Date(cd).toISOString())}` : ""
                  return { kind: "text", text: `${id} ${fmt(w.h5)}${cdTxt}` } as Row
                })
              return [{ kind: "usage", label, providerID: pid }, ...freeRows, ...modelRows]
            },
          }
        })
        .sort((a, b) => (priority.get(a.providerID) ?? 99) - (priority.get(b.providerID) ?? 99))
    }
    const VIEWS = buildViews()

    // Provider the current session is actually using: the provider of the
    // most recent assistant message. Delegates to the kit's resolver.
    const sessionProvider = (sessionID?: string): string | null => {
      const m = resolveCurrentModel(context, sessionID)
      return m?.providerID ?? null
    }

    // Auto-pick precedence:
    // 1. The view matching the provider the session is actively using
    //    (only when its key is added) — the footer follows what you use.
    // 2. The user's persisted/manual pick via /usage-view, if still available.
    // 3. The first connected view.
    // Computed, never set during render, so reactivity stays clean.
    const effectiveView = (sessionID?: string): ViewID => {
      const available = availableViews()
      if (available.length === 0) return "go"
      const used = sessionProvider(sessionID)
      const usedView = used ? available.find((v) => v.providerID === used) : undefined
      const persisted = VIEWS.find((v) => v.id === picker.currentID())
      return (usedView ?? (available.includes(persisted!) ? persisted : undefined) ?? available[0]).id as ViewID
    }
    const currentView = (sessionID?: string) => VIEWS.find((v) => v.id === effectiveView(sessionID))!

    // Picker (registry + persistence + /usage-view command + dialog + toast).
    // A view is selectable only when its provider key is added; a non-empty
    // argument selects that view directly (e.g. `/usage-view zen`).
    const picker = createViewPicker(context, {
      registry: VIEWS,
      storageKey: "view",
      command: {
        id: "usage.view",
        group: "Usage",
        name: "usage-view",
        aliases: ["usage"],
        title: () => `Usage footer: view provider (${currentView().title})`,
        description: "Pick which provider's usage the sidebar footer shows",
      },
      dialog: { title: "Usage view", message: "Choose the provider view shown in the sidebar footer" },
      toastPrefix: "Usage footer",
      selectable: (v) => availableViews().includes(v),
      unavailableMessage: (v) => `${v.title} has no API key added. Run /connect to add it first.`,
    })
    picker.registerCommand()

    const slot = context.ui.slot({
      replace: "sidebar.footer",
      render: ({ sessionID }: { sessionID?: string }) => {
        // No workspace key configured: render nothing instead of dead weight.
        if (apiKeys().length === 0) return null

        // One shared renderer: the active view's registry entry supplies the
        // rows, the footer just paints them.
        const lines = currentView(sessionID)
          .rows(sessionID)
          .map((row) => renderRow(context, row, sessionID))
          .filter((l) => l !== "")
        return <text>{lines.join("\n")}</text>
      },
    })

    return () => {
      polling.stop()
      connected.stop()
      slot?.()
    }
  },
})
