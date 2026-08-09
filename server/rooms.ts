import { customAlphabet } from 'nanoid'
import {
  applyCorrectPoints,
  applyFunnyVotePoints,
  authorIndexForHop,
  createEmptyStep,
  dealWords,
  EMPTY_GUESS,
  EMOJI_SECONDS,
  GUESS_SECONDS,
  guesserIndexForHop,
  HOP_COUNT,
  hopCountForPlayers,
  meaningForHop,
  MIN_PLAYERS,
  normalizeWord,
  sanitizeEmojis,
  scoreGuess,
} from './game/paths.js'
import {
  limitsFor,
  lookupPass,
  redeemPassCode,
  tierFromExpiry,
  type PartyPass,
} from './premium.js'
import { deleteRoomRecord, loadRoomRecord, saveRoomRecord } from './persist.js'
import { freeWordPack, wordPack } from './words/index.js'
import type {
  GamePath,
  Lang,
  Player,
  PublicPath,
  PublicRoom,
  Room,
  RoomStatus,
} from './types.js'

const makeCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ', 4)
const DISCONNECT_GRACE_MS = 60_000
const HOST_TRANSFER_AFTER_MS = 90_000
const ROOM_IDLE_MS = 12 * 60 * 60 * 1000
const NOTICE_TTL_MS = 45_000
const SCOREBOARD_MS = 0

const rooms = new Map<string, Room>()
const socketToPlayer = new Map<string, { code: string; playerId: string }>()
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

function roomLimits(room: Room) {
  return limitsFor(tierFromExpiry(room.premiumExpiresAt))
}

function msg(lang: Lang, sv: string, en: string) {
  return lang === 'en' ? en : sv
}

function roomMsg(room: Room, sv: string, en: string) {
  return msg(room.language, sv, en)
}

function uniqueCode(): string {
  let code = makeCode()
  while (rooms.has(code)) code = makeCode()
  return code
}

function isActivePlayer(room: Room, p: Player): boolean {
  if (p.spectator) return false
  if (p.id === room.hostId) return false
  return true
}

function seatedPlayers(room: Room): Player[] {
  return room.players.filter((p) => isActivePlayer(room, p))
}

function connectedPlayers(room: Room): Player[] {
  return seatedPlayers(room).filter((p) => p.connected)
}

function midGame(status: RoomStatus): boolean {
  return status !== 'lobby' && status !== 'finished'
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
  | 'usedWords'
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
    usedWords: [],
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
      usedWords: Array.isArray(raw.usedWords) ? raw.usedWords : [],
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

/** Pull a room from Redis into memory when this instance does not have it yet. */
export async function hydrateRoom(code: string): Promise<Room | null> {
  const c = code.toUpperCase().trim()
  if (!c) return null
  const existing = rooms.get(c)
  if (existing) return existing
  const raw = await loadRoomRecord(c)
  if (!raw) return null
  restoreRooms([raw])
  const room = rooms.get(c)
  if (!room) return null
  // Rebuild connected flags from sockets bound on THIS instance only.
  const localConnected = new Set<string>()
  for (const binding of socketToPlayer.values()) {
    if (binding.code === c) localConnected.add(binding.playerId)
  }
  for (const p of room.players) {
    p.connected = localConnected.has(p.id)
  }
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
    return local ?? null
  }
  // Ignore Redis echo of our own save (same or older updatedAt), otherwise we
  // clobber live sockets (save persists connected:false) right after startGame.
  if (local && (local.updatedAt || 0) >= (raw.updatedAt || 0)) {
    return local
  }
  const localConnected = new Set<string>()
  for (const binding of socketToPlayer.values()) {
    if (binding.code === c) localConnected.add(binding.playerId)
  }
  restoreRooms([raw])
  const room = rooms.get(c)
  if (!room) return null
  for (const p of room.players) {
    p.connected = localConnected.has(p.id)
  }
  return room
}

export function getBinding(socketId: string) {
  return socketToPlayer.get(socketId) ?? null
}

export function createRoom(
  hostName: string,
  socketId: string,
  language: Lang = 'sv',
  partyToken?: string | null,
  wantPublic = false,
): { room: Room; playerId: string } {
  const pass = lookupPass(partyToken)
  const premiumExpiresAt = pass?.expiresAt ?? null
  const isParty = tierFromExpiry(premiumExpiresAt) === 'party'
  const code = uniqueCode()
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
    premiumExpiresAt,
    isPublic: Boolean(wantPublic && isParty),
    waitlist: [],
    emojiSeconds: EMOJI_SECONDS,
    guessSeconds: GUESS_SECONDS,
    notice: null,
    updatedAt: Date.now(),
    ...emptyGameFields(),
  }

  releaseSocket(socketId)
  rooms.set(code, room)
  socketToPlayer.set(socketId, { code, playerId })
  touch(room)
  return { room, playerId }
}

function releaseSocket(socketId: string) {
  const prev = socketToPlayer.get(socketId)
  if (!prev) return
  socketToPlayer.delete(socketId)
  const room = rooms.get(prev.code)
  if (!room) return
  const player = room.players.find((p) => p.id === prev.playerId)
  if (!player || !player.connected) return
  player.connected = false
  touch(room)
  if (room.status === 'lobby' || room.status === 'finished') {
    // Drop immediately when switching rooms from the lobby so the seat frees up.
    if (player.id !== room.hostId) {
      room.players = room.players.filter((p) => p.id !== player.id)
      touch(room)
    }
  }
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
      cancelDisconnectTimer(room.code, mine.id)
      mine.connected = true
      if (!mine.spectator && mine.id !== room.hostId) mine.name = displayName
      touch(room)
      return { room, playerId: mine.id }
    }
  }

  // Leaving another room on this socket frees the old lobby seat.
  if (existing && existing.code !== room.code) {
    releaseSocket(socketId)
  }

  if (midGame(room.status)) {
    const playerId = crypto.randomUUID()
    room.players.push({
      id: playerId,
      name: displayName,
      connected: true,
      spectator: true,
    })
    socketToPlayer.set(socketId, { code: room.code, playerId })
    touch(room)
    return { room, playerId }
  }

  // Reclaim a disconnected seat with the same name (avoids ghost slots when rejoining).
  const reclaim = seatedPlayers(room).find(
    (p) => !p.connected && p.name.toLowerCase() === displayName.toLowerCase(),
  )
  if (reclaim) {
    cancelDisconnectTimer(room.code, reclaim.id)
    reclaim.connected = true
    socketToPlayer.set(socketId, { code: room.code, playerId: reclaim.id })
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
  socketToPlayer.set(socketId, { code: room.code, playerId })
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
  cancelDisconnectTimer(room.code, playerId)
  player.connected = true
  socketToPlayer.set(socketId, { code: room.code, playerId })
  touch(room)
  return room
}

export function handleDisconnect(socketId: string) {
  const binding = socketToPlayer.get(socketId)
  if (!binding) return
  socketToPlayer.delete(socketId)
  const room = rooms.get(binding.code)
  if (!room) return
  const player = room.players.find((p) => p.id === binding.playerId)
  if (!player) return
  player.connected = false
  touch(room)

  const key = playerKey(binding.code, binding.playerId)
  cancelDisconnectTimer(binding.code, binding.playerId)
  disconnectTimers.set(
    key,
    setTimeout(() => {
      disconnectTimers.delete(key)
      const r = rooms.get(binding.code)
      if (!r) return
      const p = r.players.find((x) => x.id === binding.playerId)
      if (!p || p.connected) return
      // Host transfer if host gone long enough
      if (p.id === r.hostId) {
        setTimeout(() => {
          const rr = rooms.get(binding.code)
          if (!rr) return
          const host = rr.players.find((x) => x.id === rr.hostId)
          if (host?.connected) return
          const next = rr.players.find((x) => x.connected && !x.spectator)
          if (!next) return
          rr.hostId = next.id
          rr.notice = { kind: 'host_transfer', hostName: next.name, at: Date.now() }
          touch(rr)
          onBroadcast?.(rr.code)
        }, HOST_TRANSFER_AFTER_MS - DISCONNECT_GRACE_MS)
      } else if (r.status === 'lobby' || r.status === 'finished') {
        // Drop lobby ghosts so they don't clutter the roster (capacity already
        // ignores disconnected players).
        r.players = r.players.filter((x) => x.id !== binding.playerId)
      }
      touch(r)
      onBroadcast?.(r.code)
    }, DISCONNECT_GRACE_MS),
  )
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
  if (isPublic && tierFromExpiry(room.premiumExpiresAt) !== 'party') {
    return {
      error: roomMsg(room, 'Öppen lobby kräver Party-pass', 'Open lobby requires a Party pass'),
    }
  }
  room.isPublic = Boolean(isPublic)
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
  const limits = roomLimits(room)
  return limits.freePack ? freeWordPack(room.language) : wordPack(room.language)
}

function beginEmojiPhase(room: Room) {
  room.status = 'emoji'
  room.submissions = {}
  room.phaseEndsAt = 0
  // Prepare empty step shells for this hop
  const order = seatedPlayers(room)
  const n = order.length
  for (let oi = 0; oi < room.paths.length; oi++) {
    const path = room.paths[oi]
    const author = order[authorIndexForHop(oi, room.hopIndex, n)]
    const guesser = order[guesserIndexForHop(oi, room.hopIndex, n)]
    const meaning = meaningForHop(path, room.hopIndex)
    path.steps[room.hopIndex] = createEmptyStep({
      authorId: author.id,
      meaning,
      guesserId: guesser.id,
    })
  }
}

function beginGuessPhase(room: Room) {
  room.status = 'guess'
  room.submissions = {}
  room.phaseEndsAt = 0
}

function startRoundInternal(room: Room) {
  const order = connectedPlayers(room)
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
        'Max antal rundor nått — skaffa Party för fler',
        'Max rounds reached — unlock Party for more',
      ),
    }
  }

  const used = new Set(room.usedWords.map(normalizeWord))
  const words = dealWords(packForRoom(room), order.length, used)
  room.usedWords = [...used]

  room.paths = order.map((p, i) => ({
    id: crypto.randomUUID(),
    originPlayerId: p.id,
    seedWord: words[i] ?? 'pizza',
    steps: [],
  }))
  room.hopIndex = 0
  room.hopCount = hopCountForPlayers(order.length)
  room.funnyVotes = {}
  room.submissions = {}
  room.roundIndex += 1
  for (const p of order) {
    if (room.scores[p.id] === undefined) room.scores[p.id] = 0
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
    room.scores = {}
    room.roundIndex = 0
    room.usedWords = []
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
  touch(room)
  return room
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
  const order = seatedPlayers(room)
  const n = order.length
  const ids = new Set<string>()
  if (room.status === 'emoji') {
    for (let oi = 0; oi < room.paths.length; oi++) {
      ids.add(order[authorIndexForHop(oi, room.hopIndex, n)].id)
    }
  } else if (room.status === 'guess') {
    for (let oi = 0; oi < room.paths.length; oi++) {
      ids.add(order[guesserIndexForHop(oi, room.hopIndex, n)].id)
    }
  } else if (room.status === 'funny_vote') {
    for (const p of connectedPlayers(room)) ids.add(p.id)
  }
  return [...ids]
}

function maybeAdvance(room: Room) {
  const needed = taskPlayerIds(room)
  const connectedNeeded = needed.filter((id) => {
    const p = room.players.find((x) => x.id === id)
    return p?.connected
  })
  const done = connectedNeeded.every((id) => room.submissions[id] !== undefined)
  if (done && connectedNeeded.length > 0) {
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
  if (!player || player.spectator || player.id === room.hostId) {
    return { error: roomMsg(room, 'Värden deltar inte', 'Host does not play') }
  }
  const emojis = sanitizeEmojis(emojisRaw)
  if (!emojis) {
    return { error: roomMsg(room, 'Skriv minst en emoji', 'Enter at least one emoji') }
  }
  room.submissions[playerId] = emojis
  // Write onto the path step this player authors
  const order = seatedPlayers(room)
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
  if (!player || player.spectator || player.id === room.hostId) {
    return { error: roomMsg(room, 'Värden deltar inte', 'Host does not play') }
  }
  const guess = normalizeWord(guessRaw).slice(0, 48) || EMPTY_GUESS
  room.submissions[playerId] = guess
  const order = seatedPlayers(room)
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
  if (!player || player.spectator || player.id === room.hostId) {
    return { error: roomMsg(room, 'Värden deltar inte', 'Host does not play') }
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
  fillMissingEmojis(room)
  beginGuessPhase(room)
  touch(room)
}

function lockGuesses(room: Room) {
  for (const path of room.paths) {
    const step = path.steps[room.hopIndex]
    if (!step) continue
    if (!step.guess) {
      step.guess = room.submissions[step.guesserId] || EMPTY_GUESS
    }
    step.correct = scoreGuess(step.meaning, step.guess)
    const submitted = room.submissions[step.guesserId] !== undefined
    if (submitted && step.correct) {
      applyCorrectPoints(room.scores, step.guesserId, true)
    }
  }

  if (room.hopIndex + 1 < room.hopCount) {
    room.hopIndex += 1
    beginEmojiPhase(room)
  } else {
    room.status = 'reveal'
    room.submissions = {}
    room.phaseEndsAt = 0
  }
  touch(room)
}

function enterFunnyVote(room: Room) {
  room.status = 'funny_vote'
  room.submissions = {}
  room.funnyVotes = {}
  room.phaseEndsAt = 0
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
  // Each vote → +10 to the last wrong guesser on that path.
  applyFunnyVotePoints(room.scores, room.paths, room.funnyVotes)

  room.status = 'scoreboard'
  room.phaseEndsAt = SCOREBOARD_MS
  room.submissions = {}
  touch(room)
}

export function onPhaseTimeout(_room: Room) {
  // Phases advance only when all active players have submitted (no timers).
}

export function roomsNeedingTick(): Room[] {
  return []
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

export function redeemParty(
  code: string,
  playerId: string,
  passCode: string,
): { room: Room; pass: PartyPass } | { error: string } {
  const room = rooms.get(code)
  if (!room) return { error: 'Rum saknas' }
  if (room.hostId !== playerId) return { error: 'Bara värden' }
  const pass = redeemPassCode(passCode)
  if ('error' in pass) return pass
  room.premiumExpiresAt = pass.expiresAt
  touch(room)
  return { room, pass }
}

export function applyPartyToken(code: string, token: string): Room | { error: string } {
  const room = rooms.get(code)
  if (!room) return { error: 'Rum saknas' }
  const pass = lookupPass(token)
  if (!pass) return { error: 'Ogiltigt party-pass' }
  room.premiumExpiresAt = pass.expiresAt
  touch(room)
  return room
}

export function unlockRoomWithPass(code: string, pass: PartyPass) {
  const room = rooms.get(code.toUpperCase())
  if (!room) return
  room.premiumExpiresAt = pass.expiresAt
  touch(room)
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
  const order = seatedPlayers(room)
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
    room.status === 'funny_vote' || room.status === 'scoreboard'
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
    yourFunnyVote: viewerId ? room.funnyVotes[viewerId] ?? null : null,
    notice,
    youAreSpectator: Boolean(viewer?.spectator),
    youAreHost: Boolean(viewer && viewer.id === room.hostId),
    maxRounds: limits.maxRounds,
  }
}
