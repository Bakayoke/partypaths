import type { PathStep, GamePath } from '../types.js'

export const HOP_COUNT = 3
/** Non-host players required to start. Host presents on TV and does not count. */
export const MIN_PLAYERS = 2
export const MAX_EMOJIS = 8
export const EMOJI_SECONDS = 35
export const GUESS_SECONDS = 25
export const CORRECT_POINTS = 20
/** Points awarded to the last wrong guesser on a path, per funny vote. */
export const FUNNY_VOTE_POINTS = 10
export const EMPTY_GUESS = '?'

/** Never run a hop where guesser would face their own origin path (h === n-1). */
export function hopCountForPlayers(playerCount: number): number {
  if (playerCount < 2) return 1
  return Math.min(HOP_COUNT, playerCount - 1)
}

export function normalizeWord(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function wordsMatch(a: string, b: string): boolean {
  return normalizeWord(a) === normalizeWord(b) && normalizeWord(a).length > 0
}

/** Keep emoji-ish chars; strip most latin letters/digits for safety length. */
export function sanitizeEmojis(raw: string): string {
  const cleaned = [...raw]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0
      // Allow emoji ranges + common symbols / ZWJ / variation selectors
      if (code === 0x200d || code === 0xfe0f || code === 0x20e3) return true
      if (code >= 0x1f000 && code <= 0x1faff) return true
      if (code >= 0x2600 && code <= 0x27bf) return true
      if (code >= 0x1f300 && code <= 0x1f9ff) return true
      if (code >= 0xe0020 && code <= 0xe007f) return true
      if (ch === ' ' || ch === '\u00a0') return false
      // Allow a few punctuation used in emoji sequences
      return false
    })
    .join('')
    .replace(/\s+/g, '')
  // Cap by grapheme-ish chunks of code points (approx)
  const chars = [...cleaned]
  return chars.slice(0, MAX_EMOJIS * 8).join('').slice(0, 64)
}

export function shuffleInPlace<T>(arr: T[], rand: () => number = Math.random): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

export function dealWords(
  pack: string[],
  count: number,
  used: Set<string>,
  rand: () => number = Math.random,
): string[] {
  const available = pack.filter((w) => !used.has(normalizeWord(w)))
  if (available.length < count) {
    used.clear()
    available.length = 0
    available.push(...pack)
  }
  const pool = shuffleInPlace([...available], rand)
  const picked = pool.slice(0, count)
  for (const w of picked) used.add(normalizeWord(w))
  return picked
}

export function ringIndex(originIndex: number, offset: number, n: number): number {
  return ((originIndex + offset) % n + n) % n
}

export function authorIndexForHop(originIndex: number, hopIndex: number, n: number): number {
  return ringIndex(originIndex, hopIndex, n)
}

export function guesserIndexForHop(originIndex: number, hopIndex: number, n: number): number {
  return ringIndex(originIndex, hopIndex + 1, n)
}

export function meaningForHop(path: GamePath, hopIndex: number): string {
  if (hopIndex <= 0) return path.seedWord
  return path.steps[hopIndex - 1]?.guess || EMPTY_GUESS
}

export function scoreGuess(meaning: string, guess: string): boolean {
  if (!guess || normalizeWord(guess) === EMPTY_GUESS) return false
  return wordsMatch(meaning, guess)
}

export function applyCorrectPoints(
  scores: Record<string, number>,
  guesserId: string,
  correct: boolean,
  points = CORRECT_POINTS,
): void {
  if (!correct) return
  scores[guesserId] = (scores[guesserId] ?? 0) + points
}

/** Who "owned" the meaning that was just guessed — origin on hop 0, else previous guesser. */
export function victimForWrongGuess(path: GamePath, hopIndex: number): string {
  if (hopIndex <= 0) return path.originPlayerId
  return path.steps[hopIndex - 1]?.guesserId || path.originPlayerId
}

export function wrongStepContributors(path: GamePath): string[] {
  const ids = new Set<string>()
  for (const step of path.steps) {
    if (!step.correct && step.guesserId) ids.add(step.guesserId)
  }
  return [...ids]
}

/** The player who made the final wrong guess on this path (funniest fail recipient). */
export function lastWrongGuesser(path: GamePath): string | null {
  for (let i = path.steps.length - 1; i >= 0; i--) {
    const step = path.steps[i]
    if (!step.correct && step.guesserId) return step.guesserId
  }
  return null
}

export function tallyFunnyVotes(votes: Record<string, string>): string[] {
  const counts = new Map<string, number>()
  for (const pathId of Object.values(votes)) {
    if (!pathId) continue
    counts.set(pathId, (counts.get(pathId) ?? 0) + 1)
  }
  let best = 0
  for (const c of counts.values()) best = Math.max(best, c)
  if (best <= 0) return []
  return [...counts.entries()].filter(([, c]) => c === best).map(([id]) => id)
}

/**
 * Each vote awards points to the last wrong guesser on that path
 * (not the seed/origin author — the person who wrote the fail that stuck).
 */
export function applyFunnyVotePoints(
  scores: Record<string, number>,
  paths: GamePath[],
  votes: Record<string, string>,
  pointsPerVote = FUNNY_VOTE_POINTS,
): void {
  for (const pathId of Object.values(votes)) {
    if (!pathId) continue
    const path = paths.find((p) => p.id === pathId)
    if (!path) continue
    const recipient = lastWrongGuesser(path)
    if (!recipient) continue
    scores[recipient] = (scores[recipient] ?? 0) + pointsPerVote
  }
}

export function createEmptyStep(
  partial: Pick<PathStep, 'authorId' | 'meaning' | 'guesserId'>,
): PathStep {
  return {
    authorId: partial.authorId,
    meaning: partial.meaning,
    emojis: '',
    guesserId: partial.guesserId,
    guess: '',
    correct: false,
  }
}
