import { io, type Socket } from 'socket.io-client'
import type { Lang, PublicRoom, Session } from './types'

const API_BASE = (import.meta.env.VITE_SOCKET_URL || '').replace(/\/$/, '')

let socket: Socket | null = null
let rejoinInFlight: Promise<{
  ok: boolean
  playerId?: string
  room?: PublicRoom
  error?: string
} | null> | null = null
let connectionListenersAttached = false

type RoomHandler = (room: PublicRoom) => void
let onRoomHandler: RoomHandler | null = null

export function getSocket() {
  if (!socket) {
    socket = io(API_BASE || undefined, {
      autoConnect: true,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 5000,
      timeout: 20_000,
    })
  }

  if (!connectionListenersAttached) {
    connectionListenersAttached = true
    socket.on('connect', () => {
      void ensureSessionBound()
    })
    socket.on('room', (room: PublicRoom) => {
      onRoomHandler?.(room)
    })
  }

  return socket
}

export type ConnState = 'connected' | 'connecting' | 'disconnected'

export function subscribeConnection(handler: (state: ConnState) => void): () => void {
  const s = getSocket()
  const emit = () => {
    if (s.connected) handler('connected')
    else if (s.active) handler('connecting')
    else handler('disconnected')
  }
  const onConnect = () => handler('connected')
  const onDisconnect = () => handler('disconnected')
  const onAttempt = () => handler('connecting')
  s.on('connect', onConnect)
  s.on('disconnect', onDisconnect)
  s.on('reconnect_attempt', onAttempt)
  s.on('reconnect', onConnect)
  emit()
  return () => {
    s.off('connect', onConnect)
    s.off('disconnect', onDisconnect)
    s.off('reconnect_attempt', onAttempt)
    s.off('reconnect', onConnect)
  }
}

export function setRoomHandler(handler: RoomHandler | null) {
  onRoomHandler = handler
  getSocket()
}

function apiUrl(path: string) {
  return `${API_BASE}${path}`
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), init)
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(
      res.ok
        ? 'Invalid API response / Ogiltigt API-svar'
        : `API error ${res.status}. Check VITE_SOCKET_URL / Railway.`,
    )
  }
}

export async function ensureSessionBound(
  retries = 4,
): Promise<{ ok: boolean; playerId?: string; room?: PublicRoom; error?: string } | null> {
  const session = loadSession()
  if (!session) return null
  if (rejoinInFlight) return rejoinInFlight

  rejoinInFlight = (async () => {
    let last: { ok: boolean; playerId?: string; room?: PublicRoom; error?: string } = {
      ok: false,
      error: 'rejoin failed',
    }
    for (let i = 0; i < retries; i++) {
      last = await rejoinGame(session.code, session.playerId)
      if (last.ok && last.room) return last
      const err = last.error ?? ''
      if (err.includes('finns inte') || err.includes('hittades inte') || err.includes('not found')) {
        break
      }
      await new Promise((r) => setTimeout(r, 700 * (i + 1)))
    }
    return last
  })()

  try {
    return await rejoinInFlight
  } finally {
    rejoinInFlight = null
  }
}

async function ack<T>(event: string, payload?: unknown): Promise<T> {
  const s = getSocket()
  if (!s.connected) {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error('Could not reach server / Kunde inte ansluta till servern')),
        12_000,
      )
      s.once('connect', () => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  if (event !== 'create' && event !== 'join' && event !== 'rejoin') {
    await ensureSessionBound(2)
  }

  const session = loadSession()
  const raw =
    payload && typeof payload === 'object' ? { ...(payload as Record<string, unknown>) } : {}
  // create/join/rejoin carry their own identity — never smear an old session onto them
  // (that used to force a second tab/QR join back into the previous player seat).
  const isIdentityEvent = event === 'create' || event === 'join' || event === 'rejoin'
  const body = isIdentityEvent
    ? raw
    : {
        ...raw,
        playerId: raw.playerId ?? session?.playerId,
        roomCode: raw.roomCode ?? session?.code,
      }

  return new Promise((resolve, reject) => {
    s.timeout(12000).emit(event, body, (err: Error | null, res: T) => {
      if (err) reject(err)
      else resolve(res)
    })
  })
}

type OkRoom = { ok: true; playerId: string; room: PublicRoom }
type Err = { ok: false; error: string; code?: string }

export async function createGame(name: string, language: Lang, isPublic = false) {
  return ack<OkRoom | Err>('create', { name, language, isPublic })
}

export async function joinGame(code: string, name: string) {
  return ack<OkRoom | Err>('join', { code, name })
}

export async function rejoinGame(code: string, playerId: string) {
  return ack<OkRoom | Err>('rejoin', { code, playerId })
}

export async function startGame() {
  return ack<{ ok: boolean; error?: string; room?: PublicRoom }>('startGame', {})
}

export async function nextRound() {
  return ack<{ ok: boolean; error?: string; room?: PublicRoom }>('nextRound', {})
}

export async function endParty() {
  return ack<{ ok: boolean; error?: string; room?: PublicRoom }>('endParty', {})
}

export async function backToLobby() {
  return ack<{ ok: boolean; error?: string; room?: PublicRoom }>('backToLobby', {})
}

export async function submitEmojis(emojis: string) {
  return ack<{ ok: boolean; error?: string; room?: PublicRoom }>('submitEmojis', { emojis })
}

export async function submitGuess(guess: string) {
  return ack<{ ok: boolean; error?: string; room?: PublicRoom }>('submitGuess', { guess })
}

export async function voteFunny(pathId: string) {
  return ack<{ ok: boolean; error?: string; room?: PublicRoom }>('voteFunny', { pathId })
}

export async function advanceReveal() {
  return ack<{ ok: boolean; error?: string; room?: PublicRoom }>('advanceReveal', {})
}

export async function setLanguage(language: Lang) {
  return ack<{ ok: boolean; error?: string; room?: PublicRoom }>('setLanguage', { language })
}

export async function setPhaseTimers(emojiSeconds?: number, guessSeconds?: number) {
  return ack<{ ok: boolean; error?: string; room?: PublicRoom }>('setPhaseTimers', {
    emojiSeconds,
    guessSeconds,
  })
}

export async function setPublicLobby(isPublic: boolean) {
  return ack<{ ok: boolean; error?: string; room?: PublicRoom }>('setPublicLobby', { isPublic })
}

export type HealthInfo = {
  ok: boolean
  rooms?: number
  persist?: {
    configured: boolean
    backend: string | null
    redis?: boolean
    hint?: string | null
  }
}

export async function fetchHealth(): Promise<HealthInfo> {
  return apiJson<HealthInfo>('/api/health')
}

export type RoomPreview = {
  code: string
  language: Lang
  status: string
  playerCount: number
  hostName: string
  isPublic: boolean
}

export async function fetchRoomPreview(code: string): Promise<RoomPreview> {
  const path = `/api/room/${encodeURIComponent(code.trim().toUpperCase())}/preview`
  const res = await fetch(apiUrl(path), { signal: AbortSignal.timeout(8_000) })
  const data = (await res.json().catch(() => ({}))) as RoomPreview & { error?: string }
  if (!res.ok) {
    throw new Error(data.error || `API error ${res.status}`)
  }
  return data
}

export type PublicLobbyCard = {
  code: string
  language: Lang
  playerCount: number
  hostName: string
  updatedAt: number
  ageMs: number
}

export async function fetchPublicLobbies(lang?: Lang): Promise<PublicLobbyCard[]> {
  const q = lang ? `?lang=${lang}` : ''
  const data = await apiJson<{ lobbies: PublicLobbyCard[] }>(`/api/lobbies${q}`)
  return data.lobbies ?? []
}

const SESSION_KEY = 'partypaths-session'

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    return JSON.parse(raw) as Session
  } catch {
    return null
  }
}

export function saveSession(session: Session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY)
  localStorage.removeItem('partypaths-party-pass')
}
