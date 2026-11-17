# GTA 6 Clipper — конвейер нарезок стримов

Автоматически ловит яркие моменты у стримеров, которые играют в GTA 6, монтирует вертикальные клипы
с субтитрами и присылает их тебе в Telegram. Ты нажимаешь одну кнопку, и клип уходит на YouTube Shorts.

## Как это работает

```
Twitch/YouTube API ──► кто сейчас в эфире с GTA 6
        │
        ├─► кольцевая запись стрима (последние 8 мин на диске)
        ├─► чат ──► детектор всплесков (KEKW, «ахах», «клип», рост скорости в 3+ раза)
        └─► клипы зрителей Twitch (популярные за 30 мин)
                     │
                     ▼
     Whisper (текст + таймкоды слов) ──► Claude: стоит ли публиковать (1–10),
     точные границы 12–58 с, заголовок, описание, хэштеги, хук на RU или EN
                     │
                     ▼
     ffmpeg: 9:16, вебка сверху (Claude сам находит её на кадре), игра снизу,
     крупные субтитры с подсветкой слова, хук, нормализация громкости
                     │
                     ▼
     Telegram: [✅ На YouTube] [📱 Выложу сам] [❌ Мимо]
```

Клип от момента до твоего телефона: примерно 1–3 минуты.

### Подборки «N стримеров реагируют на один момент»
Каждому моменту Claude даёт тег события в игре («Lucia prison escape cutscene»). Слабые одиночные
сюжетные моменты (4–5/10) не выбрасываются, а копятся в пуле. Раз в 20 минут Claude ищет одно и то же
событие у 2+ разных стримеров (отдельно для RU и EN), выбирает по куску реакции от каждого и порядок.
Конвейер монтирует ролик до 58 с: подпись `@стример` на каждом куске, общий хук, одинаковая громкость.
Готовый ролик приходит в Telegram с теми же кнопками. Собрать вручную: `/compile`.

## Установка (Docker, рекомендуется)

```bash
cd clipper
cp config.example.yaml config.yaml     # стримеры, чаты, настройки
cp .env.example .env                   # ключи
docker compose run --rm clipper python -m clipper check   # проверка логинов и окружения
docker compose up -d                   # запуск
docker compose logs -f                 # логи
```

Без Docker: Python 3.11+, `ffmpeg`, затем `pip install -r requirements.txt` и `python -m clipper run`.

### Ключи
| Что | Где взять |
|---|---|
| `TWITCH_CLIENT_ID/SECRET` | dev.twitch.tv/console/apps → Register Application |
| `TELEGRAM_BOT_TOKEN` | @BotFather → /newbot. Добавь бота в чат и напиши `/status`: бот ответит chat_id |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| YouTube | Google Cloud Console → включить YouTube Data API v3 → OAuth Client (Desktop) → `secrets/client_secret.json`, затем на машине с браузером: `python -m clipper youtube-auth ru` (и `en`); токены положить в `secrets/` на сервере |

## Команды
- `python -m clipper run`: запустить конвейер
- `python -m clipper check`: проверить бинарники, ключи и логины стримеров
- `python -m clipper process video.mp4 --streamer Buster`: прогнать локальный файл (тест)
- В Telegram: `/status`, `/pause`, `/resume`, `/compile`

## Железо
- CPU-сервер: 4–8 ядер, Whisper `small`, 2 воркера. Около 30–60 с на клип.
- GPU (любая NVIDIA от 6 ГБ): Whisper `large-v3`, `device: cuda`, 3–4 воркера. Около 10 с на клип.
- Сеть: ~3 Мбит/с на каждый записываемый стрим 720p. Диск: ~400 МБ на стрим (буфер 8 мин).
- Claude: примерно $0.01–0.03 за оценку клипа.

## Лимиты
- YouTube API по умолчанию даёт около 6 загрузок в день на проект. Подай заявку на увеличение квоты
  или заведи отдельный проект Google на каждый канал.
- TikTok, VK Клипы, Reels пока выкладываешь руками (кнопка «Выложу сам»): видео уже в чате.

## Тесты
```bash
pip install pytest && python -m pytest -q tests
```
