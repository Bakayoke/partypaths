export type Lang = 'sv' | 'en'
export type RoomStatus =
  | 'lobby'
  | 'emoji'
  | 'guess'
  | 'reveal'
  | 'funny_vote'
  | 'scoreboard'
  | 'finished'
export type PremiumTier = 'free' | 'party'

export type Player = {
  id: string
  name: string
  connected: boolean
  spectator?: boolean
}

export type PublicPathStep = {
  authorName: string
  meaning: string
  emojis: string
  guesserName: string
  guess: string
  correct: boolean
}

export type PublicPath = {
  id: string
  originPlayerId: string
  originName: string
  seedWord: string
  steps: PublicPathStep[]
}

export type PublicRoom = {
  code: string
  hostId: string
  players: Player[]
  language: Lang
  status: RoomStatus
  premiumTier: PremiumTier
  premiumExpiresAt: number | null
  limits: { maxPlayers: number; maxRounds: number; freePack: boolean }
  isPublic: boolean
  waitlist: { id: string; name: string; at: number }[]
  emojiSeconds: number
  guessSeconds: number
  phaseEndsAt: number
  roundIndex: number
  hopIndex: number
  hopCount: number
  submittedCount: number
  submitterCount: number
  submittedIds: string[]
  youSubmitted: boolean
  yourMeaning: string | null
  yourPromptEmojis: string | null
  yourGuessTargetPathId: string | null
  scores: { playerId: string; name: string; score: number }[]
  paths: PublicPath[] | null
  funnyVotes: Record<string, number> | null
  yourFunnyVote: string | null
  notice: string | null
  youAreSpectator: boolean
  youAreHost: boolean
  maxRounds: number
}

export type Session = {
  code: string
  playerId: string
  name: string
}
