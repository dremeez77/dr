"""Распознавание речи (faster-whisper) с таймкодами слов."""
from __future__ import annotations

import threading
from pathlib import Path

from .render import Word


class Transcriber:
    def __init__(self, model_size: str = "small", device: str = "auto", compute_type: str = "int8"):
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type
        self._model = None
        self._lock = threading.Lock()

    def _load(self):
        if self._model is None:
            from faster_whisper import WhisperModel
            self._model = WhisperModel(self.model_size, device=self.device, compute_type=self.compute_type)
        return self._model

    def transcribe(self, audio: Path, language: str | None) -> list[Word]:
        with self._lock:  # модель одна, не грузим её дважды в память
            model = self._load()
            segments, _ = model.transcribe(str(audio), language=language, word_timestamps=True,
                                           vad_filter=True, beam_size=5)
            words = []
            for seg in segments:
                for w in seg.words or []:
                    if w.word.strip():
                        words.append(Word(w.start, w.end, w.word.strip()))
            return words


def transcript_lines(words: list[Word], gap: float = 0.8) -> list[str]:
    """Компактный транскрипт для LLM: '[12.3] фраза'."""
    lines: list[str] = []
    cur: list[str] = []
    t0 = 0.0
    prev_end = -10.0
    for w in words:
        if cur and (w.start - prev_end > gap or len(cur) >= 14):
            lines.append(f"[{t0:.1f}] {' '.join(cur)}")
            cur = []
        if not cur:
            t0 = w.start
        cur.append(w.text)
        prev_end = w.end
    if cur:
        lines.append(f"[{t0:.1f}] {' '.join(cur)}")
    return lines
