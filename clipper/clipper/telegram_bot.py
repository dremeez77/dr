"""Telegram-бот модерации: присылает готовый клип с кнопками, принимает решения."""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Awaitable, Callable

import aiohttp

log = logging.getLogger(__name__)
MAX_UPLOAD = 49 * 1024 * 1024

OnAction = Callable[[int, str], Awaitable[str]]     # (clip_id, action) -> текст статуса
OnCommand = Callable[[str], Awaitable[str]]        # (command) -> ответ


class TelegramBot:
    def __init__(self, token: str, session: aiohttp.ClientSession):
        self.api = f"https://api.telegram.org/bot{token}"
        self.session = session
        self.on_action: OnAction | None = None
        self.on_command: OnCommand | None = None
        self.allowed_chats: set[str] = set()

    async def _call(self, method: str, **params):
        async with self.session.post(f"{self.api}/{method}", json=params) as r:
            d = await r.json()
            if not d.get("ok"):
                log.warning("telegram %s failed: %s", method, d)
            return d.get("result")

    async def send_text(self, chat_id: str, text: str):
        return await self._call("sendMessage", chat_id=chat_id, text=text[:4000])

    @staticmethod
    def keyboard(clip_id: int, youtube: bool) -> dict:
        row = []
        if youtube:
            row.append({"text": "✅ На YouTube", "callback_data": f"yt:{clip_id}"})
        row.append({"text": "📱 Выложу сам", "callback_data": f"manual:{clip_id}"})
        row.append({"text": "❌ Мимо", "callback_data": f"reject:{clip_id}"})
        return {"inline_keyboard": [row]}

    async def send_clip(self, chat_id: str, video: Path, caption: str, clip_id: int, youtube: bool) -> int | None:
        markup = json.dumps(self.keyboard(clip_id, youtube))
        if video.stat().st_size > MAX_UPLOAD:
            res = await self._call("sendMessage", chat_id=chat_id, reply_markup=json.loads(markup),
                                   text=f"{caption}\n\n⚠️ Файл >50 МБ, лежит на сервере: {video}")
            return res and res["message_id"]
        form = aiohttp.FormData()
        form.add_field("chat_id", str(chat_id))
        form.add_field("caption", caption[:1024])
        form.add_field("supports_streaming", "true")
        form.add_field("reply_markup", markup)
        form.add_field("video", video.open("rb"), filename=video.name, content_type="video/mp4")
        async with self.session.post(f"{self.api}/sendVideo", data=form) as r:
            d = await r.json()
        if not d.get("ok"):
            log.warning("sendVideo failed: %s", d)
            return None
        return d["result"]["message_id"]

    async def send_photo(self, chat_id: str, photo: Path, caption: str, clip_id: int, youtube: bool) -> int | None:
        form = aiohttp.FormData()
        form.add_field("chat_id", str(chat_id))
        form.add_field("caption", caption[:1024])
        form.add_field("reply_markup", json.dumps(self.keyboard(clip_id, youtube)))
        form.add_field("photo", photo.open("rb"), filename=photo.name, content_type="image/jpeg")
        async with self.session.post(f"{self.api}/sendPhoto", data=form) as r:
            d = await r.json()
        if not d.get("ok"):
            log.warning("sendPhoto failed: %s", d)
            return None
        return d["result"]["message_id"]

    async def run(self):
        offset = 0
        while True:
            try:
                updates = await self._call("getUpdates", offset=offset, timeout=50,
                                           allowed_updates=["message", "callback_query"]) or []
                for u in updates:
                    offset = u["update_id"] + 1
                    await self._handle(u)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("telegram polling error: %s", e)
                await asyncio.sleep(5)

    async def _handle(self, u: dict):
        if "callback_query" in u:
            q = u["callback_query"]
            msg = q.get("message") or {}
            chat_id = str(msg.get("chat", {}).get("id", ""))
            if self.allowed_chats and chat_id not in self.allowed_chats:
                return
            action, _, cid = q.get("data", "").partition(":")
            status = await self.on_action(int(cid), action) if self.on_action and cid.isdigit() else "?"
            await self._call("answerCallbackQuery", callback_query_id=q["id"], text=status[:180])
            caption = (msg.get("caption") or msg.get("text") or "")
            edit = {"chat_id": chat_id, "message_id": msg.get("message_id"),
                    "reply_markup": {"inline_keyboard": []}}
            if "video" in msg or "photo" in msg:
                await self._call("editMessageCaption", caption=f"{caption}\n\n➡️ {status}"[:1024], **edit)
            else:
                await self._call("editMessageText", text=f"{caption}\n\n➡️ {status}"[:4000], **edit)
        elif "message" in u:
            m = u["message"]
            chat_id = str(m["chat"]["id"])
            text = m.get("text", "")
            if not text.startswith("/"):
                return
            if self.allowed_chats and chat_id not in self.allowed_chats:
                await self.send_text(chat_id, f"Этот чат не в списке. chat_id = {chat_id}")
                return
            if self.on_command:
                await self.send_text(chat_id, await self.on_command(text.split()[0].split("@")[0]))
