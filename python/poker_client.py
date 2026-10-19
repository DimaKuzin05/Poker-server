
import requests
import json
import time
import os
import sys

SERVER_URL = "http://localhost:8080" #Запуск: python poker_client.py

SUIT_SYMBOLS = {"s": "♠", "h": "♥", "d": "♦", "c": "♣"}

def format_card(c: str) -> str:
    """Форматирует карту с красивым символом масти."""
    if len(c) < 2:
        return c
    r, s = c[0].upper(), c[1].lower()
    return f"{r}{SUIT_SYMBOLS.get(s, s)}"

def fetch_table_state():
    """Запрашивает состояние стола с сервера."""
    try:
        r = requests.get(f"{SERVER_URL}/api/table", timeout=2.0)
        return r.json()
    except Exception as e:
        print(f"❌ Ошибка соединения с покер-сервером ({SERVER_URL}): {e}")
        return None

def send_action(action: str, amount: int = 0):
    """Отправляет действие игрока на сервер."""
    try:
        r = requests.post(f"{SERVER_URL}/api/action", json={"action": action, "amount": amount}, timeout=2.0)
        return r.json()
    except Exception as e:
        print(f"❌ Ошибка отправки действия: {e}")
        return None

def start_new_hand():
    """Запрашивает раздачу новых карт."""
    try:
        r = requests.post(f"{SERVER_URL}/api/new_hand", json={}, timeout=2.0)
        return r.json()
    except Exception as e:
        return None

def print_table(state):
    """Красивый консольный вывод стола."""
    os.system('cls' if os.name == 'nt' else 'clear')
    print("=" * 60)
    print("               🃏 POKER CLIENT - TEXAS HOLD'EM              ")
    print("=" * 60)
    
    stage = state.get("stage", "UNKNOWN")
    pot = state.get("pot", 0)
    curr_bet = state.get("current_bet", 0)
    board = state.get("community_cards", [])
    
    formatted_board = " ".join([format_card(c) for c in board]) if board else "[ Карты еще не сданы ]"
    print(f"📍 Стадия игры: {stage} | 💰 Общий банк: ${pot} | Текущая ставка: ${curr_bet}")
    print(f"🎴 Карты на столе (Борд): {formatted_board}")
    print("-" * 60)
    
    players = state.get("players", [])
    hero = players[0] if players else {}
    hero_cards = " ".join([format_card(c) for c in hero.get("cards", [])])
    
    print(f"👤 ВЫ: {hero.get('name')} | Фишки: ${hero.get('chips')} | Ставка: ${hero.get('bet')}")
    print(f"🃏 Ваши карманные карты: [ {hero_cards} ]")
    
    eq = state.get("hero_equity", {})
    if eq:
        wr = eq.get("win_rate", 0)
        equity = eq.get("equity", 0)
        print(f"📊 Текущий процент побед (Win Rate): {wr}% | Эквити: {equity}%")
    
    print("-" * 60)
    print("🤖 Оппоненты:")
    for opp in players[1:]:
        status = "СБРОСИЛ" if opp.get("folded") else f"Фишки: ${opp.get('chips')} | Ставка: ${opp.get('bet')}"
        print(f"   • {opp.get('name')} ({opp.get('position')}): {status}")

    print("-" * 60)
    print("📝 Лог стола:")
    for msg in state.get("log", [])[-4:]:
        print(f"   > {msg}")
    print("=" * 60)

def main():
    print("Подключение к покерному серверу...")
    state = fetch_table_state()
    if not state:
        print("Пожалуйста, убедитесь, что запущен сервер: `python poker_server.py`")
        return

    while True:
        state = fetch_table_state()
        if not state:
            time.sleep(2)
            continue

        print_table(state)
        
        stage = state.get("stage")
        if stage == "SHOWDOWN":
            print("\nРаздача завершена!")
            cmd = input("Нажмите Enter для следующей раздачи или 'q' для выхода: ").strip().lower()
            if cmd == 'q':
                break
            start_new_hand()
            continue

        print("\nВыберите действие:")
        print("  [c] Check / Call")
        print("  [r] Raise (Повысить)")
        print("  [f] Fold (Сбросить)")
        print("  [n] Новая раздача")
        print("  [q] Выход")
        
        choice = input("Ваш ход > ").strip().lower()
        if choice == 'q':
            break
        elif choice == 'c':
            hero = state["players"][0]
            curr_bet = state.get("current_bet", 0)
            if curr_bet > hero.get("bet", 0):
                send_action("call")
            else:
                send_action("check")
        elif choice == 'r':
            try:
                amt = int(input("Введите общую сумму ставки (например 60): "))
                send_action("raise", amt)
            except ValueError:
                print("Некорректная сумма.")
                time.sleep(1)
        elif choice == 'f':
            send_action("fold")
        elif choice == 'n':
            start_new_hand()
        
        time.sleep(0.3)

if __name__ == "__main__":
    main()
