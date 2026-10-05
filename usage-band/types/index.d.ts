// One rate-limit window as the last API response reported it
export type UsageWindow = { kind: string; percentUsed: number; resetsAt?: string }

// The latest reading of all windows and when it was taken (ms since epoch)
export type UsageReading = { at: number; windows: UsageWindow[] }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { reading: UsageReading | null }
  }
}
