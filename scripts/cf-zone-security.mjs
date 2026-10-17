#!/usr/bin/env node
/**
 * Configure Cloudflare Security Center findings for partypaths.com:
 * - security.txt (Security Center)
 * - AI Labyrinth (crawler_protection)
 *
 * Requires CLOUDFLARE_API_TOKEN with Zone Settings Write + Bot Management Write.
 */
const ZONE_NAME = 'partypaths.com'
const CONTACT = 'mailto:linus.stenvi@gmail.com'
const EXPIRES = '2027-12-31T00:00:00.000Z'
const CANONICAL = 'https://partypaths.com/.well-known/security.txt'

function authHeader() {
  const t = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN
  if (!t) {
    throw new Error(
      'Saknar CLOUDFLARE_API_TOKEN. Skapa en token med Zone Settings Write + Bot Management Write för partypaths.com, sedan: CLOUDFLARE_API_TOKEN=... npm run cf:security',
    )
  }
  return { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }
}

async function cf(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { ...authHeader(), ...(init.headers || {}) },
  })
  const body = await res.json()
  if (!body.success) {
    const msg = (body.errors || []).map((e) => e.message).join('; ') || res.statusText
    throw new Error(`${path} → ${msg}`)
  }
  return body.result
}

const zone = (await cf(`/zones?name=${encodeURIComponent(ZONE_NAME)}`))[0]
if (!zone) throw new Error(`Hittade inte zone ${ZONE_NAME}`)
console.log('zone', zone.id, zone.name)

await cf(`/zones/${zone.id}/security-center/securitytxt`, {
  method: 'PUT',
  body: JSON.stringify({
    enabled: true,
    contact: [CONTACT],
    expires: EXPIRES,
    canonical: [CANONICAL],
    preferred_languages: 'sv, en',
  }),
})
console.log('security.txt enabled')

const current = await cf(`/zones/${zone.id}/bot_management`)
console.log('bot_management before', {
  crawler_protection: current.crawler_protection,
  ai_bots_protection: current.ai_bots_protection,
  fight_mode: current.fight_mode,
})

const bot = await cf(`/zones/${zone.id}/bot_management`, {
  method: 'PUT',
  body: JSON.stringify({
    ...current,
    crawler_protection: 'enabled',
  }),
})
console.log('bot_management after', {
  crawler_protection: bot.crawler_protection,
  ai_bots_protection: bot.ai_bots_protection,
  fight_mode: bot.fight_mode,
})

console.log('Klar för', ZONE_NAME)
