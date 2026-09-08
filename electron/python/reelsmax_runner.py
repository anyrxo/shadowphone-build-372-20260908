#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import sys
import warnings
from pathlib import Path
from typing import Any

EVENT_PREFIX = "__REELSMAX_JSON__"
VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
AUDIO_EXTENSIONS = {".m4a", ".mp3", ".wav", ".aac"}

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

warnings.filterwarnings(
    "ignore",
    message=r"In file .* bytes wanted but 0 bytes read at frame index .* Using the last valid frame instead\.",
)


def emit(payload: dict[str, Any]) -> None:
    print(f"{EVENT_PREFIX}{json.dumps(payload, ensure_ascii=False)}", flush=True)


def count_files(folder: Path, extensions: set[str]) -> int:
    if not folder.exists():
        return 0
    return sum(1 for item in folder.iterdir() if item.is_file() and item.suffix.lower() in extensions)


def list_recent_outputs(folder: Path, limit: int = 12) -> list[dict[str, Any]]:
    if not folder.exists():
        return []
    files = [
        item for item in folder.iterdir()
        if item.is_file() and item.suffix.lower() in (VIDEO_EXTENSIONS | IMAGE_EXTENSIONS)
    ]
    files.sort(key=lambda item: item.stat().st_mtime, reverse=True)
    return [
        {
            "name": item.name,
            "path": str(item),
            "size": item.stat().st_size,
            "updated_at": item.stat().st_mtime,
        }
        for item in files[:limit]
    ]


def load_bot(project_dir: Path):
    run_path = project_dir / "run.py"
    if not run_path.exists():
        raise FileNotFoundError(f"run.py not found in {project_dir}")

    spec = importlib.util.spec_from_file_location("reelsmax_project", run_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load project run.py")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    bot_cls = getattr(module, "MoviePyPILEmojiBot", None)
    if bot_cls is None:
        raise RuntimeError("MoviePyPILEmojiBot class not found in run.py")

    return bot_cls(project_dir)


def inspect_project(project_dir: Path) -> dict[str, Any]:
    bot = load_bot(project_dir)
    reels_dir = project_dir / "reels"
    audio_dir = project_dir / "audio"
    output_dir = project_dir / "output"
    flashes_dir = project_dir / "flashes"
    gifs_dir = project_dir / "gifs"
    emojis_dir = project_dir / "emojis"

    info = {
        "project_dir": str(project_dir),
        "run_path": str(project_dir / "run.py"),
        "valid": True,
        "counts": {
            "reels": count_files(reels_dir, VIDEO_EXTENSIONS),
            "audio": count_files(audio_dir, AUDIO_EXTENSIONS),
            "flashes": count_files(flashes_dir, IMAGE_EXTENSIONS),
            "gifs": count_files(gifs_dir, {".gif"}),
            "emojis": count_files(emojis_dir, {".png"}),
            "output": count_files(output_dir, VIDEO_EXTENSIONS | IMAGE_EXTENSIONS),
            "captions": len(getattr(bot, "captions", []) or []),
        },
        "folders": {
            "reels": str(reels_dir),
            "audio": str(audio_dir),
            "output": str(output_dir),
            "flashes": str(flashes_dir),
            "gifs": str(gifs_dir),
            "emojis": str(emojis_dir),
        },
        "outputs": list_recent_outputs(output_dir),
    }
    return info


def clear_output(project_dir: Path) -> dict[str, Any]:
    output_dir = project_dir / "output"
    deleted = 0
    if output_dir.exists():
        for item in output_dir.iterdir():
            if item.is_file() and item.suffix.lower() in (VIDEO_EXTENSIONS | IMAGE_EXTENSIONS):
                item.unlink(missing_ok=True)
                deleted += 1
    return {"deleted": deleted, "output_dir": str(output_dir)}


def estimate_total(mode: str, counts: dict[str, int], count: int) -> int:
    captions = counts["captions"]
    reels = counts["reels"]
    audio = counts["audio"]
    if mode == "single":
        return max(1, count)
    if mode == "random_sounds":
        return captions
    if mode == "random_captions":
        return audio
    if mode == "unique_pairs":
        return min(reels, audio, captions)
    if mode == "all_combinations":
        return reels * audio * captions
    raise ValueError(f"Unsupported mode: {mode}")


def run_mode(project_dir: Path, mode: str, count: int) -> dict[str, Any]:
    bot = load_bot(project_dir)
    inspect_info = inspect_project(project_dir)
    counts = inspect_info["counts"]
    total = estimate_total(mode, counts, count)
    if total <= 0:
        raise RuntimeError("Project does not have enough inputs to generate output.")

    progress = {"completed": 0}
    original_render = bot.create_video_with_caption_and_emojis
    original_audio = bot.add_audio_to_video

    def wrapped_render(video_path, caption, output_path):
        index = progress["completed"] + 1
        emit({
            "type": "item_start",
            "index": index,
            "total": total,
            "video": Path(str(video_path)).name,
            "output": Path(str(output_path)).name,
        })
        ok = original_render(video_path, caption, output_path)
        if ok:
            progress["completed"] += 1
            emit({
                "type": "progress",
                "completed": progress["completed"],
                "total": total,
                "output": Path(str(output_path)).name,
            })
        else:
            emit({
                "type": "item_failed",
                "index": index,
                "total": total,
                "output": Path(str(output_path)).name,
            })
        return ok

    def wrapped_audio(video_path, audio_path, output_path):
        emit({
            "type": "audio_stage",
            "video": Path(str(video_path)).name,
            "audio": Path(str(audio_path)).name if audio_path else None,
            "output": Path(str(output_path)).name,
        })
        return original_audio(video_path, audio_path, output_path)

    bot.create_video_with_caption_and_emojis = wrapped_render
    bot.add_audio_to_video = wrapped_audio

    emit({
        "type": "run_start",
        "mode": mode,
        "count": count,
        "total": total,
        "project_dir": str(project_dir),
    })

    if mode == "single":
        for _ in range(max(1, count)):
            bot.process_single_video()
    elif mode == "random_sounds":
        bot.process_reels_with_random_sounds()
    elif mode == "random_captions":
        bot.process_reels_with_random_captions()
    elif mode == "unique_pairs":
        bot.process_unique_pairs_only()
    elif mode == "all_combinations":
        bot.process_all_combinations()
    else:
        raise ValueError(f"Unsupported mode: {mode}")

    outputs = list_recent_outputs(project_dir / "output")
    emit({
        "type": "run_complete",
        "mode": mode,
        "completed": progress["completed"],
        "total": total,
        "output_count": len(outputs),
    })
    return {
        "mode": mode,
        "completed": progress["completed"],
        "total": total,
        "outputs": outputs,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="ShadowPhone ReelsMax local runner")
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser("inspect")
    inspect_parser.add_argument("--project-dir", required=True)

    clear_parser = subparsers.add_parser("clear")
    clear_parser.add_argument("--project-dir", required=True)

    run_parser = subparsers.add_parser("run")
    run_parser.add_argument("--project-dir", required=True)
    run_parser.add_argument(
        "--mode",
        choices=["single", "random_sounds", "random_captions", "unique_pairs", "all_combinations"],
        required=True,
    )
    run_parser.add_argument("--count", type=int, default=1)

    return parser.parse_args()


def main() -> int:
    args = parse_args()
    project_dir = Path(args.project_dir).expanduser().resolve()
    try:
        if args.command == "inspect":
            print(json.dumps(inspect_project(project_dir), ensure_ascii=False))
            return 0
        if args.command == "clear":
            print(json.dumps(clear_output(project_dir), ensure_ascii=False))
            return 0
        if args.command == "run":
            result = run_mode(project_dir, args.mode, getattr(args, "count", 1))
            print(json.dumps(result, ensure_ascii=False))
            return 0
        raise RuntimeError(f"Unknown command: {args.command}")
    except Exception as exc:  # pragma: no cover - CLI wrapper
        emit({"type": "error", "message": str(exc)})
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
