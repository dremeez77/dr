import asyncio
import shutil
import subprocess
from pathlib import Path

import pytest

from clipper import compilation as C
from clipper.config import CompCfg, DetectorCfg, RenderCfg, Settings, Streamer
from clipper.render import build_ass, Word


def clip(cid, streamer, src="x.mp4", duration=40.0, event="Lucia prison escape cutscene"):
    return {"id": cid, "streamer": streamer, "meta": {
        "event": event, "event_type": "story", "src": src, "duration": duration,
        "window": [5, 30], "facecam": None, "words": [[1.0, 1.5, "no"], [1.5, 2.0, "way"]]}}


def test_validate_group_filters_bad_segments():
    by_id = {1: clip(1, "Buster"), 2: clip(2, "Zloy"), 3: clip(3, "Buster")}
    g = {"segments": [
        {"clip_id": 1, "start": 10, "end": 30},
        {"clip_id": 3, "start": 0, "end": 10},     # тот же стример — выкинуть
        {"clip_id": 99, "start": 0, "end": 10},    # выдуманный id — выкинуть
        {"clip_id": 2, "start": 35, "end": 100},   # конец за пределами — обрезать до 40
    ]}
    segs = C.validate_group(g, by_id, min_streamers=2, max_seconds=58)
    assert [s.clip_id for s in segs] == [1, 2]
    assert segs[1].end == 40.0


def test_validate_group_shrinks_to_max_and_needs_min_streamers():
    by_id = {1: clip(1, "A", duration=60), 2: clip(2, "B", duration=60)}
    segs = C.validate_group({"segments": [{"clip_id": 1, "start": 0, "end": 40},
                                          {"clip_id": 2, "start": 0, "end": 40}]}, by_id, 2, 40)
    assert abs(sum(s.end - s.start for s in segs) - 40) < 1e-6
    assert segs[0].end == 40  # срезается начало, реакция в конце сохраняется
    assert C.validate_group({"segments": [{"clip_id": 1, "start": 0, "end": 10}]}, by_id, 2, 40) is None


def test_label_in_ass():
    ass = build_ass([Word(0, 1, "hi")], RenderCfg(), label="@Buster", duration=5)
    assert "Label,,0,0,0,,@Buster" in ass


class FakeClaude:
    def __init__(self, ids):
        self.ids = ids
        self.calls = 0

    def group(self, audience, candidates, min_streamers, max_seconds):
        self.calls += 1
        assert {c["id"] for c in candidates} == set(self.ids)
        return [{"event": "prison escape", "score": 8, "title": "Стримеры и побег", "description": "d",
                 "hashtags": ["gta6", "#стримеры"], "hook_text": "все в шоке",
                 "segments": [{"clip_id": i, "start": 1, "end": 4.5} for i in self.ids]}]


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg required")
def test_make_compilations_end_to_end(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    from clipper.pipeline import Pipeline
    streamers = [Streamer("Buster", "twitch", "buster", "ru", "ru"), Streamer("Zloy", "twitch", "zloyn", "ru", "ru")]
    s = Settings(data_dir=tmp_path, game_names=[], streamers=streamers, detector=DetectorCfg(),
                 render=RenderCfg(preset="ultrafast"), comp=CompCfg())
    for sub in ("segments", "work", "out"):
        (tmp_path / sub).mkdir()
    p = Pipeline(s)
    ids = []
    for name, color in (("Buster", "red"), ("Zloy", "blue")):
        src = tmp_path / "out" / f"{name}.mp4"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"color={color}:size=1280x720:rate=30",
                        "-f", "lavfi", "-i", "sine", "-t", "5", "-c:v", "libx264", "-c:a", "aac", "-shortest",
                        str(src)], check=True)
        cid = p.db.create(f"k{name}", name, "ru", "chat", 1000.0 + len(ids) * 500)
        c = clip(cid, name, str(src), duration=5.0)
        p.db.update(cid, status="pool", meta=c["meta"])
        ids.append(cid)
    p.claude = FakeClaude(ids)
    assert asyncio.run(p.make_compilations("ru")) == 1
    assert asyncio.run(p.make_compilations("ru")) == 0      # клипы уже использованы
    comp = p.db.get(max(ids) + 1)
    assert comp["source"] == "compilation" and comp["status"] == "review" and comp["hashtags"] == "gta6 стримеры"
    out = Path(comp["video_path"])
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                str(out)], capture_output=True, text=True).stdout)
    assert 6.5 < dur < 7.8
