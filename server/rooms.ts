import { customAlphabet } from 'nanoid'
import {
  applyCorrectPoints,
  applyFunnyVotePoints,
  authorIndexForHop,
  CORRECT_POINTS,
  createEmptyStep,
  dealWords,
  EMPTY_GUESS,
  EMOJI_SECONDS,
  FUNNY_VOTE_POINTS,
  GUESS_SECONDS,
  guesserIndexForHop,
  HOP_COUNT,
  hopCountForPlayers,
  lastWrongGuesser,
  meaningForHop,
  MIN_PLAYERS,
  normalizeWord,
  sanitizeEmojis,
  scoreGuess,
  tallyFunnyVotes,
  victimForWrongGuess,
} from './game/paths.js'
import { limitsFor, tierFromExpiry } from './premium.js'
import {
  claimRoomCode,
  deleteRoomRecord,
  getOnlinePlayerIds,
  getPlayerPresenceAt,
  loadRoomRecord,
  saveRoomRecord,
  setPlayerOnline,
} from './persist.js'
import { wordPack } from './words/index.js'
import type {
  Award,
  Lang,
  PartyPlayerStats,
  Player,
  PublicPath,
  PublicRoom,
  RivalStreakPublic,
  Room,
  RoomStatus,
} from './types.js'

const makeCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ', 4)
const DISCONNECT_GRACE_MS = 60_000
const HOST_TRANSFER_AFTER_MS = 90_000
const ROOM_IDLE_MS = 12 * 60 * 60 * 1000
const NOTICE_TTL_MS = 45_000
const SCOREBOARD_MS = 0
const REVEAL_SECONDS = 18
const FUNNY_VOTE_SECONDS = 25

const WORD_THEMES = new Set(['fest', 'adult', 'jobb', 'familj'])

function normalizeTheme(raw: unknown): import('./types.js').WordTheme {
  const t = String(raw ?? 'fest')
  return WORD_THEMES.has(t) ? (t as import('./types.js').WordTheme) : 'fest'
}

const rooms = new Map<string, Room>()
const socketToPlayer = new Map<string, { code: string; playerId: string }>()
/** All live sockets for a seat — multi-tab / overlapping reconnect safe. */
const playerSockets = new Map<string, Set<string>>()
const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()

let onPersist: (() => void) | null = null
let onBroadcast: ((code: string) => void) | null = null

export function setPersistHook(fn: (() => void) | null) {
  onPersist = fn
}

export function setBroadcastHook(fn: ((code: string) => void) | null) {
  onBroadcast = fn
}

function touch(room?: Room) {
  if (room) {
    room.updatedAt = Date.now()
    // Live Redis write so join on another instance finds the room.
    void saveRoomRecord(room)
  }
  onPersist?.()
}

function playerKey(code: string, playerId: string) {
  return `${code}:${playerId}`
}

function cancelDisconnectTimer(code: string, playerId: string) {
  const key = playerKey(code, playerId)
  const t = disconnectTimers.get(key)
  if (t) {
    clearTimeout(t)
    disconnectTimers.delete(key)
  }
}

function localSocketCount(code: string, playerId: string) {
  return playerSockets.get(playerKey(code, playerId))?.size ?? 0
}

function bindSocket(code: string, playerId: string, socketId: string) {
  const prev = socketToPlayer.get(socketId)
  if (prev && (prev.code !== code || prev.playerId !== playerId)) {
    detachSocket(socketId, { dropLobbySeat: true, deferOffline: false })
  }

  socketToPlayer.set(socketId, { code, playerId })
  const key = playerKey(code, playerId)
  let set = playerSockets.get(key)
  if (!set) {
    set = new Set()
    playerSockets.set(key, set)
  }
  set.add(socketId)
  cancelDisconnectTimer(code, playerId)

  const room = rooms.get(code)
  const player = room?.players.find((p) => p.id === playerId)
  if (player) player.connected = true
  void setPlayerOnline(code, playerId, true)
}

/**
 * Detach one socket from its seat.
 * - deferOffline: keep `connected` true until grace expires (brief reconnects)
 * - dropLobbySeat: leaving lobby frees the seat immediately
 */
function detachSocket(
  socketId: string,
  opts: { dropLobbySeat?: boolean; deferOffline?: boolean } = {},
): { code: string; playerId: string } | null {
  const binding = socketToPlayer.get(socketId)
  if (!binding) return null
  socketToPlayer.delete(socketId)

  const key = playerKey(binding.code, binding.playerId)
  const set = playerSockets.get(key)
  if (set) {
    set.delete(socketId)
    if (set.size === 0) playerSockets.delete(key)
  }

  if (localSocketCount(binding.code, binding.playerId) > 0) {
    return binding
  }

  const room = rooms.get(binding.code)
  if (!room) return binding
  const player = room.players.find((p) => p.id === binding.playerId)
  if (!player) return binding

  if (opts.dropLobbySeat && (room.status === 'lobby' || room.status === 'finished')) {
    if (player.id !== room.hostId) {
      room.players = room.players.filter((p) => p.id !== player.id)
      cancelDisconnectTimer(binding.code, binding.playerId)
      void setPlayerOnline(binding.code, binding.playerId, false)
      touch(room)
      return binding
    }
  }

  if (opts.deferOffline !== false) {
    // Stay "connected" during grace so phases don't skip the player on a blip.
    scheduleDisconnectGrace(binding.code, binding.playerId)
    touch(room)
    return binding
  }

  player.connected = false
  void setPlayerOnline(binding.code, binding.playerId, false)
  touch(room)
  return binding
}

function scheduleDisconnectGrace(code: string, playerId: string) {
  cancelDisconnectTimer(code, playerId)
  const key = playerKey(code, playerId)
  const graceStartedAt = Date.now()
  disconnectTimers.set(
    key,
    setTimeout(() => {
      void (async () => {
        disconnectTimers.delete(key)
        if (localSocketCount(code, playerId) > 0) return

        // Reconnected on another instance after we started grace — keep them online.
        const presenceAt = await getPlayerPresenceAt(code, playerId)
        if (presenceAt != null && presenceAt > graceStartedAt) return

        const r = rooms.get(code)
        if (!r) return
        const p = r.players.find((x) => x.id === playerId)
        if (!p) return
        p.connected = false
        void setPlayerOnline(code, playerId, false)

        if (p.id === r.hostId) {
          setTimeout(() => {
            void (async () => {
              const rr = rooms.get(code)
              if (!rr) return
              if (localSocketCount(code, rr.hostId) > 0) return
              const hostPresence = await getPlayerPresenceAt(code, rr.hostId)
              if (hostPresence != null) return
              const host = rr.players.find((x) => x.id === rr.hostId)
              if (host?.connected) return
              await refreshConnectedFlags(rr)
              const next = rr.players.find((x) => x.connected && !x.spectator)
              if (!next) return
              rr.hostId = next.id
              rr.notice = { kind: 'host_transfer', hostName: next.name, at: Date.now() }
              touch(rr)
              onBroadcast?.(rr.code)
            })()
          }, HOST_TRANSFER_AFTER_MS - DISCONNECT_GRACE_MS)
        } else if (r.status === 'lobby' || r.status === 'finished') {
          r.players = r.players.filter((x) => x.id !== playerId)
        }
        touch(r)
        onBroadcast?.(r.code)
      })()
    }, DISCONNECT_GRACE_MS),
  )
}

/** Merge local sockets + Redis presence into room.players[].connected */
export async function refreshConnectedFlags(room: Room): Promise<void> {
  const remote = await getOnlinePlayerIds(room.code)
  for (const p of room.players) {
    const local = localSocketCount(room.code, p.id) > 0
    const grace = disconnectTimers.has(playerKey(room.code, p.id))
    p.connected = local || remote.has(p.id) || grace
  }
}

function roomLimits(room: Room) {
  return limitsFor(tierFromExpiry(room.premiumExpiresAt))
}

function msg(lang: Lang, sv: string, en: string) {
  return lang === 'en' ? en : sv
}

function roomMsg(room: Room, sv: string, en: string) {
  return msg(room.language, sv, en)
}

async function allocateRoomCode(): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const code = makeCode()
    if (rooms.has(code)) continue
    if (await claimRoomCode(code)) return code
  }
  throw new Error('Could not allocate a free room code')
}

function isActivePlayer(room: Room, p: Player): boolean {
  if (p.spectator) return false
  if (p.id === room.hostId && !room.hostPlays) return false
  return true
}

function seatedPlayers(room: Room): Player[] {
  return room.players.filter((p) => isActivePlayer(room, p))
}

function connectedPlayers(room: Room): Player[] {
  return seatedPlayers(room).filter((p) => p.connected)
}

/** Seated players still in the party — includes brief reconnect grace. */
function playablePlayers(room: Room): Player[] {
  return seatedPlayers(room).filter(
    (p) => p.connected || disconnectTimers.has(playerKey(room.code, p.id)),
  )
}

function midGame(status: RoomStatus): boolean {
  return status !== 'lobby' && status !== 'finished'
}

function emptyPartyStats(): PartyPlayerStats {
  return {
    correctGuesses: 0,
    wrongGuesses: 0,
    ruinsDealt: 0,
    ruinsSuffered: 0,
    funnyVotesReceived: 0,
    emojiChars: 0,
  }
}

function ensurePartyStats(room: Room, playerId: string): PartyPlayerStats {
  if (!room.partyStats) room.partyStats = {}
  if (!room.partyStats[playerId]) room.partyStats[playerId] = emptyPartyStats()
  return room.partyStats[playerId]
}

function emptyGameFields(): Pick<
  Room,
  | 'phaseEndsAt'
  | 'roundIndex'
  | 'hopIndex'
  | 'hopCount'
  | 'paths'
  | 'submissions'
  | 'scores'
  | 'funnyVotes'
  | 'nightPath'
  | 'nightPathVotes'
  | 'usedWords'
  | 'callbackPool'
  | 'rivalRuins'
  | 'partyStats'
  | 'awards'
  | 'doublePoints'
  | 'revengePlayerId'
  | 'revengeSeed'
> {
  return {
    phaseEndsAt: 0,
    roundIndex: 0,
    hopIndex: 0,
    hopCount: HOP_COUNT,
    paths: [],
    submissions: {},
    scores: {},
    funnyVotes: {},
    nightPath: null,
    nightPathVotes: 0,
    usedWords: [],
    callbackPool: [],
    rivalRuins: [],
    partyStats: {},
    awards: [],
    doublePoints: false,
    revengePlayerId: null,
    revengeSeed: null,
  }
}

export function allRooms() {
  return rooms
}

export function restoreRooms(list: Room[]) {
  for (const raw of list) {
    if (!raw?.code) continue
    // Skip legacy DnD rooms that lack emoji-path shape
    if (!Array.isArray((raw as Room).paths) && (raw as { nodeId?: string }).nodeId) {
      continue
    }
    const room: Room = {
      code: raw.code,
      hostId: raw.hostId,
      players: (raw.players ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        connected: Boolean(p.connected),
        spectator: Boolean(p.spectator),
      })),
      language: raw.language === 'en' ? 'en' : 'sv',
      status: (raw.status as RoomStatus) || 'lobby',
      premiumExpiresAt: raw.premiumExpiresAt ?? null,
      isPublic: Boolean(raw.isPublic),
      waitlist: Array.isArray(raw.waitlist) ? raw.waitlist : [],
      hostPlays: Boolean(raw.hostPlays),
      wordTheme: normalizeTheme(raw.wordTheme),
      emojiSeconds: Number(raw.emojiSeconds) || EMOJI_SECONDS,
      guessSeconds: Number(raw.guessSeconds) || GUESS_SECONDS,
      phaseEndsAt: Number(raw.phaseEndsAt) || 0,
      roundIndex: Number(raw.roundIndex) || 0,
      hopIndex: Number(raw.hopIndex) || 0,
      hopCount: Number(raw.hopCount) || HOP_COUNT,
      paths: Array.isArray(raw.paths) ? raw.paths : [],
      submissions: raw.submissions && typeof raw.submissions === 'object' ? raw.submissions : {},
      scores: raw.scores && typeof raw.scores === 'object' ? raw.scores : {},
      funnyVotes: raw.funnyVotes && typeof raw.funnyVotes === 'object' ? raw.funnyVotes : {},
      nightPath: raw.nightPath && typeof raw.nightPath === 'object' ? raw.nightPath : null,
      nightPathVotes: Number(raw.nightPathVotes) || 0,
      usedWords: Array.isArray(raw.usedWords) ? raw.usedWords : [],
      callbackPool: Array.isArray(raw.callbackPool) ? raw.callbackPool : [],
      rivalRuins: Array.isArray(raw.rivalRuins) ? raw.rivalRuins : [],
      partyStats: raw.partyStats && typeof raw.partyStats === 'object' ? raw.partyStats : {},
      seasonStats: raw.seasonStats && typeof raw.seasonStats === 'object' ? raw.seasonStats : {},
      awards: Array.isArray(raw.awards) ? raw.awards : [],
      doublePoints: Boolean(raw.doublePoints),
      revengePlayerId: raw.revengePlayerId ?? null,
      revengeSeed: raw.revengeSeed ?? null,
      notice: raw.notice ?? null,
      updatedAt: raw.updatedAt ?? Date.now(),
    }
    // Keep mid-game status when hydrating from Redis. Resetting emoji/guess→lobby
    // here broke start: saveRoomRecord published an update, this instance reloaded,
    // and wipe-to-lobby bounced everyone straight back to the lobby UI.
    rooms.set(room.code, room)
  }
}

export function getRoom(code: string) {
  return rooms.get(code.toUpperCase().trim()) ?? null
}

/** Pull a room from Redis into memory; refresh if a newer copy exists. */
export async function hydrateRoom(code: string): Promise<Room | null> {
  const c = code.toUpperCase().trim()
  if (!c) return null
  if (rooms.has(c)) {
    return (await reloadRoomFromStore(c)) ?? rooms.get(c) ?? null
  }
  const raw = await loadRoomRecord(c)
  if (!raw) return null
  restoreRooms([raw])
  const room = rooms.get(c)
  if (!room) return null
  await refreshConnectedFlags(room)
  return room
}

/** Reload room from Redis (after another instance mutated it). */
export async function reloadRoomFromStore(code: string): Promise<Room | null> {
  const c = code.toUpperCase().trim()
  if (!c) return null
  const local = rooms.get(c)
  const raw = await loadRoomRecord(c)
  if (!raw) {
    // A missed Redis read must NOT wipe a live local room (transient blips /
    // publish-before-write races were deleting lobbies mid-session).
    if (local) await refreshConnectedFlags(local)
    return local ?? null
  }
  // Ignore Redis echo of our own save (same or older updatedAt), otherwise we
  // clobber live sockets (save persists connected:false) right after startGame.
  if (local && (local.updatedAt || 0) >= (raw.updatedAt || 0)) {
    await refreshConnectedFlags(local)
    return local
  }
  restoreRooms([raw])
  const room = rooms.get(c)
  if (!room) return null
  await refreshConnectedFlags(room)
  return room
}

export function getBinding(socketId: string) {
  return socketToPlayer.get(socketId) ?? null
}

export async function createRoom(
  hostName: string,
  socketId: string,
  language: Lang = 'sv',
  _partyToken?: string | null,
  wantPublic = false,
): Promise<{ room: Room; playerId: string }> {
  const code = await allocateRoomCode()
  const playerId = crypto.randomUUID()
  const host: Player = {
    id: playerId,
    name: hostName.trim().slice(0, 20) || (language === 'en' ? 'Host' : 'Värd'),
    connected: true,
    spectator: false,
  }

  const room: Room = {
    code,
    hostId: playerId,
    players: [host],
    language: language === 'en' ? 'en' : 'sv',
    status: 'lobby',
    premiumExpiresAt: null,
    isPublic: Boolean(wantPublic),
    waitlist: [],
    hostPlays: false,
    wordTheme: 'fest',
    emojiSeconds: EMOJI_SECONDS,
    guessSeconds: GUESS_SECONDS,
    notice: null,
    updatedAt: Date.now(),
    seasonStats: {},
    ...emptyGameFields(),
  }

  detachSocket(socketId, { dropLobbySeat: true, deferOffline: false })
  rooms.set(code, room)
  bindSocket(code, playerId, socketId)
  touch(room)
  return { room, playerId }
}

export function joinRoom(
  code: string,
  name: string,
  socketId: string,
):
  | { room: Room; playerId: string }
  | {
      error: string
      code?: 'ROOM_FULL' | 'NOT_FOUND' | 'STARTED'
      roomCode?: string
      waitlistCount?: number
    } {
  const room = rooms.get(code.toUpperCase().trim())
  if (!room) {
    return {
      error: 'Hittade inget spel med den koden / No game found with that code',
      code: 'NOT_FOUND',
    }
  }

  const displayName =
    name.trim().slice(0, 20) || (room.language === 'en' ? 'Player' : 'Spelare')

  // Same socket already in this room — reconnect that seat instead of adding a twin.
  const existing = socketToPlayer.get(socketId)
  if (existing?.code === room.code) {
    const mine = room.players.find((p) => p.id === existing.playerId)
    if (mine) {
      bindSocket(room.code, mine.id, socketId)
      if (!mine.spectator && mine.id !== room.hostId) mine.name = displayName
      touch(room)
      return { room, playerId: mine.id }
    }
  }

  // Leaving another room on this socket frees the old lobby seat.
  if (existing && existing.code !== room.code) {
    detachSocket(socketId, { dropLobbySeat: true, deferOffline: false })
  }

  if (midGame(room.status)) {
    const playerId = crypto.randomUUID()
    room.players.push({
      id: playerId,
      name: displayName,
      connected: true,
      spectator: true,
    })
    bindSocket(room.code, playerId, socketId)
    touch(room)
    return { room, playerId }
  }

  // Reclaim a disconnected seat with the same name (avoids ghost slots when rejoining).
  const reclaim = seatedPlayers(room).find(
    (p) => !p.connected && p.name.toLowerCase() === displayName.toLowerCase(),
  )
  if (reclaim) {
    bindSocket(room.code, reclaim.id, socketId)
    touch(room)
    return { room, playerId: reclaim.id }
  }

  const maxPlayers = roomLimits(room).maxPlayers
  // Only connected players hold a seat — disconnected lobby ghosts must not block joins.
  const connectedSeated = seatedPlayers(room).filter((p) => p.connected)
  if (maxPlayers > 0 && connectedSeated.length >= maxPlayers) {
    const existingWait = room.waitlist.find(
      (w) => w.name.toLowerCase() === displayName.toLowerCase(),
    )
    if (!existingWait) {
      room.waitlist.push({
        id: crypto.randomUUID(),
        name: displayName,
        at: Date.now(),
      })
      room.waitlist = room.waitlist.slice(-24)
    }
    touch(room)
    return {
      error: roomMsg(
        room,
        'Rummet är fullt — du står på väntlistan',
        'Room is full — you are on the waitlist',
      ),
      code: 'ROOM_FULL',
      roomCode: room.code,
      waitlistCount: room.waitlist.length,
    }
  }

  const playerId = crypto.randomUUID()
  room.players.push({
    id: playerId,
    name: displayName,
    connected: true,
    spectator: false,
  })
  bindSocket(room.code, playerId, socketId)
  touch(room)
  return { room, playerId }
}

export function reconnectSocket(
  code: string,
  playerId: string,
  socketId: string,
): Room | { error: string } {
  const room = rooms.get(code.toUpperCase().trim())
  if (!room) return { error: 'Rummet finns inte / Room not found' }
  const player = room.players.find((p) => p.id === playerId)
  if (!player) return { error: 'Spelaren hittades inte / Player not found' }
  bindSocket(room.code, playerId, socketId)
  touch(room)
  return room
}

export function handleDisconnect(socketId: string) {
  detachSocket(socketId, { deferOffline: true })
}

export function previewRoom(code: string) {
  const room = rooms.get(code.toUpperCase().trim())
  if (!room) return null
  return {
    code: room.code,
    language: room.language,
    status: room.status,
    playerCount: seatedPlayers(room).filter((p) => p.connected).length,
    hostName: room.players.find((p) => p.id === room.hostId)?.name ?? '',
    isPublic: room.isPublic,
  }
}

export function listPublicLobbies(opts: { language?: Lang | null; limit?: number } = {}) {
  const limit = opts.limit ?? 24
  const now = Date.now()
  return [...rooms.values()]
    .filter((r) => {
      if (!r.isPublic || r.status !== 'lobby') return false
      if (tierFromExpiry(r.premiumExpiresAt) !== 'party') return false
      if (opts.language && r.language !== opts.language) return false
      const max = roomLimits(r).maxPlayers
      const seated = seatedPlayers(r).filter((p) => p.connected).length
      if (max > 0 && seated >= max) return false
      return true
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map((r) => ({
      code: r.code,
      language: r.language,
      playerCount: seatedPlayers(r).filter((p) => p.connected).length,
      hostName: r.players.find((p) => p.id === r.hostId)?.name ?? '',
      updatedAt: r.updatedAt,
      ageMs: now - r.updatedAt,
    }))
}

export function setLanguage(code: string, playerId: string, language: Lang): Room | { error: string } {
  const room = rooms.get(code)
  if (!room) return { error: 'Rum saknas' }
  if (room.hostId !== playerId) return { error: 'Bara värden kan byta språk' }
  room.language = language === 'en' ? 'en' : 'sv'
  touch(room)
  return room
}

export function setPublicLobby(
  code: string,
  playerId: string,
  isPublic: boolean,
): Room | { error: string } {
  const room = rooms.get(code)
  if (!room) return { error: 'Rum saknas' }
  if (room.hostId !== playerId) return { error: 'Bara värden kan ändra' }
  room.isPublic = Boolean(isPublic)
  touch(room)
  return room
}

export function setHostPlays(
  code: string,
  playerId: string,
  hostPlays: boolean,
): Room | { error: string } {
  const room = rooms.get(code)
  if (!room) return { error: 'Rum saknas' }
  if (room.hostId !== playerId) return { error: 'Bara värden kan ändra' }
  if (room.status !== 'lobby') return { error: 'Kan bara ändras i lobbyn' }
  room.hostPlays = Boolean(hostPlays)
  touch(room)
  return room
}

export function setWordTheme(
  code: string,
  playerId: string,
  theme: string,
): Room | { error: string } {
  const room = rooms.get(code)
  if (!room) return { error: 'Rum saknas' }
  if (room.hostId !== playerId) return { error: 'Bara värden kan ändra' }
  if (room.status !== 'lobby') return { error: 'Kan bara ändras i lobbyn' }
  room.wordTheme = normalizeTheme(theme)
  touch(room)
  return room
}

export function setPhaseTimers(
  code: string,
  playerId: string,
  emojiSeconds?: number,
  guessSeconds?: number,
): Room | { error: string } {
  const room = rooms.get(code)
  if (!room) return { error: 'Rum saknas' }
  if (room.hostId !== playerId) return { error: 'Bara värden kan ändra' }
  if (room.status !== 'lobby') return { error: 'Kan bara ändras i lobbyn' }
  if (emojiSeconds !== undefined) {
    const e = Math.round(Number(emojiSeconds))
    if ([20, 35, 50].includes(e)) room.emojiSeconds = e
  }
  if (guessSeconds !== undefined) {
    const g = Math.round(Number(guessSeconds))
    if ([15, 25, 40].includes(g)) room.guessSeconds = g
  }
  touch(room)
  return room
}

function packForRoom(room: Room): string[] {
  return wordPack(room.language, room.wordTheme ?? 'fest')
}

function pathOrder(room: Room): Player[] {
  // Keep the roster that the round was dealt for — not whoever happens to be
  // connected at hop boundaries (that desynced authors/guessers after blips).
  const byId = new Map(room.players.map((p) => [p.id, p]))
  const fromPaths = room.paths
    .map((p) => byId.get(p.originPlayerId))
    .filter((p): p is Player => p != null && isActivePlayer(room, p))
  if (fromPaths.length === room.paths.length && fromPaths.length > 0) return fromPaths
  return playablePlayers(room)
}

function beginEmojiPhase(room: Room) {
  room.status = 'emoji'
  room.submissions = {}
  room.phaseEndsAt = Date.now() + room.emojiSeconds * 1000
  const order = pathOrder(room)
  const n = order.length
  if (n === 0) return
  for (let oi = 0; oi < room.paths.length; oi++) {
    const path = room.paths[oi]
    const author = order[authorIndexForHop(oi, room.hopIndex, n)]
    const guesser = order[guesserIndexForHop(oi, room.hopIndex, n)]
    if (!author || !guesser) continue
    path.steps[room.hopIndex] = createEmptyStep({
      authorId: author.id,
      meaning: meaningForHop(path, room.hopIndex),
      guesserId: guesser.id,
    })
  }
}

function beginGuessPhase(room: Room) {
  room.status = 'guess'
  room.submissions = {}
  room.phaseEndsAt = Date.now() + room.guessSeconds * 1000
}

function startRoundInternal(room: Room) {
  room.callbackPool ??= []
  room.rivalRuins ??= []
  room.partyStats ??= {}
  room.seasonStats ??= {}
  room.awards ??= []

  const order = playablePlayers(room)
  if (order.length < MIN_PLAYERS) {
    return {
      error: roomMsg(
        room,
        `Behöver minst ${MIN_PLAYERS} spelare`,
        `Need at least ${MIN_PLAYERS} players`,
      ),
    }
  }

  const limits = roomLimits(room)
  if (room.roundIndex >= limits.maxRounds) {
    return {
      error: roomMsg(
        room,
        'Max antal rundor nått',
        'Max rounds reached',
      ),
    }
  }

  const used = new Set(room.usedWords.map(normalizeWord))
  const words = dealWords(packForRoom(room), order.length, used)

  // Inject up to one callback word from earlier fails (rounds 2+).
  if (room.roundIndex >= 1 && room.callbackPool.length > 0 && words.length > 0) {
    const callbacks = room.callbackPool.filter((w) => !used.has(normalizeWord(w)))
    if (callbacks.length > 0) {
      const pick = callbacks[Math.floor(Math.random() * callbacks.length)]
      const slot = Math.floor(Math.random() * words.length)
      used.delete(normalizeWord(words[slot]))
      words[slot] = pick
      used.add(normalizeWord(pick))
    }
  }

  // Revenge seed replaces the revenge player's origin word.
  if (room.revengePlayerId && room.revengeSeed) {
    const ri = order.findIndex((p) => p.id === room.revengePlayerId)
    if (ri >= 0) {
      used.delete(normalizeWord(words[ri] ?? ''))
      words[ri] = room.revengeSeed
      used.add(normalizeWord(room.revengeSeed))
    }
  }

  room.usedWords = [...used]
  room.revengePlayerId = null
  room.revengeSeed = null

  room.paths = order.map((p, i) => ({
    id: crypto.randomUUID(),
    originPlayerId: p.id,
    seedWord: words[i] ?? 'pizza',
    steps: [],
  }))
  room.hopIndex = 0

  const limitsLeft = limits.maxRounds - room.roundIndex
  const isSuddenDeath = limitsLeft === 1
  const isWarmup = room.roundIndex === 0
  const fullHops = hopCountForPlayers(order.length)
  room.hopCount = isWarmup || isSuddenDeath ? Math.min(1, fullHops) : fullHops
  room.doublePoints = isSuddenDeath
  room.funnyVotes = {}
  room.submissions = {}
  room.roundIndex += 1
  for (const p of order) {
    if (room.scores[p.id] === undefined) room.scores[p.id] = 0
    ensurePartyStats(room, p.id)
  }
  beginEmojiPhase(room)
  touch(room)
  return room
}

export function startGame(code: string, playerId: string): Room | { error: string } {
  const room = rooms.get(code)
  if (!room) return { error: 'Rum saknas' }
  if (room.hostId !== playerId) return { error: 'Bara värden kan starta' }
  if (room.status !== 'lobby' && room.status !== 'scoreboard' && room.status !== 'finished') {
    return { error: roomMsg(room, 'Spelet pågår redan', 'Game already in progress') }
  }
  if (room.status === 'finished') {
    Object.assign(room, emptyGameFields())
  }
  // Promote waitlist / clear spectators when starting from lobby
  if (room.status === 'lobby') {
    for (const p of room.players) p.spectator = false
    promoteWaitlist(room)
  }
  return startRoundInternal(room)
}

export function nextRound(code: string, playerId: string): Room | { error: string } {
  const room = rooms.get(code)
  if (!room) return { error: 'Rum saknas' }
  if (room.hostId !== playerId) return { error: 'Bara värden kan fortsätta' }
  if (room.status !== 'scoreboard') {
    return { error: roomMsg(room, 'Vänta till poängtavlan', 'Wait for the scoreboard') }
  }
  return startRoundInternal(room)
}

export function endParty(code: string, playerId: string): Room | { error: string } {
  const room = rooms.get(code)
  if (!room) return { error: 'Rum saknas' }
  if (room.hostId !== playerId) return { error: 'Bara värden kan avsluta' }
  room.status = 'finished'
  room.phaseEndsAt = 0
  room.isPublic = false
  room.awards = computeAwards(room)
  touch(room)
  return room
}

export function rematch(code: string, playerId: string): Room | { error: string } {
  const room = rooms.get(code)
  if (!room) return { error: 'Rum saknas' }
  if (room.hostId !== playerId) return { error: 'Bara värden' }
  if (room.status !== 'finished' && room.status !== 'scoreboard') {
    return { error: roomMsg(room, 'Kan bara rematcha efter festen', 'Rematch only after the party') }
  }
  rollSeasonStats(room)
  Object.assign(room, emptyGameFields())
  for (const p of room.players) p.spectator = false
  promoteWaitlist(room)
  return startRoundInternal(room)
}

export function submitRevengeSeed(
  code: string,
  playerId: string,
  rawWord: string,
): Room | { error: string } {
  const room = rooms.get(code)
  if (!room) return { error: 'Rum saknas' }
  if (room.status !== 'scoreboard') {
    return { error: roomMsg(room, 'Bara på poängtavlan', 'Only on the scoreboard') }
  }
  if (room.revengePlayerId !== playerId) {
    return { error: roomMsg(room, 'Du har ingen hämnd just nu', 'You do not have revenge right now') }
  }
  const word = normalizeWord(rawWord).slice(0, 32)
  if (word.length < 2) {
    return { error: roomMsg(room, 'Ordet är för kort', 'Word is too short') }
  }
  room.revengeSeed = word
  touch(room)
  return room
}

function rollSeasonStats(room: Room) {
  const ranked = seatedPlayers(room)
    .map((p) => ({ id: p.id, score: room.scores[p.id] ?? 0 }))
    .sort((a, b) => b.score - a.score)
  const winnerId = ranked[0]?.id
  for (const p of room.players) {
    if (p.id === room.hostId) continue
    const score = room.scores[p.id] ?? 0
    const ps = room.partyStats[p.id] ?? emptyPartyStats()
    const prev = room.seasonStats[p.id] ?? {
      partiesPlayed: 0,
      totalScore: 0,
      wins: 0,
      ruinsDealt: 0,
      funnyVotesReceived: 0,
    }
    room.seasonStats[p.id] = {
      partiesPlayed: prev.partiesPlayed + 1,
      totalScore: prev.totalScore + score,
      wins: prev.wins + (p.id === winnerId ? 1 : 0),
      ruinsDealt: prev.ruinsDealt + ps.ruinsDealt,
      funnyVotesReceived: prev.funnyVotesReceived + ps.funnyVotesReceived,
    }
  }
}

function computeAwards(room: Room): Award[] {
  const awards: Award[] = []
  const players = seatedPlayers(room).filter((p) => p.id !== room.hostId)
  if (players.length === 0) return awards

  const byScore = [...players].sort((a, b) => (room.scores[b.id] ?? 0) - (room.scores[a.id] ?? 0))
  const champ = byScore[0]
  if (champ) {
    awards.push({
      id: 'champion',
      playerId: champ.id,
      labelSv: 'Kvällens mästare',
      labelEn: 'Party champion',
      detailSv: `${room.scores[champ.id] ?? 0} poäng`,
      detailEn: `${room.scores[champ.id] ?? 0} points`,
    })
  }

  const saboteur = [...players].sort(
    (a, b) =>
      (room.partyStats[b.id]?.ruinsDealt ?? 0) - (room.partyStats[a.id]?.ruinsDealt ?? 0),
  )[0]
  if (saboteur && (room.partyStats[saboteur.id]?.ruinsDealt ?? 0) > 0) {
    awards.push({
      id: 'saboteur',
      playerId: saboteur.id,
      labelSv: 'Sabotör #1',
      labelEn: 'Saboteur #1',
      detailSv: `${room.partyStats[saboteur.id].ruinsDealt} förstörda paths`,
      detailEn: `${room.partyStats[saboteur.id].ruinsDealt} ruined paths`,
    })
  }

  const funniest = [...players].sort(
    (a, b) =>
      (room.partyStats[b.id]?.funnyVotesReceived ?? 0) -
      (room.partyStats[a.id]?.funnyVotesReceived ?? 0),
  )[0]
  if (funniest && (room.partyStats[funniest.id]?.funnyVotesReceived ?? 0) > 0) {
    awards.push({
      id: 'funniest',
      playerId: funniest.id,
      labelSv: 'Mest kaos',
      labelEn: 'Most chaos',
      detailSv: `${room.partyStats[funniest.id].funnyVotesReceived} funny-röster`,
      detailEn: `${room.partyStats[funniest.id].funnyVotesReceived} funny votes`,
    })
  }

  const savior = [...players].sort(
    (a, b) =>
      (room.partyStats[b.id]?.correctGuesses ?? 0) - (room.partyStats[a.id]?.correctGuesses ?? 0),
  )[0]
  if (savior && (room.partyStats[savior.id]?.correctGuesses ?? 0) > 0) {
    awards.push({
      id: 'savior',
      playerId: savior.id,
      labelSv: 'Bästa räddning',
      labelEn: 'Best save',
      detailSv: `${room.partyStats[savior.id].correctGuesses} rätt`,
      detailEn: `${room.partyStats[savior.id].correctGuesses} correct`,
    })
  }

  const poet = [...players].sort(
    (a, b) => (room.partyStats[b.id]?.emojiChars ?? 0) - (room.partyStats[a.id]?.emojiChars ?? 0),
  )[0]
  if (poet && (room.partyStats[poet.id]?.emojiChars ?? 0) > 0) {
    awards.push({
      id: 'poet',
      playerId: poet.id,
      labelSv: 'Emoji-poet',
      labelEn: 'Emoji poet',
    })
  }

  const streaks = topRivalStreaks(room, 1)
  if (streaks[0] && streaks[0].count >= 2) {
    awards.push({
      id: 'rival',
      playerId: streaks[0].ruinerId,
      labelSv: 'Ärkerival',
      labelEn: 'Arch-rival',
      detailSv: `${streaks[0].ruinerName} vs ${streaks[0].victimName} (${streaks[0].count}×)`,
      detailEn: `${streaks[0].ruinerName} vs ${streaks[0].victimName} (${streaks[0].count}×)`,
    })
  }

  return awards
}

function topRivalStreaks(room: Room, limit = 3): RivalStreakPublic[] {
  const counts = new Map<string, { ruinerId: string; victimId: string; count: number }>()
  for (const r of room.rivalRuins ?? []) {
    const key = `${r.ruinerId}:${r.victimId}`
    const cur = counts.get(key) ?? { ruinerId: r.ruinerId, victimId: r.victimId, count: 0 }
    cur.count += 1
    counts.set(key, cur)
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((r) => ({
      ...r,
      ruinerName: playerName(room, r.ruinerId),
      victimName: playerName(room, r.victimId),
    }))
}

export function backToLobby(code: string, playerId: string): Room | { error: string } {
  const room = rooms.get(code)
  if (!room) return { error: 'Rum saknas' }
  if (room.hostId !== playerId) return { error: 'Bara värden' }
  room.status = 'lobby'
  Object.assign(room, emptyGameFields())
  room.scores = {}
  for (const p of room.players) p.spectator = false
  promoteWaitlist(room)
  touch(room)
  return room
}

function promoteWaitlist(room: Room) {
  const max = roomLimits(room).maxPlayers
  while (room.waitlist.length > 0) {
    const seated = seatedPlayers(room).filter((p) => p.connected).length
    if (max > 0 && seated >= max) break
    const w = room.waitlist.shift()
    if (!w) break
    room.players.push({
      id: w.id,
      name: w.name,
      connected: false,
      spectator: false,
    })
  }
}

function taskPlayerIds(room: Room): string[] {
  const order = pathOrder(room)
  const n = order.length
  const ids = new Set<string>()
  if (n === 0) return []
  if (room.status === 'emoji') {
    for (let oi = 0; oi < room.paths.length; oi++) {
      const p = order[authorIndexForHop(oi, room.hopIndex, n)]
      if (p) ids.add(p.id)
    }
  } else if (room.status === 'guess') {
    for (let oi = 0; oi < room.paths.length; oi++) {
      const p = order[guesserIndexForHop(oi, room.hopIndex, n)]
      if (p) ids.add(p.id)
    }
  } else if (room.status === 'funny_vote') {
    for (const p of playablePlayers(room)) ids.add(p.id)
  }
  return [...ids]
}

function playerStillInParty(room: Room, playerId: string) {
  const p = room.players.find((x) => x.id === playerId)
  if (!p) return false
  if (p.connected) return true
  if (disconnectTimers.has(playerKey(room.code, playerId))) return true
  return false
}

function maybeAdvance(room: Room) {
  const needed = taskPlayerIds(room)
  // Wait for anyone still in the party (including reconnect grace) — do not
  // skip a briefly-dropped socket and jump the whole table forward.
  const presentNeeded = needed.filter((id) => playerStillInParty(room, id))
  if (presentNeeded.length === 0) return
  const done = presentNeeded.every((id) => room.submissions[id] !== undefined)
  if (done) {
    if (room.status === 'emoji') lockEmojis(room)
    else if (room.status === 'guess') lockGuesses(room)
    else if (room.status === 'funny_vote') lockFunnyVotes(room)
  }
}

export function submitEmojis(
  code: string,
  playerId: string,
  emojisRaw: string,
): Room | { error: string } {
  const room = rooms.get(code)
  if (!room) return { error: 'Rum saknas' }
  if (room.status !== 'emoji') return { error: roomMsg(room, 'Inte emoji-fas', 'Not emoji phase') }
  const player = room.players.find((p) => p.id === playerId)
  if (!player || player.spectator || (player.id === room.hostId && !room.hostPlays)) {
    return { error: roomMsg(room, 'Du spelar inte just nu', 'You are not playing right now') }
  }
  const emojis = sanitizeEmojis(emojisRaw)
  if (!emojis) {
    return { error: roomMsg(room, 'Skriv minst en emoji', 'Enter at least one emoji') }
  }
  room.submissions[playerId] = emojis
  ensurePartyStats(room, playerId).emojiChars += [...emojis].length
  // Write onto the path step this player authors
  const order = pathOrder(room)
  const n = order.length
  const authorIdx = order.findIndex((p) => p.id === playerId)
  for (let oi = 0; oi < room.paths.length; oi++) {
    if (authorIndexForHop(oi, room.hopIndex, n) === authorIdx) {
      const step = room.paths[oi].steps[room.hopIndex]
      if (step) step.emojis = emojis
    }
  }
  touch(room)
  maybeAdvance(room)
  return room
}

export function submitGuess(
  code: string,
  playerId: string,
  guessRaw: string,
): Room | { error: string } {
  const room = rooms.get(code)
  if (!room) return { error: 'Rum saknas' }
  if (room.status !== 'guess') return { error: roomMsg(room, 'Inte gissningsfas', 'Not guess phase') }
  const player = room.players.find((p) => p.id === playerId)
  if (!player || player.spectator || (player.id === room.hostId && !room.hostPlays)) {
    return { error: roomMsg(room, 'Du spelar inte just nu', 'You are not playing right now') }
  }
  const guess = normalizeWord(guessRaw).slice(0, 48) || EMPTY_GUESS
  room.submissions[playerId] = guess
  const order = pathOrder(room)
  const n = order.length
  const guesserIdx = order.findIndex((p) => p.id === playerId)
  for (let oi = 0; oi < room.paths.length; oi++) {
    if (guesserIndexForHop(oi, room.hopIndex, n) === guesserIdx) {
      const step = room.paths[oi].steps[room.hopIndex]
      if (step) {
        step.guess = guess
        step.correct = scoreGuess(step.meaning, guess)
      }
    }
  }
  touch(room)
  maybeAdvance(room)
  return room
}

export function voteFunny(
  code: string,
  playerId: string,
  pathId: string,
): Room | { error: string } {
  const room = rooms.get(code)
  if (!room) return { error: 'Rum saknas' }
  if (room.status !== 'funny_vote') {
    return { error: roomMsg(room, 'Inte röstningsfas', 'Not voting phase') }
  }
  const player = room.players.find((p) => p.id === playerId)
  if (!player || player.spectator || (player.id === room.hostId && !room.hostPlays)) {
    return { error: roomMsg(room, 'Du spelar inte just nu', 'You are not playing right now') }
  }
  const path = room.paths.find((p) => p.id === pathId)
  if (!path) return { error: 'Ogiltig path' }
  room.submissions[playerId] = pathId
  room.funnyVotes[playerId] = pathId
  touch(room)
  maybeAdvance(room)
  return room
}

function fillMissingEmojis(room: Room) {
  for (const path of room.paths) {
    const step = path.steps[room.hopIndex]
    if (!step) continue
    if (!step.emojis) {
      const sub = room.submissions[step.authorId]
      step.emojis = sub || '❓'
    }
  }
}

function lockEmojis(room: Room) {
  if (room.status !== 'emoji') return
  fillMissingEmojis(room)
  beginGuessPhase(room)
  touch(room)
}

function lockGuesses(room: Room) {
  if (room.status !== 'guess') return
  const points = room.doublePoints ? CORRECT_POINTS * 2 : CORRECT_POINTS
  for (const path of room.paths) {
    const step = path.steps[room.hopIndex]
    if (!step) continue
    if (!step.guess) {
      step.guess = room.submissions[step.guesserId] || EMPTY_GUESS
    }
    step.correct = scoreGuess(step.meaning, step.guess)
    const submitted = room.submissions[step.guesserId] !== undefined
    if (submitted) {
      const stats = ensurePartyStats(room, step.guesserId)
      if (step.correct) {
        applyCorrectPoints(room.scores, step.guesserId, true, points)
        stats.correctGuesses += 1
      } else {
        stats.wrongGuesses += 1
        const victimId = victimForWrongGuess(path, room.hopIndex)
        if (victimId && victimId !== step.guesserId) {
          room.rivalRuins.push({
            ruinerId: step.guesserId,
            victimId,
            pathId: path.id,
            roundIndex: room.roundIndex,
          })
          ensurePartyStats(room, step.guesserId).ruinsDealt += 1
          ensurePartyStats(room, victimId).ruinsSuffered += 1
        }
        const guess = normalizeWord(step.guess)
        if (guess.length >= 2 && guess !== EMPTY_GUESS && !room.callbackPool.includes(guess)) {
          room.callbackPool.push(guess)
          if (room.callbackPool.length > 24) room.callbackPool.shift()
        }
      }
    }
  }

  if (room.hopIndex + 1 < room.hopCount) {
    room.hopIndex += 1
    beginEmojiPhase(room)
  } else {
    room.status = 'reveal'
    room.submissions = {}
    room.phaseEndsAt = Date.now() + REVEAL_SECONDS * 1000
  }
  touch(room)
}

function enterFunnyVote(room: Room) {
  if (room.status !== 'reveal') return
  room.status = 'funny_vote'
  room.submissions = {}
  room.funnyVotes = {}
  room.phaseEndsAt = Date.now() + FUNNY_VOTE_SECONDS * 1000
  touch(room)
}

export function advanceReveal(code: string, playerId: string): Room | { error: string } {
  const room = rooms.get(code)
  if (!room) return { error: 'Rum saknas' }
  if (room.hostId !== playerId) return { error: 'Bara värden kan gå vidare' }
  if (room.status !== 'reveal') {
    return { error: roomMsg(room, 'Inte reveal-fas', 'Not reveal phase') }
  }
  enterFunnyVote(room)
  return room
}

function lockFunnyVotes(room: Room) {
  if (room.status !== 'funny_vote') return
  const pointsPerVote = room.doublePoints ? FUNNY_VOTE_POINTS * 2 : FUNNY_VOTE_POINTS
  applyFunnyVotePoints(room.scores, room.paths, room.funnyVotes, pointsPerVote)

  const winners = tallyFunnyVotes(room.funnyVotes)
  const tally = Object.values(room.funnyVotes).reduce(
    (acc, id) => {
      acc[id] = (acc[id] ?? 0) + 1
      return acc
    },
    {} as Record<string, number>,
  )

  for (const [pathId, count] of Object.entries(tally)) {
    const path = room.paths.find((p) => p.id === pathId)
    if (!path) continue
    const recipient = lastWrongGuesser(path)
    if (recipient) ensurePartyStats(room, recipient).funnyVotesReceived += count
  }

  if (winners.length > 0) {
    const bestVotes = Math.max(...winners.map((id) => tally[id] ?? 0))
    if (bestVotes > room.nightPathVotes) {
      const pub = publicPaths(room).find((p) => p.id === winners[0])
      if (pub) {
        room.nightPath = pub
        room.nightPathVotes = bestVotes
      }
    }
    // Revenge: last wrong guesser on the funniest path picks next seed.
    const winPath = room.paths.find((p) => p.id === winners[0])
    if (winPath) {
      room.revengePlayerId = lastWrongGuesser(winPath)
      room.revengeSeed = null
    }
  }

  room.status = 'scoreboard'
  room.phaseEndsAt = SCOREBOARD_MS
  room.submissions = {}
  touch(room)
}

export function onPhaseTimeout(room: Room) {
  if (room.phaseEndsAt <= 0 || Date.now() < room.phaseEndsAt) return
  if (room.status === 'emoji') lockEmojis(room)
  else if (room.status === 'guess') lockGuesses(room)
  else if (room.status === 'reveal') enterFunnyVote(room)
  else if (room.status === 'funny_vote') lockFunnyVotes(room)
}

export function roomsNeedingTick(): Room[] {
  const now = Date.now()
  const out: Room[] = []
  for (const room of rooms.values()) {
    if (
      room.phaseEndsAt > 0 &&
      now >= room.phaseEndsAt &&
      (room.status === 'emoji' ||
        room.status === 'guess' ||
        room.status === 'reveal' ||
        room.status === 'funny_vote')
    ) {
      out.push(room)
    }
  }
  return out
}

export function pruneIdleRooms() {
  const now = Date.now()
  for (const [code, room] of rooms) {
    if (now - room.updatedAt > ROOM_IDLE_MS) {
      rooms.delete(code)
      void deleteRoomRecord(code)
    }
  }
}

function playerName(room: Room, id: string) {
  return room.players.find((p) => p.id === id)?.name ?? '?'
}

function publicPaths(room: Room): PublicPath[] {
  return room.paths.map((p) => ({
    id: p.id,
    originPlayerId: p.originPlayerId,
    originName: playerName(room, p.originPlayerId),
    seedWord: p.seedWord,
    steps: p.steps.map((s) => ({
      authorName: playerName(room, s.authorId),
      meaning: s.meaning,
      emojis: s.emojis,
      guesserName: playerName(room, s.guesserId),
      guess: s.guess,
      correct: s.correct,
    })),
  }))
}

function viewerTask(room: Room, viewerId: string) {
  const order = pathOrder(room)
  const n = order.length
  const idx = order.findIndex((p) => p.id === viewerId)
  if (idx < 0) return null

  if (room.status === 'emoji') {
    for (let oi = 0; oi < room.paths.length; oi++) {
      if (authorIndexForHop(oi, room.hopIndex, n) === idx) {
        const path = room.paths[oi]
        return {
          meaning: meaningForHop(path, room.hopIndex),
          promptEmojis: null as string | null,
          pathId: path.id,
        }
      }
    }
  }
  if (room.status === 'guess') {
    for (let oi = 0; oi < room.paths.length; oi++) {
      if (guesserIndexForHop(oi, room.hopIndex, n) === idx) {
        const path = room.paths[oi]
        const step = path.steps[room.hopIndex]
        return {
          meaning: null as string | null,
          promptEmojis: step?.emojis || '❓',
          pathId: path.id,
        }
      }
    }
  }
  return null
}

export function toPublicRoom(room: Room, viewerId?: string | null): PublicRoom {
  const lang = room.language
  const limits = roomLimits(room)
  const viewer = viewerId ? room.players.find((p) => p.id === viewerId) : null
  const needed = taskPlayerIds(room)
  const connectedNeeded = needed.filter((id) => room.players.find((p) => p.id === id)?.connected)
  const showPaths =
    room.status === 'reveal' ||
    room.status === 'funny_vote' ||
    room.status === 'scoreboard' ||
    room.status === 'finished'

  let notice: string | null = null
  if (room.notice && Date.now() - room.notice.at < NOTICE_TTL_MS) {
    notice = msg(
      lang,
      `${room.notice.hostName} är nu värd`,
      `${room.notice.hostName} is now the host`,
    )
  }

  const task = viewerId && !viewer?.spectator ? viewerTask(room, viewerId) : null
  const funnyTally: Record<string, number> | null =
    room.status === 'funny_vote' ||
    room.status === 'scoreboard' ||
    room.status === 'finished'
      ? Object.values(room.funnyVotes).reduce(
          (acc, id) => {
            acc[id] = (acc[id] ?? 0) + 1
            return acc
          },
          {} as Record<string, number>,
        )
      : null

  const scoreboard = seatedPlayers(room)
    .map((p) => ({
      playerId: p.id,
      name: p.name,
      score: room.scores[p.id] ?? 0,
    }))
    .sort((a, b) => b.score - a.score)

  return {
    code: room.code,
    hostId: room.hostId,
    players: room.players,
    language: room.language,
    status: room.status,
    premiumTier: tierFromExpiry(room.premiumExpiresAt),
    premiumExpiresAt: room.premiumExpiresAt,
    limits,
    isPublic: Boolean(room.isPublic),
    waitlist: room.waitlist,
    hostPlays: Boolean(room.hostPlays),
    wordTheme: room.wordTheme ?? 'fest',
    emojiSeconds: room.emojiSeconds,
    guessSeconds: room.guessSeconds,
    phaseEndsAt: room.phaseEndsAt,
    roundIndex: room.roundIndex,
    hopIndex: room.hopIndex,
    hopCount: room.hopCount,
    submittedCount: Object.keys(room.submissions).length,
    submitterCount: connectedNeeded.length || needed.length,
    submittedIds: Object.keys(room.submissions),
    youSubmitted: Boolean(viewerId && room.submissions[viewerId] !== undefined),
    yourMeaning: room.status === 'emoji' ? task?.meaning ?? null : null,
    yourPromptEmojis: room.status === 'guess' ? task?.promptEmojis ?? null : null,
    yourGuessTargetPathId: room.status === 'guess' ? task?.pathId ?? null : null,
    scores: scoreboard,
    paths: showPaths ? publicPaths(room) : null,
    funnyVotes: funnyTally,
    nightPath: room.nightPath ?? null,
    nightPathVotes: room.nightPathVotes ?? 0,
    yourFunnyVote: viewerId ? room.funnyVotes[viewerId] ?? null : null,
    notice,
    youAreSpectator: Boolean(viewer?.spectator),
    youAreHost: Boolean(viewer && viewer.id === room.hostId),
    maxRounds: limits.maxRounds,
    doublePoints: Boolean(room.doublePoints),
    suddenDeath: Boolean(room.doublePoints),
    revengePlayerId: room.revengePlayerId ?? null,
    revengeSeed: room.revengeSeed ?? null,
    youHaveRevenge: Boolean(viewerId && room.revengePlayerId === viewerId),
    awards: Array.isArray(room.awards) ? room.awards : [],
    rivalStreaks: topRivalStreaks(room, 3),
    seasonStats: Object.entries(room.seasonStats ?? {}).map(([playerId, s]) => ({
      playerId,
      name: playerName(room, playerId),
      partiesPlayed: s.partiesPlayed,
      totalScore: s.totalScore,
      wins: s.wins,
    })),
  }
}
