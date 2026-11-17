"""Claude: оценка момента, выбор точных границ, заголовок/описание; поиск вебки на кадре."""
from __future__ import annotations

import base64
import json
import logging
from pathlib import Path

import anthropic

from .config import Facecam

log = logging.getLogger(__name__)
FALLBACK_BETA = "server-side-fallback-2026-07-01"

JUDGE_SYSTEM = """You are the lead editor of a fast-moving short-form channel that posts GTA 6 streamer highlights \
(YouTube Shorts / TikTok / Reels). You receive a timestamped transcript of a stream fragment, a sample of \
live chat around the moment, and metadata. Decide if this fragment can become a strong short.

Judge like a viewer scrolling a feed:
- Strong: genuine funny reactions, rage, shock, chaos, fails, wins, unexpected events, memorable quotes, \
  first reactions to big story moments, interactions between streamers.
- Weak: silence, menus, loading, reading donations, ads, talking about unrelated things, nothing happening.
- Story spoilers are fine but mark them in the title only if the reaction is the point.

Pick the best continuous segment of 12-58 seconds (start/end in seconds, relative to the fragment). \
Start right before the setup (no long intro), end right after the payoff/reaction.

Write all viewer-facing text in the requested audience language:
- title: punchy, max 70 characters, includes the streamer name when it helps, no fake claims or clickbait lies.
- description: 1-2 sentences.
- hashtags: 3-6 tags without '#', always including gta6.
- hook_text: overlay for the first 3 seconds, max 6 words, makes the viewer stay.
Score 1-10 where 7+ means you would post it on a big channel today."""

JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "keep": {"type": "boolean"},
        "score": {"type": "integer"},
        "start": {"type": "number"},
        "end": {"type": "number"},
        "title": {"type": "string"},
        "description": {"type": "string"},
        "hashtags": {"type": "array", "items": {"type": "string"}},
        "hook_text": {"type": "string"},
        "reason": {"type": "string"},
    },
    "required": ["keep", "score", "start", "end", "title", "description", "hashtags", "hook_text", "reason"],
    "additionalProperties": False,
}

FACECAM_SCHEMA = {
    "type": "object",
    "properties": {
        "has_facecam": {"type": "boolean"},
        "x": {"type": "number"}, "y": {"type": "number"},
        "w": {"type": "number"}, "h": {"type": "number"},
    },
    "required": ["has_facecam", "x", "y", "w", "h"],
    "additionalProperties": False,
}

LANG_NAMES = {"ru": "Russian", "en": "English"}


class Claude:
    def __init__(self, model: str = "claude-opus-5-5", effort: str = "medium"):
        self.client = anthropic.Anthropic()
        self.model = model
        self.effort = effort

    def _json(self, system: str, content, schema: dict, max_tokens: int = 4000) -> dict | None:
        try:
            resp = self.client.beta.messages.create(
                model=self.model,
                max_tokens=max_tokens,
                system=system,
                messages=[{"role": "user", "content": content}],
                output_config={"effort": self.effort, "format": {"type": "json_schema", "schema": schema}},
                betas=[FALLBACK_BETA],
                fallbacks="default",
            )
        except anthropic.RateLimitError as e:
            log.warning("Claude rate limited: %s", e)
            return None
        except anthropic.APIStatusError as e:
            log.error("Claude API error %s: %s", e.status_code, e.message)
            return None
        except anthropic.APIConnectionError as e:
            log.error("Claude connection error: %s", e)
            return None
        if resp.stop_reason == "refusal":
            log.warning("Claude refused: %s", getattr(resp, "stop_details", None))
            return None
        text = next((b.text for b in resp.content if b.type == "text"), "")
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            log.error("Claude returned invalid JSON: %r", text[:200])
            return None

    def judge(self, streamer: str, audience: str, source: str, duration: float,
              transcript: list[str], chat_sample: list[str], clip_title: str = "") -> dict | None:
        lang = LANG_NAMES.get(audience, audience)
        parts = [
            f"Streamer: {streamer}",
            f"Audience language: {lang}",
            f"Source: {source}" + (f" (viewer clip title: {clip_title!r})" if clip_title else ""),
            f"Fragment duration: {duration:.1f}s",
            "Transcript:\n" + ("\n".join(transcript) if transcript else "(no speech detected)"),
        ]
        if chat_sample:
            parts.append("Live chat around the moment:\n" + "\n".join(chat_sample[-25:]))
        data = self._json(JUDGE_SYSTEM, "\n\n".join(parts), JUDGE_SCHEMA)
        if not data:
            return None
        data["score"] = max(1, min(10, int(data.get("score", 0))))
        start = max(0.0, float(data.get("start", 0)))
        end = min(duration, float(data.get("end", duration)))
        if end - start < 8:
            start, end = max(0.0, duration - 45), duration
        if end - start > 59:
            end = start + 59
        data["start"], data["end"] = start, end
        data["hashtags"] = [h.lstrip("#").replace(" ", "") for h in data.get("hashtags", []) if h.strip()]
        return data

    def find_facecam(self, frame: Path) -> Facecam | None:
        img = base64.standard_b64encode(frame.read_bytes()).decode()
        media = "image/png" if frame.suffix == ".png" else "image/jpeg"
        content = [
            {"type": "image", "source": {"type": "base64", "media_type": media, "data": img}},
            {"type": "text", "text": (
                "This is a frame from a live stream. Is there a webcam overlay showing the streamer's face? "
                "If yes, return its bounding box as fractions of image width/height (x, y = top-left corner). "
                "Include the whole webcam rectangle including its border. If not, has_facecam=false and zeros.")},
        ]
        data = self._json("You locate UI elements in video frames precisely.", content, FACECAM_SCHEMA, 2000)
        if not data or not data.get("has_facecam"):
            return None
        x, y, w, h = (max(0.0, min(1.0, float(data[k]))) for k in ("x", "y", "w", "h"))
        if w < 0.05 or h < 0.05 or x + w > 1.01 or y + h > 1.01:
            return None
        return Facecam(x, y, min(w, 1 - x), min(h, 1 - y))
