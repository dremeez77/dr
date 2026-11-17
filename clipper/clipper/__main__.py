"""CLI: python -m clipper {run|check|process|youtube-auth}."""
from __future__ import annotations

import argparse
import asyncio
import logging
import shutil
import sys
import time
from pathlib import Path

from . import config


def cmd_run(s: config.Settings, _):
    from .pipeline import Pipeline
    asyncio.run(Pipeline(s).run())


def cmd_check(s: config.Settings, _):
    ok = True
    for b in ("ffmpeg", "ffprobe", "streamlink", "yt-dlp"):
        found = shutil.which(b)
        print(f"{'✅' if found else '❌'} {b}")
        ok &= bool(found)
    for name, val in (("TWITCH_CLIENT_ID", s.twitch_client_id), ("TWITCH_CLIENT_SECRET", s.twitch_client_secret),
                      ("TELEGRAM_BOT_TOKEN", s.telegram_token)):
        print(f"{'✅' if val else '⚠️ '} {name}")
    print(f"{'✅' if s.telegram_chats else '⚠️ '} telegram chats: {s.telegram_chats}")
    for aud, tok in s.youtube_tokens.items():
        print(f"{'✅' if Path(tok).exists() else '⚠️ '} YouTube токен [{aud}]: {tok}")
    if s.twitch_client_id and s.twitch_client_secret:
        import aiohttp
        from .twitch import Twitch

        async def go():
            async with aiohttp.ClientSession() as sess:
                tw = Twitch(s.twitch_client_id, s.twitch_client_secret, sess)
                logins = [st.channel for st in s.streamers if st.platform == "twitch"]
                ids = await tw.resolve_users(logins)
                for l in logins:
                    print(f"{'✅' if l in ids else '❌ не найден на Twitch:'} twitch/{l}")
                live = await tw.live_streams(logins)
                for l, info in live.items():
                    print(f"   🔴 {l}: {info.get('game_name')} — {info.get('title')[:60]}")
                print(f"   ID игры: {await tw.game_ids(s.game_names) or 'категория пока не найдена'}")
        asyncio.run(go())
    sys.exit(0 if ok else 1)


def cmd_process(s: config.Settings, a):
    """Прогнать локальный файл через конвейер (тест без живого стрима)."""
    from .pipeline import Job, Pipeline
    p = Pipeline(s)
    st = s.streamer(a.streamer)
    src = Path(a.file)
    work = s.data_dir / "work" / f"manual_{int(time.time())}{src.suffix}"
    shutil.copy(src, work)
    cid = p.db.create(f"manual:{src.name}:{time.time()}", st.name, st.audience, "manual", time.time())
    res = p.process(Job(cid, st, "manual", work, a.moment))
    if res:
        print(f"✅ {res['score']}/10 — {res['title']}\n{res['video']}\n{res['reason']}")
    else:
        print("❌ Отклонено судьёй (см. лог)")


def cmd_youtube_auth(s: config.Settings, a):
    from .youtube_upload import authorize
    out = Path(s.youtube_tokens.get(a.audience) or f"secrets/youtube_{a.audience}.json")
    authorize(Path(a.client_secrets), out)
    print(f"✅ Токен сохранён: {out}")


def main():
    ap = argparse.ArgumentParser(prog="clipper")
    ap.add_argument("-c", "--config", default="config.yaml")
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run", help="запустить конвейер")
    sub.add_parser("check", help="проверить окружение и логины стримеров")
    pp = sub.add_parser("process", help="обработать локальный видеофайл")
    pp.add_argument("file")
    pp.add_argument("--streamer", required=True)
    pp.add_argument("--moment", type=float, default=5.0, help="секунда с вебкой в кадре")
    ya = sub.add_parser("youtube-auth", help="авторизовать YouTube-канал")
    ya.add_argument("audience", choices=["ru", "en"])
    ya.add_argument("--client-secrets", default="secrets/client_secret.json")
    a = ap.parse_args()
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    for noisy in ("httpx", "httpx2", "faster_whisper", "googleapiclient"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    s = config.load(a.config)
    {"run": cmd_run, "check": cmd_check, "process": cmd_process, "youtube-auth": cmd_youtube_auth}[a.cmd](s, a)


if __name__ == "__main__":
    main()
