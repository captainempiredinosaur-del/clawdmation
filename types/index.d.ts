export type Anim = { clip: string; frame: number; caption: string }

declare module 'claude-code' {
  interface PluginState {
    'clawdmation': { anim: Shaped<Anim> }
  }
}
