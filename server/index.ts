import express from 'express'
import cors from 'cors'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from 'socket.io'
import {
  allPasses,
  restorePasses,
  setPassPersistHook,
} from './premium.js'
import {
  buildSnapshot,
  createRedisAdapterClients,
  flushPersist,
  initPersist,
  loadSnapshot,
  persistDiagnostics,
  scheduleSave,
  subscribeRoomUpdates,
} from './persist.js'
import {
  allRooms,
  advanceReveal,
  backToLobby,
  createRoom,
  endParty,
  getBinding,
  getRoom,
  handleDisconnect,
  hydrateRoom,
  joinRoom,
  nextRound,
  onPhaseTimeout,
  previewRoom,
  pruneIdleRooms,
  reconnectSocket,
  reloadRoomFromStore,
  restoreRooms,
  roomsNeedingTick,
  setLanguage,
  setBroadcastHook,
  setPersistHook,
  setPhaseTimers,
  setPublicLobby,
  listPublicLobbies,
  startGame,
  submitEmojis,
  submitGuess,
  toPublicRoom,
  voteFunny,
} from './rooms.js'
import type { Lang } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 3001
const isProd = process.env.NODE_ENV === 'production'

const app = express()
const httpServer = createServer(app)

function resolveCorsOrigin():
  | boolean
  | string[]
  | ((origin: string | undefined, cb: (err: Error | null, allow?: boolean | string) => void) => void) {
  const extras =
    process.env.CORS_ORIGIN?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? []
  const allowed = new Set([
    'https://partypaths.com',
    'https://www.partypaths.com',
    ...extras,
  ])

  return (origin, cb) => {
    if (!origin) {
      cb(null, true)
      return
    }
    if (allowed.has(origin) || origin.endsWith('.up.railway.app') || origin.startsWith('http://localhost:')) {
      cb(null, origin)
      return
    }
    cb(null, false)
  }
}

const corsOrigin = resolveCorsOrigin()

const io = new Server(httpServer, {
  cors: {
    origin: ['https://partypaths.com', 'https://www.partypaths.com', 'http://localhost:5173'],
    methods: ['GET', 'POST'],
    credentials: true,
  },
})

function persistNow() {
  scheduleSave(buildSnapshot(allPasses().values(), allRooms().values()))
}

setPersistHook(persistNow)
setPassPersistHook(persistNow)
setBroadcastHook(broadcastRoom)

function broadcastRoom(code: string) {
  const room = getRoom(code)
  if (!room) return
  for (const [, socket] of io.of('/').sockets) {
    const binding = getBinding(socket.id)
    if (!binding || binding.code !== code) continue
    socket.emit('room', toPublicRoom(room, binding.playerId))
  }
}

app.use(cors({ origin: corsOrigin, credentials: true }))
app.use(express.json())

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'partypaths',
    rooms: allRooms().size,
    persist: persistDiagnostics(),
  })
})

app.get('/api/room/:code/preview', async (req, res) => {
  const code = String(req.params.code ?? '')
  await hydrateRoom(code)
  const preview = previewRoom(code)
  if (!preview) {
    res.status(404).json({
      error: 'Hittade inget spel med den koden / No game found with that code',
    })
    return
  }
  res.json(preview)
})

app.get('/api/lobbies', (req, res) => {
  const lang = req.query.lang === 'en' ? 'en' : req.query.lang === 'sv' ? 'sv' : null
  const lobbies = listPublicLobbies({ language: lang, limit: 24 })
  res.json({ lobbies, count: lobbies.length })
})

io.on('connection', (socket) => {
  function bindingFrom(payload?: { code?: unknown; roomCode?: unknown; playerId?: unknown }) {
    let binding = getBinding(socket.id)
    const code = payload?.roomCode ?? payload?.code
    if (!binding && code && payload?.playerId) {
      const rebound = reconnectSocket(String(code), String(payload.playerId), socket.id)
      if (!('error' in rebound)) binding = getBinding(socket.id)
    }
    return binding
  }

  socket.on('create', async (payload, ack) => {
    try {
      const name = String(payload?.name ?? '')
      const language = (payload?.language === 'en' ? 'en' : 'sv') as Lang
      const wantPublic = Boolean(payload?.isPublic)
      const { room, playerId } = createRoom(name, socket.id, language, null, wantPublic)
      // Force snapshot flush so a restart right after create can still restore.
      persistNow()
      await flushPersist()
      ack?.({ ok: true, playerId, room: toPublicRoom(room, playerId) })
      broadcastRoom(room.code)
    } catch (e) {
      console.error(e)
      ack?.({ ok: false, error: 'Kunde inte skapa rum' })
    }
  })

  socket.on('join', async (payload, ack) => {
    try {
      const code = String(payload?.code ?? '')
      await hydrateRoom(code)
      const result = joinRoom(code, String(payload?.name ?? ''), socket.id)
      if ('error' in result) {
        ack?.({ ok: false, ...result })
        return
      }
      ack?.({
        ok: true,
        playerId: result.playerId,
        room: toPublicRoom(result.room, result.playerId),
      })
      broadcastRoom(result.room.code)
    } catch (e) {
      console.error(e)
      ack?.({ ok: false, error: 'Kunde inte gå med' })
    }
  })

  socket.on('rejoin', async (payload, ack) => {
    try {
      const code = String(payload?.code ?? '')
      await hydrateRoom(code)
      const result = reconnectSocket(code, String(payload?.playerId ?? ''), socket.id)
      if ('error' in result) {
        ack?.({ ok: false, error: result.error })
        return
      }
      const binding = getBinding(socket.id)
      ack?.({
        ok: true,
        playerId: binding!.playerId,
        room: toPublicRoom(result, binding!.playerId),
      })
      broadcastRoom(result.code)
    } catch (e) {
      console.error(e)
      ack?.({ ok: false, error: 'Kunde inte återansluta' })
    }
  })

  socket.on('setLanguage', (payload, ack) => {
    const binding = bindingFrom(payload)
    if (!binding) return ack?.({ ok: false, error: 'Inte i ett rum' })
    const result = setLanguage(
      binding.code,
      binding.playerId,
      payload?.language === 'en' ? 'en' : 'sv',
    )
    if ('error' in result) return ack?.({ ok: false, error: result.error })
    ack?.({ ok: true, room: toPublicRoom(result, binding.playerId) })
    broadcastRoom(result.code)
  })

  socket.on('setPhaseTimers', (payload, ack) => {
    const binding = bindingFrom(payload)
    if (!binding) return ack?.({ ok: false, error: 'Inte i ett rum' })
    const result = setPhaseTimers(
      binding.code,
      binding.playerId,
      payload?.emojiSeconds !== undefined ? Number(payload.emojiSeconds) : undefined,
      payload?.guessSeconds !== undefined ? Number(payload.guessSeconds) : undefined,
    )
    if ('error' in result) return ack?.({ ok: false, error: result.error })
    ack?.({ ok: true, room: toPublicRoom(result, binding.playerId) })
    broadcastRoom(result.code)
  })

  socket.on('setPublicLobby', (payload, ack) => {
    const binding = bindingFrom(payload)
    if (!binding) return ack?.({ ok: false, error: 'Inte i ett rum' })
    const result = setPublicLobby(binding.code, binding.playerId, Boolean(payload?.isPublic))
    if ('error' in result) return ack?.({ ok: false, error: result.error })
    ack?.({ ok: true, room: toPublicRoom(result, binding.playerId) })
    broadcastRoom(result.code)
  })

  socket.on('startGame', (payload, ack) => {
    const binding = bindingFrom(payload)
    if (!binding) return ack?.({ ok: false, error: 'Inte i ett rum' })
    const result = startGame(binding.code, binding.playerId)
    if ('error' in result) return ack?.({ ok: false, error: result.error })
    ack?.({ ok: true, room: toPublicRoom(result, binding.playerId) })
    broadcastRoom(result.code)
  })

  socket.on('nextRound', (payload, ack) => {
    const binding = bindingFrom(payload)
    if (!binding) return ack?.({ ok: false, error: 'Inte i ett rum' })
    const result = nextRound(binding.code, binding.playerId)
    if ('error' in result) return ack?.({ ok: false, error: result.error })
    ack?.({ ok: true, room: toPublicRoom(result, binding.playerId) })
    broadcastRoom(result.code)
  })

  socket.on('endParty', (payload, ack) => {
    const binding = bindingFrom(payload)
    if (!binding) return ack?.({ ok: false, error: 'Inte i ett rum' })
    const result = endParty(binding.code, binding.playerId)
    if ('error' in result) return ack?.({ ok: false, error: result.error })
    ack?.({ ok: true, room: toPublicRoom(result, binding.playerId) })
    broadcastRoom(result.code)
  })

  socket.on('backToLobby', (payload, ack) => {
    const binding = bindingFrom(payload)
    if (!binding) return ack?.({ ok: false, error: 'Inte i ett rum' })
    const result = backToLobby(binding.code, binding.playerId)
    if ('error' in result) return ack?.({ ok: false, error: result.error })
    ack?.({ ok: true, room: toPublicRoom(result, binding.playerId) })
    broadcastRoom(result.code)
  })

  socket.on('advanceReveal', (payload, ack) => {
    const binding = bindingFrom(payload)
    if (!binding) return ack?.({ ok: false, error: 'Inte i ett rum' })
    const result = advanceReveal(binding.code, binding.playerId)
    if ('error' in result) return ack?.({ ok: false, error: result.error })
    ack?.({ ok: true, room: toPublicRoom(result, binding.playerId) })
    broadcastRoom(result.code)
  })

  socket.on('submitEmojis', (payload, ack) => {
    const binding = bindingFrom(payload)
    if (!binding) return ack?.({ ok: false, error: 'Inte i ett rum' })
    const result = submitEmojis(binding.code, binding.playerId, String(payload?.emojis ?? ''))
    if ('error' in result) return ack?.({ ok: false, error: result.error })
    ack?.({ ok: true, room: toPublicRoom(result, binding.playerId) })
    broadcastRoom(result.code)
  })

  socket.on('submitGuess', (payload, ack) => {
    const binding = bindingFrom(payload)
    if (!binding) return ack?.({ ok: false, error: 'Inte i ett rum' })
    const result = submitGuess(binding.code, binding.playerId, String(payload?.guess ?? ''))
    if ('error' in result) return ack?.({ ok: false, error: result.error })
    ack?.({ ok: true, room: toPublicRoom(result, binding.playerId) })
    broadcastRoom(result.code)
  })

  socket.on('voteFunny', (payload, ack) => {
    const binding = bindingFrom(payload)
    if (!binding) return ack?.({ ok: false, error: 'Inte i ett rum' })
    const result = voteFunny(binding.code, binding.playerId, String(payload?.pathId ?? ''))
    if ('error' in result) return ack?.({ ok: false, error: result.error })
    ack?.({ ok: true, room: toPublicRoom(result, binding.playerId) })
    broadcastRoom(result.code)
  })

  socket.on('disconnect', () => {
    const binding = getBinding(socket.id)
    handleDisconnect(socket.id)
    if (binding) broadcastRoom(binding.code)
  })
})

setInterval(() => {
  for (const room of roomsNeedingTick()) {
    onPhaseTimeout(room)
    broadcastRoom(room.code)
  }
}, 250)

setInterval(() => {
  pruneIdleRooms()
}, 30_000)

if (isProd) {
  const dist = path.join(__dirname, '../client/dist')
  app.use(express.static(dist))
  app.get('/{*path}', (_req, res) => {
    res.sendFile(path.join(dist, 'index.html'))
  })
}

async function main() {
  const { backend } = await initPersist()
  const snap = await loadSnapshot()
  if (snap) {
    restorePasses(snap.passes)
    restoreRooms(snap.rooms as never)
    console.log(`Restored ${snap.passes.length} passes, ${snap.rooms.length} rooms`)
  }
  console.log(`Persist backend: ${backend ?? 'memory'}`)
  if (!backend) {
    console.warn(
      'WARNING: No REDIS_URL / data dir — rooms live only in memory and disappear on deploy/restart.',
    )
  }

  const adapterClients = await createRedisAdapterClients()
  if (adapterClients) {
    const { createAdapter } = await import('@socket.io/redis-adapter')
    io.adapter(createAdapter(adapterClients.pubClient, adapterClients.subClient))
    console.log('Socket.io Redis adapter enabled')
  }

  await subscribeRoomUpdates((code) => {
    void reloadRoomFromStore(code).then((room) => {
      if (room) broadcastRoom(code)
    })
  })

  httpServer.listen(PORT, () => {
    console.log(`Party Paths API on :${PORT}`)
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

process.on('SIGTERM', () => {
  void flushPersist().finally(() => process.exit(0))
})
