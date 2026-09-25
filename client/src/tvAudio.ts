/** Tiny Web Audio stings for TV mode — no asset files needed. */
let ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null
  if (!ctx) ctx = new AC()
  return ctx
}

function tone(freq: number, duration: number, type: OscillatorType, gain = 0.08, delay = 0) {
  const audio = getCtx()
  if (!audio) return
  const t0 = audio.currentTime + delay
  const osc = audio.createOscillator()
  const g = audio.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t0)
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)
  osc.connect(g)
  g.connect(audio.destination)
  osc.start(t0)
  osc.stop(t0 + duration + 0.02)
}

export function playTvSting(kind: 'emoji' | 'guess' | 'reveal' | 'funny' | 'score' | 'sudden') {
  void getCtx()?.resume().catch(() => null)
  switch (kind) {
    case 'emoji':
      tone(523, 0.12, 'triangle', 0.07)
      tone(659, 0.14, 'triangle', 0.06, 0.08)
      break
    case 'guess':
      tone(392, 0.1, 'square', 0.05)
      tone(494, 0.12, 'square', 0.05, 0.09)
      break
    case 'reveal':
      tone(330, 0.15, 'sawtooth', 0.04)
      tone(440, 0.18, 'sawtooth', 0.05, 0.12)
      tone(554, 0.22, 'sawtooth', 0.06, 0.26)
      break
    case 'funny':
      tone(220, 0.1, 'square', 0.06)
      tone(277, 0.1, 'square', 0.06, 0.08)
      tone(330, 0.18, 'triangle', 0.07, 0.16)
      break
    case 'score':
      tone(523, 0.1, 'sine', 0.06)
      tone(659, 0.1, 'sine', 0.06, 0.08)
      tone(784, 0.2, 'sine', 0.07, 0.16)
      break
    case 'sudden':
      tone(180, 0.2, 'sawtooth', 0.08)
      tone(240, 0.25, 'sawtooth', 0.07, 0.15)
      break
  }
}

export function stingForStatus(status: string): Parameters<typeof playTvSting>[0] | null {
  switch (status) {
    case 'emoji':
      return 'emoji'
    case 'guess':
      return 'guess'
    case 'reveal':
      return 'reveal'
    case 'funny_vote':
      return 'funny'
    case 'scoreboard':
    case 'finished':
      return 'score'
    default:
      return null
  }
}
