// A /color argument: one of the colors, or "default" for the theme's own
export type SessionColor = string

declare module 'claude-code' {
  interface PluginState {
    // The color last set through the picker or a typed /color; null while unknown
    'color-chooser': { current: SessionColor | null }
  }
}
