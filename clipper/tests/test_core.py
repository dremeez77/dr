import shutil
import subprocess
from pathlib import Path

import pytest

from clipper.chat import parse_privmsg
from clipper.config import Facecam, RenderCfg
from clipper.db import DB
from clipper.detector import SpikeDetector, message_weight
from clipper.recorder import pick_segments
from clipper.render import Word, build_ass, build_filter, chunk_words, render
from clipper.transcribe import transcript_lines


def test_detector_fires_on_spike_and_respects_cooldown():
    d = SpikeDetector("x", window=10, baseline_window=300, ratio=3, min_rate=1.5, cooldown=90, min_history=60)
    t = 1000.0
    spikes = []
    for i in range(120):            # 2 минуты спокойного чата: 1 сообщение/сек
        spikes.append(d.add("hello", t + i))
    assert not any(spikes)
    t += 120
    hits = [d.add("KEKW KEKW", t + i / 10) for i in range(100)]  # 10 сообщений/сек с эмоутами
    fired = [h for h in hits if h]
    assert len(fired) == 1            # cooldown не даёт сработать повторно
    assert fired[0].ratio >= 3


def test_detector_quiet_chat_never_fires():
    d = SpikeDetector("x", min_history=10)
    assert not any(d.add("hi", 1000 + i * 0.5) for i in range(2000))


def test_message_weight():
    assert message_weight("hi") == 1.0
    assert message_weight("OMEGALUL clip it") > 4


def test_parse_privmsg():
    assert parse_privmsg(":a!a@a.tmi.twitch.tv PRIVMSG #KaiCenat :W stream") == ("kaicenat", "W stream")
    assert parse_privmsg("@badge=1 :a!a@a PRIVMSG #x :hey :)") == ("x", "hey :)")
    assert parse_privmsg(":tmi.twitch.tv 001 justinfan :Welcome") is None


def test_pick_segments_skips_open_tail():
    p = Path
    segs = [(0, p("a")), (6, p("b")), (12, p("c")), (18, p("d"))]
    got = pick_segments(segs, 5, 13, now=20)
    assert [x[2].name for x in got] == ["a", "b", "c"]
    assert pick_segments(segs, 19, 30, now=20) == []


def test_chunk_and_ass():
    words = [Word(0, 0.3, "привет"), Word(0.3, 0.6, "это"), Word(0.6, 0.9, "gta"), Word(2.0, 2.4, "{six}")]
    chunks = chunk_words(words)
    assert [len(c) for c in chunks] == [3, 1]
    ass = build_ass(words, RenderCfg(), hook_text="он не ожидал")
    assert "ОН НЕ ОЖИДАЛ" in ass
    assert ass.count("Dialogue: 0,") == 4
    assert "{six}" not in ass and "(SIX)" in ass


def test_transcript_lines():
    words = [Word(0, 0.5, "a"), Word(0.5, 1, "b"), Word(3, 3.5, "c")]
    assert transcript_lines(words) == ["[0.0] a b", "[3.0] c"]


def test_db_dedupe(tmp_path):
    db = DB(tmp_path / "c.db")
    cid = db.create("k1", "Buster", "ru", "chat", 1000.0)
    assert cid and db.create("k1", "Buster", "ru", "chat", 1000.0) is None
    assert db.has_moment_near("Buster", 1030.0) and not db.has_moment_near("Buster", 1100.0)
    db.update(cid, status="review", meta={"a": 1})
    assert db.get(cid)["meta"] == {"a": 1}


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg required")
@pytest.mark.parametrize("facecam", [None, Facecam(0.0, 0.0, 0.25, 0.3)])
def test_render_end_to_end(tmp_path, facecam):
    src = tmp_path / "src.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30",
                    "-f", "lavfi", "-i", "sine=frequency=440", "-t", "6", "-c:v", "libx264", "-c:a", "aac",
                    "-shortest", str(src)], check=True)
    out = tmp_path / "out.mp4"
    cfg = RenderCfg(preset="ultrafast")
    render(src, out, 1.0, 3.0, [Word(0.1, 0.5, "тест"), Word(0.5, 1.0, "субтитров")], cfg, facecam, "хук")
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height", "-of", "csv=p=0", str(out)], capture_output=True, text=True)
    assert r.stdout.strip() == "1080,1920"
    assert "split" in build_filter(cfg, facecam)
