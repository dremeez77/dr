"""SQLite-хранилище клипов: дедупликация, статусы, история публикаций."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE,
    streamer TEXT NOT NULL,
    audience TEXT NOT NULL,
    source TEXT NOT NULL,
    moment_at REAL NOT NULL,
    status TEXT NOT NULL,
    score INTEGER,
    title TEXT,
    description TEXT,
    hashtags TEXT,
    video_path TEXT,
    tg_message_id INTEGER,
    youtube_id TEXT,
    meta TEXT,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clips_streamer_moment ON clips(streamer, moment_at);
"""


class DB:
    def __init__(self, path: Path):
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        with self.lock:
            self.conn.executescript(SCHEMA)

    def create(self, key: str, streamer: str, audience: str, source: str,
               moment_at: float, meta: dict | None = None) -> int | None:
        """Создаёт запись; None если такой ключ уже был (дубликат)."""
        with self.lock:
            try:
                cur = self.conn.execute(
                    "INSERT INTO clips(key, streamer, audience, source, moment_at, status, meta, created_at)"
                    " VALUES (?,?,?,?,?,?,?,?)",
                    (key, streamer, audience, source, moment_at, "new", json.dumps(meta or {}), time.time()),
                )
                self.conn.commit()
                return cur.lastrowid
            except sqlite3.IntegrityError:
                return None

    def update(self, clip_id: int, **fields):
        if "meta" in fields and not isinstance(fields["meta"], str):
            fields["meta"] = json.dumps(fields["meta"], ensure_ascii=False)
        cols = ", ".join(f"{k}=?" for k in fields)
        with self.lock:
            self.conn.execute(f"UPDATE clips SET {cols} WHERE id=?", (*fields.values(), clip_id))
            self.conn.commit()

    def get(self, clip_id: int) -> dict | None:
        with self.lock:
            row = self.conn.execute("SELECT * FROM clips WHERE id=?", (clip_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        d["meta"] = json.loads(d["meta"] or "{}")
        return d

    def has_moment_near(self, streamer: str, moment_at: float, within: float = 60.0) -> bool:
        with self.lock:
            row = self.conn.execute(
                "SELECT 1 FROM clips WHERE streamer=? AND ABS(moment_at-?)<? LIMIT 1",
                (streamer, moment_at, within),
            ).fetchone()
        return row is not None

    def count_since(self, streamer: str, since: float) -> int:
        with self.lock:
            return self.conn.execute(
                "SELECT COUNT(*) FROM clips WHERE streamer=? AND created_at>=?", (streamer, since)
            ).fetchone()[0]

    def recent(self, audience: str, since: float, statuses: tuple[str, ...]) -> list[dict]:
        q = ",".join("?" * len(statuses))
        with self.lock:
            rows = self.conn.execute(
                f"SELECT * FROM clips WHERE audience=? AND created_at>=? AND status IN ({q}) ORDER BY id",
                (audience, since, *statuses),
            ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["meta"] = json.loads(d["meta"] or "{}")
            out.append(d)
        return out

    def used_in_compilations(self) -> set[int]:
        with self.lock:
            rows = self.conn.execute("SELECT meta FROM clips WHERE source='compilation'").fetchall()
        used: set[int] = set()
        for r in rows:
            used.update(json.loads(r["meta"] or "{}").get("clip_ids", []))
        return used

    def stats(self, since: float) -> dict[str, int]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT status, COUNT(*) c FROM clips WHERE created_at>=? GROUP BY status", (since,)
            ).fetchall()
        return {r["status"]: r["c"] for r in rows}
