import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Anim } from '../types'

// Clawdmation: a claymation Clawd popup. Frames are rendered in Blender,
// 12 fps "on twos", shipped as base64 WebP in ../data/<clip>-<k>.json (8 frames a file).
// The mod reads only its own data files: no network, nothing sent anywhere.

const PANE = 'clawd'
const FPS_MS = 83

// frame counts per clip, whether it loops, and how many ticks the last drawing is held
const CLIPS: Record<string, { frames: number; loop: boolean; hold: number }> = {
  idle: { frames: 24, loop: true, hold: 0 },
  think: { frames: 36, loop: true, hold: 0 },
  type: { frames: 24, loop: true, hold: 0 },
  angry: { frames: 36, loop: false, hold: 4 },
  idea: { frames: 30, loop: false, hold: 6 },
  happy: { frames: 30, loop: false, hold: 10 },
  pop: { frames: 27, loop: false, hold: 2 },
}

const CAPTIONS: Record<string, string> = {
  idle: 'Waiting…',
  think: 'Hmmmm…',
  type: 'Typing…',
  angry: 'Grr. That failed.',
  idea: 'Ooh, a plan!',
  happy: 'Done!',
  pop: 'Pop!',
}

const anim = atom({ plugin: 'clawdmation', key: 'anim' } as const, { clip: 'idle', frame: 0, caption: '' } as Anim, {
  shape: 'anim-1',
})

const TYPE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell'])
const PLAN_TOOLS = new Set(['TodoWrite', 'ExitPlanMode', 'EnterPlanMode', 'TaskCreate', 'mcp__ccd_turn__update_plan'])

// module state: a reload starts it over; what the drawing shows lives in $.state
type Queued = { clip: string; caption: string }
const S: {
  want: string
  wantCaption: string
  queue: Queued[]
  closing: boolean
  timer: Timer | undefined
  held: number
  enabled: boolean
  cache: Map<string, string>
  sounds: Record<string, { base64: string; mime: string }> | undefined
} = { want: 'think', wantCaption: '', queue: [], closing: false, timer: undefined, held: 0, enabled: true, cache: new Map(), sounds: undefined }

// a short in-memory trace of what Clawd showed (handy when debugging the mod)
const LOG: string[] = []
let renders = 0
function note($: EngineInterface, line: string): void {
  LOG.push(`${new Date().toISOString().slice(11, 19)} ${line}`)
  if (LOG.length > 200) LOG.splice(0, LOG.length - 200)
}

function baseName(p: unknown): string {
  return typeof p === 'string' ? (p.split(/[\\/]/).pop() ?? '') : ''
}

const CHUNK = 8

async function loadFrame($: EngineInterface, clip: string, i: number): Promise<string> {
  const key = `${clip}/${i}`
  const hit = S.cache.get(key)
  if (hit) return hit
  const k = Math.floor(i / CHUNK)
  const text = await $.fs.read(`${$.plugin.root}/data/${clip}-${k}.json`)
  const chunk = JSON.parse(text) as { first: number; frames: string[] }
  chunk.frames.forEach((b64, j) => S.cache.set(`${clip}/${chunk.first + j}`, b64))
  const got = S.cache.get(key)
  if (!got) throw new Error(`no frame ${key}`)
  return got
}

async function preload($: EngineInterface, clip: string): Promise<void> {
  const n = CLIPS[clip]?.frames ?? 0
  for (let i = 0; i < n; i++) {
    try {
      await loadFrame($, clip, i)
    } catch {
      return
    }
  }
}

async function playSound($: EngineInterface, name: string): Promise<void> {
  try {
    if (!S.sounds) S.sounds = JSON.parse(await $.fs.read(`${$.plugin.root}/data/sounds.json`))
    const clip = S.sounds?.[name]
    if (clip) await $.audio.play({ base64: clip.base64, mime: clip.mime })
  } catch {
    // no sound is fine
  }
}

async function switchTo($: EngineInterface, clip: string, caption: string): Promise<void> {
  note($, `clip ${clip} "${caption}"`)
  void preload($, clip)
  await update($, anim, () => ({ clip, frame: 0, caption: caption || CAPTIONS[clip] || '' }))
}

function stop(): void {
  S.timer?.cancel()
  S.timer = undefined
}

async function tick($: EngineInterface): Promise<void> {
  const cur = await read($, anim)
  const spec = CLIPS[cur.clip] ?? { frames: 24, loop: true, hold: 0 }
  const n = cur.frame + 1
  if (spec.loop) {
    const q = S.queue.shift()
    if (q) return switchTo($, q.clip, q.caption)
    if (S.want !== cur.clip) return switchTo($, S.want, S.wantCaption)
    const caption = S.wantCaption || CAPTIONS[cur.clip] || ''
    await update($, anim, a => ({ ...a, frame: n % spec.frames, caption }))
    return
  }
  // one-shot clip: play it through, hold the last drawing a moment
  if (n < spec.frames) {
    if (cur.clip === 'pop' && n === 19) void playSound($, 'pop')
    if (cur.clip === 'idea' && n === 8) void playSound($, 'ding')
    S.held = 0
    await update($, anim, a => ({ ...a, frame: n }))
    return
  }
  if (S.held < spec.hold) {
    S.held += 1
    return
  }
  S.held = 0
  const q = S.queue.shift()
  if (q) return switchTo($, q.clip, q.caption)
  if (S.closing && cur.clip === 'pop') {
    S.closing = false
    stop()
    await $.ui.close({ id: PANE }).catch(() => {})
    note($, 'closed after pop')
    return
  }
  return switchTo($, S.want, S.wantCaption)
}

async function show($: EngineInterface, clip: string, caption: string): Promise<void> {
  if (!S.enabled) return
  S.closing = false
  S.queue = []
  S.want = clip
  S.wantCaption = caption
  const opened = await $.ui
    .open({ id: PANE, title: 'Clawd', placement: 'widget', backgroundColor: 'transparent' })
    .catch((err: unknown) => ({ isPlaced: false, reason: String(err) }))
  note($, `show ${clip}: ${JSON.stringify(opened)}`)
  if (!S.timer) {
    await switchTo($, clip, caption)
    S.timer = $.clock.every(FPS_MS, () => {
      tick($).catch(() => {})
    })
  }
}

async function setEnabled($: EngineInterface, on: boolean): Promise<void> {
  S.enabled = on
  await $.store.set('enabled', on).catch(() => {})
  if (!on) {
    stop()
    await $.ui.close({ id: PANE }).catch(() => {})
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('enabled').catch(() => undefined)
    if (stored === false) S.enabled = false
    await $.command.register({
      name: 'clawd',
      description: 'Clay Clawd popup: /clawd shows it, /clawd demo plays every clip, /clawd off|on',
      argumentHint: '[demo|on|off]',
    })
    void preload($, 'think')
    return next(e)
  })

  on('command.run', { command: 'clawd' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      await setEnabled($, false)
      return { text: 'Clawd popup off. /clawd on brings it back.' }
    }
    if (arg === 'on') {
      await setEnabled($, true)
      return { text: 'Clawd popup on: it shows up while Claude works.' }
    }
    S.enabled = true
    if (arg === 'demo') {
      await show($, 'think', 'Demo: thinking…')
      S.queue = [
        { clip: 'type', caption: 'Demo: typing…' },
        { clip: 'angry', caption: 'Demo: an error!' },
        { clip: 'idea', caption: 'Demo: an idea!' },
        { clip: 'happy', caption: 'Demo: thumbs up' },
        { clip: 'pop', caption: 'Demo: pop!' },
      ]
      S.closing = true
      return { text: 'Clawd demo: think, type, angry, idea, thumbs up, pop.' }
    }
    await show($, 'idle', '')
    return { text: 'Clawd is here.' }
  })

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) await show($, 'think', '')
    return r
  })

  on('tool.call', async ($, e, next) => {
    const tool = e.tool
    const input = e as unknown as Record<string, unknown>
    const isLive = S.enabled && S.timer !== undefined
    if (isLive) {
      if (TYPE_TOOLS.has(tool)) {
        S.want = 'type'
        const file = baseName(input.file_path ?? input.notebook_path)
        S.wantCaption = file
          ? `Typing · ${file}`
          : tool === 'Bash' || tool === 'PowerShell'
            ? 'Typing a command…'
            : 'Typing…'
      } else if (PLAN_TOOLS.has(tool)) {
        S.queue.push({ clip: 'idea', caption: 'Ooh, a plan!' })
      } else if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') {
        S.want = 'think'
        const file = baseName(input.file_path ?? input.path)
        S.wantCaption = file ? `Reading · ${file}` : 'Looking around…'
      } else {
        S.want = 'think'
        S.wantCaption = `Hmm… ${tool.replace(/^mcp__.*__/, '')}`
      }
    }
    const ran = await next(e)
    if (isLive) {
      const failed = ran.deny !== undefined || ran.isError === true
      if (failed && !S.queue.some(q => q.clip === 'angry')) {
        S.queue.push({ clip: 'angry', caption: `Grr. ${tool.replace(/^mcp__.*__/, '')} failed.` })
      }
      S.want = 'think'
      S.wantCaption = ''
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && S.enabled && S.timer !== undefined) {
      if (e.reason === 'answer') {
        S.queue.push({ clip: 'happy', caption: 'Done! Thumbs up.' }, { clip: 'pop', caption: 'Pop!' })
      } else if (e.reason === 'aborted') {
        S.queue.push({ clip: 'pop', caption: 'Stopped.' })
      } else {
        S.queue.push({ clip: 'angry', caption: 'Something broke.' }, { clip: 'pop', caption: 'Pop!' })
      }
      S.want = 'idle'
      S.wantCaption = ''
      S.closing = true
    }
    return r
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'plugin') stop()
    return next(e)
  })

  // The rendered clay frame as an embedded WebP; if a surface refuses embedded images,
  // the .catch below draws the same frame as a pure-vector pixel picture instead.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const a = await read($, anim)
    const caption = a.caption || CAPTIONS[a.clip] || ''
    const b64 = await loadFrame($, a.clip, a.frame)
    renders += 1
    if (renders % 50 === 1) note($, `render #${renders} ${e.surface} ${e.props.placement} ${a.clip}/${a.frame} (webp ${b64.length})`)
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="256" viewBox="0 0 320 256"><image href="data:image/webp;base64,${b64}" x="0" y="0" width="320" height="256"/></svg>`
    if (e.surface === 'desktop' || e.surface === 'mobile' || e.surface === 'vscode') {
      const { Box, Text, Svg } = $.ui.resolve(e)
      const w = e.props.placement === 'widget' ? 200 : 320
      return (
        <Box flexDirection="column" alignItems="center">
          <Svg source={source} alt={`Clawd: ${caption}`} width={w} height={Math.round((w * 256) / 320)} />
          <Text dimColor>{caption}</Text>
        </Box>
      )
    }
    const { Text } = $.ui.resolve(e)
    return <Text>Clawd: {caption}</Text>
  }).catch(async ($, e) => {
    const a = await read($, anim)
    renders += 1
    if (renders % 50 === 1) note($, `FALLBACK render #${renders} ${e.surface} ${a.clip}/${a.frame}`)
    const caption = a.caption || CAPTIONS[a.clip] || ''
    if (e.surface === 'desktop' || e.surface === 'mobile' || e.surface === 'vscode') {
      const { Box, Text, Svg } = $.ui.resolve(e)
      const w = e.props.placement === 'widget' ? 200 : 320
      const bob = Math.round(Math.sin(a.frame / 2) * 6)
      const source = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="256" viewBox="0 0 320 256"><ellipse cx="160" cy="${150 + bob}" rx="78" ry="62" fill="#D97757"/><circle cx="135" cy="${135 + bob}" r="11" fill="#1a1a1a"/><circle cx="185" cy="${135 + bob}" r="11" fill="#1a1a1a"/></svg>`
      return (
        <Box flexDirection="column" alignItems="center">
          <Svg source={source} alt={`Clawd: ${caption}`} width={w} height={Math.round((w * 256) / 320)} />
          <Text dimColor>{caption}</Text>
        </Box>
      )
    }
    const { Text } = $.ui.resolve(e)
    return <Text>Clawd: {caption}</Text>
  })
}
