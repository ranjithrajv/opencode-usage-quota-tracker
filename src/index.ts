import { Plugin } from "@opencode-ai/plugin"

// Server-side entrypoint. All behavior lives in the TUI entrypoint
// (src/tui.tsx), which renders live provider quota usage into the
// sidebar footer only — never sidebar content, and no messages are
// injected into sessions.
export default Plugin.define({
  id: "opencode-go.usage",
  setup() {},
})
