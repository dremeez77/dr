import asyncio
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import pytest

from clipper import digest as D
from clipper.config import CompCfg, DetectorCfg, DigestCfg, RenderCfg, Settings, Streamer


def clip(cid, streamer, src, duration=40.0, score=7):
    return {"id": cid, "streamer": streamer, "score": score, "title": "t", "meta": {
        "event": f"event {cid}", "event_type": "gameplay", "src": str(src), "duration": duration,
        "window": [5, 30], "facecam": None, "words": [[1.0, 1.5, "no"], [1.5, 2.0, "way"]]}}


def test_validate_and_chapters(tmp_path):
    src = tmp_path / "a.mp4"
    src.write_bytes(b"x")
    by_id = {i: clip(i, f"S{i}", src) for i in range(1, 5)}
    plan = {"segments": [
        {"clip_id": 1, "start": 0, "end": 20, "chapter": "Cold open", "context": "c"},
        {"clip_id": 1, "start": 0, "end": 20, "chapter": "dup", "context": ""},       # повтор клипа
        {"clip_id": 2, "start": 5, "end": 9, "chapter": "too short", "context": ""},  # < 10 с
        {"clip_id": 3, "start": 10, "end": 75, "chapter": "Chaos", "context": ""},    # обрежется до 40
        {"clip_id": 4, "start": 0, "end": 15, "chapter": "", "context": ""},
    ]}
    segs = D.validate(plan, by_id, min_segments=3, max_minutes=15)
    assert [s.clip_id for s in segs] == [1, 3, 4]
    assert segs[1].end == 40 and segs[2].chapter == "S4"
    assert D.chapters(segs).splitlines() == ["0:00 Cold open — @S1", "0:23 Chaos — @S3", "0:53 S4 — @S4"]
    assert D.validate(plan, by_id, min_segments=4, max_minutes=15) is None
    # лимит длины: в 0.6 минуты (36 с) влезает только первый
    assert D.validate(plan, by_id, min_segments=1, max_minutes=0.6)[-1].clip_id == 1


def test_next_run_timezone():
    now = datetime(2026, 11, 19, 19, 30, tzinfo=timezone.utc)   # 22:30 МСК
    assert D.next_run(now, 23, 0, "Europe/Moscow").isoformat() == "2026-11-19T23:00:00+03:00"
    now = datetime(2026, 11, 19, 20, 30, tzinfo=timezone.utc)   # 23:30 МСК -> завтра
    assert D.next_run(now, 23, 0, "Europe/Moscow").day == 20


def test_candidates_skip_missing_sources(tmp_path):
    src = tmp_path / "a.mp4"
    src.write_bytes(b"x")
    got = D.candidates([clip(1, "A", src, score=5), clip(2, "B", tmp_path / "gone.mp4"), clip(3, "C", src, score=9)], 10)
    assert [c["id"] for c in got] == [3, 1]


class FakeClaude:
    def __init__(self, ids):
        self.ids = ids

    def digest(self, audience, candidates, min_segments, target_minutes, max_minutes):
        return {"title": "GTA 6 streams: day 1", "description": "Best of the day.", "tags": ["gta6", "#kai"],
                "thumbnail_text": "they lost it", "thumbnail_clip_id": self.ids[1], "thumbnail_at": 2.0,
                "segments": [{"clip_id": i, "start": 0, "end": 11, "chapter": f"Moment {i}", "context": "ctx"}
                             for i in self.ids]}


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg required")
def test_make_digest_end_to_end(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    from clipper.pipeline import Pipeline
    streamers = [Streamer("KaiCenat", "twitch", "kaicenat", "en", "en"), Streamer("Jynxzi", "twitch", "jynxzi", "en", "en")]
    s = Settings(data_dir=tmp_path, game_names=[], streamers=streamers, detector=DetectorCfg(),
                 render=RenderCfg(preset="ultrafast"), comp=CompCfg(), digest=DigestCfg(min_segments=2))
    for sub in ("segments", "work", "out"):
        (tmp_path / sub).mkdir()
    p = Pipeline(s)
    ids = []
    for name, color in (("KaiCenat", "red"), ("Jynxzi", "blue")):
        src = tmp_path / "out" / f"{name}.mp4"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"testsrc2=size=1280x720:rate=60",
                        "-f", "lavfi", "-i", "sine=r=44100", "-t", "12", "-c:v", "libx264", "-c:a", "aac",
                        "-shortest", str(src)], check=True)
        cid = p.db.create(f"k{name}", name, "en", "chat", 1000.0 + len(ids) * 500)
        c = clip(cid, name, src, duration=12.0)
        p.db.update(cid, status="review", score=7, title="t", meta=c["meta"])
        ids.append(cid)
    p.claude = FakeClaude(ids)
    did = asyncio.run(p.make_digest("en"))
    assert did and asyncio.run(p.make_digest("en")) is None        # раз в день
    d = p.db.get(did)
    assert d["source"] == "digest" and "0:00 Moment" in d["description"] and d["hashtags"] == "gta6 kai"
    out = Path(d["video_path"])
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                        "-of", "csv=p=0", str(out)], capture_output=True, text=True)
    assert r.stdout.strip() == "1920,1080"
    assert 24 < d["meta"]["duration"] < 26.5                       # интро 3 + 11 + 11
    assert Path(d["meta"]["thumb"]).exists()
