"""Монтаж вертикального клипа: 9:16, вебка + игра, анимированные субтитры, хук."""
from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

from .config import Facecam, RenderCfg


@dataclass
class Word:
    start: float
    end: float
    text: str


def _ts(t: float) -> str:
    t = max(t, 0.0)
    h = int(t // 3600)
    m = int(t % 3600 // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _esc(text: str) -> str:
    return text.replace("\\", "").replace("{", "(").replace("}", ")").replace("\n", " ")


def chunk_words(words: list[Word], max_words: int = 3, max_gap: float = 0.6) -> list[list[Word]]:
    chunks: list[list[Word]] = []
    for w in words:
        if (chunks and len(chunks[-1]) < max_words and w.start - chunks[-1][-1].end <= max_gap):
            chunks[-1].append(w)
        else:
            chunks.append([w])
    return chunks


def build_ass(words: list[Word], cfg: RenderCfg, hook_text: str = "", hook_seconds: float = 3.0,
              label: str = "", duration: float = 0.0) -> str:
    """ASS-субтитры: фразы по 1-3 слова, текущее слово подсвечено жёлтым.

    Время слов — относительно начала клипа.
    """
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {cfg.width}
PlayResY: {cfg.height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,{cfg.font},{cfg.font_size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,6,2,2,60,60,{cfg.subs_margin_v},1
Style: Hook,{cfg.font},{int(cfg.font_size * 0.8)},&H00000000,&H00000000,&H0000E5FF,&H0000E5FF,-1,0,0,0,100,100,0,0,3,18,0,8,80,80,140,1
Style: Label,{cfg.font},{int(cfg.font_size * 0.55)},&H00FFFFFF,&H00FFFFFF,&H60000000,&H60000000,-1,0,0,0,100,100,0,0,3,12,0,7,40,40,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = []
    if label:
        end = duration or (max((w.end for w in words), default=0.0) + 5)
        lines.append(f"Dialogue: 2,{_ts(0)},{_ts(end)},Label,,0,0,0,,{_esc(label)}")
    if hook_text:
        lines.append(f"Dialogue: 1,{_ts(0)},{_ts(hook_seconds)},Hook,,0,0,0,,{_esc(hook_text.upper())}")
    for chunk in chunk_words(words):
        for i, w in enumerate(chunk):
            end = chunk[i + 1].start if i + 1 < len(chunk) else w.end
            parts = []
            for j, x in enumerate(chunk):
                t = _esc(x.text.strip().upper())
                parts.append("{\\c&H0000E5FF&}" + t + "{\\c&H00FFFFFF&}" if j == i else t)
            pop = "{\\fscx108\\fscy108\\t(0,80,\\fscx100\\fscy100)}" if i == 0 else ""
            lines.append(f"Dialogue: 0,{_ts(w.start)},{_ts(end)},Sub,,0,0,0,,{pop}{' '.join(parts)}")
    return head + "\n".join(lines) + "\n"


def build_filter(cfg: RenderCfg, facecam: Facecam | None) -> str:
    """filter_complex для 16:9 -> 9:16. Выход: [v]."""
    W, H = cfg.width, cfg.height
    if facecam:
        cam_h = int(H * cfg.cam_ratio) // 2 * 2
        game_h = H - cam_h
        f = facecam
        return (
            "[0:v]split[c][g];"
            f"[c]crop=iw*{f.w:.4f}:ih*{f.h:.4f}:iw*{f.x:.4f}:ih*{f.y:.4f},"
            f"scale={W}:{cam_h}:force_original_aspect_ratio=increase,crop={W}:{cam_h},setsar=1[cam];"
            f"[g]crop='min(iw,ih*{W}/{game_h})':ih,scale={W}:{game_h},setsar=1[game];"
            "[cam][game]vstack=inputs=2[v]"
        )
    return (
        "[0:v]split[a][b];"
        f"[a]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=25:5,eq=brightness=-0.15[bg];"
        f"[b]scale={W}:-2[fg];"
        "[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v]"
    )


def render(src: Path, out: Path, start: float, duration: float, words: list[Word],
           cfg: RenderCfg, facecam: Facecam | None = None, hook_text: str = "", label: str = "") -> Path:
    """words — с временем относительно начала клипа (start)."""
    work = out.parent
    ass = work / (out.stem + ".ass")
    ass.write_text(build_ass(words, cfg, hook_text, label=label, duration=duration), encoding="utf-8")
    fc = build_filter(cfg, facecam) + f";[v]ass={ass.name}[out]"
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-ss", f"{start:.3f}", "-i", str(src.resolve()), "-t", f"{duration:.3f}",
        "-filter_complex", fc, "-map", "[out]", "-map", "0:a:0?",
        "-c:v", "libx264", "-preset", cfg.preset, "-crf", str(cfg.crf), "-pix_fmt", "yuv420p",
        "-r", "30", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
    ]
    if cfg.loudnorm:
        cmd += ["-af", "loudnorm=I=-14:TP=-1.5:LRA=11"]
    cmd += ["-movflags", "+faststart", str(out.resolve())]
    subprocess.run(cmd, check=True, cwd=work)
    ass.unlink(missing_ok=True)
    return out


@dataclass
class Segment:
    """Кусок подборки: время — в секундах исходника `src`."""
    clip_id: int
    streamer: str
    src: Path
    start: float
    end: float
    words: list[Word]
    facecam: Facecam | None


def render_compilation(segments: list[Segment], out: Path, cfg: RenderCfg, hook_text: str = "") -> Path:
    """Каждый кусок монтируется отдельно (своя вебка, подпись @стример), затем склейка без перекодирования."""
    parts = []
    try:
        for i, seg in enumerate(segments):
            part = out.parent / f"{out.stem}_p{i}.mp4"
            rel = [Word(w.start - seg.start, w.end - seg.start, w.text)
                   for w in seg.words if w.end > seg.start and w.start < seg.end]
            render(seg.src, part, seg.start, seg.end - seg.start, rel, cfg, seg.facecam,
                   hook_text if i == 0 else "", label=f"@{seg.streamer}")
            parts.append(part)
        lst = out.with_suffix(".txt")
        lst.write_text("".join(f"file '{p.resolve()}'\n" for p in parts))
        subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
                        "-i", str(lst), "-c", "copy", "-movflags", "+faststart", str(out)], check=True)
        lst.unlink(missing_ok=True)
    finally:
        for p in parts:
            p.unlink(missing_ok=True)
    return out


def extract_frame(src: Path, out: Path, at: float = 1.0) -> Path:
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{at:.2f}",
                    "-i", str(src), "-frames:v", "1", "-vf", "scale=1280:-2", str(out)], check=True)
    return out


def extract_audio(src: Path, out: Path) -> Path:
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
                    "-vn", "-ac", "1", "-ar", "16000", str(out)], check=True)
    return out


def probe_duration(src: Path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=nw=1:nk=1", str(src)], capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0
