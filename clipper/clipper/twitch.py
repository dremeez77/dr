"""Минимальный клиент Twitch Helix API (app access token)."""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

import aiohttp

log = logging.getLogger(__name__)
HELIX = "https://api.twitch.tv/helix"


def parse_ts(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def iso(t: float) -> str:
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Twitch:
    def __init__(self, client_id: str, client_secret: str, session: aiohttp.ClientSession):
        self.client_id = client_id
        self.client_secret = client_secret
        self.session = session
        self.token = ""
        self.token_exp = 0.0
        self.user_ids: dict[str, str] = {}

    async def _auth(self):
        async with self.session.post("https://id.twitch.tv/oauth2/token", params={
            "client_id": self.client_id, "client_secret": self.client_secret,
            "grant_type": "client_credentials",
        }) as r:
            r.raise_for_status()
            d = await r.json()
        self.token = d["access_token"]
        self.token_exp = time.time() + d.get("expires_in", 3600) - 300

    async def get(self, path: str, params) -> list[dict]:
        if time.time() > self.token_exp:
            await self._auth()
        for attempt in range(2):
            headers = {"Client-Id": self.client_id, "Authorization": f"Bearer {self.token}"}
            async with self.session.get(f"{HELIX}/{path}", params=params, headers=headers) as r:
                if r.status == 401 and attempt == 0:
                    await self._auth()
                    continue
                r.raise_for_status()
                return (await r.json()).get("data", [])
        return []

    async def resolve_users(self, logins: list[str]) -> dict[str, str]:
        """login -> user_id (кэшируется)."""
        missing = [l for l in logins if l.lower() not in self.user_ids]
        for i in range(0, len(missing), 100):
            for u in await self.get("users", [("login", l) for l in missing[i:i + 100]]):
                self.user_ids[u["login"].lower()] = u["id"]
        return {l: self.user_ids[l.lower()] for l in logins if l.lower() in self.user_ids}

    async def live_streams(self, logins: list[str]) -> dict[str, dict]:
        """login -> данные стрима (только тех, кто сейчас в эфире)."""
        out = {}
        for i in range(0, len(logins), 100):
            for s in await self.get("streams", [("user_login", l) for l in logins[i:i + 100]]):
                out[s["user_login"].lower()] = s
        return out

    async def game_ids(self, names: list[str]) -> set[str]:
        return {g["id"] for g in await self.get("games", [("name", n) for n in names])}

    async def recent_clips(self, broadcaster_id: str, since: float, first: int = 20) -> list[dict]:
        return await self.get("clips", {
            "broadcaster_id": broadcaster_id, "started_at": iso(since), "first": first,
        })
