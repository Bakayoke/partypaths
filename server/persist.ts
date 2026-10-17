import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import type { PartyPass } from './premium.js'
import type { Room } from './types.js'

export type PersistedSnapshot = {
  version: 1
  savedAt: number
  passes: PartyPass[]
  rooms: Room[]
}

type Backend = {
  name: string
  load(): Promise<PersistedSnapshot | null>
  save(snapshot: PersistedSnapshot): Promise<void>
}

// Minimal surface we use from node-redis — kept loose to avoid version coupling.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisClient = any

let backend: Backend | null = null
let redis: RedisClient | null = null
let redisUrl: string | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let pending: PersistedSnapshot | null = null
let ready = false
let lastSaveAt = 0
let lastError: string | null = null

const ROOM_KEY = (code: string) => `partypaths:room:${code}`
const ROOM_INDEX = 'partypaths:rooms'
const PRESENCE_KEY = (code: string) => `partypaths:presence:${code}`
const CODE_CLAIM_KEY = (code: string) => `partypaths:code:${code}`
const TICK_KEY = (code: string, phaseEndsAt: number) =>
  `partypaths:tick:${code}:${phaseEndsAt}`
export const ROOM_UPDATE_CHANNEL = 'partypaths:room-update'
const ROOM_TTL_SEC = 60 * 60 * 24
const PRESENCE_TTL_SEC = 60 * 60 * 6
const CODE_CLAIM_TTL_SEC = ROOM_TTL_SEC

function emptySnapshot(): PersistedSnapshot {
  return { version: 1, savedAt: Date.now(), passes: [], rooms: [] }
}

function fileBackend(dir: string): Backend {
  const file = path.join(dir, 'partypaths-state.json')
  return {
    name: `file:${file}`,
    async load() {
      try {
        const raw = await readFile(file, 'utf8')
        return JSON.parse(raw) as PersistedSnapshot
      } catch {
        return null
      }
    },
    async save(snapshot) {
      await mkdir(dir, { recursive: true })
      await writeFile(file, JSON.stringify(snapshot), 'utf8')
    },
  }
}

async function redisBackend(url: string): Promise<Backend> {
  const { createClient } = await import('redis')
  const client = createClient({
    url,
    socket: {
      reconnectStrategy: (retries) => Math.min(retries * 200, 3000),
    },
  })
  client.on('error', (err) => {
    lastError = err instanceof Error ? err.message : 'redis error'
    console.error('Redis error', err)
  })
  await client.connect()
  redis = client
  redisUrl = url
  const key = 'partypaths:state'
  return {
    name: 'redis',
    async load() {
      const raw = await client.get(key)
      if (!raw) return null
      return JSON.parse(typeof raw === 'string' ? raw : raw.toString()) as PersistedSnapshot
    },
    async save(snapshot) {
      const now = Date.now()
      const maxPassMs = Math.max(0, ...snapshot.passes.map((p) => p.expiresAt - now))
      const maxRoomMs = Math.max(
        0,
        ...snapshot.rooms.map((r) => (r.premiumExpiresAt ?? 0) - now),
      )
      const ttlSec = Math.max(
        60 * 60 * 48,
        Math.ceil(Math.max(maxPassMs, maxRoomMs) / 1000) + 60 * 60,
      )
      await client.set(key, JSON.stringify(snapshot), { EX: ttlSec })
      for (const room of snapshot.rooms) {
        await client.set(ROOM_KEY(room.code), JSON.stringify(room), { EX: ROOM_TTL_SEC })
        await client.sAdd(ROOM_INDEX, room.code)
      }
    },
  }
}

async function dirExists(dir: string) {
  try {
    await access(dir)
    return true
  } catch {
    return false
  }
}

export function getRedisUrl(): string | null {
  return (
    process.env.REDIS_URL?.trim() ||
    process.env.REDIS_PRIVATE_URL?.trim() ||
    process.env.REDIS_PUBLIC_URL?.trim() ||
    null
  )
}

export async function initPersist(): Promise<{ backend: string | null }> {
  const url = getRedisUrl()
  const dataDir =
    process.env.PARTYPATHS_DATA_DIR?.trim() ||
    ((await dirExists('/data')) ? '/data' : '')

  try {
    if (url) {
      backend = await redisBackend(url)
      lastError = null
    } else if (dataDir) {
      backend = fileBackend(dataDir)
      lastError = null
    } else {
      backend = null
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message : 'persist init failed'
    console.error('Persist init failed — falling back to memory only', e)
    backend = null
    redis = null
  }

  ready = true
  return { backend: backend?.name ?? null }
}

export function persistConfigured(): boolean {
  return Boolean(backend)
}

export function hasRedis(): boolean {
  return Boolean(redis)
}

export function persistDiagnostics() {
  return {
    configured: Boolean(backend),
    backend: backend?.name ?? null,
    redis: Boolean(redis),
    lastSaveAt: lastSaveAt || null,
    lastError,
    hint: backend
      ? null
      : 'Sätt REDIS_URL (Railway Redis-plugin) eller PARTYPATHS_DATA_DIR=/data med volume — annars försvinner rum vid restart/deploy och kan saknas mellan instanser.',
  }
}

export async function loadSnapshot(): Promise<PersistedSnapshot | null> {
  if (!backend) return null
  try {
    const snap = await backend.load()
    if (!snap || snap.version !== 1) return null
    return snap
  } catch (e) {
    lastError = e instanceof Error ? e.message : 'load failed'
    console.error('Persist load failed', e)
    return null
  }
}

export function scheduleSave(snapshot: PersistedSnapshot) {
  if (!backend || !ready) return
  pending = snapshot
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const toWrite = pending
    pending = null
    if (!toWrite || !backend) return
    void backend
      .save({ ...toWrite, savedAt: Date.now() })
      .then(() => {
        lastSaveAt = Date.now()
        lastError = null
      })
      .catch((e) => {
        lastError = e instanceof Error ? e.message : 'save failed'
        console.error('Persist save failed', e)
      })
  }, 400)
}

export async function flushPersist() {
  if (!backend) return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const toWrite = pending
  pending = null
  if (!toWrite) return
  await backend.save({ ...toWrite, savedAt: Date.now() })
  lastSaveAt = Date.now()
}

export function buildSnapshot(passes: Iterable<PartyPass>, rooms: Iterable<Room>): PersistedSnapshot {
  const now = Date.now()
  const keepMs = 12 * 60 * 60 * 1000
  return {
    version: 1,
    savedAt: now,
    passes: [...passes].filter((p) => p.expiresAt > now),
    rooms: [...rooms]
      .map((room) => ({
        ...room,
        players: room.players.map((p) => ({ ...p, connected: false })),
      }))
      .filter((room) => {
        const partyLive = Boolean(room.premiumExpiresAt && room.premiumExpiresAt > now)
        const fresh = now - (room.updatedAt || 0) < keepMs
        return partyLive || fresh
      }),
  }
}

/** Live per-room write so other Railway instances can join immediately. */
export async function saveRoomRecord(room: Room): Promise<void> {
  if (!redis) return
  try {
    const payload = JSON.stringify({
      ...room,
      players: room.players.map((p) => ({ ...p, connected: false })),
    })
    const key = ROOM_KEY(room.code)
    // Last-write-wins guard: never let an older in-memory copy overwrite newer Redis state.
    const existing = await redis.get(key)
    if (existing) {
      try {
        const prev = JSON.parse(
          typeof existing === 'string' ? existing : existing.toString(),
        ) as { updatedAt?: number }
        if ((prev.updatedAt || 0) > (room.updatedAt || 0)) {
          return
        }
      } catch {
        /* overwrite corrupt payloads */
      }
    }
    await redis.set(key, payload, { EX: ROOM_TTL_SEC })
    await redis.sAdd(ROOM_INDEX, room.code)
    await redis.publish(ROOM_UPDATE_CHANNEL, room.code)
    lastSaveAt = Date.now()
    lastError = null
  } catch (e) {
    lastError = e instanceof Error ? e.message : 'room save failed'
    console.error('saveRoomRecord failed', e)
  }
}

/** Claim a 4-letter room code across instances (SET NX). */
export async function claimRoomCode(code: string): Promise<boolean> {
  const c = code.toUpperCase().trim()
  if (!c) return false
  if (!redis) return true
  try {
    const ok = await redis.set(CODE_CLAIM_KEY(c), '1', {
      NX: true,
      EX: CODE_CLAIM_TTL_SEC,
    })
    return ok === 'OK' || ok === true
  } catch (e) {
    console.error('claimRoomCode failed', e)
    return true
  }
}

export async function releaseRoomCode(code: string): Promise<void> {
  if (!redis) return
  try {
    await redis.del(CODE_CLAIM_KEY(code.toUpperCase().trim()))
  } catch {
    /* ignore */
  }
}

/** Cross-instance presence: who is currently online in a room. */
export async function setPlayerOnline(
  code: string,
  playerId: string,
  online: boolean,
): Promise<void> {
  if (!redis) return
  const c = code.toUpperCase().trim()
  if (!c || !playerId) return
  try {
    const key = PRESENCE_KEY(c)
    if (online) {
      await redis.hSet(key, playerId, String(Date.now()))
      await redis.expire(key, PRESENCE_TTL_SEC)
    } else {
      await redis.hDel(key, playerId)
    }
  } catch (e) {
    console.error('setPlayerOnline failed', e)
  }
}

export async function getOnlinePlayerIds(code: string): Promise<Set<string>> {
  const out = new Set<string>()
  if (!redis) return out
  const c = code.toUpperCase().trim()
  if (!c) return out
  try {
    const raw = await redis.hGetAll(PRESENCE_KEY(c))
    if (!raw || typeof raw !== 'object') return out
    for (const id of Object.keys(raw)) {
      if (id) out.add(id)
    }
  } catch (e) {
    console.error('getOnlinePlayerIds failed', e)
  }
  return out
}

/** Only one instance should advance a given phase deadline. */
export async function claimPhaseTick(code: string, phaseEndsAt: number): Promise<boolean> {
  if (!redis) return true
  const c = code.toUpperCase().trim()
  if (!c || !phaseEndsAt) return true
  try {
    const ok = await redis.set(TICK_KEY(c, phaseEndsAt), '1', { NX: true, EX: 60 })
    return ok === 'OK' || ok === true
  } catch (e) {
    console.error('claimPhaseTick failed', e)
    return true
  }
}

export async function loadRoomRecord(code: string): Promise<Room | null> {
  if (!redis) return null
  const c = code.toUpperCase().trim()
  if (!c) return null
  try {
    const raw = await redis.get(ROOM_KEY(c))
    if (!raw) return null
    return JSON.parse(typeof raw === 'string' ? raw : raw.toString()) as Room
  } catch (e) {
    lastError = e instanceof Error ? e.message : 'room load failed'
    console.error('loadRoomRecord failed', e)
    return null
  }
}

export async function deleteRoomRecord(code: string): Promise<void> {
  if (!redis) return
  const c = code.toUpperCase().trim()
  try {
    await redis.del(ROOM_KEY(c))
    await redis.del(PRESENCE_KEY(c))
    await redis.del(CODE_CLAIM_KEY(c))
    await redis.sRem(ROOM_INDEX, c)
    await redis.publish(ROOM_UPDATE_CHANNEL, c)
  } catch (e) {
    lastError = e instanceof Error ? e.message : 'room delete failed'
    console.error('deleteRoomRecord failed', e)
  }
}

export async function subscribeRoomUpdates(
  onCode: (code: string) => void,
): Promise<(() => void) | null> {
  if (!redis || !redisUrl) return null
  try {
    const sub = redis.duplicate()
    await sub.connect()
    await sub.subscribe(ROOM_UPDATE_CHANNEL, (message: string) => {
      if (typeof message === 'string' && message) onCode(message)
    })
    return () => {
      void sub.quit?.()
    }
  } catch (e) {
    console.error('Room update subscribe failed', e)
    return null
  }
}

/** Duplicate Redis clients for socket.io adapter (pub/sub). */
export async function createRedisAdapterClients(): Promise<{
  pubClient: RedisClient
  subClient: RedisClient
} | null> {
  const url = getRedisUrl()
  if (!url) return null
  const { createClient } = await import('redis')
  const pubClient = createClient({
    url,
    socket: { reconnectStrategy: (retries) => Math.min(retries * 200, 3000) },
  })
  const subClient = pubClient.duplicate()
  pubClient.on('error', (err: unknown) => console.error('Redis adapter pub', err))
  subClient.on('error', (err: unknown) => console.error('Redis adapter sub', err))
  await Promise.all([pubClient.connect(), subClient.connect()])
  return { pubClient, subClient }
}

export { emptySnapshot }
