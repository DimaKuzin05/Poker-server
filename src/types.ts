export type Suit = 's' | 'h' | 'd' | 'c';
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';

export interface Card {
  rank: Rank;
  suit: Suit;
  code: string; // e.g. "As", "Kh"
}

export type TableStage = 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN';

export type Position = 'BTN' | 'CO' | 'MP' | 'UTG' | 'SB' | 'BB';

export interface Player {
  id: number;
  name: string;
  chips: number;
  cards: Card[];
  bet: number;
  folded: boolean;
  position: Position;
  isBot: boolean;
  isHero?: boolean;
}

export interface EquityResult {
  winRate: number;
  tieRate: number;
  lossRate: number;
  equity: number;
  simulations: number;
  handDistribution: Record<string, number>;
}

export interface HandRecord {
  id: number;
  gameId: number;
  timestamp: string;
  pot: number;
  boardCards: string[];
  winnerName: string;
  winnerHand: string;
  heroCards: string[];
  startingHand: string;
  position: Position;
  won: boolean;
  profit: number;
  equity: number;
}

export interface StartingHandStat {
  hand: string; // "AA", "AKs", "72o"
  row: string;
  col: string;
  samples: number;
  wins: number;
  winRate: number;
  profit: number;
  isSuited: boolean;
  isPair: boolean;
}

export interface PositionStat {
  position: Position;
  total: number;
  wins: number;
  winRate: number;
  profit: number;
}

export interface DetectedCard {
  code: string;
  rank: string;
  suit: string;
  suitSymbol: string;
  suitName: string;
  color: 'red' | 'black';
  confidence: number;
  bbox?: { x: number; y: number; width: number; height: number };
}
