import type { Plugin } from "@opencode-ai/plugin"

// Stable v2 server plugin - no-op, all behavior is in TUI
export const QuotaTrackerPlugin: Plugin = async () => {
  return {}
}
