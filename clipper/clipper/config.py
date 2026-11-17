"""Загрузка конфигурации: config.yaml + секреты из переменных окружения."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class Facecam:
    """Прямоугольник вебки в относительных координатах кадра (0..1)."""
    x: float
    y: float
    w: float
    h: float


@dataclass
class Streamer:
    name: str
    platform: str            # twitch | youtube
    channel: str             # twitch login или ссылка на YouTube-канал
    audience: str            # ru | en — на какой канал публикуем
    language: str            # язык речи для Whisper
    facecam: Facecam | None = None
    facecam_auto: bool = True   # определять вебку через Claude Vision, если не задана вручную
    record: bool = True         # держать кольцевой буфер записи (нужно для детекта по чату)
    max_per_hour: int = 6
    title_keywords: list[str] = field(default_factory=lambda: ["gta", "гта"])  # для YouTube: игра по названию стрима

    @property
    def url(self) -> str:
        if self.platform == "twitch":
            return f"https://www.twitch.tv/{self.channel}"
        return self.channel


@dataclass
class DetectorCfg:
    window: float = 10.0
    baseline_window: float = 300.0
    ratio: float = 3.0
    min_rate: float = 1.5
    cooldown: float = 90.0
    min_history: float = 60.0
    pre_seconds: float = 45.0
    post_seconds: float = 20.0


@dataclass
class RenderCfg:
    width: int = 1080
    height: int = 1920
    cam_ratio: float = 0.38
    font: str = "DejaVu Sans"
    font_size: int = 78
    subs_margin_v: int = 560
    crf: int = 21
    preset: str = "veryfast"
    loudnorm: bool = True


@dataclass
class CompCfg:
    """Подборки «N стримеров реагируют на один момент»."""
    enabled: bool = True
    interval_minutes: int = 20
    lookback_hours: int = 72
    min_streamers: int = 2
    max_seconds: float = 58.0
    min_pool_score: int = 4   # слабые одиночные сюжетные моменты копим для подборок


@dataclass
class DigestCfg:
    """Ежедневный длинный ролик «Главное за день» (16:9, для монетизации)."""
    enabled: bool = True
    audiences: list[str] = field(default_factory=lambda: ["en"])
    hour: int = 23
    minute: int = 0
    timezone: str = "Europe/Moscow"
    lookback_hours: int = 24
    min_segments: int = 6
    target_minutes: float = 10.0
    max_minutes: float = 15.0
    max_candidates: int = 80


@dataclass
class Settings:
    data_dir: Path
    game_names: list[str]
    streamers: list[Streamer]
    detector: DetectorCfg
    render: RenderCfg
    comp: CompCfg = field(default_factory=CompCfg)
    digest: DigestCfg = field(default_factory=DigestCfg)
    buffer_minutes: int = 8
    segment_seconds: int = 6
    quality: str = "720p60,720p,best"
    max_recordings: int = 12
    live_poll_seconds: int = 60
    clips_poll_seconds: int = 120
    clips_min_views: int = 20
    workers: int = 2
    whisper_model: str = "small"
    whisper_device: str = "auto"
    whisper_compute: str = "int8"
    llm_model: str = "claude-opus-5-5"
    llm_effort: str = "medium"
    llm_creative_model: str = "claude-opus-5-5"
    min_score: int = 6
    youtube_privacy: str = "public"
    youtube_tokens: dict[str, str] = field(default_factory=dict)
    # секреты
    twitch_client_id: str = ""
    twitch_client_secret: str = ""
    telegram_token: str = ""
    telegram_chats: dict[str, str] = field(default_factory=dict)

    def streamer(self, name: str) -> Streamer:
        for s in self.streamers:
            if s.name.lower() == name.lower() or s.channel.lower() == name.lower():
                return s
        raise KeyError(f"Стример {name!r} не найден в конфиге")

    def chat_for(self, audience: str) -> str:
        return self.telegram_chats.get(audience) or self.telegram_chats.get("default", "")


def _streamer(d: dict) -> Streamer:
    fc = d.get("facecam")
    facecam = Facecam(**fc) if isinstance(fc, dict) else None
    return Streamer(
        name=d["name"],
        platform=d.get("platform", "twitch"),
        channel=d["channel"],
        audience=d["audience"],
        language=d.get("language", d["audience"]),
        facecam=facecam,
        facecam_auto=fc != "none" and d.get("facecam_auto", True),
        record=d.get("record", True),
        max_per_hour=d.get("max_per_hour", 6),
        title_keywords=d.get("title_keywords", ["gta", "гта"]),
    )


def load(path: str | Path) -> Settings:
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    data_dir = Path(raw.get("data_dir", "data")).resolve()
    rec = raw.get("recording", {})
    llm = raw.get("llm", {})
    wh = raw.get("whisper", {})
    yt = raw.get("youtube", {})
    chats = {k: str(v) for k, v in (raw.get("telegram_chats") or {}).items()}
    if os.getenv("TELEGRAM_CHAT_ID"):
        chats.setdefault("default", os.environ["TELEGRAM_CHAT_ID"])
    s = Settings(
        data_dir=data_dir,
        game_names=raw.get("game_names", ["Grand Theft Auto VI"]),
        streamers=[_streamer(x) for x in raw.get("streamers", [])],
        detector=DetectorCfg(**raw.get("detector", {})),
        render=RenderCfg(**raw.get("render", {})),
        comp=CompCfg(**raw.get("compilations", {})),
        digest=DigestCfg(**raw.get("digest", {})),
        buffer_minutes=rec.get("buffer_minutes", 8),
        segment_seconds=rec.get("segment_seconds", 6),
        quality=rec.get("quality", "720p60,720p,best"),
        max_recordings=rec.get("max_recordings", 12),
        live_poll_seconds=raw.get("live_poll_seconds", 60),
        clips_poll_seconds=raw.get("clips_poll_seconds", 120),
        clips_min_views=raw.get("clips_min_views", 20),
        workers=raw.get("workers", 2),
        whisper_model=wh.get("model", "small"),
        whisper_device=wh.get("device", "auto"),
        whisper_compute=wh.get("compute_type", "int8"),
        llm_model=llm.get("model", "claude-opus-5-5"),
        llm_effort=llm.get("effort", "medium"),
        llm_creative_model=llm.get("creative_model", llm.get("model", "claude-opus-5-5")),
        min_score=llm.get("min_score", 6),
        youtube_privacy=yt.get("privacy", "public"),
        youtube_tokens=yt.get("tokens", {}),
        twitch_client_id=os.getenv("TWITCH_CLIENT_ID", ""),
        twitch_client_secret=os.getenv("TWITCH_CLIENT_SECRET", ""),
        telegram_token=os.getenv("TELEGRAM_BOT_TOKEN", ""),
        telegram_chats=chats,
    )
    for sub in ("segments", "work", "out"):
        (data_dir / sub).mkdir(parents=True, exist_ok=True)
    return s
