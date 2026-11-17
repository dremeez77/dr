"""Ежедневный дайджест: выбор кандидатов, проверка плана от Claude, главы YouTube, расписание."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from .compilation import words_of
from .config import Facecam
from .transcribe import transcript_lines

DIGEST_STATUSES = ("review", "published", "manual", "pool")
INTRO_SECONDS = 3.0


@dataclass
class DigestSegment:
    clip_id: int
    streamer: str
    src: Path
    start: float
    end: float
    words: list
    chapter: str
    context: str
    facecam: Facecam | None = None

    @property
    def duration(self) -> float:
        return self.end - self.start


def candidates(clips: list[dict], limit: int) -> list[dict]:
    ok = [c for c in clips if c["meta"].get("src") and Path(c["meta"]["src"]).exists()
          and c["meta"].get("duration")]
    ok.sort(key=lambda c: -(c.get("score") or 0))
    return ok[:limit]


def payload(clips: list[dict]) -> list[dict]:
    out = []
    for c in clips:
        m = c["meta"]
        out.append({
            "id": c["id"], "streamer": c["streamer"], "score": c.get("score"),
            "event": m.get("event", ""), "event_type": m.get("event_type", "other"),
            "short_title": c.get("title") or "", "duration": round(m["duration"], 1),
            "best_window": m.get("window"), "transcript": transcript_lines(words_of(c))[:40],
        })
    return out


def validate(plan: dict, by_id: dict[int, dict], min_segments: int, max_minutes: float) -> list[DigestSegment] | None:
    segs: list[DigestSegment] = []
    seen: set[int] = set()
    budget = max_minutes * 60 - INTRO_SECONDS
    for s in plan.get("segments", []):
        c = by_id.get(s.get("clip_id"))
        if not c or c["id"] in seen:
            continue
        dur = float(c["meta"]["duration"])
        start = max(0.0, min(float(s["start"]), dur))
        end = max(0.0, min(float(s["end"]), dur))
        if end - start < 10.0:            # главы YouTube требуют >= 10 с
            continue
        if sum(x.duration for x in segs) + (end - start) > budget:
            break
        fc = c["meta"].get("facecam")
        segs.append(DigestSegment(c["id"], c["streamer"], Path(c["meta"]["src"]), start, end, words_of(c),
                                  (s.get("chapter") or c["streamer"]).strip()[:60],
                                  (s.get("context") or "").strip()[:140], Facecam(**fc) if fc else None))
        seen.add(c["id"])
    return segs if len(segs) >= min_segments else None


def fmt_ts(t: float) -> str:
    t = int(t)
    h, m, s = t // 3600, t % 3600 // 60, t % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def chapters(segs: list[DigestSegment]) -> str:
    """Строки глав для описания YouTube. Первая — 0:00 (интро входит в первую главу)."""
    lines, t = [], 0.0
    for i, s in enumerate(segs):
        lines.append(f"{fmt_ts(0 if i == 0 else t)} {s.chapter} — @{s.streamer}")
        t += s.duration + (INTRO_SECONDS if i == 0 else 0)
    return "\n".join(lines)


def next_run(now: datetime, hour: int, minute: int, tz: str) -> datetime:
    local = now.astimezone(ZoneInfo(tz))
    target = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= local:
        target += timedelta(days=1)
    return target
