
import random
from itertools import combinations
from typing import List, Tuple, Dict

# Ранги и масти
RANKS = '23456789TJQKA'
SUITS = 'shdc'  # spades (♠), hearts (♥), diamonds (♦), clubs (♣)
RANK_VALUES = {r: i for i, r in enumerate(RANKS, start=2)}
SUIT_SYMBOLS = {'s': '♠', 'h': '♥', 'd': '♦', 'c': '♣'}

HAND_NAMES = [
    "Старшая карта",
    "Пара",
    "Две пары",
    "Сет (Тройка)",
    "Стрит",
    "Флеш",
    "Фулл-хаус",
    "Каре",
    "Стрит-флеш",
    "Роял-флеш"
]

def make_deck() -> List[str]:
    """Создает стандартную колоду из 52 карт."""
    return [r + s for r in RANKS for s in SUITS]

def parse_card(card: str) -> Tuple[int, str]:
    """Парсит карту (например, 'Ah', 'Ts') в (значение, масть)."""
    card = card.strip()
    if len(card) == 2:
        r, s = card[0].upper(), card[1].lower()
    elif len(card) == 3 and card[:2] == '10':
        r, s = 'T', card[2].lower()
    else:
        raise ValueError(f"Неверный формат карты: {card}")
    
    if r not in RANK_VALUES or s not in SUITS:
        raise ValueError(f"Неизвестная карта: {card}")
    return RANK_VALUES[r], s

def evaluate_5_cards(cards: List[str]) -> Tuple[int, List[int]]:
    """
    Оценивает 5-карточную комбинацию.
    Возвращает (ранг комбинации 0..9, кикеры для разрешения ничьей).
    """
    parsed = [parse_card(c) for c in cards]
    values = sorted([p[0] for p in parsed], reverse=True)
    suits = [p[1] for p in parsed]
    
    is_flush = len(set(suits)) == 1
    
    # Проверка на стрит
    unique_vals = sorted(list(set(values)), reverse=True)
    is_straight = False
    straight_high = 0
    
    if len(unique_vals) == 5:
        if unique_vals[0] - unique_vals[4] == 4:
            is_straight = True
            straight_high = unique_vals[0]
        # Колесо: A-2-3-4-5
        elif unique_vals == [14, 5, 4, 3, 2]:
            is_straight = True
            straight_high = 5

    # Подсчет совпадений по рангам
    counts = {}
    for v in values:
        counts[v] = counts.get(v, 0) + 1
    
    # Сортировка по частоте, затем по значению
    by_count = sorted(counts.items(), key=lambda x: (x[1], x[0]), reverse=True)
    pattern = [item[1] for item in by_count]
    ordered_vals = [item[0] for item in by_count]

    # Роял-флеш и Стрит-флеш
    if is_flush and is_straight:
        if straight_high == 14:
            return (9, [14])  # Роял-флеш
        return (8, [straight_high])  # Стрит-флеш
    
    # Каре
    if pattern == [4, 1]:
        return (7, ordered_vals)
    
    # Фулл-хаус
    if pattern == [3, 2]:
        return (6, ordered_vals)
    
    # Флеш
    if is_flush:
        return (5, values)
    
    # Стрит
    if is_straight:
        return (4, [straight_high])
    
    # Сет
    if pattern == [3, 1, 1]:
        return (3, ordered_vals)
    
    # Две пары
    if pattern == [2, 2, 1]:
        return (2, ordered_vals)
    
    # Пара
    if pattern == [2, 1, 1, 1]:
        return (1, ordered_vals)
    
    # Старшая карта
    return (0, values)

def evaluate_7_cards(cards: List[str]) -> Tuple[int, List[int], str]:
    """
    Выбирает наилучшую 5-карточную комбинацию из 7 карт (или 5-6 карт).
    """
    best_score = (-1, [])
    for comb in combinations(cards, 5):
        score = evaluate_5_cards(list(comb))
        if score > best_score:
            best_score = score
    return best_score[0], best_score[1], HAND_NAMES[best_score[0]]

def calculate_equity(hero_cards: List[str], board_cards: List[str] = None, num_opponents: int = 1, simulations: int = 2000) -> Dict:
    """
    Монте-Карло расчет шансов на победу (Win Rate %).
    """
    if board_cards is None:
        board_cards = []
    
    known_cards = set(hero_cards + board_cards)
    full_deck = [c for c in make_deck() if c not in known_cards]
    
    needed_board = 5 - len(board_cards)
    if needed_board < 0:
        needed_board = 0

    wins = 0
    ties = 0
    losses = 0
    hand_type_counts = {name: 0 for name in HAND_NAMES}

    for _ in range(simulations):
        deck_sample = random.sample(full_deck, needed_board + num_opponents * 2)
        sim_board = board_cards + deck_sample[:needed_board]
        
        # Рука игрока (Hero)
        hero_rank, hero_kickers, hero_hand_name = evaluate_7_cards(hero_cards + sim_board)
        hand_type_counts[hero_hand_name] += 1
        hero_score = (hero_rank, hero_kickers)

        # Оппоненты
        opp_scores = []
        offset = needed_board
        for _ in range(num_opponents):
            opp_cards = deck_sample[offset:offset+2]
            offset += 2
            o_rank, o_kickers, _ = evaluate_7_cards(opp_cards + sim_board)
            opp_scores.append((o_rank, o_kickers))
        
        best_opp = max(opp_scores)
        
        if hero_score > best_opp:
            wins += 1
        elif hero_score == best_opp:
            ties += 1
        else:
            losses += 1

    win_rate = (wins / simulations) * 100.0
    tie_rate = (ties / simulations) * 100.0
    loss_rate = (losses / simulations) * 100.0
    
    hand_distribution = {
        name: round((count / simulations) * 100, 2)
        for name, count in hand_type_counts.items()
        if count > 0
    }

    return {
        "hero_cards": hero_cards,
        "board_cards": board_cards,
        "opponents": num_opponents,
        "simulations": simulations,
        "win_rate": round(win_rate, 2),
        "tie_rate": round(tie_rate, 2),
        "loss_rate": round(loss_rate, 2),
        "equity": round(win_rate + tie_rate / (num_opponents + 1), 2),
        "hand_distribution": hand_distribution
    }

if __name__ == "__main__":
    print("Тестирование калькулятора вероятности побед:")
    res = calculate_equity(["As", "Kd"], ["Ah", "7c", "2s"], num_opponents=2, simulations=1000)
    print(f"Рука: As Kd | Борд: Ah 7c 2s | Оппонентов: 2")
    print(f"Win Rate: {res['win_rate']}% | Tie: {res['tie_rate']}% | Эквити: {res['equity']}%")
    print(f"Распределение комбинаций: {res['hand_distribution']}")
