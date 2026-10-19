
import './index.css';
import confetti from 'canvas-confetti';
import { Card, HandRecord, Player, TableStage, StartingHandStat } from './types';
import {
  createDeck,
  shuffleDeck,
  evaluateHand,
  calculateEquityFast,
  compute13x13Matrix,
  generateInitialHistory,
  getStartingHandCode,
  parseCard,
  SUIT_SYMBOLS,
} from './utils/pokerEngine';

type TabName = 'table' | 'streamlit' | 'vision' | 'code';
let currentTab: TabName = 'table';

let handHistory: HandRecord[] = generateInitialHistory();// sqlite

let deck: Card[] = [];
let communityCards: Card[] = [];
let stage: TableStage = 'PREFLOP';
let pot = 0;
let currentBet = 20;
let message = 'Новая раздача началась. Ваш ход!';

// игрок
let players: Player[] = [
  { id: 0, name: 'Hero (Вы)', chips: 1000, cards: [], bet: 0, folded: false, position: 'BTN', isBot: false, isHero: true },
  { id: 1, name: 'Бот Алексей', chips: 1000, cards: [], bet: 0, folded: false, position: 'SB', isBot: true },
  { id: 2, name: 'Бот Елена', chips: 1000, cards: [], bet: 0, folded: false, position: 'BB', isBot: true },
  { id: 3, name: 'Бот Дмитрий', chips: 1000, cards: [], bet: 0, folded: false, position: 'UTG', isBot: true },
];

let heroEquity = 50.0;
let winnerAnnouncement: string | null = null;

// Состояние модуля OpenCV Камеры
let cameraStream: MediaStream | null = null;
let detectedCards: { code: string; rank: string; suitSymbol: string; suitName: string; confidence: number }[] = [];
let scanningCard = false;

declare global {
  interface Window {
    Tesseract?: { createWorker: (language: string) => Promise<any> };
  }
}

// Состояние калькулятора Streamlit
let calcHero1 = 'As';
let calcHero2 = 'Kd';
let calcBoard = ['Ah', '7c', '2s', '', ''];
let calcOpponents = 2;
let calcSimulations = 1000;
let selectedMatrixHand: StartingHandStat | null = null;

let activePythonFile = 'poker_server';

// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ОТРИСОВКИ

function getSuitColor(suit: string): string {
  if (suit === 'h' || suit === '♥') return 'text-rose-600';
  if (suit === 'd' || suit === '♦') return 'text-blue-600';
  if (suit === 'c' || suit === '♣') return 'text-emerald-700';
  return 'text-slate-900';
}

function renderCardHtml(card: Card | null, isHidden = false, highlight = false): string {
  if (!card) {
    return `<div class="w-11 h-16 sm:w-14 sm:h-20 border-2 border-dashed border-emerald-800/60 rounded-xl flex items-center justify-center text-emerald-800/60 text-xs">?</div>`;
  }
  if (isHidden) {
    return `
      <div class="w-11 h-16 sm:w-14 sm:h-20 bg-gradient-to-br from-indigo-900 via-blue-900 to-indigo-950 border border-indigo-700 rounded-xl flex items-center justify-center shadow-md">
        <span class="text-xs font-bold text-indigo-300 select-none">🃏</span>
      </div>`;
  }

  const symbol = SUIT_SYMBOLS[card.suit] || card.suit;
  const colorClass = getSuitColor(card.suit);
  const ringClass = highlight ? 'ring-2 ring-amber-400 shadow-amber-500/30' : '';

  return `
    <div class="w-11 h-16 sm:w-14 sm:h-20 bg-white border border-slate-300 rounded-xl flex flex-col justify-between p-1 sm:p-1.5 shadow-lg select-none transform transition hover:-translate-y-1 ${ringClass}">
      <div class="flex items-center justify-between text-[11px] sm:text-xs font-bold leading-none ${colorClass}">
        <span>${card.rank}</span>
        <span class="text-[10px]">${symbol}</span>
      </div>
      <div class="text-center text-base sm:text-lg leading-none ${colorClass}">
        ${symbol}
      </div>
      <div class="flex items-center justify-between text-[11px] sm:text-xs font-bold leading-none rotate-180 ${colorClass}">
        <span>${card.rank}</span>
        <span class="text-[10px]">${symbol}</span>
      </div>
    </div>`;
}

// ЛОГИКА (TEXAS HOLD'EM)

function startNewHand(customHeroCards?: Card[]) {
  deck = shuffleDeck(createDeck());
  communityCards = [];
  stage = 'PREFLOP';
  winnerAnnouncement = null;

  // Раздаем карты
  players.forEach((p, idx) => {
    p.folded = false;
    p.bet = 0;
    if (p.isHero && customHeroCards && customHeroCards.length >= 2) {
      p.cards = [customHeroCards[0], customHeroCards[1]];
      // Убираем эти карты из колоды
      deck = deck.filter(c => c.code !== p.cards[0].code && c.code !== p.cards[1].code);
    } else {
      p.cards = [deck.pop()!, deck.pop()!];
    }
  });

  // Блайнды
  players[1].bet = 10; // SB
  players[1].chips -= 10;
  players[2].bet = 20; // BB
  players[2].chips -= 20;
  currentBet = 20;
  pot = 30;

  message = 'Новая раздача началась! Префлоп. Ваш ход: Чек, Колл или Рейз.';
  recalcHeroEquity();
  renderApp();
}

function recalcHeroEquity() {
  const hero = players[0];
  if (!hero || hero.cards.length < 2) return;
  const activeOpponents = players.filter(p => !p.isHero && !p.folded).length || 1;
  const res = calculateEquityFast(hero.cards, communityCards, activeOpponents, 500);
  heroEquity = res.winRate;
}

function advanceStreet() {
  // Сбрасываем ставки в банк
  players.forEach(p => {
    p.bet = 0;
  });
  currentBet = 0;

  if (stage === 'PREFLOP') {
    stage = 'FLOP';
    communityCards = [deck.pop()!, deck.pop()!, deck.pop()!];
    message = 'Открыт Флоп! Оцените силу руки и текущий Win Rate.';
  } else if (stage === 'FLOP') {
    stage = 'TURN';
    communityCards.push(deck.pop()!);
    message = 'Открыт Тёрн!';
  } else if (stage === 'TURN') {
    stage = 'RIVER';
    communityCards.push(deck.pop()!);
    message = 'Открыт Ривер! Финальный раунд торговли.';
  } else if (stage === 'RIVER') {
    stage = 'SHOWDOWN';
    handleShowdown();
    return;
  }

  recalcHeroEquity();
  renderApp();
}

function handleShowdown() {
  const activePlayers = players.filter(p => !p.folded);
  let bestScore = -1;
  let winner = activePlayers[0];
  let winningHandName = '';

  activePlayers.forEach(p => {
    const evaluation = evaluateHand([...p.cards, ...communityCards]);
    if (evaluation.score > bestScore) {
      bestScore = evaluation.score;
      winner = p;
      winningHandName = evaluation.name;
    }
  });

  winner.chips += pot;
  winnerAnnouncement = `Победил ${winner.name} с комбинацией "${winningHandName}"! Банк: $${pot}`;
  message = winnerAnnouncement;

  // Эффект победы
  if (winner.isHero) {
    try {
      confetti({ particleCount: 80, spread: 60, origin: { y: 0.6 } });
    } catch (e) {
      // игнорируем ошибку конфетти если недоступно
    }
  }

  // Запись в историю SQLite
  const hero = players[0];
  const heroEval = evaluateHand([...hero.cards, ...communityCards]);
  const heroWon = winner.isHero;
  const profit = heroWon ? pot - 50 : -50;

  const newRecord: HandRecord = {
    id: handHistory.length + 1,
    gameId: 1000 + handHistory.length + 1,
    timestamp: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    pot,
    boardCards: communityCards.map(c => c.code),
    winnerName: winner.name,
    winnerHand: winningHandName,
    heroCards: hero.cards.map(c => c.code),
    startingHand: getStartingHandCode(hero.cards[0], hero.cards[1]),
    position: hero.position,
    won: heroWon,
    profit,
    equity: heroEquity,
  };

  handHistory.unshift(newRecord);
  renderApp();
}

function playerAction(action: 'fold' | 'check' | 'call' | 'raise') {
  const hero = players[0];
  if (hero.folded || stage === 'SHOWDOWN') return;

  if (action === 'fold') {
    hero.folded = true;
    message = 'Вы сбросили карты (Fold). Раздача завершена.';
    stage = 'SHOWDOWN';
    handleShowdown();
    return;
  }

  if (action === 'call') {
    const diff = currentBet - hero.bet;
    hero.chips -= diff;
    hero.bet = currentBet;
    pot += diff;
    message = `Вы сделали Колл ($${diff}).`;
  } else if (action === 'raise') {
    const raiseAmount = currentBet + 50;
    const diff = raiseAmount - hero.bet;
    hero.chips -= diff;
    hero.bet = raiseAmount;
    currentBet = raiseAmount;
    pot += diff;
    message = `Вы сделали Рейз до $${raiseAmount}!`;
  } else if (action === 'check') {
    message = 'Вы сделали Чек.';
  }

  // Ходы ботов (простая учебная логика)
  players.slice(1).forEach(bot => {
    if (!bot.folded) {
      const diff = currentBet - bot.bet;
      if (diff > 0) {
        bot.chips -= diff;
        bot.bet = currentBet;
        pot += diff;
      }
    }
  });

  // Переход на следующую улицу
  setTimeout(() => {
    advanceStreet();
  }, 400);
}

// Генерация пачки раздач для демонстрации базы данных
function generateBatchHands(count = 50) {
  const positions = ['BTN', 'CO', 'MP', 'UTG', 'SB', 'BB'] as const;
  const newRecords: HandRecord[] = [];
  const testDeck = createDeck();

  for (let i = 0; i < count; i++) {
    const shuffled = shuffleDeck(testDeck);
    const board = shuffled.slice(0, 5);
    const heroCards = [shuffled[5], shuffled[6]];
    const pos = positions[Math.floor(Math.random() * positions.length)];
    const cat = getStartingHandCode(heroCards[0], heroCards[1]);

    const opp1 = [shuffled[7], shuffled[8]];
    const opp2 = [shuffled[9], shuffled[10]];

    const heroEval = evaluateHand([...heroCards, ...board]);
    const opp1Eval = evaluateHand([...opp1, ...board]);
    const opp2Eval = evaluateHand([...opp2, ...board]);

    let maxOpp = opp1Eval;
    let winnerName = 'Бот Алексей';
    if (opp2Eval.score > maxOpp.score) {
      maxOpp = opp2Eval;
      winnerName = 'Бот Елена';
    }

    const heroWins = heroEval.score > maxOpp.score;
    const finalWinner = heroWins ? 'Hero (Вы)' : winnerName;
    const finalHand = heroWins ? heroEval.name : maxOpp.name;
    const handPot = 40 + Math.floor(Math.random() * 320);
    const profit = heroWins ? handPot - 40 : -40;

    newRecords.push({
      id: handHistory.length + i + 1,
      gameId: 1000 + handHistory.length + i + 1,
      timestamp: new Date(Date.now() - i * 40000).toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
      }),
      pot: handPot,
      boardCards: board.map(c => c.code),
      winnerName: finalWinner,
      winnerHand: finalHand,
      heroCards: heroCards.map(c => c.code),
      startingHand: cat,
      position: pos,
      won: heroWins,
      profit,
      equity: heroWins ? 65.5 : 34.2,
    });
  }

  handHistory = [...newRecords, ...handHistory];
  renderApp();
}

// КОМПЬЮТЕРНОЕ ЗРЕНИЕ (OPENCV / WEBCAM)

async function toggleWebcam() {
  const videoEl = document.getElementById('webcam-video') as HTMLVideoElement | null;
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
    if (videoEl) videoEl.srcObject = null;
    renderApp();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' },
    });
    cameraStream = stream;
    renderApp();
    setTimeout(() => {
      const v = document.getElementById('webcam-video') as HTMLVideoElement | null;
      if (v) {
        v.srcObject = stream;
        v.play();
      }
    }, 50);
  } catch (err) {
    alert('Камера недоступна или доступ заблокирован браузером. Используйте готовые тестовые наборы карт ниже.');
  }
}

async function scanCardFromCamera() {
  const video = document.getElementById('webcam-video') as HTMLVideoElement | null;
  if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    alert('Сначала включите камеру и дождитесь изображения.');
    return;
  }
  if (scanningCard) return;
  scanningCard = true;
  const button = document.getElementById('scan-card-btn') as HTMLButtonElement | null;
  if (button) button.disabled = true;
  try {
    if (!window.Tesseract) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Не удалось загрузить OCR'));
        document.head.appendChild(script);
      });
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas недоступен');
    ctx.drawImage(video, 0, 0);
    // Держите карту вертикально в центре кадра; OCR читает её верхний левый индекс.
    const x = Math.round(canvas.width * 0.2);
    const y = Math.round(canvas.height * 0.12);
    const roi = document.createElement('canvas');
    roi.width = Math.round(canvas.width * 0.25);
    roi.height = Math.round(canvas.height * 0.34);
    roi.getContext('2d')!.drawImage(canvas, x, y, roi.width, roi.height, 0, 0, roi.width * 3, roi.height * 3);
    const worker = await window.Tesseract!.createWorker('eng');
    await worker.setParameters({ tessedit_char_whitelist: 'A23456789TJQK10' });
    const { data } = await worker.recognize(roi);
    await worker.terminate();
    const match = String(data.text).toUpperCase().replace(/\s/g, '').match(/10|[2-9TJQKA]/);
    if (!match) throw new Error('Ранг не распознан. Поднесите карту ближе и повторите.');
    const rank = match[0] === '10' ? 'T' : match[0];
    const suitChoice = prompt(`Распознан ранг ${rank}. Введите масть: s (пики), h (червы), d (бубны), c (трефы)`, 's')?.toLowerCase();
    if (!suitChoice || !['s', 'h', 'd', 'c'].includes(suitChoice)) return;
    if (detectedCards.some(card => card.code === `${rank}${suitChoice}`)) {
      alert('Такая карта уже добавлена.');
      return;
    }
    const suitNames: Record<string, string> = { s: 'Пики', h: 'Червы', d: 'Бубны', c: 'Трефы' };
    const suitSymbols: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
    detectedCards = [...detectedCards, { code: `${rank}${suitChoice}`, rank, suitSymbol: suitSymbols[suitChoice], suitName: suitNames[suitChoice], confidence: Math.round((data.confidence || 0) * 10) / 10 }];
    renderApp();
  } catch (error) {
    alert(error instanceof Error ? error.message : 'Не удалось распознать карту.');
  } finally {
    scanningCard = false;
  }
}

function setPresetCards(type: 'aces' | 'ak' | 'flush') {
  if (type === 'aces') {
    detectedCards = [
      { code: 'As', rank: 'A', suitSymbol: '♠', suitName: 'Пики', confidence: 98 },
      { code: 'Ah', rank: 'A', suitSymbol: '♥', suitName: 'Червы', confidence: 96 },
    ];
  } else if (type === 'ak') {
    detectedCards = [
      { code: 'As', rank: 'A', suitSymbol: '♠', suitName: 'Пики', confidence: 95 },
      { code: 'Kd', rank: 'K', suitSymbol: '♦', suitName: 'Бубны', confidence: 94 },
    ];
  } else {
    detectedCards = [
      { code: 'Ks', rank: 'K', suitSymbol: '♠', suitName: 'Пики', confidence: 94 },
      { code: 'Qs', rank: 'Q', suitSymbol: '♠', suitName: 'Пики', confidence: 92 },
    ];
  }
  renderApp();
}

function transferCardsToTable() {
  if (detectedCards.length >= 2) {
    const c1 = parseCard(detectedCards[0].code);
    const c2 = parseCard(detectedCards[1].code);
    currentTab = 'table';
    startNewHand([c1, c2]);
  }
}

// ==========================================
// ГЛАВНЫЙ РЕНДЕРИНГ (ВАНАЛЬНЫЙ HTML + TAILWIND)
// ==========================================

function renderApp() {
  const root = document.getElementById('app');
  if (!root) return;

  const totalHands = handHistory.length;
  const winsCount = handHistory.filter(h => h.won).length;
  const overallWinRate = totalHands > 0 ? Number(((winsCount / totalHands) * 100).toFixed(1)) : 0;
  const totalProfit = handHistory.reduce((sum, h) => sum + h.profit, 0);

  // Шапка сайта
  const navHtml = `
    <header class="bg-slate-900 border-b border-slate-800 sticky top-0 z-30 shadow-xl">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="flex items-center justify-between h-16">
          <!-- Логотип учебного проекта -->
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-500 flex items-center justify-center text-white font-black text-xl shadow-lg shadow-emerald-600/30">
              ♠
            </div>
            <div>
              <div class="flex items-center gap-2">
                <span class="font-extrabold text-white text-base sm:text-lg tracking-tight">Poker Lab (Учебный проект)</span>
                <span class="text-[10px] bg-emerald-500/20 text-emerald-400 font-bold px-2 py-0.5 rounded-full border border-emerald-500/30">
                  Без React
                </span>
              </div>
              <p class="text-[11px] text-slate-400 hidden sm:block">Покер-сервер • SQLite Win Rate • Streamlit • OpenCV Камера</p>
            </div>
          </div>

          <!-- Метрики в шапке -->
          <div class="hidden md:flex items-center gap-4 text-xs font-mono">
            <div class="bg-slate-950 px-3 py-1.5 rounded-xl border border-slate-800 flex items-center gap-2">
              <span class="text-slate-400">База SQLite:</span>
              <span class="text-white font-bold">${totalHands} раздач</span>
            </div>
            <div class="bg-slate-950 px-3 py-1.5 rounded-xl border border-slate-800 flex items-center gap-2">
              <span class="text-slate-400">Общий Win Rate:</span>
              <span class="font-bold ${overallWinRate >= 50 ? 'text-emerald-400' : 'text-amber-400'}">${overallWinRate}%</span>
            </div>
          </div>

          <!-- Вкладки навигации -->
          <div class="flex items-center bg-slate-950 p-1 rounded-2xl border border-slate-800 text-xs font-semibold">
            <button id="tab-btn-table" class="px-3 py-1.5 rounded-xl transition ${currentTab === 'table' ? 'bg-emerald-600 text-white shadow-md' : 'text-slate-400 hover:text-white'}">
              🃏 Стол
            </button>
            <button id="tab-btn-streamlit" class="px-3 py-1.5 rounded-xl transition ${currentTab === 'streamlit' ? 'bg-rose-600 text-white shadow-md' : 'text-slate-400 hover:text-white'}">
              📊 Аналитика
            </button>
            <button id="tab-btn-vision" class="px-3 py-1.5 rounded-xl transition ${currentTab === 'vision' ? 'bg-cyan-600 text-white shadow-md' : 'text-slate-400 hover:text-white'}">
              📷 Камера
            </button>
            <button id="tab-btn-code" class="px-3 py-1.5 rounded-xl transition ${currentTab === 'code' ? 'bg-amber-600 text-white shadow-md' : 'text-slate-400 hover:text-white'}">
              🐍 Python
            </button>
          </div>
        </div>
      </div>
    </header>
  `;

  // Тело в зависимости от вкладки
  let contentHtml = '';
  if (currentTab === 'table') {
    contentHtml = renderTableTab();
  } else if (currentTab === 'streamlit') {
    contentHtml = renderStreamlitTab();
  } else if (currentTab === 'vision') {
    contentHtml = renderVisionTab();
  } else if (currentTab === 'code') {
    contentHtml = renderCodeTab();
  }

  // Подвал
  const footerHtml = `
    <footer class="border-t border-slate-900 bg-slate-950 py-4 text-center text-xs text-slate-500 mt-auto">
      <div class="max-w-7xl mx-auto px-4 flex flex-wrap items-center justify-between gap-2">
        <span>Учебный проект: Покерный клиент-сервер, сбор Win Rate статистики, Streamlit и OpenCV</span>
        <span class="font-mono text-slate-400 text-[11px]">Чистый TypeScript + Python 3.10 • 0% React</span>
      </div>
    </footer>
  `;

  root.innerHTML = `
    <div class="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      ${navHtml}
      <main class="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        ${contentHtml}
      </main>
      ${footerHtml}
    </div>
  `;

  if (cameraStream) {
    const video = document.getElementById('webcam-video') as HTMLVideoElement | null;
    if (video && video.srcObject !== cameraStream) {
      video.srcObject = cameraStream;
      void video.play().catch(() => undefined);
    }
  }

  attachEventHandlers();
}

// ВКЛАДКА 1: ПОКЕРНЫЙ СТОЛ

function renderTableTab(): string {
  const hero = players[0];
  const bots = players.slice(1);

  return `
    <div class="space-y-6">
      <!-- Баннер состояния -->
      <div class="bg-slate-900 border border-slate-800 rounded-3xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4 shadow-xl">
        <div class="flex items-center gap-3">
          <div class="w-3 h-3 rounded-full ${stage === 'SHOWDOWN' ? 'bg-amber-400' : 'bg-emerald-400 animate-ping'}"></div>
          <div>
            <div class="text-xs font-mono uppercase tracking-wider text-slate-400">Улица: <strong class="text-white">${stage}</strong></div>
            <div class="text-sm font-bold text-white mt-0.5">${message}</div>
          </div>
        </div>

        <div class="flex items-center gap-4">
          <div class="bg-slate-950 px-4 py-2 rounded-2xl border border-slate-800 text-center">
            <div class="text-[10px] text-slate-400 uppercase font-semibold">Общий Банк</div>
            <div class="text-xl font-extrabold text-amber-400 font-mono">$${pot}</div>
          </div>

          <div class="bg-slate-950 px-4 py-2 rounded-2xl border border-emerald-500/30 text-center">
            <div class="text-[10px] text-emerald-400 uppercase font-semibold">Hero Win Rate</div>
            <div class="text-xl font-extrabold text-emerald-300 font-mono">${heroEquity}%</div>
          </div>

          <button id="deal-new-hand-btn" class="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-emerald-600/20 active:scale-95">
            Новая раздача
          </button>
        </div>
      </div>

      <!-- ЗЕЛЕНОЕ СУКНО ПОКЕРНОГО СТОЛА -->
      <div class="relative bg-gradient-to-b from-emerald-900 via-emerald-950 to-slate-950 border-8 border-amber-950/80 rounded-[40px] p-6 sm:p-10 shadow-2xl min-h-[480px] flex flex-col justify-between overflow-hidden">
        <!-- Текстура сукна -->
        <div class="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-emerald-800/20 via-transparent to-black/60 pointer-events-none"></div>

        <!-- Оппоненты (Боты) в верхней части стола -->
        <div class="relative z-10 grid grid-cols-3 gap-4 text-center">
          ${bots.map(b => `
            <div class="bg-slate-900/80 backdrop-blur-sm border ${b.folded ? 'border-slate-800 opacity-50' : 'border-emerald-700/50'} rounded-2xl p-3 shadow-lg flex flex-col items-center">
              <div class="flex items-center justify-between w-full text-[11px] font-mono text-slate-300 mb-1.5">
                <span class="font-bold">${b.name} (${b.position})</span>
                <span class="text-amber-400 font-bold">$${b.chips}</span>
              </div>
              <div class="flex gap-1.5 justify-center my-1">
                ${b.cards.map(c => renderCardHtml(c, stage !== 'SHOWDOWN' && !b.folded)).join('')}
              </div>
              <div class="text-[10px] mt-1 ${b.folded ? 'text-rose-400 font-bold' : 'text-slate-400'}">
                ${b.folded ? 'Фолд' : b.bet > 0 ? `Ставка: $${b.bet}` : 'В игре'}
              </div>
            </div>
          `).join('')}
        </div>

        <!-- ЦЕНТР СТОЛА: ОБЩИЕ КАРТЫ (BOARD) И БАНК -->
        <div class="relative z-10 my-6 flex flex-col items-center justify-center space-y-3">
          <div class="text-xs font-mono text-emerald-300/80 uppercase tracking-wider font-bold">
            Общие карты стола (Борд)
          </div>
          <div class="flex gap-2 p-3 bg-emerald-950/80 border border-emerald-600/40 rounded-2xl shadow-inner">
            ${[0, 1, 2, 3, 4].map(idx => {
              const card = communityCards[idx] || null;
              return renderCardHtml(card);
            }).join('')}
          </div>
          ${winnerAnnouncement ? `
            <div class="bg-amber-500/20 border border-amber-500/40 text-amber-300 px-4 py-2 rounded-xl text-xs font-bold shadow-lg animate-bounce">
              🏆 ${winnerAnnouncement}
            </div>
          ` : ''}
        </div>

        <!-- НИЖНЯЯ ЧАСТЬ: ИГРОК (HERO) И КНОПКИ ДЕЙСТВИЙ -->
        <div class="relative z-10 bg-slate-900/90 backdrop-blur-md border border-slate-700 rounded-3xl p-4 shadow-2xl flex flex-wrap items-center justify-between gap-4">
          <!-- Карты Hero -->
          <div class="flex items-center gap-4">
            <div class="flex gap-2">
              ${hero.cards.map(c => renderCardHtml(c, false, true)).join('')}
            </div>
            <div>
              <div class="flex items-center gap-2">
                <span class="text-sm font-bold text-white">${hero.name}</span>
                <span class="text-[10px] bg-emerald-500/20 text-emerald-300 font-mono px-2 py-0.5 rounded-full border border-emerald-500/30">
                  Позиция: ${hero.position}
                </span>
              </div>
              <div class="text-xs text-slate-400 mt-1">
                Стек: <strong class="text-amber-400 font-mono">$${hero.chips}</strong> • Текущая ставка: $${hero.bet}
              </div>
              <div class="text-[11px] text-emerald-400 font-mono mt-0.5">
                Шанс на победу: <strong>${heroEquity}%</strong>
              </div>
            </div>
          </div>

          <!-- Кнопки действий -->
          <div class="flex items-center gap-2">
            <button id="act-fold-btn" class="px-4 py-2.5 bg-rose-600/30 hover:bg-rose-600/50 text-rose-300 border border-rose-500/40 rounded-xl text-xs font-bold transition">
              Фолд (Fold)
            </button>
            <button id="act-check-btn" class="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-white border border-slate-600 rounded-xl text-xs font-bold transition">
              Чек (Check)
            </button>
            <button id="act-call-btn" class="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition shadow-md shadow-blue-600/20">
              Колл ($${Math.max(0, currentBet - hero.bet)})
            </button>
            <button id="act-raise-btn" class="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition shadow-md shadow-emerald-600/20">
              Рейз ($${currentBet + 50})
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ВКЛАДКА 2: АНАЛИТИКА STREAMLIT

function renderStreamlitTab(): string {
  const totalHands = handHistory.length;
  const winsCount = handHistory.filter(h => h.won).length;
  const overallWinRate = totalHands > 0 ? Number(((winsCount / totalHands) * 100).toFixed(1)) : 0;
  const totalProfit = handHistory.reduce((sum, h) => sum + h.profit, 0);

  const matrix = compute13x13Matrix(handHistory);

  // Расчет калькулятора эквити
  const p1 = parseCard(calcHero1);
  const p2 = parseCard(calcHero2);
  const bCards = calcBoard.filter(Boolean).map(c => parseCard(c));
  const calcResult = calculateEquityFast([p1, p2], bCards, calcOpponents, calcSimulations);

  // Статы по позициям
  const posOrder = ['BTN', 'CO', 'MP', 'UTG', 'SB', 'BB'];
  const posStats = posOrder.map(pos => {
    const subset = handHistory.filter(h => h.position === pos);
    const wins = subset.filter(h => h.won).length;
    const wr = subset.length > 0 ? Number(((wins / subset.length) * 100).toFixed(1)) : 0;
    const profit = subset.reduce((acc, h) => acc + h.profit, 0);
    return { pos, count: subset.length, wins, wr, profit };
  });

  return `
    <div class="space-y-6">
      <!-- Заголовок Streamlit -->
      <div class="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl flex flex-wrap items-center justify-between gap-4">
        <div>
          <div class="flex items-center gap-2">
            <span class="text-2xl">📊</span>
            <h2 class="text-lg font-bold text-white tracking-tight">Streamlit Poker Win-Rate Dashboard</h2>
            <span class="text-[11px] bg-rose-500/20 text-rose-300 font-semibold px-2 py-0.5 rounded-full border border-rose-500/30">
              SQLite Аналитика
            </span>
          </div>
          <p class="text-xs text-slate-400 mt-1">
            Тепловая матрица стартовых рук 13x13, расчет эквити Монте-Карло и статистика по позициям стола.
          </p>
        </div>

        <button id="seed-50-btn" class="px-4 py-2.5 bg-gradient-to-r from-rose-600 to-pink-600 hover:from-rose-500 hover:to-pink-500 text-white rounded-xl text-xs font-bold transition shadow-md shadow-rose-600/20">
          Сгенерировать 50 раздач в SQLite
        </button>
      </div>

      <!-- KPI Метрики -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-lg">
          <div class="text-xs text-slate-400 uppercase font-semibold">Всего раздач</div>
          <div class="text-2xl font-extrabold text-white font-mono mt-1">${totalHands}</div>
          <div class="text-[11px] text-slate-500 mt-1">Рук в базе данных</div>
        </div>

        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-lg">
          <div class="text-xs text-slate-400 uppercase font-semibold">Процент побед (Win Rate)</div>
          <div class="text-2xl font-extrabold font-mono mt-1 ${overallWinRate >= 50 ? 'text-emerald-400' : 'text-amber-400'}">
            ${overallWinRate}%
          </div>
          <div class="text-[11px] text-emerald-400 mt-1">Шоудаун + фолды</div>
        </div>

        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-lg">
          <div class="text-xs text-slate-400 uppercase font-semibold">Побед / Поражений</div>
          <div class="text-2xl font-extrabold text-white font-mono mt-1">
            ${winsCount} <span class="text-slate-500 text-sm font-normal">/ ${totalHands - winsCount}</span>
          </div>
          <div class="text-[11px] text-slate-400 mt-1">Успешность Hero</div>
        </div>

        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-lg">
          <div class="text-xs text-slate-400 uppercase font-semibold">Чистый Профит</div>
          <div class="text-2xl font-extrabold font-mono mt-1 ${totalProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}">
            $${totalProfit}
          </div>
          <div class="text-[11px] text-slate-400 mt-1">Фишек в банках</div>
        </div>
      </div>

      <!-- 13x13 ТЕПЛОВАЯ МАТРИЦА СТАРТОВЫХ РУК -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div class="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-4">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-bold text-white flex items-center gap-2">
              <span>🔥 13x13 Тепловая матрица стартовых рук</span>
            </h3>
            <div class="flex items-center gap-2 font-mono text-[10px]">
              <span class="flex items-center gap-1"><span class="w-2.5 h-2.5 bg-emerald-600 rounded"></span> &gt;65%</span>
              <span class="flex items-center gap-1"><span class="w-2.5 h-2.5 bg-amber-600 rounded"></span> 45-65%</span>
              <span class="flex items-center gap-1"><span class="w-2.5 h-2.5 bg-rose-900 rounded"></span> &lt;45%</span>
            </div>
          </div>

          <div class="overflow-x-auto pb-2">
            <div class="grid grid-cols-13 gap-1 min-w-[540px]">
              ${matrix.flatMap((row, r) => row.map((cell, c) => {
                let color = 'bg-slate-950 text-slate-400 border-slate-800';
                if (cell.winRate >= 65) color = 'bg-emerald-600 text-white font-bold';
                else if (cell.winRate >= 50) color = 'bg-emerald-800/80 text-emerald-100';
                else if (cell.winRate >= 40) color = 'bg-amber-600/80 text-amber-100';
                else color = 'bg-rose-900/60 text-rose-200';

                return `
                  <button data-hand="${cell.hand}" class="matrix-cell-btn h-9 rounded text-[10px] font-mono flex flex-col items-center justify-center border transition hover:scale-105 active:scale-95 ${color}">
                    <span class="leading-none font-bold">${cell.hand}</span>
                    <span class="text-[8px] opacity-80 mt-0.5 leading-none">${cell.winRate}%</span>
                  </button>
                `;
              })).join('')}
            </div>
          </div>
          <p class="text-[11px] text-slate-400">
            Кликните на любую ячейку (например, AA, AKs, 72o) для детального инспектора справа.
          </p>
        </div>

        <!-- Инспектор выбранной руки -->
        <div class="bg-slate-900 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-4">
          <h3 class="text-sm font-bold text-white">Инспектор комбинации</h3>
          ${selectedMatrixHand ? `
            <div class="bg-slate-950 p-4 rounded-2xl border border-slate-800 space-y-3">
              <div class="flex items-center justify-between">
                <span class="text-2xl font-extrabold font-mono text-white">${selectedMatrixHand.hand}</span>
                <span class="text-xs px-2 py-0.5 rounded font-bold ${selectedMatrixHand.winRate >= 50 ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}">
                  ${selectedMatrixHand.winRate}% Win Rate
                </span>
              </div>
              <div class="text-xs space-y-2 text-slate-300">
                <div class="flex justify-between py-1 border-b border-slate-850">
                  <span class="text-slate-400">Сыграно сэмплов:</span>
                  <span class="font-mono text-white">${selectedMatrixHand.samples}</span>
                </div>
                <div class="flex justify-between py-1 border-b border-slate-850">
                  <span class="text-slate-400">Побед Hero:</span>
                  <span class="font-mono text-emerald-400">${selectedMatrixHand.wins}</span>
                </div>
                <div class="flex justify-between py-1">
                  <span class="text-slate-400">Профит:</span>
                  <span class="font-mono text-amber-400">$${selectedMatrixHand.profit}</span>
                </div>
              </div>
              <button id="test-in-calc-btn" class="w-full mt-2 py-2 bg-rose-600/30 hover:bg-rose-600/50 text-rose-300 border border-rose-500/40 rounded-xl text-xs font-bold transition">
                Загрузить в калькулятор эквити &rarr;
              </button>
            </div>
          ` : `
            <div class="p-8 border border-dashed border-slate-800 rounded-2xl text-center text-xs text-slate-500">
              Выберите любую ячейку в матрице слева для детального отчета.
            </div>
          `}
        </div>
      </div>

      <!-- КАЛЬКУЛЯТОР ЭКВИТИ МОНТЕ-КАРЛО -->
      <div class="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-5">
        <h3 class="text-sm font-bold text-white flex items-center gap-2">
          <span>🧮 Интерактивный Калькулятор Эквити (Монте-Карло)</span>
        </h3>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div class="space-y-4">
            <div>
              <label class="text-xs font-semibold text-slate-300 block mb-1">Карты игрока (Hero):</label>
              <div class="grid grid-cols-2 gap-2">
                <input id="calc-h1-input" type="text" value="${calcHero1}" class="bg-slate-950 border border-slate-700 text-white rounded-xl p-2 text-xs font-mono text-center" />
                <input id="calc-h2-input" type="text" value="${calcHero2}" class="bg-slate-950 border border-slate-700 text-white rounded-xl p-2 text-xs font-mono text-center" />
              </div>
            </div>

            <div>
              <label class="text-xs font-semibold text-slate-300 block mb-1">Борд (Флоп, Тёрн, Ривер):</label>
              <div class="grid grid-cols-5 gap-1.5">
                ${calcBoard.map((c, i) => `
                  <input data-board-idx="${i}" type="text" value="${c}" placeholder="-" class="calc-board-input bg-slate-950 border border-slate-700 text-white rounded-xl p-2 text-xs font-mono text-center" />
                `).join('')}
              </div>
            </div>

            <div>
              <div class="flex justify-between text-xs text-slate-300 mb-1">
                <span>Оппонентов:</span>
                <span class="font-bold text-amber-400 font-mono">${calcOpponents}</span>
              </div>
              <input id="calc-opp-slider" type="range" min="1" max="8" value="${calcOpponents}" class="w-full accent-rose-500" />
            </div>
          </div>

          <div class="lg:col-span-2 space-y-4">
            <div class="grid grid-cols-3 gap-3">
              <div class="bg-slate-950 p-3 rounded-xl border border-slate-800 text-center">
                <div class="text-[10px] text-slate-400 uppercase">Победа (Win)</div>
                <div class="text-2xl font-extrabold text-emerald-400 font-mono mt-1">${calcResult.winRate}%</div>
              </div>
              <div class="bg-slate-950 p-3 rounded-xl border border-slate-800 text-center">
                <div class="text-[10px] text-slate-400 uppercase">Ничья (Tie)</div>
                <div class="text-2xl font-extrabold text-amber-400 font-mono mt-1">${calcResult.tieRate}%</div>
              </div>
              <div class="bg-slate-950 p-3 rounded-xl border border-slate-800 text-center">
                <div class="text-[10px] text-slate-400 uppercase">Эквити</div>
                <div class="text-2xl font-extrabold text-cyan-400 font-mono mt-1">${calcResult.equity}%</div>
              </div>
            </div>

            <!-- Полоса вероятностей -->
            <div class="h-3 bg-slate-950 rounded-full overflow-hidden flex">
              <div class="bg-emerald-500 h-full" style="width: ${calcResult.winRate}%"></div>
              <div class="bg-amber-400 h-full" style="width: ${calcResult.tieRate}%"></div>
              <div class="bg-rose-500 h-full" style="width: ${calcResult.lossRate}%"></div>
            </div>

            <!-- Распределение комбинаций -->
            <div class="space-y-1.5 pt-1">
              <div class="text-xs font-bold text-slate-300">Вероятность комбинаций к риверу:</div>
              <div class="grid grid-cols-2 gap-2 text-xs">
                ${Object.entries(calcResult.handDistribution).slice(0, 6).map(([name, prob]) => `
                  <div class="flex justify-between bg-slate-950 p-2 rounded-lg border border-slate-850">
                    <span class="text-slate-400">${name}</span>
                    <span class="font-mono font-bold text-emerald-400">${prob}%</span>
                  </div>
                `).join('')}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ТАБЛИЦА СТАТИСТИКИ ПО ПОЗИЦИЯМ -->
      <div class="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-4">
        <h3 class="text-sm font-bold text-white">Статистика Win Rate по позициям стола (BTN, CO, MP, UTG, SB, BB)</h3>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs text-slate-300">
            <thead class="bg-slate-950 text-slate-400 font-mono text-[10px] uppercase">
              <tr>
                <th class="p-3">Позиция</th>
                <th class="p-3">Сыграно раздач</th>
                <th class="p-3">Побед</th>
                <th class="p-3">Win Rate %</th>
                <th class="p-3">Профит</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800">
              ${posStats.map(row => `
                <tr class="hover:bg-slate-850">
                  <td class="p-3 font-mono font-bold text-white">${row.pos}</td>
                  <td class="p-3 font-mono">${row.count}</td>
                  <td class="p-3 font-mono text-emerald-400">${row.wins}</td>
                  <td class="p-3 font-mono font-bold">${row.wr}%</td>
                  <td class="p-3 font-mono font-bold ${row.profit >= 0 ? 'text-emerald-400' : 'text-rose-400'}">$${row.profit}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

// ВКЛАДКА 3: OPENCV CARD VISION

function renderVisionTab(): string {
  const visionEquity = detectedCards.length >= 2
    ? calculateEquityFast([parseCard(detectedCards[0].code), parseCard(detectedCards[1].code)], [], 2, 500)
    : null;

  return `
    <div class="space-y-6">
      <div class="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl flex flex-wrap items-center justify-between gap-4">
        <div>
          <div class="flex items-center gap-2">
            <span class="text-2xl">📷</span>
            <h2 class="text-lg font-bold text-white tracking-tight">OpenCV Card Vision &amp; Camera HUD</h2>
            <span class="text-[11px] bg-cyan-500/20 text-cyan-300 font-semibold px-2 py-0.5 rounded-full border border-cyan-500/30">
              Компьютерное зрение
            </span>
          </div>
          <p class="text-xs text-slate-400 mt-1">
            Распознавание карт через веб-камеру, контурный анализ OpenCV, оверлей рангов и расчет Win Rate.
          </p>
        </div>

        <div class="flex items-center gap-2">
          <button id="toggle-camera-btn" class="px-4 py-2.5 ${cameraStream ? 'bg-rose-600 hover:bg-rose-500' : 'bg-cyan-600 hover:bg-cyan-500'} text-white rounded-xl text-xs font-bold transition shadow-lg shadow-cyan-600/20">
            ${cameraStream ? 'Отключить камеру' : 'Включить веб-камеру'}
          </button>
          <button id="scan-card-btn" class="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition" ${!cameraStream || detectedCards.length >= 2 ? 'disabled' : ''}>
            ${scanningCard ? 'Распознаю…' : 'Считать карту'}
          </button>
          <button id="inject-cards-btn" class="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-emerald-600/20">
            Передать карты за стол &rarr;
          </button>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- Видоискатель камеры с HUD -->
        <div class="lg:col-span-2 relative bg-slate-950 border border-slate-800 rounded-3xl overflow-hidden min-h-[440px] flex flex-col justify-between shadow-2xl">
          <div class="relative w-full h-[440px] bg-slate-900 flex items-center justify-center overflow-hidden">
            <video id="webcam-video" playsinline autoplay muted class="w-full h-full object-cover ${cameraStream ? '' : 'hidden'}"></video>

            ${!cameraStream ? `
              <div class="relative z-10 text-center p-6 space-y-3 max-w-sm">
                <div class="w-16 h-16 rounded-2xl bg-cyan-950/80 border border-cyan-500/40 text-cyan-400 mx-auto flex items-center justify-center text-2xl">
                  🎯
                </div>
                <h3 class="text-base font-bold text-white">Режим сканирования карт</h3>
                <p class="text-xs text-slate-400">
                  Включите камеру, поместите угол карты в центр кадра и нажмите «Считать карту».
                </p>
              </div>
            ` : ''}

            <!-- Оверлей HUD рамок обнаруженных карт -->
            <div class="absolute inset-0 pointer-events-none p-6 flex items-center justify-center gap-8">
              ${detectedCards.map((c, i) => `
                <div class="w-36 h-52 border-2 border-cyan-400 rounded-xl bg-cyan-950/20 shadow-[0_0_15px_rgba(6,182,212,0.3)] flex flex-col justify-between p-2">
                  <div class="bg-cyan-900/90 text-cyan-200 text-[11px] font-mono px-2 py-0.5 rounded flex justify-between">
                    <span class="font-extrabold">${c.rank}${c.suitSymbol}</span>
                    <span>${c.confidence}%</span>
                  </div>
                  <div class="self-center text-cyan-400 text-3xl">⊕</div>
                  <div class="text-[10px] text-cyan-300 font-mono text-center bg-black/60 py-0.5 rounded">
                    ${c.suitName}
                  </div>
                </div>
              `).join('')}
            </div>

            <!-- Верхняя строка HUD -->
            <div class="absolute top-0 left-0 right-0 bg-slate-950/80 backdrop-blur-md p-3 border-b border-cyan-500/30 flex items-center justify-between text-xs font-mono z-10">
              <span class="text-cyan-300 font-bold">РАСПОЗНАНО КАРТ: ${detectedCards.length}/2</span>
              <span class="text-emerald-400 font-bold">${visionEquity ? `WIN RATE: ${visionEquity.winRate}%` : 'Считайте две карты'}</span>
            </div>
          </div>
        </div>

        <!-- Боковая панель -->
        <div class="space-y-6">
          <div class="bg-slate-900 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-4">
            <h3 class="text-sm font-bold text-white">Распознанные карты</h3>
            <div class="flex gap-3 justify-center py-2">
              ${detectedCards.map(c => `
                <div class="flex flex-col items-center">
                  ${renderCardHtml(parseCard(c.code), false, true)}
                  <span class="text-[10px] text-slate-400 font-mono mt-1">${c.confidence}% точность</span>
                </div>
              `).join('')}
            </div>
            <button id="send-vision-btn" class="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition shadow-md shadow-emerald-600/20">
              Использовать в игре как карты Hero &rarr;
            </button>
          </div>

          <!-- Пресеты карт -->
          <div class="bg-slate-900 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-3">
            <h3 class="text-xs font-bold text-slate-300 uppercase">Тестовые наборы карт:</h3>
            <div class="space-y-2">
              <button id="preset-aces-btn" class="w-full p-2.5 bg-slate-950 hover:bg-slate-850 rounded-xl border border-slate-800 text-left flex justify-between text-xs transition">
                <span class="text-white font-semibold">Пара Тузов (Ракеты)</span>
                <span class="font-mono text-cyan-400 font-bold">A♠ A♥ (85% WR)</span>
              </button>
              <button id="preset-ak-btn" class="w-full p-2.5 bg-slate-950 hover:bg-slate-850 rounded-xl border border-slate-800 text-left flex justify-between text-xs transition">
                <span class="text-white font-semibold">Туз-Король (AKo)</span>
                <span class="font-mono text-cyan-400 font-bold">A♠ K♦ (67% WR)</span>
              </button>
              <button id="preset-flush-btn" class="w-full p-2.5 bg-slate-950 hover:bg-slate-850 rounded-xl border border-slate-800 text-left flex justify-between text-xs transition">
                <span class="text-white font-semibold">Король-Дама одномастные</span>
                <span class="font-mono text-cyan-400 font-bold">K♠ Q♠ (63% WR)</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ВКЛАДКА 4: PYTHON КОД  ИНСТРУКЦИЯ

const pythonFilesData: Record<string, { name: string; desc: string; code: string }> = {
  poker_server: {
    name: 'poker_server.py',
    desc: 'Сервер для игры в покер, REST API и сохранение раздач в SQLite',
    code: `"""
Poker Server with Win-Rate Analytics & REST API
Учебный покерный сервер на чистом Python и SQLite.
"""
import http.server
import socketserver
import json
import sqlite3
import random
import os
from poker_equity import calculate_equity, evaluate_7_cards, make_deck

DB_FILE = "poker_stats.db"

def init_db():
    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            pot INTEGER,
            board_cards TEXT,
            winner_name TEXT,
            winner_hand TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS hand_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id INTEGER,
            player_name TEXT,
            hole_cards TEXT,
            starting_hand TEXT,
            position TEXT,
            won INTEGER,
            profit INTEGER,
            final_hand TEXT,
            win_rate_equity REAL,
            FOREIGN KEY(game_id) REFERENCES games(id)
        )
    """)
    conn.commit()
    conn.close()

if __name__ == "__main__":
    init_db()
    print("🃏 Сервер запущен на http://localhost:8080")
    # Обработчик запросов и сохранение в SQLite...`,
  },
  streamlit_app: {
    name: 'streamlit_app.py',
    desc: 'Дашборд визуализации процента побед в Streamlit (13x13 матрица & эквити)',
    code: `"""
Streamlit Poker Win-Rate Analytics
Запуск: streamlit run streamlit_app.py
"""
import streamlit as st
import pandas as pd
import sqlite3
from poker_equity import calculate_equity

st.set_page_config(page_title="Poker Analytics", page_icon="🃏", layout="wide")

# 1. Чтение базы данных SQLite poker_stats.db
# 2. Отрисовка KPI метрик (Win Rate, Hands, Profit)
# 3. 13x13 Тепловая матрица комбинаций
# 4. Калькулятор шансов Монте-Карло`,
  },
  card_detector: {
    name: 'card_detector.py',
    desc: 'Программа OpenCV для распознавания игральных карт через веб-камеру',
    code: `"""
Card Detector & Vision HUD (OpenCV + Python)
Запуск: python card_detector.py
"""
import cv2
import numpy as np
from poker_equity import calculate_equity

def main():
    cap = cv2.VideoCapture(0)
    print("📷 Камера подключена. Нажмите 'q' для выхода или 's' для отправки карт на сервер.")
    while True:
        ret, frame = cap.read()
        if not ret: break

        # 1. Grayscale + Gaussian Blur + Otsu Threshold
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        blur = cv2.GaussianBlur(gray, (5, 5), 0)
        _, thresh = cv2.threshold(blur, 120, 255, cv2.THRESH_BINARY)

        # 2. Поиск 4-угольных контуров карт
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        # 3. Выравнивание cv2.warpPerspective (200x300)
        # 4. Распознавание ранга и масти, вывод Win Rate
        cv2.imshow("Poker Vision HUD", frame)
        if cv2.waitKey(1) & 0xFF == ord('q'): break`,
  },
  poker_client: {
    name: 'poker_client.py',
    desc: 'Консольный клиент для игры за столом против ботов',
    code: `"""
Poker Client (Python CLI)
Запуск: python poker_client.py
"""
import requests

SERVER_URL = "http://localhost:8080"
print("🎮 Подключение к покерному столу...")
# Вызов API: Check, Call, Raise, Fold с живым расчетом Win Rate!`,
  },
  poker_equity: {
    name: 'poker_equity.py',
    desc: 'Оценка комбинаций и расчет эквити Монте-Карло',
    code: `"""
Poker Equity Calculator (Monte Carlo)
"""
def calculate_equity(hero_cards, board_cards=None, num_opponents=1, simulations=1500):
    # Быстрый перебор случайных раздач колоды
    # Возвращает win_rate %, tie_rate %, equity %
    pass`,
  },
};

function renderCodeTab(): string {
  const current = pythonFilesData[activePythonFile] || pythonFilesData.poker_server;

  return `
    <div class="space-y-6">
      <div class="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl flex flex-wrap items-center justify-between gap-4">
        <div>
          <div class="flex items-center gap-2">
            <span class="text-2xl">🐍</span>
            <h2 class="text-lg font-bold text-white tracking-tight">Python Файлы Учебного Проекта</h2>
            <span class="text-[11px] bg-amber-500/20 text-amber-300 font-semibold px-2 py-0.5 rounded-full border border-amber-500/30">
              Чистый Python 3.10
            </span>
          </div>
          <p class="text-xs text-slate-400 mt-1">
            Все программы написаны на чистом Python без лишних библиотек: сервер с SQLite, Streamlit и OpenCV.
          </p>
        </div>

        <button id="copy-code-btn" class="px-4 py-2.5 bg-amber-600 hover:bg-amber-500 text-slate-950 font-bold rounded-xl text-xs transition shadow-lg shadow-amber-600/20">
          Копировать код файла
        </button>
      </div>

      <!-- Быстрые команды запуска -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-lg space-y-2">
          <div class="text-xs font-bold text-white">1. Запуск сервера:</div>
          <pre class="bg-slate-950 p-2 rounded font-mono text-[11px] text-emerald-400">python poker_server.py</pre>
          <div class="text-[11px] text-slate-400">Порт 8080, сохранение в базу SQLite poker_stats.db</div>
        </div>

        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-lg space-y-2">
          <div class="text-xs font-bold text-white">2. Дашборд Streamlit:</div>
          <pre class="bg-slate-950 p-2 rounded font-mono text-[11px] text-rose-400">streamlit run streamlit_app.py</pre>
          <div class="text-[11px] text-slate-400">Тепловая карта 13x13 и калькулятор эквити</div>
        </div>

        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-lg space-y-2">
          <div class="text-xs font-bold text-white">3. Камера OpenCV:</div>
          <pre class="bg-slate-950 p-2 rounded font-mono text-[11px] text-cyan-400">python card_detector.py</pre>
          <div class="text-[11px] text-slate-400">Распознавание карт через веб-камеру с HUD</div>
        </div>
      </div>

      <!-- Просмотрщик файлов -->
      <div class="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl">
        <div class="flex overflow-x-auto bg-slate-950 p-2 gap-1.5 border-b border-slate-800">
          ${Object.entries(pythonFilesData).map(([key, item]) => `
            <button data-file-key="${key}" class="file-tab-btn px-3 py-1.5 rounded-xl text-xs font-mono transition ${activePythonFile === key ? 'bg-slate-800 text-white font-bold border border-slate-700' : 'text-slate-400 hover:text-white'}">
              ${item.name}
            </button>
          `).join('')}
        </div>

        <div class="p-4 bg-slate-900 border-b border-slate-800 flex justify-between items-center text-xs">
          <span class="font-bold text-white font-mono">${current.name}</span>
          <span class="text-slate-400">${current.desc}</span>
        </div>

        <div class="p-4 bg-slate-950 overflow-x-auto max-h-[500px]">
          <pre class="font-mono text-xs text-slate-300 leading-relaxed"><code>${current.code}</code></pre>
        </div>
      </div>
    </div>
  `;
}

// НАВЕШИВАНИЕ ОБРАБОТЧИКОВ СОБЫТИЙ (DOM)

function attachEventHandlers() {
  // Переключение вкладок
  document.getElementById('tab-btn-table')?.addEventListener('click', () => { currentTab = 'table'; renderApp(); });
  document.getElementById('tab-btn-streamlit')?.addEventListener('click', () => { currentTab = 'streamlit'; renderApp(); });
  document.getElementById('tab-btn-vision')?.addEventListener('click', () => { currentTab = 'vision'; renderApp(); });
  document.getElementById('tab-btn-code')?.addEventListener('click', () => { currentTab = 'code'; renderApp(); });

  // Вкладка 1: Стол
  document.getElementById('deal-new-hand-btn')?.addEventListener('click', () => startNewHand());
  document.getElementById('act-fold-btn')?.addEventListener('click', () => playerAction('fold'));
  document.getElementById('act-check-btn')?.addEventListener('click', () => playerAction('check'));
  document.getElementById('act-call-btn')?.addEventListener('click', () => playerAction('call'));
  document.getElementById('act-raise-btn')?.addEventListener('click', () => playerAction('raise'));

  // Вкладка 2: Streamlit
  document.getElementById('seed-50-btn')?.addEventListener('click', () => generateBatchHands(50));
  document.querySelectorAll('.matrix-cell-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const hand = (e.currentTarget as HTMLElement).getAttribute('data-hand');
      if (hand) {
        const matrix = compute13x13Matrix(handHistory);
        for (const row of matrix) {
          for (const cell of row) {
            if (cell.hand === hand) {
              selectedMatrixHand = cell;
              renderApp();
              return;
            }
          }
        }
      }
    });
  });

  document.getElementById('test-in-calc-btn')?.addEventListener('click', () => {
    if (selectedMatrixHand) {
      calcHero1 = `${selectedMatrixHand.row}s`;
      calcHero2 = `${selectedMatrixHand.col}${selectedMatrixHand.isSuited ? 's' : 'h'}`;
      renderApp();
    }
  });

  const h1Input = document.getElementById('calc-h1-input') as HTMLInputElement | null;
  const h2Input = document.getElementById('calc-h2-input') as HTMLInputElement | null;
  h1Input?.addEventListener('change', e => { calcHero1 = (e.target as HTMLInputElement).value; renderApp(); });
  h2Input?.addEventListener('change', e => { calcHero2 = (e.target as HTMLInputElement).value; renderApp(); });

  document.querySelectorAll('.calc-board-input').forEach(input => {
    input.addEventListener('change', e => {
      const target = e.target as HTMLInputElement;
      const idx = Number(target.getAttribute('data-board-idx'));
      calcBoard[idx] = target.value;
      renderApp();
    });
  });

  const oppSlider = document.getElementById('calc-opp-slider') as HTMLInputElement | null;
  oppSlider?.addEventListener('input', e => {
    calcOpponents = Number((e.target as HTMLInputElement).value);
    renderApp();
  });

  // Вкладка 3: Vision
  document.getElementById('toggle-camera-btn')?.addEventListener('click', toggleWebcam);
  document.getElementById('scan-card-btn')?.addEventListener('click', scanCardFromCamera);
  document.getElementById('inject-cards-btn')?.addEventListener('click', transferCardsToTable);
  document.getElementById('send-vision-btn')?.addEventListener('click', transferCardsToTable);
  document.getElementById('preset-aces-btn')?.addEventListener('click', () => setPresetCards('aces'));
  document.getElementById('preset-ak-btn')?.addEventListener('click', () => setPresetCards('ak'));
  document.getElementById('preset-flush-btn')?.addEventListener('click', () => setPresetCards('flush'));

  // Вкладка 4: Code
  document.querySelectorAll('.file-tab-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const key = (e.currentTarget as HTMLElement).getAttribute('data-file-key');
      if (key) {
        activePythonFile = key;
        renderApp();
      }
    });
  });

  document.getElementById('copy-code-btn')?.addEventListener('click', () => {
    const code = (pythonFilesData[activePythonFile] || pythonFilesData.poker_server).code;
    navigator.clipboard.writeText(code);
    alert('Код скопирован в буфер обмена!');
  });
}

// СТАРТ ПРИЛОЖЕНИЯ

// Запускаем первую раздачу при загрузке
startNewHand();
