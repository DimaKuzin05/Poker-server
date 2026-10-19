
import streamlit as st
import pandas as pd
import sqlite3
import os
import sys

# Подключение модуля расчета эквити
sys.path.append(os.path.dirname(__file__))
from poker_equity import calculate_equity, RANKS, SUITS, SUIT_SYMBOLS, HAND_NAMES

# Конфигурация страницы
st.set_page_config(
    page_title="Poker Win-Rate Analytics | Streamlit",
    page_icon="🃏",
    layout="wide",
    initial_sidebar_state="expanded"
)

DB_FILE = os.path.join(os.path.dirname(__file__), "poker_stats.db")

def get_connection():
    """Подключение к базе данных SQLite."""
    return sqlite3.connect(DB_FILE)

def load_summary_metrics():
    """Загрузка ключевых метрик побед."""
    conn = get_connection()
    cur = conn.cursor()
    
    cur.execute("SELECT COUNT(*) FROM games")
    total_games = cur.fetchone()[0]
    
    cur.execute("""
        SELECT COUNT(*), SUM(won), SUM(profit) 
        FROM hand_stats 
        WHERE player_name LIKE 'Hero%'
    """)
    res = cur.fetchone()
    total_hands = res[0] or 0
    total_wins = res[1] or 0
    total_profit = res[2] or 0
    win_rate = round((total_wins / total_hands * 100), 1) if total_hands > 0 else 0
    
    # Лучшая рука
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
    best_hand_row = cur.fetchone()
    best_hand = f"{best_hand_row[0]} ({best_hand_row[3]}%)" if best_hand_row else "AA (85%)"
    
    conn.close()
    return total_games, total_hands, total_wins, win_rate, total_profit, best_hand

def load_starting_hands_matrix():
    """Загрузка данных для 13x13 тепловой матрицы стартовых рук."""
    ranks = list("AKQJT98765432")
    matrix = pd.DataFrame(index=ranks, columns=ranks, data=0.0)
    samples_matrix = pd.DataFrame(index=ranks, columns=ranks, data=0)
    
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("""
        SELECT starting_hand, COUNT(*) as cnt, 
               ROUND(CAST(SUM(won) AS FLOAT)/COUNT(*)*100, 1) as wr
        FROM hand_stats
        GROUP BY starting_hand
    """)
    rows = cur.fetchall()
    conn.close()
    
    stats_dict = {r[0]: (r[1], r[2]) for r in rows}
    
    for i, r1 in enumerate(ranks):
        for j, r2 in enumerate(ranks):
            if i == j:
                hand = f"{r1}{r2}"
            elif i < j:
                hand = f"{r1}{r2}s"  # Одномастные (Suited)
            else:
                hand = f"{r2}{r1}o"  # Разномастные (Offsuit)
            
            if hand in stats_dict:
                cnt, wr = stats_dict[hand]
                matrix.loc[r1, r2] = wr
                samples_matrix.loc[r1, r2] = cnt
            else:
                # Базовые теоретические ожидания эквити если нет достаточных выборок
                matrix.loc[r1, r2] = 50.0 if i == j else (45.0 if i < j else 35.0)
                samples_matrix.loc[r1, r2] = 0
                
    return matrix, samples_matrix

# Боковая панель
with st.sidebar:
    st.header("⚙️ Управление Покер-Сервером")
    st.markdown("Сбор и анализ процентов побед в покере.")
    
    if st.button("🎲 Сгенерировать 50 раздач в БД", use_container_width=True):
        from poker_server import seed_sample_data
        conn = get_connection()
        seed_sample_data(conn.cursor())
        conn.commit()
        conn.close()
        st.success("Успешно добавлено 50 симулированных раздач!")
        st.rerun()

    st.markdown("---")
    st.markdown("### 📡 Источник данных")
    st.info(f"SQLite файл:\n`{os.path.basename(DB_FILE)}`")
    
    st.markdown("---")
    st.markdown("### 📷 Распознавание карт")
    st.caption("Для захвата карт через камеру запустите в терминале: `python card_detector.py`")

# Заголовок страницы
st.title("🃏 Poker Win-Rate & Hand Analytics")
st.markdown("Дашборд анализа процента побед, тепловой матрицы рук и шансов банка (Equity).")

# 1. KPI Метрики
total_games, total_hands, total_wins, win_rate, total_profit, best_hand = load_summary_metrics()

c1, c2, c3, c4, c5 = st.columns(5)
c1.metric("Сыграно раздач", total_hands)
c2.metric("Процент побед (Win Rate)", f"{win_rate}%", delta=f"{win_rate - 50.0:.1f}% vs baseline")
c3.metric("Всего побед", total_wins)
c4.metric("Профит ($)", f"${total_profit}", delta=f"{total_profit}$")
c5.metric("Топ-рука", best_hand)

st.markdown("---")

tab1, tab2, tab3, tab4 = st.tabs([
    "🔥 13x13 Матрица Win Rate",
    "🧮 Калькулятор Эквити (Монте-Карло)",
    "📍 Победы по позициям и банкролл",
    "📜 История раздач"
])

# Вкладка 1: 13x13 Тепловая матрица
with tab1:
    st.subheader("Тепловая карта процента побед по стартовым рукам (13x13)")
    st.caption("По диагонали: карманные пары (AA, KK..). Выше диагонали: одномастные (s). Ниже: разномастные (o).")
    
    matrix, samples_matrix = load_starting_hands_matrix()
    
    # Стилизация таблицы с градиентом
    st.dataframe(
        matrix.style.background_gradient(cmap="RdYlGn", vmin=20, vmax=85).format("{:.1f}%"),
        use_container_width=True,
        height=480
    )

# Вкладка 2: Калькулятор Эквити
with tab2:
    st.subheader("Монте-Карло расчет процента побед (Equity)")
    st.caption("Задайте карманные карты и карты стола для мгновенного расчета математического ожидания победы.")
    
    col_hero, col_board, col_settings = st.columns(3)
    
    with col_hero:
        st.markdown("**Карманные карты игрока (Hero)**")
        h1 = st.selectbox("Карта 1", ["As", "Ah", "Ad", "Ac", "Ks", "Kh", "Kd", "Kc", "Qs", "Qh", "Qd", "Qc", "Js", "Ts"], index=0)
        h2 = st.selectbox("Карта 2", ["Kd", "Kh", "Ks", "Kc", "Qd", "Qs", "Jh", "Th", "9s", "8s", "7c", "2h"], index=0)
        hero_selection = [h1, h2]
        
    with col_board:
        st.markdown("**Общие карты стола (Борд)**")
        use_board = st.checkbox("Задать борд (Флоп / Терн / Ривер)", value=True)
        if use_board:
            b1 = st.selectbox("Флоп 1", ["", "Ah", "Kd", "7s", "2c", "Qh", "Jd", "Tc"], index=1)
            b2 = st.selectbox("Флоп 2", ["", "7c", "9s", "3d", "5h", "Kh", "Qc"], index=1)
            b3 = st.selectbox("Флоп 3", ["", "2s", "8d", "4c", "Jc", "Ts"], index=1)
            b4 = st.selectbox("Терн (необязательно)", ["", "Qc", "Td", "Jh", "4s"], index=0)
            b5 = st.selectbox("Ривер (необязательно)", ["", "5s", "8c", "2d", "Ks"], index=0)
            board_selection = [c for c in [b1, b2, b3, b4, b5] if c != ""]
        else:
            board_selection = []

    with col_settings:
        st.markdown("**Параметры симуляции**")
        num_opponents = st.slider("Количество оппонентов", 1, 8, 2)
        sim_count = st.select_slider("Итераций Монте-Карло", options=[500, 1000, 2000, 5000], value=1000)
        calc_btn = st.button("🚀 Рассчитать вероятность победы", type="primary", use_container_width=True)

    if calc_btn or True:
        with st.spinner("Симуляция раздач..."):
            equity_result = calculate_equity(hero_selection, board_selection, num_opponents=num_opponents, simulations=sim_count)
            
            eq_c1, eq_c2, eq_c3 = st.columns(3)
            eq_c1.metric("Шанс на победу (Win %)", f"{equity_result['win_rate']}%")
            eq_c2.metric("Ничья (Tie %)", f"{equity_result['tie_rate']}%")
            eq_c3.metric("Итоговый Капитал", f"{equity_result['equity']}%")
            
            st.progress(equity_result['win_rate'] / 100.0)
            
            st.markdown("#### Вероятность получения комбинаций к риверу:")
            dist_df = pd.DataFrame([
                {"Комбинация": k, "Вероятность %": v}
                for k, v in equity_result['hand_distribution'].items()
            ])
            st.bar_chart(dist_df.set_index("Комбинация"))

# Вкладка 3: Позиции и банкролл
with tab3:
    st.subheader("Процент побед по позициям за столом")
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("""
        SELECT position, COUNT(*) as hands, SUM(won) as wins,
               ROUND(CAST(SUM(won) AS FLOAT)/COUNT(*)*100, 1) as win_rate,
               SUM(profit) as profit
        FROM hand_stats
        WHERE player_name LIKE 'Hero%'
        GROUP BY position
    """)
    pos_data = cur.fetchall()
    conn.close()
    
    if pos_data:
        pos_df = pd.DataFrame(pos_data, columns=["Позиция", "Раздач", "Побед", "Win Rate %", "Профит ($)"])
        st.bar_chart(pos_df.set_index("Позиция")["Win Rate %"])
        st.dataframe(pos_df, use_container_width=True)
    else:
        st.info("Нет данных по позициям.")

# Вкладка 4: История раздач
with tab4:
    st.subheader("Последние раздачи из базы данных")
    conn = get_connection()
    history_df = pd.read_sql_query("""
        SELECT g.id as ID, g.timestamp as Время, g.pot as Банк, g.board_cards as Борд,
               g.winner_name as Победитель, g.winner_hand as Комбинация,
               h.hole_cards as Карты_Hero, h.starting_hand as Тип_Руки,
               h.won as Победа, h.profit as Профит
        FROM games g
        JOIN hand_stats h ON g.id = h.game_id AND h.player_name LIKE 'Hero%'
        ORDER BY g.id DESC
        LIMIT 30
    """, conn)
    conn.close()
    
    st.dataframe(history_df, use_container_width=True)
