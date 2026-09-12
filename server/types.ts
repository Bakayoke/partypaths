export type Lang = 'sv' | 'en'

export type PremiumTier = 'free' | 'party'

export type PremiumLimits = {
  /** 0 = unlimited */
  maxPlayers: number
  /** Max rounds per party session */
  maxRounds: number
  /** Use smaller word pack when true */
  freePack: boolean
}

export type Player = {
  id: string
  name: string
  connected: boolean
  /** Mid-game joiners watch until next lobby */
  spectator?: boolean
}

export type RoomNotice = {
  kind: 'host_transfer'
  hostName: string
  at: number
}

export type RoomStatus =
  | 'lobby'
  | 'emoji'
  | 'guess'
  | 'reveal'
  | 'funny_vote'
  | 'scoreboard'
  | 'finished'

export type PathStep = {
  authorId: string
  meaning: string
  emojis: string
  guesserId: string
  guess: string
  correct: boolean
}

export type GamePath = {
  id: string
  originPlayerId: string
  seedWord: string
  steps: PathStep[]
}

export type Room = {
  code: string
  hostId: string
  players: Player[]
  language: Lang
  status: RoomStatus
  premiumExpiresAt: number | null
  isPublic: boolean
  waitlist: { id: string; name: string; at: number }[]
  /** Emoji phase seconds */
  emojiSeconds: number
  /** Guess phase seconds */
  guessSeconds: number
  phaseEndsAt: number
  roundIndex: number
  hopIndex: number
  hopCount: number
  paths: GamePath[]
  /** playerId -> emojis or guess for current phase */
  submissions: Record<string, string>
  scores: Record<string, number>
  funnyVotes: Record<string, string>
  /** Funniest path snapshot across the party (most votes in any round). */
  nightPath: PublicPath | null
  nightPathVotes: number
  usedWords: string[]
  notice: RoomNotice | null
  updatedAt: number
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
  limits: PremiumLimits
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
  /** Secret word / current meaning for emoji phase */
  yourMeaning: string | null
  /** Emojis to interpret in guess phase */
  yourPromptEmojis: string | null
  yourGuessTargetPathId: string | null
  scores: { playerId: string; name: string; score: number }[]
  paths: PublicPath[] | null
  funnyVotes: Record<string, number> | null
  /** Path with the most funny votes across the whole party. */
  nightPath: PublicPath | null
  nightPathVotes: number
  yourFunnyVote: string | null
  notice: string | null
  youAreSpectator: boolean
  youAreHost: boolean
  maxRounds: number
}
