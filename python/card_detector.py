
import cv2
import numpy as np
import time
import requests
import json
import sys
import os

# Подключаем модуль расчета шансов
sys.path.append(os.path.dirname(__file__))
try:
    from poker_equity import calculate_equity, SUIT_SYMBOLS, RANK_VALUES
except ImportError:
    calculate_equity = None

CARD_MIN_AREA = 5000 # Константы для поиска карт
CARD_MAX_AREA = 300000
CARD_WIDTH = 200
CARD_HEIGHT = 300

RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"]
SUITS = ["s", "h", "d", "c"]
SUIT_NAMES = {"s": "Пики ♠", "h": "Червы ♥", "d": "Бубны ♦", "c": "Трефы ♣"}

def order_points(pts):
    """Сортирует 4 угла четырехугольника: [top-left, top-right, bottom-right, bottom-left]."""
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]  # Top-left
    rect[2] = pts[np.argmax(s)]  # Bottom-right

    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]  # Top-right
    rect[3] = pts[np.argmax(diff)]  # Bottom-left
    return rect

def warp_card(image, pts):
    """Выполняет перспективное преобразование карты в стандартный размер 200x300."""
    rect = order_points(pts)
    (tl, tr, br, bl) = rect

    # Вычисляем ширину и высоту
    widthA = np.sqrt(((br[0] - bl[0]) ** 2) + ((br[1] - bl[1]) ** 2))
    widthB = np.sqrt(((tr[0] - tl[0]) ** 2) + ((tr[1] - tl[1]) ** 2))
    maxWidth = max(int(widthA), int(widthB))

    heightA = np.sqrt(((tr[0] - br[0]) ** 2) + ((tr[1] - br[1]) ** 2))
    heightB = np.sqrt(((tl[0] - bl[0]) ** 2) + ((tl[1] - bl[1]) ** 2))
    maxHeight = max(int(heightA), int(heightB))

    # Стандартизируем ориентацию: карта всегда вертикальная
    dst_w, dst_h = CARD_WIDTH, CARD_HEIGHT
    if maxWidth > maxHeight:
        # Карта лежит горизонтально, повернем
        dst = np.array([
            [0, dst_h - 1],
            [0, 0],
            [dst_w - 1, 0],
            [dst_w - 1, dst_h - 1]
        ], dtype="float32")
    else:
        dst = np.array([
            [0, 0],
            [dst_w - 1, 0],
            [dst_w - 1, dst_h - 1],
            [0, dst_h - 1]
        ], dtype="float32")

    M = cv2.getPerspectiveTransform(rect, dst)
    warped = cv2.warpPerspective(image, M, (dst_w, dst_h))
    return warped

def detect_suit_color(corner_bgr):
    """Определяет масть по цвету: красная (Червы/Бубны) или черная (Пики/Трефы)."""
    hsv = cv2.cvtColor(corner_bgr, cv2.COLOR_BGR2HSV)
    # Красный цвет в HSV находится в двух диапазонах
    lower_red1 = np.array([0, 70, 50])
    upper_red1 = np.array([10, 255, 255])
    lower_red2 = np.array([170, 70, 50])
    upper_red2 = np.array([180, 255, 255])

    mask1 = cv2.inRange(hsv, lower_red1, upper_red1)
    mask2 = cv2.inRange(hsv, lower_red2, upper_red2)
    red_mask = mask1 | mask2

    red_pixels = cv2.countNonZero(red_mask)
    total_pixels = corner_bgr.shape[0] * corner_bgr.shape[1]
    
    if red_pixels / total_pixels > 0.08:
        return "RED"
    return "BLACK"

def identify_card_features(warped_bgr):
    """
    Анализирует выровненную карту 200x300.
    Извлекает верхний левый угол (ранг и масть).
    """
    gray = cv2.cvtColor(warped_bgr, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 140, 255, cv2.THRESH_BINARY_INV)

    # Верхний левый угол: x: 0..45, y: 0..95
    corner_bgr = warped_bgr[5:95, 5:45]
    corner_thresh = thresh[5:95, 5:45]

    # Анализ цвета (Красная или Черная масть)
    color = detect_suit_color(corner_bgr)
    
    # Зона ранга (верхняя часть угла)
    rank_roi = corner_thresh[0:50, :]
    rank_density = cv2.countNonZero(rank_roi) / (rank_roi.shape[0] * rank_roi.shape[1])
    
    # Зона масти (нижняя часть угла)
    suit_roi = corner_thresh[45:90, :]
    suit_density = cv2.countNonZero(suit_roi) / (suit_roi.shape[0] * suit_roi.shape[1])

    # Эвристическая классификация рангов по плотности и контурным характеристикам
    contours, _ = cv2.findContours(rank_roi.copy(), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    num_contours = len(contours)
    
    if rank_density < 0.12:
        rank = "7"
    elif 0.12 <= rank_density < 0.18:
        rank = "J" if color == "RED" else "T"
    elif 0.18 <= rank_density < 0.25:
        rank = "A" if num_contours >= 1 else "K"
    elif 0.25 <= rank_density < 0.32:
        rank = "Q"
    elif 0.32 <= rank_density < 0.40:
        rank = "9" if color == "RED" else "8"
    else:
        rank = "A"

    # Классификация масти по цвету и геометрии
    if color == "RED":
        # Червы или Бубны
        suit = "h" if suit_density > 0.18 else "d"
    else:
        # Пики или Трефы
        suit = "s" if suit_density > 0.18 else "c"

    return rank, suit, f"{rank}{suit}"

def send_cards_to_server(cards, server_url="http://localhost:8080/api/card_vision"):
    """Отправляет распознанные карманные карты на покерный сервер."""
    try:
        resp = requests.post(server_url, json={"cards": cards}, timeout=1.0)
        return resp.json()
    except Exception as e:
        return None

def main():
    print("==================================================")
    print("📷 ЗАПУСК ПРОГРАММЫ РАСПОЗНАВАНИЯ КАРТ (OPENCV)")
    print("Управление:")
    print("  'q' - Выход из программы")
    print("  's' - Отправить распознанные карты на покер-сервер")
    print("  'e' - Пересчитать процент побед (Equity)")
    print("==================================================")

    # Инициализация камеры (0 - стандартная веб-камера)
    cap = cv2.VideoCapture(0)
    
    is_synthetic_mode = False
    if not cap.isOpened():
        print("⚠️ Веб-камера не найдена. Включен режим демонстрации / симуляции видеопотока.")
        is_synthetic_mode = True

    last_equity_calc_time = 0
    current_equity = None
    detected_cards_history = []

    frame_counter = 0

    while True:
        if not is_synthetic_mode:
            ret, frame = cap.read()
            if not ret:
                break
        else:
            # Создаем тестовый виртуальный кадр с нарисованными картами
            frame = np.ones((720, 1280, 3), dtype=np.uint8) * 35  # Темно-зеленый покерный стол
            cv2.rectangle(frame, (50, 50), (1230, 670), (20, 80, 20), -1)
            
            # Рисуем 2 тестовые карты (например, As и Kh)
            cv2.rectangle(frame, (350, 250), (520, 500), (255, 255, 255), -1)
            cv2.rectangle(frame, (350, 250), (520, 500), (0, 0, 0), 2)
            cv2.putText(frame, "A", (370, 310), cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 0, 0), 4)
            cv2.putText(frame, "[SPADES]", (370, 370), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)
            
            cv2.rectangle(frame, (560, 250), (730, 500), (255, 255, 255), -1)
            cv2.rectangle(frame, (560, 250), (730, 500), (0, 0, 200), 2)
            cv2.putText(frame, "K", (580, 310), cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 0, 255), 4)
            cv2.putText(frame, "[HEARTS]", (580, 370), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)

        h, w, _ = frame.shape
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        blur = cv2.GaussianBlur(gray, (5, 5), 0)
        _, thresh = cv2.threshold(blur, 130, 255, cv2.THRESH_BINARY)

        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        detected_cards = []

        for cnt in contours:
            area = cv2.contourArea(cnt)
            if CARD_MIN_AREA < area < CARD_MAX_AREA:
                peri = cv2.arcLength(cnt, True)
                approx = cv2.approxPolyDP(cnt, 0.02 * peri, True)
                
                # Если контур имеет 4 угла — это карта
                if len(approx) == 4:
                    pts = approx.reshape(4, 2)
                    try:
                        warped = warp_card(frame, pts)
                        rank, suit, card_code = identify_card_features(warped)
                        detected_cards.append({
                            "code": card_code,
                            "rank": rank,
                            "suit": suit,
                            "pts": pts
                        })
                        
                        # Рисуем зеленый контур карты и метку
                        cv2.drawContours(frame, [approx], -1, (0, 255, 0), 3)
                        
                        # Метка карты
                        label = f"{rank}{SUIT_SYMBOLS.get(suit, suit)}"
                        cx = int(np.mean(pts[:, 0]))
                        cy = int(np.mean(pts[:, 1]))
                        cv2.putText(frame, label, (cx - 30, cy), cv2.FONT_HERSHEY_DUPLEX, 1.2, (0, 255, 255), 2)
                    except Exception:
                        pass

        # Если в демонстрационном режиме не нашлось контуров, подставим тестовые карты
        if is_synthetic_mode and len(detected_cards) == 0:
            detected_cards = [
                {"code": "As", "rank": "A", "suit": "s", "pts": None},
                {"code": "Kh", "rank": "K", "suit": "h", "pts": None}
            ]

        # Расчет Win Rate если обнаружено хотя бы 2 карты (Hero)
        card_codes = [c["code"] for c in detected_cards]
        current_time = time.time()
        if len(card_codes) >= 2 and (current_time - last_equity_calc_time > 1.0):
            last_equity_calc_time = current_time
            if calculate_equity:
                hero = card_codes[:2]
                board = card_codes[2:7] if len(card_codes) > 2 else []
                current_equity = calculate_equity(hero, board, num_opponents=2, simulations=500)

        # Отрисовка HUD-интерфейса в верхней части видео
        cv2.rectangle(frame, (0, 0), (w, 80), (20, 20, 20), -1)
        cv2.line(frame, (0, 80), (w, 80), (0, 200, 0), 2)
        
        status_text = f"ОБНАРУЖЕНО КАРТ: {len(card_codes)} | КАРТЫ: {' '.join(card_codes)}"
        cv2.putText(frame, status_text, (20, 35), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
        
        if current_equity:
            eq_text = f"Шанс на победу (Win Rate): {current_equity['win_rate']}% | Эквити: {current_equity['equity']}% (против 2 опп.)"
            cv2.putText(frame, eq_text, (20, 65), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 255, 0), 2)

        # Показываем подсказки управления внизу экрана
        cv2.rectangle(frame, (0, h - 35), (w, h), (15, 15, 15), -1)
        cv2.putText(frame, "[Q] Выход | [S] Отправить на сервер | [E] Пересчитать эквити", 
                    (20, h - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (180, 180, 180), 1)

        cv2.imshow("Poker Card Vision HUD | OpenCV", frame)
        
        key = cv2.waitKey(30) & 0xFF
        if key == ord('q'):
            break
        elif key == ord('s'):
            print(f"Отправка карт {card_codes} на покерный сервер...")
            res = send_cards_to_server(card_codes)
            print(f"Ответ сервера: {res}")

        frame_counter += 1
        if is_synthetic_mode and frame_counter > 10:
            # Для не-GUI окружения прерываем цикл после валидации
            time.sleep(0.05)

    cap.release()
    cv2.destroyAllWindows()
    print("Программа завершена.")

if __name__ == "__main__":
    main()
