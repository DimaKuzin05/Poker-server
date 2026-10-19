
import http.server
import socketserver
import json
import sqlite3
import random
import os
import time
from urllib.parse import urlparse, parse_qs
from typing import List, Dict, Any

from poker_equity import calculate_equity, evaluate_7_cards, make_deck, SUIT_SYMBOLS

DB_FILE = os.path.join(os.path.dirname(__file__), "poker_stats.db")

def init_db():
    """Инициализация базы данных SQLite для сбора статистики покера."""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            pot INTEGER,
            board_cards TEXT,
            winner_name TEXT,
            winner_hand TEXT
        )
    """)
    
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS hand_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id INTEGER,
            player_name TEXT,
            hole_cards TEXT,
            starting_hand TEXT, -- например 'AA', 'AKs', '72o'
            position TEXT,       -- BTN, CO, MP, UTG, SB, BB
            won INTEGER,         -- 1 если выиграл, 0 если проиграл
            profit INTEGER,
            final_hand TEXT,
            win_rate_equity REAL,
            FOREIGN KEY(game_id) REFERENCES games(id)
        )
    """)
    
    # Проверим, есть ли записи, если нет - создадим стартовые тестовые данные
    cursor.execute("SELECT COUNT(*) FROM hand_stats")
    if cursor.fetchone()[0] == 0:
        seed_sample_data(cursor)
    
    conn.commit()
    conn.close()

def get_hand_category(c1: str, c2: str) -> str:
    """Возвращает категорию руки, например 'AKs', 'AKo', 'AA'."""
    r1, s1 = c1[0].upper(), c1[1].lower()
    r2, s2 = c2[0].upper(), c2[1].lower()
    from poker_equity import RANK_VALUES
    if RANK_VALUES.get(r1, 0) < RANK_VALUES.get(r2, 0):
        r1, r2 = r2, r1
        s1, s2 = s2, s1
    
    if r1 == r2:
        return f"{r1}{r2}"
    elif s1 == s2:
        return f"{r1}{r2}s"
    else:
        return f"{r1}{r2}o"

def seed_sample_data(cursor):
    """Генерирует репрезентативную начальную статистику для немедленной визуализации."""
    positions = ["BTN", "CO", "MP", "UTG", "SB", "BB"]
    players = ["Hero (Вы)", "Bot_Aggressive", "Bot_Tight", "Bot_CallingStation"]
    
    deck = make_deck()
    for g in range(1, 101):
        random.shuffle(deck)
        board = deck[:5]
        pot = random.randint(30, 450)
        
        # Рука Hero
        hero_hole = [deck[5], deck[6]]
        hero_pos = positions[g % len(positions)]
        hero_cat = get_hand_category(hero_hole[0], hero_hole[1])
        
        # 3 оппонента
        opp1 = [deck[7], deck[8]]
        opp2 = [deck[9], deck[10]]
        opp3 = [deck[11], deck[12]]
        
        all_players = [
            ("Hero (Вы)", hero_hole, hero_pos),
            ("Bot_Aggressive", opp1, positions[(g+1) % len(positions)]),
            ("Bot_Tight", opp2, positions[(g+2) % len(positions)]),
            ("Bot_CallingStation", opp3, positions[(g+3) % len(positions)])
        ]
        
        # Определяем победителя
        scores = []
        for p_name, cards, pos in all_players:
            rank_val, kickers, hand_name = evaluate_7_cards(cards + board)
            scores.append((rank_val, kickers, hand_name, p_name, cards, pos))
        
        scores.sort(key=lambda x: (x[0], x[1]), reverse=True)
        winner_name = scores[0][3]
        winner_hand = scores[0][2]
        
        cursor.execute(
            "INSERT INTO games (pot, board_cards, winner_name, winner_hand) VALUES (?, ?, ?, ?)",
            (pot, " ".join(board), winner_name, winner_hand)
        )
        game_id = cursor.lastrowid
        
        # Записываем статы каждого игрока
        for item in scores:
            p_name, cards, pos = item[3], item[4], item[5]
            is_winner = 1 if p_name == winner_name else 0
            profit = pot - 40 if is_winner else -40
            cat = get_hand_category(cards[0], cards[1])
            eq = 50.0 if is_winner else 25.0
            
            cursor.execute("""
                INSERT INTO hand_stats 
                (game_id, player_name, hole_cards, starting_hand, position, won, profit, final_hand, win_rate_equity)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (game_id, p_name, " ".join(cards), cat, pos, is_winner, profit, item[2], eq))

class PokerGameState:
    """Состояние живой покерной игры за столом."""
    def __init__(self):
        self.reset_table()

    def reset_table(self):
        self.deck = make_deck()
        random.shuffle(self.deck)
        self.community_cards: List[str] = []
        self.pot = 0
        self.current_bet = 20
        self.stage = "PREFLOP"  # PREFLOP, FLOP, TURN, RIVER, SHOWDOWN
        self.players = [
            {"id": 1, "name": "Hero (Вы)", "chips": 1000, "cards": [self.deck.pop(), self.deck.pop()], "bet": 20, "folded": False, "position": "BTN", "is_bot": False},
            {"id": 2, "name": "Bot_Alex", "chips": 980, "cards": [self.deck.pop(), self.deck.pop()], "bet": 20, "folded": False, "position": "SB", "is_bot": True},
            {"id": 3, "name": "Bot_Elena", "chips": 960, "cards": [self.deck.pop(), self.deck.pop()], "bet": 20, "folded": False, "position": "BB", "is_bot": True},
        ]
        self.pot = 60
        self.log: List[str] = ["Раздача началась. Малый блайнд: 10, Большой блайнд: 20."]
        self.calculate_live_equity()

    def calculate_live_equity(self):
        hero = self.players[0]
        if not hero["folded"]:
            active_opponents = len([p for p in self.players[1:] if not p["folded"]])
            if active_opponents > 0:
                eq_res = calculate_equity(hero["cards"], self.community_cards, num_opponents=active_opponents, simulations=600)
                self.hero_equity = eq_res
            else:
                self.hero_equity = {"win_rate": 100.0, "tie_rate": 0.0, "equity": 100.0, "hand_distribution": {}}
        else:
            self.hero_equity = {"win_rate": 0.0, "tie_rate": 0.0, "equity": 0.0, "hand_distribution": {}}

    def advance_stage(self):
        if self.stage == "PREFLOP":
            self.stage = "FLOP"
            self.community_cards = [self.deck.pop(), self.deck.pop(), self.deck.pop()]
            self.log.append(f"Флоп открыт: {' '.join(self.community_cards)}")
        elif self.stage == "FLOP":
            self.stage = "TURN"
            self.community_cards.append(self.deck.pop())
            self.log.append(f"Терн открыт: {self.community_cards[-1]}")
        elif self.stage == "TURN":
            self.stage = "RIVER"
            self.community_cards.append(self.deck.pop())
            self.log.append(f"Ривер открыт: {self.community_cards[-1]}")
        elif self.stage == "RIVER":
            self.stage = "SHOWDOWN"
            self.evaluate_showdown()
        
        self.calculate_live_equity()

    def evaluate_showdown(self):
        active = [p for p in self.players if not p["folded"]]
        scores = []
        for p in active:
            rank_val, kickers, hand_name = evaluate_7_cards(p["cards"] + self.community_cards)
            scores.append((rank_val, kickers, hand_name, p))
        
        scores.sort(key=lambda x: (x[0], x[1]), reverse=True)
        winner = scores[0][3]
        winner_hand = scores[0][2]
        winner["chips"] += self.pot
        self.log.append(f"Вскрытие! Победитель: {winner['name']} с комбинацией '{winner_hand}'. Банк: ${self.pot}!")
        
        # Сохранение в БД
        self.save_to_db(winner, winner_hand)

    def save_to_db(self, winner, winner_hand):
        try:
            conn = sqlite3.connect(DB_FILE)
            cur = conn.cursor()
            cur.execute("INSERT INTO games (pot, board_cards, winner_name, winner_hand) VALUES (?, ?, ?, ?)",
                        (self.pot, " ".join(self.community_cards), winner["name"], winner_hand))
            game_id = cur.lastrowid
            
            for p in self.players:
                is_win = 1 if p["id"] == winner["id"] else 0
                cat = get_hand_category(p["cards"][0], p["cards"][1])
                profit = (self.pot - p["bet"]) if is_win else -p["bet"]
                final_name = winner_hand if is_win else "Проигрыш"
                eq = self.hero_equity.get("equity", 50.0) if p["id"] == 1 else 30.0
                cur.execute("""
                    INSERT INTO hand_stats (game_id, player_name, hole_cards, starting_hand, position, won, profit, final_hand, win_rate_equity)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (game_id, p["name"], " ".join(p["cards"]), cat, p["position"], is_win, profit, final_name, eq))
            
            conn.commit()
            conn.close()
        except Exception as e:
            print("DB Save error:", e)

    def player_action(self, action: str, amount: int = 0):
        hero = self.players[0]
        if hero["folded"] or self.stage == "SHOWDOWN":
            return
        
        if action == "fold":
            hero["folded"] = True
            self.log.append("Hero сбросил карты (Fold).")
        elif action == "check":
            self.log.append("Hero сделал Чек (Check).")
        elif action == "call":
            call_cost = self.current_bet - hero["bet"]
            hero["chips"] -= call_cost
            hero["bet"] += call_cost
            self.pot += call_cost
            self.log.append(f"Hero коллировал ${call_cost} (Call).")
        elif action == "raise":
            raise_amt = max(amount, 40)
            diff = raise_amt - hero["bet"]
            hero["chips"] -= diff
            hero["bet"] = raise_amt
            self.pot += diff
            self.current_bet = raise_amt
            self.log.append(f"Hero повысил ставку до ${raise_amt} (Raise)!")
        
        # Реакция ботов
        for b in self.players[1:]:
            if not b["folded"]:
                if action == "fold" and len([p for p in self.players if not p["folded"]]) == 1:
                    break
                bot_act = random.choice(["call", "call", "check", "raise"] if action != "raise" else ["call", "fold"])
                if bot_act == "call":
                    diff = self.current_bet - b["bet"]
                    b["chips"] -= diff
                    b["bet"] += diff
                    self.pot += diff
                    self.log.append(f"{b['name']} ответил ${diff} (Call).")
                elif bot_act == "fold":
                    b["folded"] = True
                    self.log.append(f"{b['name']} сбросил карты (Fold).")
        
        active_remaining = [p for p in self.players if not p["folded"]]
        if len(active_remaining) == 1:
            winner = active_remaining[0]
            winner["chips"] += self.pot
            self.stage = "SHOWDOWN"
            self.log.append(f"Все оппоненты сбросили карты. Победил {winner['name']}!")
            self.save_to_db(winner, "Победа по фолдам")
        else:
            self.advance_stage()

TABLE = PokerGameState()

class PokerHTTPHandler(http.server.SimpleHTTPRequestHandler):
    """REST API обработчик для покерного сервера и дашборда Streamlit."""
    
    def _send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def do_OPTIONS(self):
        self._send_json({"status": "ok"})

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == "/api/table":
            # Текущее состояние стола
            data = {
                "stage": TABLE.stage,
                "pot": TABLE.pot,
                "current_bet": TABLE.current_bet,
                "community_cards": TABLE.community_cards,
                "players": TABLE.players,
                "hero_equity": TABLE.hero_equity,
                "log": TABLE.log[-10:]
            }
            self._send_json(data)
            return

        elif path == "/api/stats/summary":
            # Сводные показатели процента побед
            conn = sqlite3.connect(DB_FILE)
            cur = conn.cursor()
            
            cur.execute("SELECT COUNT(*) FROM games")
            total_games = cur.fetchone()[0]
            
            cur.execute("SELECT COUNT(*), SUM(won), SUM(profit) FROM hand_stats WHERE player_name LIKE 'Hero%'")
            hero_stats = cur.fetchone()
            hero_hands = hero_stats[0] or 0
            hero_wins = hero_stats[1] or 0
            hero_profit = hero_stats[2] or 0
            hero_win_rate = round((hero_wins / hero_hands * 100), 1) if hero_hands > 0 else 0
            
            # Лучшая стартовая рука
            cur.execute("""
                SELECT starting_hand, COUNT(*) as cnt, SUM(won) as wins, 
                       ROUND(CAST(SUM(won) AS FLOAT)/COUNT(*)*100, 1) as wr
                FROM hand_stats 
                WHERE player_name LIKE 'Hero%'
                GROUP BY starting_hand 
                HAVING cnt >= 2
                ORDER BY wr DESC, cnt DESC 
                LIMIT 1
            """)
            best_row = cur.fetchone()
            best_hand = f"{best_row[0]} ({best_row[3]}% Win)" if best_row else "AA (85%)"

            conn.close()
            self._send_json({
                "total_games": total_games,
                "hero_hands": hero_hands,
                "hero_wins": hero_wins,
                "hero_win_rate": hero_win_rate,
                "hero_profit": hero_profit,
                "best_starting_hand": best_hand
            })
            return

        elif path == "/api/stats/starting_hands":
            # 13x13 тепловая матрица процента побед по стартовым рукам
            conn = sqlite3.connect(DB_FILE)
            cur = conn.cursor()
            cur.execute("""
                SELECT starting_hand, COUNT(*) as samples, SUM(won) as wins,
                       ROUND(CAST(SUM(won) AS FLOAT)/COUNT(*)*100, 1) as win_rate,
                       SUM(profit) as total_profit
                FROM hand_stats
                GROUP BY starting_hand
            """)
            rows = cur.fetchall()
            conn.close()
            
            data = [
                {"hand": r[0], "samples": r[1], "wins": r[2], "win_rate": r[3], "profit": r[4]}
                for r in rows
            ]
            self._send_json(data)
            return

        elif path == "/api/stats/positions":
            # Статистика побед по позициям
            conn = sqlite3.connect(DB_FILE)
            cur = conn.cursor()
            cur.execute("""
                SELECT position, COUNT(*) as total, SUM(won) as wins,
                       ROUND(CAST(SUM(won) AS FLOAT)/COUNT(*)*100, 1) as win_rate,
                       SUM(profit) as profit
                FROM hand_stats
                WHERE player_name LIKE 'Hero%'
                GROUP BY position
            """)
            rows = cur.fetchall()
            conn.close()
            data = [
                {"position": r[0], "total": r[1], "wins": r[2], "win_rate": r[3], "profit": r[4]}
                for r in rows
            ]
            self._send_json(data)
            return

        elif path == "/api/stats/history":
            # Последние раздачи
            conn = sqlite3.connect(DB_FILE)
            cur = conn.cursor()
            cur.execute("""
                SELECT g.id, g.timestamp, g.pot, g.board_cards, g.winner_name, g.winner_hand,
                       h.hole_cards, h.starting_hand, h.won, h.profit
                FROM games g
                JOIN hand_stats h ON g.id = h.game_id AND h.player_name LIKE 'Hero%'
                ORDER BY g.id DESC
                LIMIT 50
            """)
            rows = cur.fetchall()
            conn.close()
            data = [
                {
                    "game_id": r[0],
                    "timestamp": r[1],
                    "pot": r[2],
                    "board_cards": r[3],
                    "winner_name": r[4],
                    "winner_hand": r[5],
                    "hero_cards": r[6],
                    "starting_hand": r[7],
                    "won": bool(r[8]),
                    "profit": r[9]
                }
                for r in rows
            ]
            self._send_json(data)
            return

        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8') if content_length > 0 else "{}"
        try:
            payload = json.loads(body)
        except Exception:
            payload = {}

        if path == "/api/action":
            # Действие игрока за столом (fold, check, call, raise)
            action = payload.get("action", "check")
            amount = payload.get("amount", 0)
            TABLE.player_action(action, amount)
            self._send_json({"status": "ok", "stage": TABLE.stage, "pot": TABLE.pot})
            return

        elif path == "/api/new_hand":
            # Начало новой раздачи
            TABLE.reset_table()
            self._send_json({"status": "ok", "message": "Новая раздача начата."})
            return

        elif path == "/api/equity":
            # Расчет эквити (Win Rate)
            hero = payload.get("hero_cards", ["As", "Kd"])
            board = payload.get("board_cards", [])
            opponents = payload.get("opponents", 1)
            sims = payload.get("simulations", 1500)
            result = calculate_equity(hero, board, num_opponents=opponents, simulations=sims)
            self._send_json(result)
            return

        elif path == "/api/simulate":
            # Автоматическая симуляция N раздач для генерации статистики
            n = min(payload.get("count", 50), 500)
            conn = sqlite3.connect(DB_FILE)
            cur = conn.cursor()
            seed_sample_data(cur)
            conn.commit()
            conn.close()
            self._send_json({"status": "ok", "generated": n})
            return

        elif path == "/api/card_vision":
            # Прием распознанных камерой карт от card_detector.py
            cards = payload.get("cards", [])
            print(f"[CARD VISION] Получены карты с камеры: {cards}")
            
            # Если передано 2 карты — это карманные карты Hero
            if len(cards) >= 2:
                TABLE.players[0]["cards"] = cards[:2]
            if len(cards) >= 5:
                TABLE.community_cards = cards[2:5]
            TABLE.calculate_live_equity()
            
            self._send_json({
                "status": "ok",
                "received_cards": cards,
                "hero_equity": TABLE.hero_equity
            })
            return

        self._send_json({"error": "Unknown endpoint"}, status=404)

def run_server(port=8080):
    """Запуск сервера."""
    init_db()
    print(f"==================================================")
    print(f"🃏 ПОКЕРНЫЙ СЕРВЕР ЗАПУЩЕН НА ПОРТУ {port}")
    print(f"📊 SQLite база данных: {DB_FILE}")
    print(f"⚡ API эндпоинты:")
    print(f"   - GET  /api/table           (Состояние игры)")
    print(f"   - GET  /api/stats/summary   (Процент побед)")
    print(f"   - GET  /api/stats/starting_hands (Матрица рук)")
    print(f"   - POST /api/equity          (Расчет Win Rate)")
    print(f"   - POST /api/card_vision     (Прием карт с камеры)")
    print(f"==================================================")
    with socketserver.ThreadingTCPServer(("0.0.0.0", port), PokerHTTPHandler) as httpd:
        httpd.serve_forever()

if __name__ == "__main__":
    run_server(8080)
