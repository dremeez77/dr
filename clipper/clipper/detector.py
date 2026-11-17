"""Детектор «моментов» по всплеску активности чата.

Чат реагирует на смешное/эпичное взрывом сообщений и эмоутов. Сравниваем
взвешенную скорость чата за последние `window` секунд с базовой скоростью за
последние `baseline_window` секунд. Работает на посекундных корзинах, поэтому
выдерживает чаты в десятки сообщений в секунду.
"""
from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field

# Слова/эмоуты, которые обычно означают «это надо клипать». Вес добавляется к 1.
KEYWORDS: dict[str, float] = {
    "omegalul": 2.0, "kekw": 1.5, "lul": 1.0, "lmao": 1.5, "lmfao": 2.0, "lol": 0.5,
    "💀": 1.5, "😂": 1.0, "🤣": 1.0, "pog": 1.0, "wtf": 1.5, "no way": 1.5, "omg": 1.0,
    "clip": 2.0, "клип": 2.0, "ахах": 1.5, "хаха": 1.0, "кек": 1.0, "ору": 1.5,
    "жесть": 1.5, "имба": 1.0, "пиздец": 1.5, "капец": 1.0, "+1": 0.0,
}


def message_weight(text: str) -> float:
    t = text.lower()
    w = 1.0
    for k, bonus in KEYWORDS.items():
        if k in t:
            w += bonus
    return min(w, 5.0)


@dataclass
class Spike:
    channel: str
    at: float
    rate: float
    baseline: float
    ratio: float
    sample: list[str] = field(default_factory=list)


class SpikeDetector:
    def __init__(self, channel: str, window: float = 10.0, baseline_window: float = 300.0,
                 ratio: float = 3.0, min_rate: float = 1.5, cooldown: float = 90.0,
                 min_history: float = 60.0, **_):
        self.channel = channel
        self.window = int(window)
        self.baseline_window = int(baseline_window)
        self.ratio = ratio
        self.min_rate = min_rate
        self.cooldown = cooldown
        self.min_history = min_history
        self.buckets: deque[list] = deque()   # [second, weight_sum]
        self.total = 0.0
        self.started: float | None = None
        self.last_spike = -1e18
        self.recent_text: deque[str] = deque(maxlen=40)

    def add(self, text: str, t: float | None = None) -> Spike | None:
        t = time.time() if t is None else t
        sec = int(t)
        if self.started is None:
            self.started = t
        w = message_weight(text)
        self.recent_text.append(text)
        if self.buckets and self.buckets[-1][0] == sec:
            self.buckets[-1][1] += w
        else:
            self.buckets.append([sec, w])
        self.total += w
        while self.buckets and self.buckets[0][0] <= sec - self.baseline_window:
            self.total -= self.buckets.popleft()[1]

        if t - self.started < self.min_history:
            return None

        recent = 0.0
        for b in reversed(self.buckets):
            if b[0] <= sec - self.window:
                break
            recent += b[1]
        rate = recent / self.window
        history_span = min(t - self.started, self.baseline_window) - self.window
        baseline = max((self.total - recent) / max(history_span, 1.0), 0.2)
        ratio = rate / baseline
        if rate >= self.min_rate and ratio >= self.ratio and t - self.last_spike >= self.cooldown:
            self.last_spike = t
            return Spike(self.channel, t, rate, baseline, ratio, list(self.recent_text)[-25:])
        return None
