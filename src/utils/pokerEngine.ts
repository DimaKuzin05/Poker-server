import { Card, Rank, Suit, EquityResult, StartingHandStat, HandRecord, Position } from '../types';

export const RANKS: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUITS: Suit[] = ['s', 'h', 'd', 'c'];

export const SUIT_SYMBOLS: Record<Suit, string> = {
  s: '♠',
  h: '♥',
  d: '♦',
  c: '♣',
};

export const SUIT_COLORS: Record<Suit, string> = {
  s: 'text-slate-900',
  h: 'text-rose-600',
  d: 'text-blue-600',
  c: 'text-emerald-700',
};

export const RANK_VALUES: Record<Rank, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
};

export const HAND_NAMES = [
  'Старшая карта',
  'Пара',
  'Две пары',
  'Сет (Тройка)',
  'Стрит',
  'Флеш',
  'Фулл-хаус',
  'Каре',
  'Стрит-флеш',
  'Роял-флеш'
];

export function parseCard(cardStr: string): Card {
  const clean = cardStr.trim();
  let r: Rank;
  let s: Suit;
  if (clean.length === 2) {
    r = clean[0].toUpperCase() as Rank;
    s = clean[1].toLowerCase() as Suit;
  } else if (clean.length === 3 && clean.startsWith('10')) {
    r = 'T';
    s = clean[2].toLowerCase() as Suit;
  } else {
    r = 'A';
    s = 's';
  }
  return { rank: r, suit: s, code: `${r}${s}` };
}

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const r of RANKS) {
    for (const s of SUITS) {
      deck.push({ rank: r, suit: s, code: `${r}${s}` });
    }
  }
  return deck;
}

export function shuffleDeck(deck: Card[]): Card[] {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function getStartingHandCode(c1: Card, c2: Card): string {
  const v1 = RANK_VALUES[c1.rank];
  const v2 = RANK_VALUES[c2.rank];
  const [high, low] = v1 >= v2 ? [c1, c2] : [c2, c1];
  
  if (high.rank === low.rank) {
    return `${high.rank}${low.rank}`;
  }
  const suited = high.suit === low.suit ? 's' : 'o';
  return `${high.rank}${low.rank}${suited}`;
}

// 5-карточный оценщик комбинаций
function evaluate5(cards: Card[]): { score: number; kickers: number[] } {
  const vals = cards.map(c => RANK_VALUES[c.rank]).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);

  // Проверка на стрит
  const uniqueVals = Array.from(new Set(vals));
  let isStraight = false;
  let straightHigh = 0;
  if (uniqueVals.length === 5) {
    if (uniqueVals[0] - uniqueVals[4] === 4) {
      isStraight = true;
      straightHigh = uniqueVals[0];
    } else if (
      uniqueVals[0] === 14 &&
      uniqueVals[1] === 5 &&
      uniqueVals[2] === 4 &&
      uniqueVals[3] === 3 &&
      uniqueVals[4] === 2
    ) {
      isStraight = true;
      straightHigh = 5;
    }
  }

  // Подсчет частотности
  const counts: Record<number, number> = {};
  for (const v of vals) counts[v] = (counts[v] || 0) + 1;
  const byCount = Object.entries(counts)
    .map(([v, count]) => ({ val: Number(v), count }))
    .sort((a, b) => b.count - a.count || b.val - a.val);

  const pattern = byCount.map(b => b.count);
  const orderedVals = byCount.map(b => b.val);

  if (isFlush && isStraight) {
    if (straightHigh === 14) return { score: 9, kickers: [14] }; // Royal flush
    return { score: 8, kickers: [straightHigh] }; // Straight flush
  }
  if (pattern[0] === 4) return { score: 7, kickers: orderedVals }; // Quads
  if (pattern[0] === 3 && pattern[1] === 2) return { score: 6, kickers: orderedVals }; // Full house
  if (isFlush) return { score: 5, kickers: vals }; // Flush
  if (isStraight) return { score: 4, kickers: [straightHigh] }; // Straight
  if (pattern[0] === 3) return { score: 3, kickers: orderedVals }; // Trips
  if (pattern[0] === 2 && pattern[1] === 2) return { score: 2, kickers: orderedVals }; // Two pair
  if (pattern[0] === 2) return { score: 1, kickers: orderedVals }; // Pair
  return { score: 0, kickers: vals }; // High card
}

// Перебор всех сочетаний 5 из N
function combinations5(cards: Card[]): Card[][] {
  const result: Card[][] = [];
  const n = cards.length;
  for (let a = 0; a < n - 4; a++) {
    for (let b = a + 1; b < n - 3; b++) {
      for (let c = b + 1; c < n - 2; c++) {
        for (let d = c + 1; d < n - 1; d++) {
          for (let e = d + 1; e < n; e++) {
            result.push([cards[a], cards[b], cards[c], cards[d], cards[e]]);
          }
        }
      }
    }
  }
  return result;
}

export function evaluateHand(cards: Card[]): { score: number; kickers: number[]; name: string } {
  if (cards.length < 5) {
    return { score: 0, kickers: [], name: 'Ожидание флопа' };
  }
  const combos = combinations5(cards);
  let best = { score: -1, kickers: [] as number[] };

  for (const combo of combos) {
    const evalResult = evaluate5(combo);
    if (evalResult.score > best.score) {
      best = evalResult;
    } else if (evalResult.score === best.score) {
      // Сравнение кикеров
      for (let i = 0; i < evalResult.kickers.length; i++) {
        if (evalResult.kickers[i] > (best.kickers[i] || 0)) {
          best = evalResult;
          break;
        } else if (evalResult.kickers[i] < (best.kickers[i] || 0)) {
          break;
        }
      }
    }
  }

  return {
    score: best.score,
    kickers: best.kickers,
    name: HAND_NAMES[best.score] || 'Неизвестно'
  };
}

function compareHands(h1: { score: number; kickers: number[] }, h2: { score: number; kickers: number[] }): number {
  if (h1.score !== h2.score) return h1.score - h2.score;
  for (let i = 0; i < Math.max(h1.kickers.length, h2.kickers.length); i++) {
    const k1 = h1.kickers[i] || 0;
    const k2 = h2.kickers[i] || 0;
    if (k1 !== k2) return k1 - k2;
  }
  return 0;
}

// Монте-Карло расчет вероятности победы (Equity)
export function calculateEquityFast(
  heroCards: Card[],
  boardCards: Card[],
  numOpponents: number = 1,
  simulations: number = 1000
): EquityResult {
  const knownCodes = new Set([...heroCards, ...boardCards].map(c => c.code));
  const fullDeck = createDeck().filter(c => !knownCodes.has(c.code));

  let wins = 0;
  let ties = 0;
  let losses = 0;
  const neededBoard = Math.max(0, 5 - boardCards.length);
  const neededPerSim = neededBoard + numOpponents * 2;

  const handCounts: Record<string, number> = {};
  for (const name of HAND_NAMES) handCounts[name] = 0;

  for (let s = 0; s < simulations; s++) {
    // Выборка без повторений
    const sample: Card[] = [];
    const available = [...fullDeck];
    for (let i = 0; i < neededPerSim; i++) {
      const idx = Math.floor(Math.random() * available.length);
      sample.push(available[idx]);
      available.splice(idx, 1);
    }

    const simBoard = [...boardCards, ...sample.slice(0, neededBoard)];
    const heroEval = evaluateHand([...heroCards, ...simBoard]);
    handCounts[heroEval.name] = (handCounts[heroEval.name] || 0) + 1;

    let oppBest = { score: -1, kickers: [] as number[] };
    let offset = neededBoard;
    for (let op = 0; op < numOpponents; op++) {
      const oppCards = sample.slice(offset, offset + 2);
      offset += 2;
      const oppEval = evaluateHand([...oppCards, ...simBoard]);
      if (compareHands(oppEval, oppBest) > 0) {
        oppBest = oppEval;
      }
    }

    const diff = compareHands(heroEval, oppBest);
    if (diff > 0) wins++;
    else if (diff === 0) ties++;
    else losses++;
  }

  const winRate = Number(((wins / simulations) * 100).toFixed(1));
  const tieRate = Number(((ties / simulations) * 100).toFixed(1));
  const lossRate = Number(((losses / simulations) * 100).toFixed(1));
  const equity = Number((winRate + tieRate / (numOpponents + 1)).toFixed(1));

  const handDistribution: Record<string, number> = {};
  for (const [name, count] of Object.entries(handCounts)) {
    if (count > 0) {
      handDistribution[name] = Number(((count / simulations) * 100).toFixed(1));
    }
  }

  return {
    winRate,
    tieRate,
    lossRate,
    equity,
    simulations,
    handDistribution
  };
}

// Генерация начальных 100 раздач для реалистичной статистики
export function generateInitialHistory(): HandRecord[] {
  const positions: Position[] = ['BTN', 'CO', 'MP', 'UTG', 'SB', 'BB'];
  const players = ['Hero (Вы)', 'Bot_Alex', 'Bot_Elena', 'Bot_Max'];
  const history: HandRecord[] = [];
  const deck = createDeck();

  for (let g = 1; g <= 75; g++) {
    const shuffled = shuffleDeck(deck);
    const board = shuffled.slice(0, 5);
    const heroCards = [shuffled[5], shuffled[6]];
    const pos = positions[g % positions.length];
    const cat = getStartingHandCode(heroCards[0], heroCards[1]);

    const opp1 = [shuffled[7], shuffled[8]];
    const opp2 = [shuffled[9], shuffled[10]];
    const opp3 = [shuffled[11], shuffled[12]];

    const heroEval = evaluateHand([...heroCards, ...board]);
    const opp1Eval = evaluateHand([...opp1, ...board]);
    const opp2Eval = evaluateHand([...opp2, ...board]);
    const opp3Eval = evaluateHand([...opp3, ...board]);

    let maxOpp = opp1Eval;
    let winner = 'Bot_Alex';
    if (compareHands(opp2Eval, maxOpp) > 0) { maxOpp = opp2Eval; winner = 'Bot_Elena'; }
    if (compareHands(opp3Eval, maxOpp) > 0) { maxOpp = opp3Eval; winner = 'Bot_Max'; }

    const heroWins = compareHands(heroEval, maxOpp) > 0;
    const finalWinner = heroWins ? 'Hero (Вы)' : winner;
    const finalHand = heroWins ? heroEval.name : maxOpp.name;
    const pot = 40 + Math.floor(Math.random() * 320);
    const profit = heroWins ? pot - 40 : -40;

    history.push({
      id: g,
      gameId: 1000 + g,
      timestamp: new Date(Date.now() - (75 - g) * 60000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      pot,
      boardCards: board.map(c => c.code),
      winnerName: finalWinner,
      winnerHand: finalHand,
      heroCards: heroCards.map(c => c.code),
      startingHand: cat,
      position: pos,
      won: heroWins,
      profit,
      equity: heroWins ? 68.4 : 32.1
    });
  }

  return history.reverse();
}

// 13x13 Стартовая матрица рук для тепловой карты
export function compute13x13Matrix(history: HandRecord[]): StartingHandStat[][] {
  const displayRanks = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
  const handMap = new Map<string, { samples: number; wins: number; profit: number }>();

  // Подсчитываем реальные раздачи
  for (const h of history) {
    const cur = handMap.get(h.startingHand) || { samples: 0, wins: 0, profit: 0 };
    cur.samples++;
    if (h.won) cur.wins++;
    cur.profit += h.profit;
    handMap.set(h.startingHand, cur);
  }

  const matrix: StartingHandStat[][] = [];

  for (let i = 0; i < 13; i++) {
    const row: StartingHandStat[] = [];
    const r1 = displayRanks[i];
    for (let j = 0; j < 13; j++) {
      const r2 = displayRanks[j];
      let code: string;
      let isPair = false;
      let isSuited = false;

      if (i === j) {
        code = `${r1}${r2}`;
        isPair = true;
      } else if (i < j) {
        code = `${r1}${r2}s`;
        isSuited = true;
      } else {
        code = `${r2}${r1}o`;
      }

      const stat = handMap.get(code);
      let samples = stat ? stat.samples : 0;
      let wins = stat ? stat.wins : 0;
      let profit = stat ? stat.profit : 0;

      // Базовые теоретические коэффициенты выигрыша для тепловой карты если мало сэмплов
      const baseExpected = isPair
        ? 55 + (14 - i) * 2.3
        : isSuited
          ? 40 + (14 - i) * 1.5 + (14 - j) * 1.0
          : 30 + (14 - j) * 1.3 + (14 - i) * 0.8;

      const winRate = samples > 0 ? Number(((wins / samples) * 100).toFixed(1)) : Number(baseExpected.toFixed(1));

      row.push({
        hand: code,
        row: r1,
        col: r2,
        samples,
        wins,
        winRate,
        profit,
        isSuited,
        isPair
      });
    }
    matrix.push(row);
  }

  return matrix;
}
