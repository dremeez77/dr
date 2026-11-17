"""Подборки «N стримеров реагируют на один момент»: подготовка кандидатов и проверка ответа модели."""
from __future__ import annotations

from pathlib import Path

from .config import Facecam
from .render import Segment, Word
from .transcribe import transcript_lines

POOL_STATUSES = ("review", "published", "manual", "rejected", "pool")


def usable(clip: dict, used: set[int]) -> bool:
    m = clip["meta"]
    return (clip["id"] not in used and bool(m.get("event")) and bool(m.get("src"))
            and Path(m["src"]).exists() and bool(m.get("duration")))


def words_of(clip: dict) -> list[Word]:
    return [Word(a, b, t) for a, b, t in clip["meta"].get("words", [])]


def payload(clips: list[dict]) -> list[dict]:
    """Компактное описание кандидатов для Claude."""
    out = []
    for c in clips:
        m = c["meta"]
        lines = transcript_lines(words_of(c))
        out.append({
            "id": c["id"], "streamer": c["streamer"], "event": m["event"],
            "event_type": m.get("event_type", "other"), "duration": round(m["duration"], 1),
            "best_window": m.get("window"), "transcript": lines[:40],
        })
    return out


def validate_group(group: dict, by_id: dict[int, dict], min_streamers: int,
                   max_seconds: float) -> list[Segment] | None:
    """Отсекает выдуманные id, повторы стримеров, кривые таймкоды; ужимает по общей длине."""
    segs: list[Segment] = []
    seen_clips, seen_streamers = set(), set()
    for s in group.get("segments", []):
        c = by_id.get(s.get("clip_id"))
        if not c or c["id"] in seen_clips or c["streamer"] in seen_streamers:
            continue
        dur = float(c["meta"]["duration"])
        start = max(0.0, min(float(s["start"]), dur))
        end = max(0.0, min(float(s["end"]), dur))
        if end - start < 3.0:
            continue
        fc = c["meta"].get("facecam")
        segs.append(Segment(c["id"], c["streamer"], Path(c["meta"]["src"]), start, end, words_of(c),
                            Facecam(**fc) if fc else None))
        seen_clips.add(c["id"])
        seen_streamers.add(c["streamer"])
    if len(segs) < min_streamers:
        return None
    total = sum(x.end - x.start for x in segs)
    if total > max_seconds:
        # ужимаем каждый кусок пропорционально, срезая начало (реакция обычно в конце)
        k = max_seconds / total
        for x in segs:
            x.start = x.end - (x.end - x.start) * k
    return segs
