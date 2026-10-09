import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getRedisUrl } from './persist.js'

export type DailyStat = { date: string; gamesStarted: number }

type StatsStore = {
  name: string
  incr(day: string): Promise<number>
  readAll(): Promise<Record<string, number>>
}

let store: StatsStore | null = null
let memory: Record<string, number> = {}
let saveTimer: ReturnType<typeof setTimeout> | null = null

/** Calendar day in Europe/Stockholm as YYYY-MM-DD */
export function stockholmDay(now = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now))
}

function memoryStore(): StatsStore {
  return {
    name: 'memory',
    async incr(day) {
      memory[day] = (memory[day] ?? 0) + 1
      return memory[day]!
    },
    async readAll() {
      return { ...memory }
    },
  }
}

function fileStore(dir: string): StatsStore {
  const file = path.join(dir, 'partypaths-stats.json')
  const flush = () => {
    if (saveTimer) return
    saveTimer = setTimeout(async () => {
      saveTimer = null
      try {
        await mkdir(dir, { recursive: true })
        await writeFile(file, JSON.stringify({ version: 1, days: memory }, null, 0), 'utf8')
      } catch (err) {
        console.error('Stats file save failed', err)
      }
    }, 300)
  }
  return {
    name: `file:${file}`,
    async incr(day) {
      memory[day] = (memory[day] ?? 0) + 1
      flush()
      return memory[day]!
    },
    async readAll() {
      return { ...memory }
    },
  }
}

async function redisStore(url: string): Promise<StatsStore> {
  const { createClient } = await import('redis')
  const client = createClient({
    url,
    socket: {
      reconnectStrategy: (retries) => Math.min(retries * 200, 3000),
    },
  })
  client.on('error', (err) => console.error('Stats redis error', err))
  await client.connect()
  const key = 'partypaths:stats:daily'
  return {
    name: 'redis',
    async incr(day) {
      return Number(await client.hIncrBy(key, day, 1))
    },
    async readAll() {
      const raw = await client.hGetAll(key)
      const out: Record<string, number> = {}
      for (const [d, v] of Object.entries(raw)) out[d] = Number(v) || 0
      return out
    },
  }
}

async function resolveDataDir(): Promise<string | null> {
  const fromEnv = process.env.PARTYPATHS_DATA_DIR?.trim()
  if (fromEnv) return fromEnv
  try {
    const { access } = await import('node:fs/promises')
    await access('/data')
    return '/data'
  } catch {
    return null
  }
}

export async function initStats() {
  const redisUrl = getRedisUrl()
  if (redisUrl) {
    try {
      store = await redisStore(redisUrl)
    } catch (err) {
      console.error('Stats redis init failed', err)
      store = null
    }
  }
  if (!store) {
    const dir = await resolveDataDir()
    if (dir) {
      const file = path.join(dir, 'partypaths-stats.json')
      try {
        const raw = await readFile(file, 'utf8')
        const parsed = JSON.parse(raw) as { days?: Record<string, number> }
        memory = parsed.days ?? {}
      } catch {
        memory = {}
      }
      store = fileStore(dir)
    }
  }
  if (!store) store = memoryStore()
  return { configured: store.name !== 'memory', name: store.name }
}

export async function recordGameStart() {
  if (!store) store = memoryStore()
  const day = stockholmDay()
  try {
    return await store.incr(day)
  } catch (err) {
    console.error('recordGameStart failed', err)
    memory[day] = (memory[day] ?? 0) + 1
    return memory[day]!
  }
}

export async function getStatsSnapshot() {
  if (!store) store = memoryStore()
  let days: Record<string, number> = {}
  try {
    days = await store.readAll()
  } catch (err) {
    console.error('getStatsSnapshot failed', err)
    days = { ...memory }
  }
  const list: DailyStat[] = Object.entries(days)
    .map(([date, gamesStarted]) => ({ date, gamesStarted }))
    .sort((a, b) => b.date.localeCompare(a.date))
  const total = list.reduce((s, d) => s + d.gamesStarted, 0)
  const today = stockholmDay()
  return {
    timezone: 'Europe/Stockholm',
    today,
    todayGames: days[today] ?? 0,
    totalGames: total,
    days: list,
    backend: store.name,
  }
}

export function adminTokenOk(token: string | undefined | null) {
  const expected = process.env.ADMIN_STATS_TOKEN?.trim()
  if (!expected || !token) return false
  return token === expected
}

export function renderStatsHtml(snap: Awaited<ReturnType<typeof getStatsSnapshot>>) {
  const rows = snap.days
    .map(
      (d) =>
        `<tr><td>${escapeHtml(d.date)}</td><td style="text-align:right">${d.gamesStarted}</td></tr>`,
    )
    .join('')
  return `<!doctype html>
<html lang="sv">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Party Paths · Admin stats</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; padding: 2rem; background: #12182a; color: #f7f3ea; }
    h1 { font-size: 1.4rem; margin: 0 0 0.35rem; }
    .muted { color: #a8b4d0; font-size: 0.9rem; }
    .cards { display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 1.25rem 0; }
    .card { background: #1a2340; border: 1px solid rgba(168,180,208,.18); border-radius: 14px; padding: 1rem 1.2rem; min-width: 140px; }
    .card strong { display: block; font-size: 1.8rem; color: #ffd166; }
    table { width: 100%; max-width: 420px; border-collapse: collapse; }
    th, td { padding: 0.45rem 0.35rem; border-bottom: 1px solid rgba(168,180,208,.12); }
    th { text-align: left; color: #a8b4d0; font-weight: 600; font-size: 0.8rem; }
  </style>
</head>
<body>
  <h1>Party Paths · startade spel</h1>
  <p class="muted">${escapeHtml(snap.timezone)} · backend ${escapeHtml(snap.backend)}</p>
  <div class="cards">
    <div class="card"><span class="muted">Idag</span><strong>${snap.todayGames}</strong></div>
    <div class="card"><span class="muted">Totalt</span><strong>${snap.totalGames}</strong></div>
  </div>
  <table>
    <thead><tr><th>Datum</th><th style="text-align:right">Spel</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="2" class="muted">Inga starter ännu</td></tr>'}</tbody>
  </table>
</body>
</html>`
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
