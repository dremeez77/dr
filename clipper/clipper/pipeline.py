"""Оркестратор: следит за эфирами, ловит моменты, монтирует, отправляет на модерацию."""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

import aiohttp

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from . import compilation as C
from . import digest as D
from . import render as R
from .chat import TwitchChat, YouTubeChat
from .config import Facecam, Settings, Streamer
from .db import DB
from .detector import SpikeDetector, Spike
from .llm import Claude
from .recorder import RingRecorder
from .telegram_bot import TelegramBot
from .transcribe import Transcriber, transcript_lines
from .twitch import Twitch, parse_ts

log = logging.getLogger(__name__)


@dataclass
class Job:
    clip_id: int
    streamer: Streamer
    source: str            # chat | twitch_clip | manual
    video: Path
    moment_offset: float   # где внутри файла пик реакции (для кадра вебки)
    chat_sample: list[str] = field(default_factory=list)
    clip_title: str = ""


@dataclass
class LiveInfo:
    title: str
    video_url: str
    since: float


class Pipeline:
    def __init__(self, s: Settings):
        self.s = s
        self.db = DB(s.data_dir / "clips.db")
        self.claude = Claude(s.llm_model, s.llm_effort)
        self.transcriber = Transcriber(s.whisper_model, s.whisper_device, s.whisper_compute)
        self.queue: asyncio.Queue[Job] = asyncio.Queue()
        self.live: dict[str, LiveInfo] = {}
        self.recorders: dict[str, RingRecorder] = {}
        self.detectors: dict[str, SpikeDetector] = {}
        self.yt_chats: dict[str, YouTubeChat] = {}
        self.facecams: dict[str, tuple[Facecam | None, float]] = {}
        self.game_ids: set[str] = set()
        self._comp_seen: dict[str, int] = {}
        self.paused = False
        self.session: aiohttp.ClientSession | None = None
        self.twitch: Twitch | None = None
        self.chat: TwitchChat | None = None
        self.bot: TelegramBot | None = None

    # ---------- ключи ----------
    @staticmethod
    def key(st: Streamer) -> str:
        return st.channel.lower() if st.platform == "twitch" else st.name.lower()

    def by_key(self, k: str) -> Streamer | None:
        return next((st for st in self.s.streamers if self.key(st) == k), None)

    # ---------- запуск ----------
    async def run(self):
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=120)) as session:
            self.session = session
            self.twitch = Twitch(self.s.twitch_client_id, self.s.twitch_client_secret, session)
            self.chat = TwitchChat(session, self.on_chat)
            tasks = [self._live_loop(), self._clips_loop(), self.chat.run(), self._cleanup_loop()]
            if self.s.comp.enabled:
                tasks.append(self._compilations_loop())
            if self.s.digest.enabled:
                tasks.append(self._digest_loop())
            if self.s.telegram_token:
                self.bot = TelegramBot(self.s.telegram_token, session)
                self.bot.on_action = self.on_action
                self.bot.on_command = self.on_command
                self.bot.allowed_chats = set(self.s.telegram_chats.values())
                tasks.append(self.bot.run())
            tasks += [self._worker(i) for i in range(self.s.workers)]
            await self.notify_all("🟢 Конвейер запущен. Слежу за: " + ", ".join(x.name for x in self.s.streamers))
            await asyncio.gather(*tasks)

    async def notify_all(self, text: str):
        if self.bot:
            for chat in set(self.s.telegram_chats.values()):
                await self.bot.send_text(chat, text)

    # ---------- эфиры ----------
    async def _live_loop(self):
        tick = 0
        while True:
            try:
                await self._check_live(check_youtube=tick % 3 == 0)
            except Exception as e:  # noqa: BLE001
                log.exception("live check failed: %s", e)
            tick += 1
            await asyncio.sleep(self.s.live_poll_seconds)

    async def _check_live(self, check_youtube: bool):
        now = time.time()
        found: dict[str, LiveInfo] = {}
        tw = [st for st in self.s.streamers if st.platform == "twitch"]
        if tw:
            if not self.game_ids:
                self.game_ids = await self.twitch.game_ids(self.s.game_names)
                log.info("GTA game ids: %s", self.game_ids)
            names = {n.lower() for n in self.s.game_names}
            streams = await self.twitch.live_streams([st.channel for st in tw])
            for st in tw:
                info = streams.get(st.channel.lower())
                if info and (info.get("game_id") in self.game_ids or info.get("game_name", "").lower() in names):
                    found[self.key(st)] = LiveInfo(info.get("title", ""), st.url, parse_ts(info["started_at"]))
        for st in self.s.streamers:
            if st.platform != "youtube":
                continue
            k = self.key(st)
            if not check_youtube:
                if k in self.live:
                    found[k] = self.live[k]
                continue
            yl = await youtube_live(st.channel)
            if yl and any(kw in yl[1].lower() for kw in st.title_keywords):
                found[k] = LiveInfo(yl[1], f"https://www.youtube.com/watch?v={yl[0]}", now)

        for k, info in found.items():
            if k not in self.live:
                await self._on_live_start(self.by_key(k), info)
        for k in list(self.live):
            if k not in found:
                await self._on_live_stop(self.by_key(k))
        self.live = found

    async def _on_live_start(self, st: Streamer, info: LiveInfo):
        log.info("LIVE: %s — %s", st.name, info.title)
        k = self.key(st)
        self.detectors[k] = SpikeDetector(k, **vars(self.s.detector))
        if st.platform == "twitch":
            await self.chat.join(st.channel)
        else:
            yc = YouTubeChat(st.name, info.video_url, self.on_chat, asyncio.get_running_loop())
            yc.start()
            self.yt_chats[k] = yc
        if st.record and sum(r.running for r in self.recorders.values()) < self.s.max_recordings:
            rec = self.recorders.get(k) or RingRecorder(
                st.name, info.video_url, self.s.data_dir / "segments",
                self.s.buffer_minutes, self.s.segment_seconds, self.s.quality)
            rec.url = info.video_url
            self.recorders[k] = rec
            rec.start()
        await self.notify_all(f"🔴 {st.name} в эфире с GTA: {info.title}")

    async def _on_live_stop(self, st: Streamer):
        log.info("OFFLINE: %s", st.name)
        k = self.key(st)
        self.detectors.pop(k, None)
        if st.platform == "twitch":
            await self.chat.part(st.channel)
        elif k in self.yt_chats:
            self.yt_chats.pop(k).stop()
        if k in self.recorders:
            await self.recorders[k].stop()

    # ---------- кандидаты: чат ----------
    def on_chat(self, chan: str, text: str, ts: float):
        if self.paused:
            return
        det = self.detectors.get(chan)
        if det:
            spike = det.add(text, ts)
            if spike:
                asyncio.get_running_loop().create_task(self._on_spike(spike))

    def _allowed(self, st: Streamer, moment: float) -> bool:
        if self.db.has_moment_near(st.name, moment, 60):
            return False
        return self.db.count_since(st.name, time.time() - 3600) < st.max_per_hour

    async def _on_spike(self, spike: Spike):
        st = self.by_key(spike.channel)
        rec = self.recorders.get(spike.channel)
        if not st or not rec or not rec.running or not self._allowed(st, spike.at):
            return
        cid = self.db.create(f"chat:{st.name}:{int(spike.at)}", st.name, st.audience, "chat", spike.at,
                             {"ratio": round(spike.ratio, 1), "rate": round(spike.rate, 1)})
        if cid is None:
            return
        log.info("SPIKE %s x%.1f (%.1f msg/s) -> clip %s", st.name, spike.ratio, spike.rate, cid)
        d = self.s.detector
        await asyncio.sleep(d.post_seconds + 2 * self.s.segment_seconds + 2)
        out = self.s.data_dir / "work" / f"{cid}_src.ts"
        offset = await rec.extract(spike.at - d.pre_seconds, spike.at + d.post_seconds, out)
        if offset is None:
            self.db.update(cid, status="failed_extract")
            return
        await self.queue.put(Job(cid, st, "chat", out, offset + d.pre_seconds, spike.sample))

    # ---------- кандидаты: клипы зрителей Twitch ----------
    async def _clips_loop(self):
        while True:
            await asyncio.sleep(self.s.clips_poll_seconds)
            if self.paused:
                continue
            try:
                await self._poll_clips()
            except Exception as e:  # noqa: BLE001
                log.warning("clips poll failed: %s", e)

    async def _poll_clips(self):
        live_tw = [self.by_key(k) for k in self.live if self.by_key(k).platform == "twitch"]
        if not live_tw:
            return
        ids = await self.twitch.resolve_users([st.channel for st in live_tw])
        for st in live_tw:
            bid = ids.get(st.channel)
            if not bid:
                continue
            clips = await self.twitch.recent_clips(bid, time.time() - 1800)
            for c in sorted(clips, key=lambda c: -c["view_count"])[:3]:
                if c["view_count"] < self.s.clips_min_views:
                    break
                moment = parse_ts(c["created_at"])
                if not self._allowed(st, moment):
                    continue
                cid = self.db.create(f"twclip:{c['id']}", st.name, st.audience, "twitch_clip", moment,
                                     {"url": c["url"], "views": c["view_count"], "title": c["title"]})
                if cid is None:
                    continue
                out = self.s.data_dir / "work" / f"{cid}_src.mp4"
                if await download(c["url"], out):
                    await self.queue.put(Job(cid, st, "twitch_clip", out, c.get("duration", 30) * 0.7,
                                             clip_title=c["title"]))
                else:
                    self.db.update(cid, status="failed_download")

    # ---------- обработка ----------
    async def _worker(self, i: int):
        while True:
            job = await self.queue.get()
            try:
                self.db.update(job.clip_id, status="processing")
                result = await asyncio.to_thread(self.process, job)
                if result and self.bot:
                    await self._send_for_review(job, result)
            except Exception as e:  # noqa: BLE001
                log.exception("job %s failed: %s", job.clip_id, e)
                self.db.update(job.clip_id, status="failed")
            finally:
                self.queue.task_done()

    def process(self, job: Job) -> dict | None:
        """Синхронная тяжёлая часть: Whisper -> Claude -> ffmpeg."""
        st, work = job.streamer, self.s.data_dir / "work"
        duration = R.probe_duration(job.video)
        audio = R.extract_audio(job.video, work / f"{job.clip_id}.wav")
        words = self.transcriber.transcribe(audio, st.language)
        audio.unlink(missing_ok=True)
        verdict = self.claude.judge(st.name, st.audience, job.source, duration,
                                    transcript_lines(words), job.chat_sample, job.clip_title)
        score = verdict["score"] if verdict else None
        keep = bool(verdict and verdict["keep"] and score >= self.s.min_score)
        # слабый одиночный сюжетный момент — в пул для подборок (рендер не тратим)
        pool = bool(verdict and not keep and self.s.comp.enabled and score >= self.s.comp.min_pool_score
                    and verdict.get("event_type") in ("story", "mission"))
        if not keep and not pool:
            reason = verdict["reason"] if verdict else "LLM недоступна"
            log.info("clip %s rejected by judge: %s", job.clip_id, reason)
            self.db.update(job.clip_id, status="rejected_auto", score=score, meta={"reason": reason})
            job.video.unlink(missing_ok=True)
            return None
        s, e = verdict["start"], verdict["end"]
        facecam = self._facecam(st, job.video, min(job.moment_offset, max(duration - 1, 0)))
        # исходник и слова храним 3 дня — из них собираются подборки
        src = self.s.data_dir / "out" / f"{job.clip_id}_src{job.video.suffix}"
        job.video.replace(src)
        meta = {"reason": verdict["reason"], "event": verdict["event"], "event_type": verdict["event_type"],
                "src": str(src), "duration": duration, "window": [round(s, 1), round(e, 1)],
                "facecam": vars(facecam) if facecam else None,
                "words": [[round(w.start, 2), round(w.end, 2), w.text] for w in words]}
        fields = dict(score=score, title=verdict["title"], description=verdict["description"],
                      hashtags=" ".join(verdict["hashtags"]), meta=meta)
        if pool:
            log.info("clip %s -> pool (%s/10): %s", job.clip_id, score, verdict["event"])
            self.db.update(job.clip_id, status="pool", **fields)
            return None
        rel = [R.Word(w.start - s, w.end - s, w.text) for w in words if w.end > s and w.start < e]
        out = self.s.data_dir / "out" / f"{job.clip_id}_{st.name}.mp4"
        R.render(src, out, s, e - s, rel, self.s.render, facecam, verdict["hook_text"])
        self.db.update(job.clip_id, status="review", video_path=str(out), **fields)
        verdict["video"] = out
        return verdict

    def _facecam(self, st: Streamer, video: Path, at: float) -> Facecam | None:
        if st.facecam:
            return st.facecam
        if not st.facecam_auto:
            return None
        cached = self.facecams.get(st.name)
        if cached and time.time() - cached[1] < 6 * 3600:
            return cached[0]
        frame = R.extract_frame(video, video.with_suffix(".jpg"), at)
        fc = self.claude.find_facecam(frame)
        frame.unlink(missing_ok=True)
        self.facecams[st.name] = (fc, time.time())
        log.info("facecam %s: %s", st.name, fc)
        return fc

    async def _send_for_review(self, job: Job, v: dict):
        st = job.streamer
        src = {"chat": "всплеск чата", "twitch_clip": "клип зрителей", "manual": "вручную"}[job.source]
        await self._send(job.clip_id, st.name, st.audience, src, v)

    async def _send(self, clip_id: int, who: str, audience: str, src: str, v: dict):
        tags = " ".join("#" + h for h in v["hashtags"])
        caption = (f"🎬 {who} · {audience.upper()} · {v['score']}/10 · {src}\n\n"
                   f"{v['title']}\n\n{v['description']}\n{tags}\n\n💬 {v.get('reason') or v.get('event', '')}")
        chat = self.s.chat_for(audience)
        if not chat or not self.bot:
            return
        has_yt = bool(self.s.youtube_tokens.get(audience))
        mid = await self.bot.send_clip(chat, v["video"], caption, clip_id, has_yt)
        self.db.update(clip_id, tg_message_id=mid)

    # ---------- подборки ----------
    async def _compilations_loop(self):
        while True:
            await asyncio.sleep(self.s.comp.interval_minutes * 60)
            if self.paused:
                continue
            for aud in sorted({st.audience for st in self.s.streamers}):
                try:
                    await self.make_compilations(aud)
                except Exception as e:  # noqa: BLE001
                    log.exception("compilations %s failed: %s", aud, e)

    async def make_compilations(self, audience: str) -> int:
        c = self.s.comp
        used = self.db.used_in_compilations()
        clips = [x for x in self.db.recent(audience, time.time() - c.lookback_hours * 3600, C.POOL_STATUSES)
                 if C.usable(x, used)]
        if len({x["streamer"] for x in clips}) < c.min_streamers:
            return 0
        signature = max(x["id"] for x in clips)
        if self._comp_seen.get(audience) == signature:
            return 0  # новых кандидатов не появилось — не тратим вызов модели
        self._comp_seen[audience] = signature
        groups = await asyncio.to_thread(self.claude.group, audience, C.payload(clips), c.min_streamers,
                                         c.max_seconds)
        by_id = {x["id"]: x for x in clips}
        made = 0
        for g in groups:
            segs = C.validate_group(g, by_id, c.min_streamers, c.max_seconds)
            if not segs or g.get("score", 0) < self.s.min_score:
                continue
            ids = sorted(x.clip_id for x in segs)
            who = " + ".join(x.streamer for x in segs)
            cid = self.db.create("comp:" + ",".join(map(str, ids)), who, audience, "compilation", time.time(),
                                 {"clip_ids": ids})
            if cid is None:
                continue
            for x in segs:
                by_id.pop(x.clip_id, None)  # один клип — одна подборка
            out = self.s.data_dir / "out" / f"{cid}_compilation.mp4"
            await asyncio.to_thread(R.render_compilation, segs, out, self.s.render, g.get("hook_text", ""))
            hashtags = [h.lstrip("#").replace(" ", "") for h in g.get("hashtags", []) if h.strip()]
            self.db.update(cid, status="review", score=int(g["score"]), title=g["title"],
                           description=g["description"], hashtags=" ".join(hashtags), video_path=str(out),
                           meta={"clip_ids": ids, "event": g.get("event", "")})
            log.info("compilation %s: %s — %s", cid, who, g.get("event"))
            await self._send(cid, who, audience, f"подборка ×{len(segs)}",
                             {**g, "hashtags": hashtags, "video": out, "reason": g.get("event", "")})
            made += 1
        return made

    # ---------- модерация ----------
    async def on_action(self, clip_id: int, action: str) -> str:
        clip = self.db.get(clip_id)
        if not clip:
            return "Клип не найден"
        if clip["status"] in ("published", "rejected", "manual"):
            return f"Уже обработан: {clip['status']}"
        if action == "reject":
            self.db.update(clip_id, status="rejected")
            return "Отклонено"
        if action == "manual":
            self.db.update(clip_id, status="manual")
            return "Отмечено: выкладываешь вручную (TikTok/VK/Reels)"
        if action == "yt":
            from .youtube_upload import upload
            token = self.s.youtube_tokens.get(clip["audience"])
            if not token:
                return "Нет YouTube-токена для этой аудитории"
            tags = (clip["hashtags"] or "").split()
            is_digest = clip["source"] == "digest"
            if is_digest:
                desc, thumb = clip["description"], Path(clip["meta"].get("thumb", ""))
            else:
                desc = f"{clip['description']}\n\n{clip['streamer']}\n" + " ".join("#" + t for t in tags)
                tags, thumb = tags + [clip["streamer"]], None
            try:
                vid = await asyncio.to_thread(upload, Path(token), Path(clip["video_path"]), clip["title"],
                                              desc, tags, self.s.youtube_privacy, False, not is_digest, thumb)
            except Exception as e:  # noqa: BLE001
                log.exception("youtube upload failed")
                return f"Ошибка загрузки: {e}"[:180]
            self.db.update(clip_id, status="published", youtube_id=vid)
            return f"Опубликовано: https://youtu.be/{vid}"
        return "Неизвестное действие"

    async def on_command(self, cmd: str) -> str:
        if cmd == "/pause":
            self.paused = True
            return "⏸ Поиск моментов на паузе"
        if cmd == "/resume":
            self.paused = False
            return "▶️ Поиск моментов возобновлён"
        if cmd == "/status":
            live = ", ".join(self.by_key(k).name for k in self.live) or "никого"
            rec = ", ".join(r.name for r in self.recorders.values() if r.running) or "нет"
            st = self.db.stats(time.time() - 86400)
            stats = ", ".join(f"{k}: {v}" for k, v in sorted(st.items())) or "пусто"
            return (f"{'⏸ ПАУЗА' if self.paused else '▶️ Работаю'}\nВ эфире с GTA: {live}\n"
                    f"Пишу: {rec}\nОчередь: {self.queue.qsize()}\nЗа 24ч: {stats}")
        if cmd == "/compile":
            async def compile_all():
                self._comp_seen.clear()
                made = 0
                for aud in sorted({st.audience for st in self.s.streamers}):
                    made += await self.make_compilations(aud)
                await self.notify_all(f"🧩 Собрано подборок: {made}")
            asyncio.get_running_loop().create_task(compile_all())
            return "🧩 Ищу совпадения и собираю подборки…"
        if cmd == "/digest":
            async def digest_all():
                for aud in self.s.digest.audiences:
                    try:
                        if not await self.make_digest(aud, force=True):
                            await self.notify_all(f"📼 Дайджест [{aud}]: мало материала")
                    except Exception as e:  # noqa: BLE001
                        log.exception("digest failed")
                        await self.notify_all(f"📼 Дайджест [{aud}] упал: {e}"[:300])
            asyncio.get_running_loop().create_task(digest_all())
            return "📼 Собираю дайджест, пришлю превью, когда будет готов (несколько минут)…"
        return "Команды: /status, /pause, /resume, /compile, /digest"

    # ---------- ежедневный дайджест ----------
    async def _digest_loop(self):
        d = self.s.digest
        while True:
            now = datetime.now(timezone.utc)
            target = D.next_run(now, d.hour, d.minute, d.timezone)
            log.info("next digest at %s", target.isoformat())
            await asyncio.sleep((target - now).total_seconds())
            for aud in d.audiences:
                try:
                    res = await self.make_digest(aud)
                    if not res:
                        await self.notify_all(f"📼 Дайджест [{aud}] не собран: мало материала за сутки")
                except Exception as e:  # noqa: BLE001
                    log.exception("digest %s failed: %s", aud, e)
            await asyncio.sleep(60)

    async def make_digest(self, audience: str, force: bool = False) -> int | None:
        d = self.s.digest
        day = datetime.now(ZoneInfo(d.timezone)).strftime("%Y-%m-%d")
        clips = D.candidates(self.db.recent(audience, time.time() - d.lookback_hours * 3600, D.DIGEST_STATUSES),
                             d.max_candidates)
        if len(clips) < d.min_segments:
            return None
        plan = await asyncio.to_thread(self.claude.digest, audience, D.payload(clips), d.min_segments,
                                       d.target_minutes, d.max_minutes)
        if not plan:
            return None
        by_id = {c["id"]: c for c in clips}
        segs = D.validate(plan, by_id, d.min_segments, d.max_minutes)
        if not segs:
            log.info("digest %s: plan rejected (too few valid segments)", audience)
            return None
        key = f"digest:{audience}:{day}" + (f":{int(time.time())}" if force else "")
        streamers = sorted({s.streamer for s in segs})
        cid = self.db.create(key, "Digest", audience, "digest", time.time(), {"clip_ids": [s.clip_id for s in segs]})
        if cid is None:
            return None  # сегодня уже собирали
        out = self.s.data_dir / "out" / f"{cid}_digest_{audience}_{day}.mp4"
        subtitle = ", ".join(streamers[:6]) + (" …" if len(streamers) > 6 else "")
        await asyncio.to_thread(R.render_digest, segs, out, self.s.render, plan["title"], subtitle)
        thumb_clip = by_id.get(plan.get("thumbnail_clip_id")) or by_id[segs[0].clip_id]
        thumb = await asyncio.to_thread(R.make_thumbnail, Path(thumb_clip["meta"]["src"]),
                                        float(plan.get("thumbnail_at", 0)), plan.get("thumbnail_text", ""),
                                        out.with_suffix(".jpg"), self.s.render)
        description = (f"{plan['description']}\n\n{D.chapters(segs)}\n\n"
                       + " ".join(f"@{s}" for s in streamers) + "\n#gta6 #gtavi")
        tags = [t.lstrip("#") for t in plan.get("tags", [])][:15]
        total = R.probe_duration(out)
        self.db.update(cid, status="review", score=10, title=plan["title"][:100], description=description,
                       hashtags=" ".join(tags), video_path=str(out),
                       meta={"clip_ids": [s.clip_id for s in segs], "thumb": str(thumb), "duration": total})
        log.info("digest %s ready: %s (%.0fs, %d segments)", audience, out, total, len(segs))
        if self.bot and self.s.chat_for(audience):
            caption = (f"📼 Дайджест · {audience.upper()} · {D.fmt_ts(total)} · {len(segs)} моментов\n\n"
                       f"{plan['title']}\n\n{description}")
            mid = await self.bot.send_photo(self.s.chat_for(audience), thumb, caption, cid,
                                            bool(self.s.youtube_tokens.get(audience)))
            self.db.update(cid, tg_message_id=mid)
        return cid

    # ---------- уборка ----------
    async def _cleanup_loop(self):
        while True:
            await asyncio.sleep(30)
            for r in self.recorders.values():
                r.cleanup()
            now = time.time()
            for sub, ttl in (("work", 2 * 3600), ("out", 3 * 86400)):
                for p in (self.s.data_dir / sub).iterdir():
                    if p.is_file() and now - p.stat().st_mtime > ttl:
                        p.unlink(missing_ok=True)


async def _run(*args: str, timeout: float = 120) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.DEVNULL)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return -1, ""
    return proc.returncode, out.decode(errors="replace")


async def youtube_live(channel_url: str) -> tuple[str, str] | None:
    """(video_id, title) если канал сейчас в эфире."""
    rc, out = await _run("yt-dlp", "--skip-download", "--no-warnings", "--playlist-items", "1",
                         "--print", "%(is_live)s\t%(id)s\t%(title)s", channel_url.rstrip("/") + "/live", timeout=60)
    if rc != 0 or not out.strip():
        return None
    is_live, vid, title = (out.strip().splitlines()[0].split("\t") + ["", ""])[:3]
    return (vid, title) if is_live == "True" else None


async def download(url: str, out: Path) -> bool:
    rc, _ = await _run("yt-dlp", "--no-warnings", "-q", "-f", "best", "-o", str(out), url, timeout=180)
    return rc == 0 and out.exists()
