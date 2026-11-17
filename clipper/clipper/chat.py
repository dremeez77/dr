"""Чтение чатов: Twitch (анонимный IRC по WebSocket) и YouTube (chat-downloader)."""
from __future__ import annotations

import asyncio
import logging
import random
import threading
import time
from typing import Awaitable, Callable

import aiohttp

log = logging.getLogger(__name__)
OnMessage = Callable[[str, str, float], Awaitable[None] | None]  # (channel, text, ts)


def parse_privmsg(line: str) -> tuple[str, str] | None:
    """':nick!nick@nick.tmi.twitch.tv PRIVMSG #chan :text' -> (chan, text)."""
    if line.startswith("@"):
        line = line.split(" ", 1)[1] if " " in line else ""
    parts = line.split(" ", 3)
    if len(parts) < 4 or parts[1] != "PRIVMSG":
        return None
    chan = parts[2].lstrip("#").lower()
    text = parts[3][1:] if parts[3].startswith(":") else parts[3]
    return chan, text


class TwitchChat:
    URL = "wss://irc-ws.chat.twitch.tv:443"

    def __init__(self, session: aiohttp.ClientSession, on_message: OnMessage):
        self.session = session
        self.on_message = on_message
        self.channels: set[str] = set()
        self.ws: aiohttp.ClientWebSocketResponse | None = None

    async def join(self, chan: str):
        chan = chan.lower()
        if chan not in self.channels:
            self.channels.add(chan)
            if self.ws and not self.ws.closed:
                await self.ws.send_str(f"JOIN #{chan}")

    async def part(self, chan: str):
        chan = chan.lower()
        if chan in self.channels:
            self.channels.discard(chan)
            if self.ws and not self.ws.closed:
                await self.ws.send_str(f"PART #{chan}")

    async def run(self):
        while True:
            try:
                async with self.session.ws_connect(self.URL, heartbeat=60) as ws:
                    self.ws = ws
                    await ws.send_str("PASS SCHMOOPIIE")
                    await ws.send_str(f"NICK justinfan{random.randint(10000, 99999)}")
                    for c in list(self.channels):
                        await ws.send_str(f"JOIN #{c}")
                    log.info("Twitch chat connected, channels: %s", sorted(self.channels))
                    async for msg in ws:
                        if msg.type != aiohttp.WSMsgType.TEXT:
                            continue
                        now = time.time()
                        for line in msg.data.split("\r\n"):
                            if not line:
                                continue
                            if line.startswith("PING"):
                                await ws.send_str("PONG :tmi.twitch.tv")
                                continue
                            pm = parse_privmsg(line)
                            if pm:
                                r = self.on_message(pm[0], pm[1], now)
                                if asyncio.iscoroutine(r):
                                    await r
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("Twitch chat error: %s; reconnecting", e)
            await asyncio.sleep(5)


class YouTubeChat:
    """Чат YouTube-трансляции в отдельном потоке (библиотека синхронная)."""

    def __init__(self, name: str, video_url: str, on_message: OnMessage, loop: asyncio.AbstractEventLoop):
        self.name = name
        self.video_url = video_url
        self.on_message = on_message
        self.loop = loop
        self.stop_flag = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self.thread.start()

    def stop(self):
        self.stop_flag.set()

    def _emit(self, text: str):
        r = self.on_message(self.name.lower(), text, time.time())
        if asyncio.iscoroutine(r):
            asyncio.run_coroutine_threadsafe(r, self.loop)

    def _run(self):
        try:
            from chat_downloader import ChatDownloader
        except ImportError:
            log.error("chat-downloader не установлен — чат YouTube недоступен")
            return
        while not self.stop_flag.is_set():
            try:
                for m in ChatDownloader().get_chat(self.video_url):
                    if self.stop_flag.is_set():
                        return
                    text = m.get("message") or ""
                    if text:
                        self.loop.call_soon_threadsafe(self._emit, text)
            except Exception as e:  # noqa: BLE001
                log.warning("YouTube chat %s error: %s", self.name, e)
            self.stop_flag.wait(15)
