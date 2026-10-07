// A /color argument: one of the colors, or "default" for the theme's own
export type SessionColor = string

declare module 'claude-code' {
  interface PluginState {
    'color-chooser': {
      // The color last set through the picker or a typed /color; null while unknown
      current: SessionColor | null
      // The latest pick whose /color waits in the session's queue until it is idle; null when none waits
      pending: SessionColor | null
      // Whether a turn of the main loop is running
      working: boolean
      // The viaPrompt option as last loaded or toggled in the picker
      viaPrompt: boolean
      // The color whose /color line the picker put into the prompt box; null when none is there
      offered: SessionColor | null
      // A /color set elsewhere while a pick waited in the queue, set again once the queue has run the pick
      restore: SessionColor | null
    }
  }
}
