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
- Story moments are fine to clip, but NEVER spoil in title or hook_text: describe the reaction, not the \
  plot twist ("Kai was NOT ready for this ending", not what happens). Set spoiler=true for story reveals.

Pick the best continuous segment of 12-58 seconds (start/end in seconds, relative to the fragment). \
Start right before the setup (no long intro), end right after the payoff/reaction.

Write all viewer-facing text in the requested audience language:
- title: punchy, max 70 characters, includes the streamer name when it helps, no fake claims or clickbait lies.
- description: 1-2 sentences.
- hashtags: 3-6 tags without '#', always including gta6.
- hook_text: overlay for the first 3 seconds, max 6 words, makes the viewer stay.
Score 1-10 where 7+ means you would post it on a big channel today.

Also tag the in-game situation (in English, regardless of audience), so the same moment from different \
streamers can be matched later:
- event: short canonical description, specific enough that another streamer hitting the same moment gets \
  nearly the same text (mission name, character, location, object, plot beat if identifiable).
- event_type: story (cutscene / plot beat), mission, gameplay (open-world chaos), social (chat, irl, \
  other streamers), other."""

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
        "event": {"type": "string"},
        "event_type": {"type": "string", "enum": ["story", "mission", "gameplay", "social", "other"]},
        "spoiler": {"type": "boolean"},
    },
    "required": ["keep", "score", "start", "end", "title", "description", "hashtags", "hook_text", "reason",
                 "event", "event_type", "spoiler"],
    "additionalProperties": False,
}

GROUP_SYSTEM = """You build "N streamers react to the same moment" compilations for a GTA 6 short-form channel. \
These outperform single clips because viewers love comparing reactions.

You get candidate clips from different streamers. Each has an event tag, a suggested best window and a \
timestamped transcript (all times in seconds of that clip's source file). Find groups where at least \
{min_streamers} DIFFERENT streamers react to the SAME in-game moment (same plot beat, mission, scene or \
very specific situation). Similar-but-different situations do not count. Never put two clips of one streamer \
in a group, never reuse a clip across groups. Return no groups rather than weak ones.

For each group pick one segment per clip (start/end in that clip's source seconds, at least 4s each) focused \
on the reaction. Total duration of all segments must be at most {max_seconds:.0f}s. Order segments for flow: \
open with a strong hook, end with the biggest reaction.
Viewer-facing text in {lang}: title (max 70 chars, e.g. "Streamers react to ..."), description (1-2 \
sentences), hashtags (3-6, no '#', include gta6), hook_text (max 6 words, shown over the first segment). \
Never reveal plot twists in title or hook_text — tease the reaction instead. Score 1-10 as for a big channel."""

GROUP_SCHEMA = {
    "type": "object",
    "properties": {
        "groups": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "event": {"type": "string"},
                    "segments": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "clip_id": {"type": "integer"},
                                "start": {"type": "number"},
                                "end": {"type": "number"},
                            },
                            "required": ["clip_id", "start", "end"],
                            "additionalProperties": False,
                        },
                    },
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "hashtags": {"type": "array", "items": {"type": "string"}},
                    "hook_text": {"type": "string"},
                    "score": {"type": "integer"},
                },
                "required": ["event", "segments", "title", "description", "hashtags", "hook_text", "score"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["groups"],
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

DIGEST_SYSTEM = """You are the showrunner of a daily long-form YouTube video "GTA 6 on stream: the best of the \
day". You get today's candidate moments from many streamers (event tag, score, suggested window, timestamped \
transcript; times are seconds in each clip's source file).

Build the episode:
- Pick {min_segments}+ segments, total about {target_minutes:.0f} minutes (hard max {max_minutes:.0f}). Each \
  segment 10-90s, one per clip, start/end in that clip's source seconds. Prefer the strongest, most varied moments; \
  avoid two segments about the same event unless they show contrasting reactions back to back.
- Order for retention: very strong cold open first, keep variety (story / chaos / funny), save one of the best \
  for the end. Group same-event reactions next to each other.
- chapter: short chapter title (max 45 chars). context: one sentence (max 120 chars) a viewer needs to get the \
  moment — this is editorial value we add, write it like a host, not a summary of the transcript.
- title: max 90 chars, compelling and honest, mention the biggest streamers/moments.
- description: 2-4 sentences (chapters are appended automatically).
- tags: 8-15 search tags. thumbnail_text: max 4 words, huge-font-friendly. thumbnail_clip_id and \
  thumbnail_at: the clip and source second whose frame works best as a thumbnail (peak reaction).
- No story spoilers in title, thumbnail_text or chapter names (tease reactions, not plot reveals); context \
  lines for story chapters should set up the scene without giving away the outcome.
All viewer-facing text in {lang}."""

DIGEST_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "description": {"type": "string"},
        "tags": {"type": "array", "items": {"type": "string"}},
        "thumbnail_text": {"type": "string"},
        "thumbnail_clip_id": {"type": "integer"},
        "thumbnail_at": {"type": "number"},
        "segments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "clip_id": {"type": "integer"},
                    "start": {"type": "number"},
                    "end": {"type": "number"},
                    "chapter": {"type": "string"},
                    "context": {"type": "string"},
                },
                "required": ["clip_id", "start", "end", "chapter", "context"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["title", "description", "tags", "thumbnail_text", "thumbnail_clip_id", "thumbnail_at",
                 "segments"],
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

    def group(self, audience: str, candidates: list[dict], min_streamers: int, max_seconds: float) -> list[dict]:
        """candidates: [{id, streamer, event, event_type, window, transcript}] -> сырые группы от модели."""
        system = GROUP_SYSTEM.format(min_streamers=min_streamers, max_seconds=max_seconds,
                                     lang=LANG_NAMES.get(audience, audience))
        content = "Candidate clips:\n" + json.dumps(candidates, ensure_ascii=False, indent=1)
        data = self._json(system, content, GROUP_SCHEMA, 16000)
        return data.get("groups", []) if data else []

    def digest(self, audience: str, candidates: list[dict], min_segments: int, target_minutes: float,
               max_minutes: float) -> dict | None:
        system = DIGEST_SYSTEM.format(min_segments=min_segments, target_minutes=target_minutes,
                                      max_minutes=max_minutes, lang=LANG_NAMES.get(audience, audience))
        content = "Today's candidate moments:\n" + json.dumps(candidates, ensure_ascii=False, indent=1)
        return self._json(system, content, DIGEST_SCHEMA, 16000)

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
