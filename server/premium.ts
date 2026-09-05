import type { PremiumLimits, PremiumTier } from './types.js'

/** All games are free — unlimited players, full pack, generous round cap. */
export const FREE_LIMITS: PremiumLimits = {
  maxPlayers: 0,
  maxRounds: 12,
  freePack: false,
}

/** @deprecated Kept as alias so older call sites keep compiling. */
export const PARTY_LIMITS = FREE_LIMITS

export type PartyPlan = 'day' | 'week'

export type PartyPass = {
  token: string
  tier: 'party'
  expiresAt: number
  plan?: PartyPlan
}

const passes = new Map<string, PartyPass>()
let onPersist: (() => void) | null = null

export function setPassPersistHook(fn: (() => void) | null) {
  onPersist = fn
}

function touchPasses() {
  onPersist?.()
}

/** Always the free/unlimited limits — payments removed. */
export function limitsFor(_tier?: PremiumTier): PremiumLimits {
  return FREE_LIMITS
}

export function isPartyActive(_expiresAt?: number | null): boolean {
  return true
}

/** Always "party" so public lobbies and full features stay unlocked. */
export function tierFromExpiry(_expiresAt?: number | null): PremiumTier {
  return 'party'
}

export function issuePartyPass(plan: PartyPlan = 'day'): PartyPass {
  const pass: PartyPass = {
    token: crypto.randomUUID(),
    tier: 'party',
    expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    plan,
  }
  passes.set(pass.token, pass)
  touchPasses()
  return pass
}

export function restorePasses(list: PartyPass[]) {
  const now = Date.now()
  for (const pass of list) {
    if (!pass?.token || !pass.expiresAt || pass.expiresAt <= now) continue
    passes.set(pass.token, pass)
  }
}

export function allPasses() {
  return passes
}

export function redeemPassCode(_code: string): PartyPass | { error: string } {
  return issuePartyPass()
}

export function lookupPass(token: string | null | undefined): PartyPass | null {
  if (!token) return null
  const pass = passes.get(token)
  if (!pass) return null
  if (pass.expiresAt <= Date.now()) {
    passes.delete(token)
    touchPasses()
    return null
  }
  return pass
}
