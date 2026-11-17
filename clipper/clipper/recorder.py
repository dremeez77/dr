"""Кольцевой буфер записи стрима.

streamlink -> ffmpeg (copy) -> сегменты по N секунд с именем = UTC-время начала.
Храним последние `buffer_minutes` минут: когда чат «взрывается», нужный
фрагмент уже лежит на диске, и клип готов через минуту, а не через час.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger(__name__)
FMT = "%Y%m%d-%H%M%S"


def seg_time(p: Path) -> float:
    return datetime.strptime(p.stem, FMT).replace(tzinfo=timezone.utc).timestamp()


def pick_segments(segs: list[tuple[float, Path]], start: float, end: float,
                  now: float) -> list[tuple[float, float, Path]]:
    """Сегменты (start, end, path), пересекающие [start, end]. Последний (пишущийся) не берём."""
    out = []
    for i, (t0, p) in enumerate(segs):
        if i + 1 >= len(segs):
            break  # последний сегмент ещё пишется
        t1 = segs[i + 1][0]
        if t1 > start and t0 < end:
            out.append((t0, t1, p))
    return out


class RingRecorder:
    def __init__(self, name: str, url: str, root: Path, buffer_minutes: int = 8,
                 segment_seconds: int = 6, quality: str = "720p60,720p,best"):
        self.name = name
        self.url = url
        self.dir = root / name.lower()
        self.dir.mkdir(parents=True, exist_ok=True)
        self.buffer = buffer_minutes * 60
        self.segment_seconds = segment_seconds
        self.quality = quality
        self.task: asyncio.Task | None = None
        self.procs: list[asyncio.subprocess.Process] = []

    @property
    def running(self) -> bool:
        return self.task is not None and not self.task.done()

    def start(self):
        if not self.running:
            self.task = asyncio.create_task(self._loop(), name=f"rec-{self.name}")

    async def stop(self):
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        await self._kill()

    async def _kill(self):
        for p in self.procs:
            if p.returncode is None:
                p.kill()
                try:
                    await p.wait()
                except Exception:  # noqa: BLE001
                    pass
        self.procs = []

    async def _loop(self):
        while True:
            try:
                await self._run_once()
            except asyncio.CancelledError:
                await self._kill()
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("recorder %s: %s", self.name, e)
            await self._kill()
            await asyncio.sleep(10)

    async def _run_once(self):
        r, w = os.pipe()
        sl_args = ["streamlink", "--stdout", "--loglevel", "warning"]
        if "twitch.tv" in self.url:
            sl_args += ["--twitch-low-latency"]  # рекламу streamlink 7+ вырезает сам
        sl_args += [self.url, self.quality]
        sl = await asyncio.create_subprocess_exec(*sl_args, stdout=w, stderr=asyncio.subprocess.DEVNULL)
        ff = await asyncio.create_subprocess_exec(
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
            "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
            "-f", "segment", "-segment_time", str(self.segment_seconds),
            "-reset_timestamps", "1", "-strftime", "1", str(self.dir / f"{FMT}.ts"),
            stdin=r, stderr=asyncio.subprocess.DEVNULL, env={**os.environ, "TZ": "UTC"},
        )
        os.close(r)
        os.close(w)
        self.procs = [sl, ff]
        log.info("recording %s started", self.name)
        await ff.wait()
        log.info("recording %s stopped (ffmpeg rc=%s)", self.name, ff.returncode)

    def segments(self) -> list[tuple[float, Path]]:
        out = []
        for p in self.dir.glob("*.ts"):
            try:
                out.append((seg_time(p), p))
            except ValueError:
                continue
        return sorted(out)

    def cleanup(self):
        cutoff = time.time() - self.buffer
        for t, p in self.segments():
            if t < cutoff:
                p.unlink(missing_ok=True)

    async def extract(self, start: float, end: float, out_path: Path) -> float | None:
        """Склеивает сегменты вокруг [start, end]. Возвращает смещение start внутри файла."""
        chosen = pick_segments(self.segments(), start, end, time.time())
        if not chosen:
            return None
        lst = out_path.with_suffix(".txt")
        lst.write_text("".join(f"file '{p.resolve()}'\n" for _, _, p in chosen))
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
            "-i", str(lst), "-c", "copy", str(out_path),
        )
        await proc.wait()
        lst.unlink(missing_ok=True)
        if proc.returncode != 0 or not out_path.exists():
            return None
        return max(0.0, start - chosen[0][0])
