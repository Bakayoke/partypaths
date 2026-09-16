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

export type RivalRuin = {
  ruinerId: string
  victimId: string
  pathId: string
  roundIndex: number
}

export type PartyPlayerStats = {
  correctGuesses: number
  wrongGuesses: number
  ruinsDealt: number
  ruinsSuffered: number
  funnyVotesReceived: number
  emojiChars: number
}

export type SeasonPlayerStats = {
  partiesPlayed: number
  totalScore: number
  wins: number
  ruinsDealt: number
  funnyVotesReceived: number
}

export type Award = {
  id: 'champion' | 'saboteur' | 'funniest' | 'savior' | 'poet' | 'rival'
  playerId: string
  labelSv: string
  labelEn: string
  detailSv?: string
  detailEn?: string
}

export type RivalStreakPublic = {
  ruinerId: string
  ruinerName: string
  victimId: string
  victimName: string
  count: number
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
  emojiSeconds: number
  guessSeconds: number
  phaseEndsAt: number
  roundIndex: number
  hopIndex: number
  hopCount: number
  paths: GamePath[]
  submissions: Record<string, string>
  scores: Record<string, number>
  funnyVotes: Record<string, string>
  nightPath: PublicPath | null
  nightPathVotes: number
  usedWords: string[]
  notice: RoomNotice | null
  updatedAt: number
  /** Wrong guesses / fails eligible as future seeds */
  callbackPool: string[]
  rivalRuins: RivalRuin[]
  partyStats: Record<string, PartyPlayerStats>
  /** Survives rematch within the same room */
  seasonStats: Record<string, SeasonPlayerStats>
  awards: Award[]
  doublePoints: boolean
  revengePlayerId: string | null
  revengeSeed: string | null
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
  yourMeaning: string | null
  yourPromptEmojis: string | null
  yourGuessTargetPathId: string | null
  scores: { playerId: string; name: string; score: number }[]
  paths: PublicPath[] | null
  funnyVotes: Record<string, number> | null
  nightPath: PublicPath | null
  nightPathVotes: number
  yourFunnyVote: string | null
  notice: string | null
  youAreSpectator: boolean
  youAreHost: boolean
  maxRounds: number
  doublePoints: boolean
  suddenDeath: boolean
  revengePlayerId: string | null
  revengeSeed: string | null
  youHaveRevenge: boolean
  awards: Award[]
  rivalStreaks: RivalStreakPublic[]
  seasonStats: {
    playerId: string
    name: string
    partiesPlayed: number
    totalScore: number
    wins: number
  }[]
}
