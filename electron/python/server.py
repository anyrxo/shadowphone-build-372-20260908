#!/usr/bin/env python3
"""
🚀 ShadowPhone Module Server
FastAPI wrapper for Railway deployment

Exposes all 27 modules as API endpoints.
The Electron app calls this server to get action sequences.
"""

import sys

# Force UTF-8 stdout/stderr so emoji-laden log lines (e.g. '📧 Found Gmail
# account…') don't crash the brain on Windows where the default is cp1252.
# Mirrors the pattern in engagement_module.py and reelsmax_runner.py.
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Critical-dependency preflight. These are hard requirements for the brain to
# run at all. Import them up-front and COLLECT every failure so operators get a
# single actionable checklist instead of an opaque one-at-a-time traceback that
# only surfaces the first missing package. Kept emoji-free for Windows cp1252
# consoles. Do NOT convert these to no-op fallbacks — they must hard-fail.
import importlib

_CRITICAL_DEPS = {
    "fastapi": "fastapi",
    "pydantic": "pydantic",
    "httpx": "httpx",
    "jwt": "PyJWT",
    "uvicorn": "uvicorn",
}
_missing_deps = []
for _mod, _pkg in _CRITICAL_DEPS.items():
    try:
        importlib.import_module(_mod)
    except Exception:
        _missing_deps.append((_mod, _pkg))
if _missing_deps:
    print("[Server] FATAL: required dependency missing:", file=sys.stderr, flush=True)
    for _mod, _pkg in _missing_deps:
        print(f"  - {_mod} (pip install {_pkg})", file=sys.stderr, flush=True)
    sys.exit(1)

# Build version for deployment verification
BUILD_VERSION = "v1.5.18-gallery-attr-fix"

import os
import json
import subprocess
import uuid
import shutil
import asyncio
import base64
import html
import re
from pathlib import Path
from datetime import datetime
from fastapi import (
    FastAPI,
    HTTPException,
    Header,
    BackgroundTasks,
    WebSocket,
    WebSocketDisconnect,
    File,
    UploadFile,
    Form,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import Optional, Dict, Any, List, Tuple
import httpx
# NOTE: supabase SDK import moved to lazy get_supabase() — saves ~50-80MB startup RAM

# Import WebSocket module adapter for legacy module support
try:
    from lib.ws_module_adapter import (
        WS_ADAPTED_MODULES,
        execute_adapted_module,
        WSDeviceAdapter,
        sanitize_module_payload,
    )
    # Per-module fault tolerance was added to the adapter so one bad import
    # no longer disables ALL ws-handled modules. We surface the failure list
    # in WebSocket error responses so users get a specific reason instead of
    # "not yet migrated".
    try:
        from lib.ws_module_adapter import WS_ADAPTER_IMPORT_FAILURES
    except ImportError:
        WS_ADAPTER_IMPORT_FAILURES = {}

    WS_ADAPTER_AVAILABLE = True
    print(
        f"[Server] WebSocket adapter loaded with {len(WS_ADAPTED_MODULES)} adapted modules"
        + (f" ({len(WS_ADAPTER_IMPORT_FAILURES)} import failure(s): {list(WS_ADAPTER_IMPORT_FAILURES.keys())})" if WS_ADAPTER_IMPORT_FAILURES else "")
    )
except ImportError as e:
    WS_ADAPTER_AVAILABLE = False
    WS_ADAPTED_MODULES = {}
    WS_ADAPTER_IMPORT_FAILURES = {"__adapter__": f"{type(e).__name__}: {e}"}
    def sanitize_module_payload(value, **_kwargs):
        if isinstance(value, dict):
            return {key: "[redacted unavailable payload]" for key in value}
        return "[redacted unavailable payload]"
    print(f"[Server] WebSocket adapter not available: {e}")

# Import Discord notifier for user context
try:
    from modules.discord_notifier import set_user_id as set_discord_user_id

    DISCORD_NOTIFIER_AVAILABLE = True
    print("[Server] Discord notifier loaded - will use user's webhook from Supabase")
except ImportError as e:
    DISCORD_NOTIFIER_AVAILABLE = False
    set_discord_user_id = lambda x: None
    print(f"[Server] Discord notifier not available: {e}")

# Import lightweight runtime telemetry helpers
try:
    from lib.runtime_telemetry import RuntimeSpan, emit_runtime_event
    from lib.posting_progression_guards import (
        verify_feed_gallery,
        verify_media_selected,
        verify_feed_caption_editor,
        verify_story_gallery,
        verify_story_editor,
        verify_feed_submission_confirmed,
        verify_story_submission_confirmed,
        confirm_submission_with_recovery,
        nudge_toward_home_or_profile,
    )
except ImportError as e:
    RuntimeSpan = None

    verify_feed_gallery = None
    verify_media_selected = None
    verify_feed_caption_editor = None
    verify_story_gallery = None
    verify_story_editor = None
    verify_feed_submission_confirmed = None
    verify_story_submission_confirmed = None
    confirm_submission_with_recovery = None
    nudge_toward_home_or_profile = None

    def emit_runtime_event(event_type: str, **fields):
        return {"event_type": event_type, **fields}

    print(f"[Server] Runtime telemetry helpers not available: {e}")

# Initialize Supabase client - REQUIRES env vars, no hardcoded defaults
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
API_SECRET = os.getenv("SHADOWPHONE_API_SECRET", "")


def _verified_state_payload(key: str, label: str, result) -> dict:
    evidence = None
    artifact_id = getattr(result, "artifact_id", None)
    if artifact_id:
        evidence = {
            "kind": "artifact_ref",
            "artifact_id": artifact_id,
            "summary": f"artifact {artifact_id}",
        }

    return {
        "type": "verified_state",
        "message": f"{label}: {'verified' if getattr(result, 'ok', False) else 'warning'}",
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "verified": {
            "key": key,
            "label": label,
            "ok": bool(getattr(result, "ok", False)),
            "screenType": getattr(result, "screen_type", None),
            "confidence": getattr(result, "confidence", None),
            "contextLabel": getattr(result, "context_label", None),
            "source": "runtime_verified",
            "evidence": evidence,
            "evidence_kind": evidence.get("kind") if evidence else None,
            "evidence_summary": evidence.get("summary") if evidence else None,
        },
    }


async def _emit_verified_state(device, key: str, label: str, result) -> None:
    payload = _verified_state_payload(key, label, result)
    try:
        await device.websocket.send_json(payload)
    except Exception:
        pass


def _make_home_entry_precondition_failure(module_id: str, data: dict | None = None) -> dict:
    payload = data.copy() if isinstance(data, dict) else {}
    return {
        "success": False,
        "error": "Launcher could not verify Instagram home entry",
        "code": "HOME_ENTRY_NOT_VERIFIED",
        "data": {
            "module_id": module_id,
            "precondition": "verified_home_ready",
            **payload,
        },
    }


def _append_verified_postcondition(data: dict, key: str, label: str, result) -> dict:
    if not isinstance(data, dict):
        data = {}
    existing = data.get("verified_postconditions")
    if isinstance(existing, list):
        verified = [item for item in existing if isinstance(item, dict)]
    else:
        verified = []

    next_verified = _verified_state_payload(key, label, result)["verified"]
    next_key = str(next_verified.get("key") or "").strip()
    if next_key:
        verified = [item for item in verified if str(item.get("key") or "").strip() != next_key]

    verified.append(next_verified)
    data["verified_postconditions"] = verified
    return data


def _posting_state_failure(
    module_id: str,
    step: str,
    *,
    result=None,
    message: str | None = None,
) -> dict:
    screen_type = getattr(result, "screen_type", None) if result else None
    confidence = getattr(result, "confidence", None) if result else None
    detail = message or f"{step} did not reach the expected Instagram screen"
    if screen_type:
        detail = f"{detail} (classified {screen_type}, confidence {confidence or 'unknown'})"
    return {
        "success": False,
        "error": detail,
        "code": "POSTING_STATE_NOT_VERIFIED",
        "data": {
            "module_id": module_id,
            "step": step,
            "screen_type": screen_type,
            "confidence": confidence,
        },
    }


def _screen_has_camera_settings(device: object) -> bool:
    xml = str(getattr(device, "current_screen", "") or "").lower()
    return (
        "camera settings" in xml
        and (
            "always start on front camera" in xml
            or "camera tools" in xml
            or "camera settings markers" in xml
        )
    )


def _node_selected(raw_attrib: dict, content_desc: str) -> bool:
    if str(raw_attrib.get("selected", "")).lower() == "true":
        return True
    desc = (content_desc or "").strip().lower()
    return desc.startswith("selected ") and not desc.startswith("unselected ")


def _find_gallery_media_thumbnail(device: object, media_kind: str = "", index: int = 0):
    """Return a parsed gallery thumbnail node, excluding the camera tile."""
    parsed = device.get_parsed_screen_state() if hasattr(device, "get_parsed_screen_state") else None
    if not parsed:
        return None

    media_kind = (media_kind or "").strip().lower()
    nodes = []
    for node in parsed.find_by_resource_id("gallery_grid_item_thumbnail", contains=True):
        if not node.center or not node.bounds:
            continue
        desc_l = (node.content_desc or "").lower()
        if "camera" in desc_l:
            continue
        if media_kind in {"video", "reel"} and "video" not in desc_l:
            continue
        if media_kind in {"image", "photo"} and not (
            "photo" in desc_l or "image" in desc_l
        ):
            continue
        nodes.append(node)

    if not nodes and media_kind:
        for node in parsed.find_by_resource_id("gallery_grid_item_thumbnail", contains=True):
            if node.center and node.bounds and "camera" not in (node.content_desc or "").lower():
                nodes.append(node)

    nodes.sort(key=lambda node: (node.bounds[1], node.bounds[0]))
    if not nodes:
        return None

    selected = [
        node
        for node in nodes
        if _node_selected(node.raw_attrib, node.content_desc)
    ]
    if selected and index <= 0:
        return selected[0]

    unselected = [
        node
        for node in nodes
        if not _node_selected(node.raw_attrib, node.content_desc)
    ]
    pool = unselected or nodes
    safe_index = max(0, min(index, len(pool) - 1))
    return pool[safe_index]


async def _select_gallery_media(
    device: object,
    *,
    media_kind: str = "",
    index: int = 0,
    context: str = "gallery media",
) -> bool:
    await device.get_screen()
    target = _find_gallery_media_thumbnail(device, media_kind, index)
    if not target or not target.center:
        await device.send_log(f"{context}: no usable gallery media thumbnail found", "WARN")
        return False

    desired_selected = _node_selected(target.raw_attrib, target.content_desc)
    desc = target.content_desc or target.resource_id or "gallery thumbnail"
    if desired_selected and index <= 0:
        await device.send_log(f"{context}: desired media already selected ({desc})")
        return True

    await device.send_log(f"{context}: selecting {desc}")

    # Tap with retry — gallery animations can eat the first tap
    for attempt in range(3):
        await device.tap(target.center[0], target.center[1], wait_after=2500)

        # Re-dump screen to check if we moved past the gallery
        await device.get_screen()
        screen_xml = getattr(device, "current_screen", "") or ""

        # ─── REEL/POST flow indicators ───
        # Reel editor has Next + Audio/Effects/Filters in the right toolbar
        if device.text_on_screen("Next") or device.text_on_screen("Audio") or device.text_on_screen("Effects"):
            await device.send_log(f"{context}: media selected, editor visible (reel)")
            return True

        # ─── STORY flow indicators ───
        # On story gallery the success state is either:
        # (a) thumbnail content-desc flipped to "Selected ..." (single-step
        #     legacy IG), OR
        # (b) we're now on the story editor (sticker/text buttons appear),
        #     OR
        # (c) the cam_dest_story pill still shows but the thumbnail is
        #     Selected (modern IG two-step — caller will tap the pill next)
        if (
            "Selected Video thumbnail" in screen_xml
            or "Selected Photo thumbnail" in screen_xml
        ):
            await device.send_log(f"{context}: thumbnail confirmed Selected (story)")
            return True
        # Story editor exposes Aa "Add text", Stickers tray, Done button —
        # any of those means we advanced past the gallery.
        if (
            'content-desc="Add text"' in screen_xml
            or 'content-desc="Stickers"' in screen_xml
            or 'resource-id="com.instagram.android:id/asset_button"' in screen_xml
            or 'content-desc="Your story"' in screen_xml
        ):
            await device.send_log(f"{context}: story editor reached (story)")
            return True

        # ─── Generic Selected check (legacy thumbnail attribute) ───
        verify_target = _find_gallery_media_thumbnail(device, media_kind, 0)
        if verify_target and _node_selected(verify_target.raw_attrib, verify_target.content_desc):
            await device.send_log(f"{context}: media selected via content-desc")
            return True

        if attempt < 2:
            await device.send_log(f"{context}: tap {attempt + 1} didn't select, retrying...", "WARN")
            await device.wait(500)

    await device.send_log(f"{context}: all tap attempts exhausted, proceeding anyway", "WARN")
    return True


def _find_next_button(device: object, *, prefer_bottom: bool = False):
    parsed = device.get_parsed_screen_state() if hasattr(device, "get_parsed_screen_state") else None
    if not parsed:
        return None

    candidates = []
    for node in parsed.nodes:
        if not node.center or not node.bounds:
            continue
        text_l = (node.text or "").strip().lower()
        desc_l = (node.content_desc or "").strip().lower()
        rid_l = (node.resource_id or "").lower()
        is_next = (
            text_l == "next"
            or desc_l == "next"
            or "next_button" in rid_l
            or "clips_right_action_button" in rid_l
        )
        if not is_next:
            continue
        x1, y1, x2, y2 = node.bounds
        if x2 < 760:
            continue
        candidates.append(node)

    if not candidates:
        return None

    if prefer_bottom:
        candidates.sort(key=lambda node: (-node.center[1], -node.center[0]))
    else:
        candidates.sort(key=lambda node: (node.center[1], -node.center[0]))
    return candidates[0]


async def _tap_instagram_next(
    device: object,
    *,
    context: str,
    prefer_bottom: bool = False,
) -> bool:
    await device.get_screen()
    if _screen_has_camera_settings(device):
        await device.send_log(f"{context}: Camera Settings screen detected; refusing to tap Next", "ERROR")
        return False

    target = _find_next_button(device, prefer_bottom=prefer_bottom)
    if prefer_bottom and target and target.center and target.center[1] < 1500:
        await device.send_log(
            f"{context}: ignoring hidden/top Next while bottom Next is expected",
            "WARN",
        )
        target = None
    if target and target.center:
        await device.send_log(
            f"{context}: tapping Next at {target.center} "
            f"({target.resource_id or target.content_desc or target.text})"
        )
        await device.tap(target.center[0], target.center[1], wait_after=1800)
        return True

    fallback = (960, 2240) if prefer_bottom else (1000, 201)
    await device.send_log(f"{context}: Next selector not found; tapping fallback {fallback}", "WARN")
    await device.tap(fallback[0], fallback[1], wait_after=1800)
    return True


def _find_trial_reel_row_y(device: object):
    parsed = device.get_parsed_screen_state() if hasattr(device, "get_parsed_screen_state") else None
    if not parsed:
        return None

    candidates = []
    for node in parsed.nodes:
        if not node.center or not node.bounds:
            continue
        label = f"{node.text or ''} {node.content_desc or ''} {node.resource_id or ''}".strip().lower()
        if "trial" not in label:
            continue
        x1, y1, x2, y2 = node.bounds
        if y2 < 700 or y1 > 2150:
            continue
        candidates.append(node)

    if not candidates:
        return None

    candidates.sort(key=lambda node: (node.center[1], node.center[0]))
    return candidates[0].center[1]


async def _handle_trial_reel_popup(device: object) -> bool:
    await device.wait(800)
    await device.get_screen()
    parsed = device.get_parsed_screen_state() if hasattr(device, "get_parsed_screen_state") else None
    labels = [
        "Got it",
        "Keep as trial",
        "Keep trial",
        "Share as trial",
        "Try it",
        "OK",
    ]

    if parsed:
        for label in labels:
            matches = parsed.find_by_text(label, exact=False, case_sensitive=False)
            matches += parsed.find_by_content_desc(label, exact=False, case_sensitive=False)
            matches = [node for node in matches if node.center and node.bounds and node.center[1] > 700]
            if matches:
                matches.sort(key=lambda node: (-int(node.clickable), node.center[1]))
                target = matches[0]
                await device.send_log(f"Trial Reel popup: tapping '{label}'")
                await device.tap(target.center[0], target.center[1], wait_after=1000)
                return True

    if hasattr(device, "text_on_screen") and device.text_on_screen("Trial settings"):
        await device.send_log("Trial Reel popup visible but button selector missed; tapping bottom confirmation", "WARN")
        await device.tap(540, 2185, wait_after=1000)
        return True

    return False


async def _toggle_trial_reel_ws(device: object) -> bool:
    await device.get_screen()
    trial_y = _find_trial_reel_row_y(device)
    if trial_y is None:
        await device.send_log("Trial Reel toggle was not visible on the caption screen", "ERROR")
        return False

    await device.send_log(f"Trial Reel toggle: tapping row y={trial_y}")
    await device.tap(970, trial_y, wait_after=1200)
    await _handle_trial_reel_popup(device)
    await device.get_screen()
    return True


async def _select_create_menu_item(
    device: object,
    label: str,
    *,
    fallback_y: int,
    wait_after: int = 2000,
) -> bool:
    await device.get_screen()
    coords = None
    if hasattr(device, "find_element_by_content_description_exact_in_bounds"):
        coords = device.find_element_by_content_description_exact_in_bounds(
            label,
            min_y=900,
            max_y=1900,
            min_x=0,
            max_x=1080,
        )
    if not coords:
        coords = device.find_element_by_content_description(label)
    if not coords:
        coords = device.find_element_by_text(label.replace("Create new ", "").title())
    if coords:
        await device.send_log(f"Create menu: selecting '{label}' at {coords}")
        await device.tap(coords[0], coords[1], wait_after=wait_after)
        return True

    await device.send_log(f"Create menu: '{label}' not found; tapping fallback y={fallback_y}", "WARN")
    await device.tap(540, fallback_y, wait_after=wait_after)
    return False


def _find_story_share_control(device: object, label: str):
    parsed = device.get_parsed_screen_state() if hasattr(device, "get_parsed_screen_state") else None
    if not parsed:
        return None
    candidates = []
    for node in parsed.find_by_content_desc(label, exact=False, case_sensitive=False):
        if node.center and node.center[1] > 1900:
            candidates.append(node)
    for node in parsed.find_by_text(label, exact=False, case_sensitive=False):
        if node.center and node.center[1] > 1900:
            candidates.append(node)
    candidates.sort(key=lambda node: (node.center[1], node.center[0]))
    return candidates[0] if candidates else None


def _story_text_editor_open(device: object) -> bool:
    xml = str(getattr(device, "current_screen", "") or "").lower()
    if "camera settings" in xml:
        return False
    has_done = 'content-desc="done"' in xml or 'text="done"' in xml
    has_keyboard = "com.google.android.inputmethod" in xml
    has_text_tools = (
        "mention" in xml
        and "location" in xml
        and ("modern" in xml or "classic" in xml or has_keyboard)
    )
    return has_done and (has_keyboard or has_text_tools)


async def _tap_story_done_if_needed(device: object, context: str) -> bool:
    await device.get_screen()
    if not _story_text_editor_open(device):
        return True

    coords = None
    if hasattr(device, "find_element_by_content_description_exact_in_bounds"):
        coords = device.find_element_by_content_description_exact_in_bounds(
            "Done",
            min_y=80,
            max_y=360,
            min_x=780,
            max_x=1080,
        )
    if not coords:
        coords = device.find_element_by_content_description("Done") or device.find_element_by_text("Done")
    if coords:
        await device.send_log(f"{context}: closing story text editor with Done at {coords}")
        await device.tap(coords[0], coords[1], wait_after=1200)
    else:
        await device.send_log(f"{context}: story text editor open but Done not found; pressing Back", "WARN")
        await device.back()
        await device.wait(800)
    return True


async def _ensure_story_ready_to_share(device: object, context: str) -> bool:
    for attempt in range(3):
        await _tap_story_done_if_needed(device, context)
        await device.get_screen()
        if _screen_has_camera_settings(device):
            await device.send_log(f"{context}: Camera Settings screen detected instead of story editor", "ERROR")
            return False
        if _find_story_share_control(device, "Your story") or _find_story_share_control(device, "Share to"):
            return True
        xml = str(getattr(device, "current_screen", "") or "").lower()
        if "com.google.android.inputmethod" in xml:
            await device.send_log(f"{context}: keyboard still open; pressing Back")
            await device.back()
            await device.wait(800)
        elif (
            "asset_picker" in xml
            or "music_browser_container" in xml
            or "headmoji_stickers_container" in xml
            or "sticker_sheet" in xml
        ) and attempt < 2:
            await device.send_log(f"{context}: sticker/music sheet still open; pressing Back")
            await device.back()
            await device.wait(800)
        elif ('content-desc="done"' in xml or 'text="done"' in xml) and attempt < 2:
            await _tap_story_done_if_needed(device, context)
        else:
            await device.wait(800)
    await device.send_log(f"{context}: share controls were not visible after cleanup", "ERROR")
    return False


async def _tap_story_top_done(device: object, context: str, fallback=(990, 200)) -> bool:
    await device.get_screen()
    coords = None
    if hasattr(device, "find_element_by_content_description_exact_in_bounds"):
        coords = device.find_element_by_content_description_exact_in_bounds(
            "Done",
            min_y=80,
            max_y=700,
            min_x=720,
            max_x=1080,
        )
    if not coords and hasattr(device, "find_element_by_text_exact_in_bounds"):
        coords = device.find_element_by_text_exact_in_bounds(
            "Done",
            min_y=80,
            max_y=700,
            min_x=720,
            max_x=1080,
        )
    if not coords:
        coords = (
            device.find_element_by_resource_id("com.instagram.android:id/done_button")
            or device.find_element_by_resource_id("com.instagram.android:id/link_sticker_list_done_button")
        )
    if coords:
        await device.send_log(f"{context}: tapping Done at {coords}")
        await device.tap(coords[0], coords[1], wait_after=1200)
        return True

    await device.send_log(f"{context}: Done selector not found; tapping fallback {fallback}", "WARN")
    await device.tap(fallback[0], fallback[1], wait_after=1200)
    return False


async def _close_feed_caption_keyboard(device: object) -> None:
    await device.get_screen()
    xml = str(getattr(device, "current_screen", "") or "").lower()
    ok_btn = None
    if hasattr(device, "find_element_by_content_description_exact_in_bounds"):
        ok_btn = device.find_element_by_content_description_exact_in_bounds(
            "OK",
            min_y=80,
            max_y=360,
            min_x=760,
            max_x=1080,
        )
    ok_btn = ok_btn or device.find_element_by_text("OK") or device.find_element_by_content_description("OK")
    if ok_btn:
        await device.send_log(f"Caption editor: closing keyboard with OK at {ok_btn}")
        await device.tap(ok_btn[0], ok_btn[1], wait_after=1200)
        return
    if "com.google.android.inputmethod" in xml:
        await device.send_log("Caption editor: closing keyboard with Back")
        await device.back()
        await device.wait(800)

# JWT secret for module token verification (shared with Next.js)
MODULE_JWT_SECRET = os.getenv("MODULE_JWT_SECRET", "")

# JWT verification
import jwt

# Rate limiting — OPTIONAL. slowapi is only wired as app.state.limiter + an
# exception handler (no @limiter.limit decorators or middleware are active), so a
# missing slowapi must NOT take down the whole brain. Source-mode users whose
# Python lacks it would otherwise get a permanently dead brain at boot
# ("ModuleNotFoundError: No module named 'slowapi'"). Degrade to a no-op limiter.
try:
    from slowapi import Limiter, _rate_limit_exceeded_handler
    from slowapi.util import get_remote_address
    from slowapi.errors import RateLimitExceeded
    limiter = Limiter(key_func=get_remote_address)
    SLOWAPI_AVAILABLE = True
except Exception as _slowapi_err:  # missing/broken slowapi (e.g. source-mode Python)
    SLOWAPI_AVAILABLE = False
    print(f"[Server] slowapi unavailable ({_slowapi_err}); rate limiting disabled", flush=True)

    class RateLimitExceeded(Exception):
        pass

    class _NoopLimiter:
        def limit(self, *_a, **_k):
            def _decorator(fn):
                return fn
            return _decorator

    def _rate_limit_exceeded_handler(_request, _exc):
        return None

    limiter = _NoopLimiter()


# JWT token verification helper
def get_jwt_algorithm(token: str) -> str:
    """Extract the algorithm from a JWT token header without verifying."""
    try:
        header = jwt.get_unverified_header(token)
        return header.get("alg", "unknown")
    except Exception:
        return "unknown"


def verify_module_jwt(token: str) -> dict:
    """
    Verify a module JWT token and extract claims.

    Returns:
        dict: {"valid": True, "user_id": str, "email": str} on success
              {"valid": False, "error": str} on failure
    """
    # Check algorithm first to route Clerk (RS256) vs Module (HS256) tokens
    alg = get_jwt_algorithm(token)
    if alg == "RS256":
        # This is a Clerk token - delegate to Clerk JWKS verification
        try:
            claims = verify_clerk_jwt(token)
            return {
                "valid": True,
                "user_id": claims.get("sub", ""),
                "email": claims.get("email", ""),
                "type": "clerk",
            }
        except HTTPException as e:
            return {"valid": False, "error": e.detail}
        except Exception as e:
            return {"valid": False, "error": str(e)}

    # HS256 Module JWT verification requires secret
    if not MODULE_JWT_SECRET:
        return {"valid": False, "error": "JWT verification not configured"}

    try:
        claims = jwt.decode(
            token,
            MODULE_JWT_SECRET,
            algorithms=["HS256"],
            audience="module-server",
            issuer="shadowphone.io",
        )
        return {
            "valid": True,
            "user_id": claims.get("userId", ""),
            "email": claims.get("email", ""),
            "type": claims.get("type", ""),
        }
    except jwt.ExpiredSignatureError:
        return {"valid": False, "error": "Token expired"}
    except jwt.InvalidAudienceError:
        return {"valid": False, "error": "Invalid audience"}
    except jwt.InvalidIssuerError:
        return {"valid": False, "error": "Invalid issuer"}
    except jwt.InvalidTokenError as e:
        return {"valid": False, "error": f"Invalid token: {str(e)}"}


# Supabase: lazy-loaded singleton (saves ~50-80MB startup RAM)
_supabase_client = None


def get_supabase():
    """Lazy-load Supabase client on first use."""
    global _supabase_client
    if _supabase_client is not None:
        return _supabase_client
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        return None
    from supabase import create_client

    _supabase_client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    print(f"[Server] Supabase client initialized (lazy) ({SUPABASE_URL[:30]}...)")
    return _supabase_client


# Backwards compat alias
supabase = None
if SUPABASE_URL and SUPABASE_SERVICE_KEY:
    print(f"[Server] Supabase configured (lazy-load on first use)")
else:
    missing = []
    if not SUPABASE_URL:
        missing.append("SUPABASE_URL")
    if not SUPABASE_SERVICE_KEY:
        missing.append("SUPABASE_SERVICE_ROLE_KEY")
    print(
        f"[Server] WARNING: Missing env vars: {', '.join(missing)} - usage tracking disabled"
    )

# Log JWT config status
if MODULE_JWT_SECRET:
    print(f"[Server] JWT authentication enabled (secret configured)")
else:
    print(f"[Server] WARNING: MODULE_JWT_SECRET not configured - JWT auth disabled")


# ==================== SMSPOOL + reCAPTCHA HELPERS ====================
# Used by execute_account_creation_ws to unblock the Gmail-add path when
# Google demands phone verification or shows the "I'm not a robot" reCAPTCHA.
# Live-validated 2026-05-26 — Google's MinuteMaid signin webview consistently
# triggers reCAPTCHA on any new-device signin attempt that doesn't have a
# trusted device fingerprint. ADB can tap the checkbox, but it won't solve a
# visual challenge — for that we ship the burden to a human (or skip if the
# checkbox-only "low-friction" challenge passes through).

# smspool key for USA numbers — required from the environment. No baked-in
# fallback: an unset key fails the signup/buy paths CLOSED with a clear error
# rather than silently draining the owner's pooled balance from a stale build.
SMSPOOL_API_KEY = (os.environ.get("SMSPOOL_API_KEY", "") or "").strip()
# Service ID 395 = Google/Gmail on smspool's catalog; country 1 = USA.
# Overridable via env so we can pivot to a different service or country
# without a redeploy.
SMSPOOL_SERVICE_GMAIL = "395"
SMSPOOL_SERVICE_INSTAGRAM = "457"
SMSPOOL_COUNTRY = os.environ.get("SMSPOOL_COUNTRY", "US")


async def smspool_buy_number(
    api_key: str = "",
    service: str = SMSPOOL_SERVICE_INSTAGRAM,
    country: str = SMSPOOL_COUNTRY,
    max_price: float = 0.50,
) -> dict:
    """Buy a fresh SMS-receivable number for the configured service.

    service: "457" = Instagram (~$0.42), "395" = Google/Gmail (~$0.96).
    Returns: {"ok": bool, "phone": "+1...", "order_id": "...", "error": "..."}
    """
    key = api_key
    if not key:
        return {"ok": False, "error": "SMSPool API key not configured"}
    try:
        price_cap = float(max_price)
    except (TypeError, ValueError):
        price_cap = 0
    if not (0.01 <= price_cap <= 100) or abs(price_cap * 100 - round(price_cap * 100)) > 1e-8:
        return {"ok": False, "error": "Invalid maximum SMS price"}
    selected_country = str(country or "US").strip().upper()
    selected_country = {"1": "US", "44": "GB"}.get(selected_country, selected_country)
    if selected_country not in {"US", "GB"}:
        return {"ok": False, "error": "SMSPool country must be US or GB"}
    ambiguous_purchase = {
        "ok": False,
        "code": "ACCOUNT_CREATION_OUTCOME_UNCERTAIN",
        "error": "SMSPool purchase response was lost or unreadable. Check active orders before retrying.",
        "manual_action_required": True,
        "reconciliation_required": True,
    }
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                "https://api.smspool.net/purchase/sms",
                data={"key": key, "service": service, "country": selected_country, "max_price": f"{price_cap:.2f}", "quantity": "1"},
            )
    except Exception:
        return ambiguous_purchase
    if getattr(r, "is_success", True) is not True:
        return ambiguous_purchase
    try:
        data = r.json()
    except Exception:
        return ambiguous_purchase
    try:
        if data.get("success") == 1 and (data.get("number") or data.get("phonenumber")):
            order_id = str(data.get("order_id") or "").strip()
            if not order_id:
                return {
                    "ok": False,
                    "code": "ACCOUNT_CREATION_OUTCOME_UNCERTAIN",
                    "error": "SMSPool reported a purchase without a trackable order. Check SMSPool active orders before retrying.",
                    "manual_action_required": True,
                    "reconciliation_required": True,
                }
            raw_number = str(data.get("number") or data.get("phonenumber") or "")
            digits = "".join(ch for ch in raw_number if ch.isdigit())
            calling_code = "".join(ch for ch in str(data.get("cc") or "") if ch.isdigit())
            if not data.get("number") and calling_code:
                local_digits = digits.lstrip("0")
                if not local_digits.startswith(calling_code):
                    digits = calling_code + local_digits
            if not digits:
                return {
                    "ok": False,
                    "code": "ACCOUNT_CREATION_OUTCOME_UNCERTAIN",
                    "error": "SMSPool reported a purchase without a usable phone number. Check active orders before retrying.",
                    "manual_action_required": True,
                    "reconciliation_required": True,
                }
            return {"ok": True, "phone": "+" + digits, "order_id": order_id, "raw": data}
        return {"ok": False, "error": data.get("message") or data.get("errors") or "smspool returned no number", "raw": data}
    except Exception:
        return ambiguous_purchase


async def smspool_poll_sms(order_id: str, api_key: str = "", timeout_s: int = 180) -> dict:
    """Poll the order until SMS arrives or timeout. status==3 means received.

    Returns: {"ok": bool, "code": "123456", "error": "..."}
    """
    key = api_key or SMSPOOL_API_KEY
    if not key:
        return {"ok": False, "error": "SMSPOOL_API_KEY not configured"}
    elapsed = 0
    poll_every = 5
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            while elapsed < timeout_s:
                r = await client.post(
                    "https://api.smspool.net/sms/check",
                    data={"key": key, "orderid": order_id},
                )
                data = r.json()
                # status 3 = SMS received. 1 = waiting. 6 = cancelled. 4 = refunded.
                if str(data.get("status")) == "3" and data.get("sms"):
                    # Strip non-digits, return first 4-8 digit run as code.
                    import re as _re_sms
                    m = _re_sms.search(r"\d{4,8}", str(data["sms"]))
                    return {"ok": True, "code": m.group(0) if m else str(data["sms"]), "raw": data}
                await asyncio.sleep(poll_every)
                elapsed += poll_every
        return {"ok": False, "error": f"smspool timeout after {timeout_s}s"}
    except Exception as e:
        return {"ok": False, "error": f"smspool poll: {e}"}


async def smspool_cancel_order(
    order_id: str,
    api_key: str = "",
    *,
    max_attempts: int = 3,
    retry_delay_s: float = 3,
) -> dict:
    key = api_key or SMSPOOL_API_KEY
    if not key or not order_id:
        return {"ok": False, "refunded": False, "reason": "missing_order_configuration"}
    attempts = max(1, min(int(max_attempts or 1), 3))
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            for attempt in range(1, attempts + 1):
                try:
                    response = await client.post(
                        "https://api.smspool.net/sms/cancel",
                        data={"key": key, "orderid": order_id},
                    )
                    payload = response.json()
                except Exception:
                    if attempt < attempts:
                        await asyncio.sleep(retry_delay_s)
                        continue
                    return {"ok": False, "refunded": False, "reason": "provider_unreachable"}
                if payload.get("success") == 1:
                    return {"ok": True, "refunded": True, "reason": "cancelled"}
                message = str(payload.get("message") or "").lower()
                if "cannot be cancelled yet" in message and attempt < attempts:
                    await asyncio.sleep(retry_delay_s)
                    continue
                reason = "time_locked" if "cannot be cancelled yet" in message else "provider_rejected"
                return {"ok": False, "refunded": False, "reason": reason}
    except Exception:
        return {"ok": False, "refunded": False, "reason": "provider_unreachable"}
    return {"ok": False, "refunded": False, "reason": "provider_rejected"}


async def cancel_smspool_order_if_safe(
    order_id: str,
    api_key: str,
    *,
    code_received: bool,
    code_submitted: bool,
    provider: str = "smspool",
    api_username: str = "",
) -> dict:
    if not order_id or code_received or code_submitted:
        return {
            "attempted": False,
            "cancelled": False,
            "refund_requested": False,
            "reconciliation_required": bool(order_id),
        }
    if provider == "textverified":
        from textverified_sms import TextVerifiedSms
        outcome = await TextVerifiedSms(api_key, api_username).cancel(order_id)
        cancelled = bool(outcome.get("ok"))
    elif provider == "smspool":
        outcome = await smspool_cancel_order(order_id, api_key)
        cancelled = bool(outcome.get("ok") and outcome.get("refunded"))
    else:
        cancelled = False
    return {
        "attempted": True,
        "cancelled": cancelled,
        "refund_requested": cancelled,
        "reconciliation_required": not cancelled,
    }


async def validate_account_creation_phone_profile(
    device,
    config: dict,
    profile_id: str,
) -> dict:
    import re as _profile_re

    expected = str(profile_id or "").strip()
    target = str((config or {}).get("target_user_id") or "").strip()
    if not _profile_re.fullmatch(r"\d+", expected) or not _profile_re.fullmatch(r"\d+", target):
        return {
            "success": False,
            "code": "ACCOUNT_CREATION_PROFILE_REQUIRED",
            "error": "Account creation requires exact profileId and target_user_id values.",
        }
    if target != expected:
        return {
            "success": False,
            "code": "ACCOUNT_CREATION_PROFILE_MISMATCH",
            "error": "profileId and target_user_id do not identify the same Android user.",
        }
    try:
        current_raw = await device.shell("am get-current-user")
    except Exception:
        return {
            "success": False,
            "code": "ACCOUNT_CREATION_ACTIVE_USER_UNKNOWN",
            "error": "Could not verify the active Android user. No SMS order was purchased.",
        }
    current_match = _profile_re.fullmatch(r"\s*(\d+)\s*", str(current_raw or ""))
    if not current_match:
        return {
            "success": False,
            "code": "ACCOUNT_CREATION_ACTIVE_USER_UNKNOWN",
            "error": "Could not verify the active Android user. No SMS order was purchased.",
        }
    if current_match.group(1) != expected:
        return {
            "success": False,
            "code": "ACCOUNT_CREATION_ACTIVE_USER_MISMATCH",
            "error": "The active Android user changed. No SMS order was purchased.",
        }
    return None


def sanitize_account_creation_phone_result(result: dict, config: dict = None) -> dict:
    import re as _sanitize_re

    if not isinstance(result, dict):
        return result
    sensitive_fields = {
        "password", "ig_password", "phone", "phone_number", "formatted_phone",
        "order_id", "smspool_order_id", "code", "sms_code", "smspool_api_key",
        "textverified_api_key", "textverified_api_username",
    }
    secrets = []

    def is_status_code(depth, key, value):
        return (
            depth == 0
            and str(key).lower() == "code"
            and isinstance(value, str)
            and _sanitize_re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{2,}", value) is not None
        )

    def collect(value, depth=0):
        if isinstance(value, dict):
            for key, item in value.items():
                normalized = str(key).lower()
                if normalized in sensitive_fields and not is_status_code(depth, key, item):
                    if isinstance(item, (str, int, float)) and str(item):
                        secrets.append(str(item))
                else:
                    collect(item, depth + 1)
        elif isinstance(value, (list, tuple)):
            for item in value:
                collect(item, depth + 1)

    collect(result)
    collect(config or {}, 1)

    def scrub_text(value):
        text = str(value)
        for secret in secrets:
            text = text.replace(secret, "[redacted]")
        text = _sanitize_re.sub(
            r'''(?ix)(\b(?:order[_\s-]*id|sms[_\s-]*code|phone(?:[_\s-]*(?:number|no))?|(?:ig[_\s-]*)?password|(?:smspool[_\s-]*)?api[_\s-]*key)\b\s*["']?\s*[:=]\s*["']?)[^"'\s,;}]+''',
            r"\1[redacted]",
            text,
        )
        text = _sanitize_re.sub(r"\+?\d(?:[\s()-]*\d){7,}", "[redacted phone]", text)
        text = _sanitize_re.sub(
            r"(?i)(\border(?:\s+id)?\s*[=:]?\s*)[A-Z0-9_-]{5,}",
            r"\1[redacted]",
            text,
        )
        text = _sanitize_re.sub(
            r"(?i)(\b(?:got|entering|typing)\s+(?:sms\s+)?code\s+)[^\s,)]+",
            r"\1[redacted]",
            text,
        )
        return text

    def clean(value, depth=0):
        if isinstance(value, str):
            return scrub_text(value)
        if isinstance(value, list):
            return [clean(item, depth + 1) for item in value]
        if isinstance(value, tuple):
            return tuple(clean(item, depth + 1) for item in value)
        if not isinstance(value, dict):
            return value
        output = {}
        for key, item in value.items():
            normalized = str(key).lower()
            if normalized in sensitive_fields and not is_status_code(depth, key, item):
                continue
            output[key] = clean(item, depth + 1)
        return output

    return clean(result)


# ==================== CAPTION POOL HELPERS ====================

import random


async def get_caption_for_account(account_id: str, user_id: str = None) -> str:
    """
    Fetch a random caption from the account's assigned caption pool.

    Flow:
    1. Get account's caption_pool_id from instagram_accounts
    2. Fetch pool content from content_pools
    3. Pick a random line from the content

    Returns: A random caption string, or empty string if no pool assigned.
    """
    if not get_supabase():
        print("[CaptionPool] Supabase not configured")
        return ""

    try:
        # 1. Get account's caption_pool_id
        query = (
            get_supabase()
            .from_("instagram_accounts")
            .select("caption_pool_id, username")
            .eq("id", account_id)
        )
        if user_id:
            query = query.eq("user_id", user_id)

        account_result = query.single().execute()

        if not account_result.data:
            print(f"[CaptionPool] Account {account_id} not found")
            return ""

        pool_id = account_result.data.get("caption_pool_id")
        username = account_result.data.get("username", "unknown")

        if not pool_id:
            print(f"[CaptionPool] No caption pool assigned to @{username}")
            return ""

        # 2. Fetch pool content
        pool_result = (
            get_supabase()
            .from_("content_pools")
            .select("content, name")
            .eq("id", pool_id)
            .single()
            .execute()
        )

        if not pool_result.data:
            print(f"[CaptionPool] Pool {pool_id} not found")
            return ""

        content = pool_result.data.get("content", "")
        pool_name = pool_result.data.get("name", "Unknown")

        if not content:
            print(f"[CaptionPool] Pool '{pool_name}' is empty")
            return ""

        # 3. Pick random line (filter out empty lines and comments)
        lines = [
            line.strip()
            for line in content.split("\n")
            if line.strip() and not line.strip().startswith("#")
        ]

        if not lines:
            print(f"[CaptionPool] Pool '{pool_name}' has no valid captions")
            return ""

        caption = random.choice(lines)
        print(
            f"[CaptionPool] Selected caption for @{username} from '{pool_name}': {caption[:50]}..."
        )
        return caption

    except Exception as e:
        print(f"[CaptionPool] Error fetching caption: {e}")
        return ""


async def get_comment_for_account(account_id: str, user_id: str = None) -> str:
    """
    Fetch a random comment from the account's assigned comment pool.
    Same logic as get_caption_for_account but uses comment_pool_id.
    """
    if not get_supabase():
        return ""

    try:
        query = (
            get_supabase()
            .from_("instagram_accounts")
            .select("comment_pool_id, username")
            .eq("id", account_id)
        )
        if user_id:
            query = query.eq("user_id", user_id)

        account_result = query.single().execute()

        if not account_result.data:
            return ""

        pool_id = account_result.data.get("comment_pool_id")

        if not pool_id:
            return ""

        pool_result = (
            get_supabase()
            .from_("content_pools")
            .select("content")
            .eq("id", pool_id)
            .single()
            .execute()
        )

        if not pool_result.data:
            return ""

        content = pool_result.data.get("content", "")
        lines = [
            line.strip()
            for line in content.split("\n")
            if line.strip() and not line.strip().startswith("#")
        ]

        if not lines:
            return ""

        return random.choice(lines)

    except Exception as e:
        print(f"[CommentPool] Error fetching comment: {e}")
        return ""


async def get_post_defaults_for_account(account_id: str, user_id: str = None) -> dict:
    """
    Fetch posting defaults from instagram_accounts for one account.

    Returns:
      {
        "username": str,
        "fixed_caption": str,   # already stripped
        "content_type": str,    # "image" | "reel" | ""
      }
    """
    defaults = {"username": "", "fixed_caption": "", "content_type": ""}

    if not get_supabase():
        return defaults

    try:
        query = (
            get_supabase()
            .from_("instagram_accounts")
            .select("username, fixed_caption, content_type")
            .eq("id", account_id)
        )
        if user_id:
            query = query.eq("user_id", user_id)

        result = query.single().execute()
        row = result.data or {}

        username = str(row.get("username") or "").strip()
        fixed_caption = str(row.get("fixed_caption") or "").strip()
        content_type = str(row.get("content_type") or "").strip().lower()
        if content_type == "video":
            content_type = "reel"
        if content_type in {"both", "all"}:
            content_type = ""
        if content_type not in {"image", "reel"}:
            content_type = ""

        return {
            "username": username,
            "fixed_caption": fixed_caption,
            "content_type": content_type,
        }
    except Exception as e:
        print(f"[PostDefaults] Error fetching account defaults: {e}")
        return defaults


async def inspect_shadowphone_content(device: "RemoteDevice") -> dict:
    """
    Inspect phone for postable media.  Checks multiple directories because
    content can land in different places depending on transfer method:
    - /sdcard/ShadowPhone/content  (direct ADB push for owner profile)
    - /sdcard/Download             (Vanadium download for non-owner profiles)
    - /sdcard/DCIM/Camera          (camera captures)
    - current Android user's MediaStore (secondary GrapheneOS profiles)
    """
    try:
        current_user_raw = await device.shell("am get-current-user")
    except Exception:
        current_user_raw = "0"
    current_user = re.sub(r"\D", "", str(current_user_raw or "0")) or "0"

    media_dirs = [
        "/sdcard/ShadowPhone/content",
        "/sdcard/Download",
        "/sdcard/DCIM",
        "/sdcard/DCIM/Camera",
        "/sdcard/Pictures",
        "/sdcard/Pictures/ShadowPhone",
        "/sdcard/Movies",
        f"/storage/emulated/{current_user}/ShadowPhone/content",
        f"/storage/emulated/{current_user}/Download",
        f"/storage/emulated/{current_user}/DCIM",
        f"/storage/emulated/{current_user}/DCIM/Camera",
        f"/storage/emulated/{current_user}/Pictures",
        f"/storage/emulated/{current_user}/Pictures/ShadowPhone",
        f"/storage/emulated/{current_user}/Movies",
    ]
    image_exts = (".jpg", ".jpeg", ".png", ".webp")
    video_exts = (".mp4", ".mov", ".m4v", ".webm")

    all_files = []
    seen_media_names = set()
    shell_files = []
    mediastore_files = []

    def _add_media_file(name: str, bucket: list[str]) -> None:
        key = name.strip().lower()
        if not key or key in seen_media_names:
            return
        seen_media_names.add(key)
        all_files.append(name)
        bucket.append(name)

    for media_dir in media_dirs:
        try:
            raw = await device.shell(f"ls -1 {media_dir} 2>/dev/null || true")
        except Exception:
            continue
        for line in (raw or "").splitlines():
            name = line.strip()
            if not name or name.startswith("ls:"):
                continue
            if name.lower().endswith(image_exts + video_exts):
                _add_media_file(name, shell_files)

    async def _query_mediastore(uri: str, projection: str) -> list[str]:
        try:
            raw = await device.shell(
                f"content query --user {current_user} --uri {uri} "
                f"--projection {projection} 2>/dev/null | head -200 || true"
            )
        except Exception:
            return []

        names = []
        for line in (raw or "").splitlines():
            if "_display_name=" not in line:
                continue
            match = re.search(r"_display_name=([^,]+)", line)
            if match:
                names.append(match.group(1).strip())
        return names

    media_store_queries = [
        ("content://media/external/images/media", "_display_name:relative_path", image_exts),
        ("content://media/external/video/media", "_display_name:relative_path", video_exts),
    ]
    for uri, projection, exts in media_store_queries:
        for name in await _query_mediastore(uri, projection):
            if name.lower().endswith(exts):
                _add_media_file(name, mediastore_files)

    image_count = sum(1 for f in all_files if f.lower().endswith(image_exts))
    video_count = sum(1 for f in all_files if f.lower().endswith(video_exts))
    total = image_count + video_count

    if total == 0:
        status = "empty"
    elif video_count > 0 and image_count == 0:
        status = "video_only"
    elif image_count > 0 and video_count == 0:
        status = "image_only"
    elif image_count > 0 and video_count > 0:
        status = "mixed"
    else:
        status = "unknown"

    return {
        "status": status,
        "images": image_count,
        "videos": video_count,
        "total": total,
        "android_user": current_user,
        "shell_files": len(shell_files),
        "mediastore_files": len(mediastore_files),
    }


def resolve_post_content_type_from_scan(
    content_scan: dict,
    explicit_content_type: str = "",
    db_content_type: str = "",
) -> dict:
    """Resolve feed/reel media type without downgrading an explicit user request."""

    content_type = explicit_content_type or db_content_type or "reel"

    detected_type = None
    if content_scan.get("status") == "video_only":
        detected_type = "reel"
    elif content_scan.get("status") == "image_only":
        detected_type = "image"

    if explicit_content_type:
        required_key = "videos" if explicit_content_type == "reel" else "images"
        required_count = int(content_scan.get(required_key, 0) or 0)
        if required_count <= 0:
            media_label = "video/reel" if explicit_content_type == "reel" else "image/photo"
            found_summary = (
                f"{content_scan.get('images', 0)} images / "
                f"{content_scan.get('videos', 0)} videos"
            )
            return {
                "ok": False,
                "content_type": explicit_content_type,
                "error": (
                    f"Requested {explicit_content_type} post but no {media_label} media was found "
                    f"in the current Android profile gallery ({found_summary}). "
                    "Run Push Content for this account/profile with the matching media type first."
                ),
            }
        return {"ok": True, "content_type": explicit_content_type, "detected_type": detected_type}

    # If only one media type exists on device, trust phone content over stale account defaults.
    if detected_type and content_type != detected_type:
        return {
            "ok": True,
            "content_type": detected_type,
            "detected_type": detected_type,
            "override_message": (
                f"Detected {detected_type} media in the active Android profile gallery. "
                f"Overriding configured content_type='{content_type}'."
            ),
        }

    return {"ok": True, "content_type": content_type, "detected_type": detected_type}


async def _handle_instagram_media_permission_popup(
    device: "RemoteDevice", context: str = ""
) -> bool:
    """
    Handle Android media permission dialogs for Instagram posting flows.

    This is safe to call on every run (idempotent): it only taps when an
    allow-permission popup is actually on screen.
    """
    await device.get_screen()
    xml = device.current_screen or ""
    xml_lower = xml.lower()

    is_permission_popup = (
        "com.android.permissioncontroller" in xml
        or "com.android.packageinstaller" in xml
        or "permission_allow" in xml_lower
        or ("allow all" in xml_lower and "don't allow" in xml_lower)
        or ("allow all" in xml_lower and "don’t allow" in xml_lower)
        or "while using the app" in xml_lower
        or ("photos and videos" in xml_lower and "allow" in xml_lower)
        or ("camera" in xml_lower and "allow" in xml_lower)
        or ("microphone" in xml_lower and "allow" in xml_lower)
        or ("record audio" in xml_lower and "allow" in xml_lower)
    )
    if not is_permission_popup:
        return False

    ctx = f" ({context})" if context else ""
    allow_rids = [
        "com.android.permissioncontroller:id/permission_allow_all_button",
        "com.android.permissioncontroller:id/permission_allow_button",
        "com.android.permissioncontroller:id/permission_allow_foreground_only_button",
        "com.android.permissioncontroller:id/permission_allow_one_time_button",
        "com.android.permissioncontroller:id/permission_allow_always_button",
        "com.android.packageinstaller:id/permission_allow_button",
        "android:id/button1",
    ]
    for rid in allow_rids:
        btn = device.find_element_by_resource_id(rid)
        if btn:
            await device.send_log(
                f"ℹ️ Instagram media permission popup detected{ctx} — tapping Allow"
            )
            await device.tap(btn[0], btn[1], wait_after=900)
            await device.get_screen()
            return True

    allow_labels = [
        "Allow all",
        "ALLOW ALL",
        "Allow while using the app",
        "While using the app",
        "Allow access to all photos",
        "Allow access to photos and videos",
        "Allow",
        "ALLOW",
    ]
    for label in allow_labels:
        btn = (
            device.find_element_by_text(label, exact=True)
            or device.find_element_by_text(label)
            or device.find_element_by_content_description(label)
        )
        if btn:
            await device.send_log(
                f"ℹ️ Instagram media permission popup detected{ctx} — tapping '{label}'"
            )
            await device.tap(btn[0], btn[1], wait_after=900)
            await device.get_screen()
            return True

    return False


async def _handle_reel_draft_popup(device: "RemoteDevice") -> bool:
    await device.get_screen()
    if not (
        device.text_on_screen("Keep editing your draft")
        or device.text_on_screen("Start new video")
    ):
        return False

    start_new = device.find_element_by_text("Start new video")
    if start_new:
        await device.send_log("Reel draft prompt detected - starting a new video")
        await device.tap(start_new[0], start_new[1], wait_after=2500)
        return True

    await device.send_log("Reel draft prompt detected - tapping Start new video fallback", "WARN")
    await device.tap(540, 1831, wait_after=2500)
    return True


async def _try_add_image_audio_from_editor(device: "RemoteDevice", random_module) -> bool:
    """Attach a random audio track from the image-post editor when available."""
    await device.get_screen()
    audio_btn = (
        device.find_element_by_text("Audio", exact=True)
        or device.find_element_by_content_description("Audio")
        or device.find_element_by_text("Add audio")
        or device.find_element_by_content_description("Add audio")
        or device.find_element_by_resource_id("com.instagram.android:id/media_album_art_button")
        or device.find_element_by_resource_id("com.instagram.android:id/music_row_title")
    )
    if audio_btn:
        await device.tap(audio_btn[0], audio_btn[1], wait_after=1600)
    else:
        # XML-verified image editor audio button sits in the lower-left toolbar.
        await device.tap(
            124 + random_module.randint(-8, 8),
            2130 + random_module.randint(-12, 12),
            wait_after=1600,
        )

    await _handle_instagram_media_permission_popup(device, "audio picker")

    scroll_times = random_module.randint(0, 4)
    for _ in range(scroll_times):
        await device.swipe(
            random_module.randint(500, 580),
            random_module.randint(1700, 1900),
            random_module.randint(500, 580),
            random_module.randint(850, 1150),
            random_module.randint(220, 420),
        )
        await device.wait(random_module.randint(350, 700))

    await device.get_screen()
    candidates = []
    for rid in [
        "com.instagram.android:id/audio_track_title",
        "com.instagram.android:id/track_container",
        "com.instagram.android:id/artist_name_container",
        "com.instagram.android:id/music_row_title",
    ]:
        try:
            candidates.extend(device.find_all_elements_by_resource_id(rid))
        except Exception:
            pass
    candidates = [
        (x, y)
        for x, y in candidates
        if 250 <= y <= 2050 and 40 <= x <= 1040
    ]

    if candidates:
        track_x, track_y = random_module.choice(candidates)
        await device.tap(track_x, track_y, wait_after=1800)
    else:
        await device.tap(
            random_module.randint(360, 720),
            random_module.randint(920, 1700),
            wait_after=1800,
        )

    # The audio picker can keep Android's UIAutomator from reaching an idle
    # state while a preview track is playing. Use the stable bottom-right
    # select arrow first, then tap top-right Done/Next without requiring XML.
    await device.tap(993, 2226, wait_after=1800)
    await device.tap(985, 201, wait_after=1200)
    return True


async def get_reddit_title_for_account_subreddit(
    account_id: str, subreddit: str, user_id: str = None
) -> str:
    """
    Fetch a caption/title for a specific subreddit assigned to an account.

    Data source: account_subreddits.caption joined to subreddits.name.
    Falls back to empty string if not found.
    """
    if not get_supabase():
        return ""
    if not account_id or not subreddit:
        return ""

    target = (subreddit or "").strip().lower()
    if target.startswith("r/"):
        target = target[2:].strip()
    if not target:
        return ""

    try:
        # SECURITY: Verify account belongs to the authenticated user (defense-in-depth).
        acct_q = (
            get_supabase()
            .from_("instagram_accounts")
            .select("id, username")
            .eq("id", account_id)
        )
        if user_id:
            acct_q = acct_q.eq("user_id", user_id)

        acct_res = acct_q.single().execute()
        if not acct_res.data:
            return ""

        rows_res = (
            get_supabase()
            .from_("account_subreddits")
            .select("caption, subreddits(name)")
            .eq("account_id", account_id)
            .execute()
        )

        rows = rows_res.data or []
        for row in rows:
            sub = (row.get("subreddits") or {}).get("name") or ""
            sub_norm = sub.strip().lower()
            if sub_norm.startswith("r/"):
                sub_norm = sub_norm[2:].strip()

            if sub_norm == target:
                caption = (row.get("caption") or "").strip()
                if caption:
                    return caption

        return ""
    except Exception as e:
        print(f"[RedditTitle] Error fetching subreddit caption: {e}")
        return ""


app = FastAPI(
    title="ShadowPhone Module Server",
    description="Server-side automation module execution",
    version="1.0.0",
)

# Add rate limiter state
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS for Electron app
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Electron app can call from any origin
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==================== MODELS ====================


class ModuleRequest(BaseModel):
    moduleId: str
    deviceId: str
    profileId: Optional[str] = None
    config: Optional[Dict[str, Any]] = {}
    # Usage tracking fields
    userId: Optional[str] = None
    email: Optional[str] = None
    clientVersion: Optional[str] = None


class ActionItem(BaseModel):
    type: str
    x: Optional[int] = None
    y: Optional[int] = None
    x1: Optional[int] = None
    y1: Optional[int] = None
    x2: Optional[int] = None
    y2: Optional[int] = None
    duration: Optional[int] = None
    delay: Optional[int] = None
    text: Optional[str] = None
    keycode: Optional[int] = None
    package: Optional[str] = None
    command: Optional[str] = None
    ms: Optional[int] = None
    percent: Optional[int] = None
    message: Optional[str] = None
    success: Optional[bool] = None
    data: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


class ModuleResponse(BaseModel):
    actions: List[Dict[str, Any]]
    metadata: Dict[str, Any]


class WorkflowRequest(BaseModel):
    workflowId: str
    deviceId: str
    profiles: List[str]
    config: Optional[Dict[str, Any]] = {}


# ==================== AUTH ====================
# All secrets MUST come from environment variables - no hardcoded defaults

API_SECRET = os.getenv("SHADOWPHONE_API_SECRET")
CLERK_JWKS_URL = os.getenv(
    "CLERK_JWKS_URL"
)  # e.g., https://<your-clerk-domain>/.well-known/jwks.json

# Validate required secrets on startup
if not API_SECRET:
    print(
        "[Server] CRITICAL: SHADOWPHONE_API_SECRET not set - API will reject all requests!"
    )
if not CLERK_JWKS_URL:
    print(
        "[Server] WARNING: CLERK_JWKS_URL not set - JWT verification disabled, using unverified userId"
    )

# Cache for JWKS keys
_jwks_cache = None
_jwks_cache_time = 0
JWKS_CACHE_DURATION = 3600  # 1 hour


def get_clerk_jwks():
    """Fetch and cache Clerk's JWKS (JSON Web Key Set)."""
    global _jwks_cache, _jwks_cache_time
    import time

    now = time.time()
    if _jwks_cache and (now - _jwks_cache_time) < JWKS_CACHE_DURATION:
        return _jwks_cache

    if not CLERK_JWKS_URL:
        return None

    try:
        import urllib.request

        with urllib.request.urlopen(CLERK_JWKS_URL, timeout=5) as response:
            _jwks_cache = json.loads(response.read().decode())
            _jwks_cache_time = now
            return _jwks_cache
    except Exception as e:
        print(f"[Auth] Failed to fetch JWKS: {e}")
        return _jwks_cache  # Return stale cache on error


def verify_clerk_jwt(token: str) -> dict:
    """Verify a Clerk JWT and return the claims (including userId)."""
    try:
        import jwt
        from jwt import PyJWKClient

        if not CLERK_JWKS_URL:
            raise HTTPException(status_code=500, detail="CLERK_JWKS_URL not configured")

        # Use PyJWT's JWK client for automatic key selection
        jwks_client = PyJWKClient(CLERK_JWKS_URL)
        signing_key = jwks_client.get_signing_key_from_jwt(token)

        # Decode and verify the token
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            options={"verify_aud": False},  # Clerk doesn't always set audience
        )

        return claims
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError as e:
        raise HTTPException(status_code=401, detail=f"Invalid token: {str(e)}")
    except Exception as e:
        print(f"[Auth] JWT verification error: {e}")
        raise HTTPException(status_code=401, detail="Token verification failed")


def verify_auth(
    authorization: str = Header(None),
    x_clerk_token: str = Header(None, alias="X-Clerk-Token"),
):
    """
    Production auth - Clerk JWT is the ONLY auth method.
    No hardcoded secrets - users must be logged in via Clerk.

    Priority:
    1. Clerk JWT (X-Clerk-Token header) - Validates user identity via Clerk JWKS
    2. Module JWT (Authorization: ModuleJWT xxx) - For desktop app sessions

    Returns: clerk_user_id (str) or raises HTTPException
    """
    clerk_user_id = None

    # Priority 1: Try Clerk JWT (preferred - validated against Clerk's JWKS)
    if x_clerk_token:
        try:
            claims = verify_clerk_jwt(x_clerk_token)
            clerk_user_id = claims.get("sub")  # Clerk stores userId in 'sub' claim
            print(f"[Auth] ✅ Verified Clerk user: {clerk_user_id}")
            return clerk_user_id
        except HTTPException:
            raise  # Re-raise auth errors
        except Exception as e:
            print(f"[Auth] Clerk token validation failed: {e}")
            # Fall through to Module JWT check

    # Priority 2: Try Module JWT (for desktop app sessions)
    if authorization and authorization.startswith("ModuleJWT "):
        token = authorization.replace("ModuleJWT ", "")
        result = verify_module_jwt(token)
        if result.get("valid"):
            print(f"[Auth] ✅ Verified Module JWT user: {result.get('user_id')}")
            return result.get("user_id")
        else:
            print(f"[Auth] Module JWT invalid: {result.get('error')}")

    # No valid auth found - user must log in
    raise HTTPException(
        status_code=401, detail="Authentication required. Please log in to use modules."
    )


# ==================== MODULE IMPLEMENTATIONS ====================
# Each module returns a list of ADB action dicts


def build_tap(x: int, y: int, delay: int = 0) -> dict:
    return {"type": "tap", "x": x, "y": y, "delay": delay}


def build_swipe(
    x1: int, y1: int, x2: int, y2: int, duration: int = 300, delay: int = 0
) -> dict:
    return {
        "type": "swipe",
        "x1": x1,
        "y1": y1,
        "x2": x2,
        "y2": y2,
        "duration": duration,
        "delay": delay,
    }


def build_input(text: str, delay: int = 0) -> dict:
    return {"type": "input", "text": text, "delay": delay}


def build_keyevent(keycode: int, delay: int = 0) -> dict:
    return {"type": "keyevent", "keycode": keycode, "delay": delay}


def build_launch(package: str, delay: int = 2000) -> dict:
    return {"type": "launch", "package": package, "delay": delay}


def build_shell(command: str, delay: int = 0) -> dict:
    return {"type": "shell", "command": command, "delay": delay}


def build_wait(ms: int) -> dict:
    return {"type": "wait", "ms": ms}


def build_progress(percent: int, message: str) -> dict:
    return {"type": "progress", "percent": percent, "message": message}


def build_complete(success: bool, data: dict = None, error: str = None) -> dict:
    return {"type": "complete", "success": success, "data": data, "error": error}


# Screen coordinates (1080x2400 default resolution)
# UPDATED: Aligned with verified Dec 2024 XML dump coordinates and ig_selectors.py
# These are FALLBACK coordinates - modules should prefer resource IDs via WebSocket adapter
SCREEN = {
    "center_x": 540,
    "center_y": 1200,
    # Bottom nav (New Layout - Dec 2024)
    "home_icon": (108, 2274),  # feed_tab
    "reels_icon": (324, 2274),  # clips_tab
    "messages_icon": (540, 2274),  # direct_tab
    "search_icon": (756, 2274),  # search_tab
    "profile_icon": (972, 2274),  # profile_tab (tab_avatar)
    # Create button (top-left in new layout)
    "create_button": (63, 201),  # creation_tab / action_bar_buttons_container_left
    # Feed engagement (ADB-VERIFIED Feb 2026 — Y is scroll-dependent!)
    "feed_like_button": (63, 456),  # row_feed_button_like X=63 STABLE
    "feed_comment_button": (226, 456),  # row_feed_button_comment X VARIES on ads
    "feed_share_button": (517, 456),  # row_feed_button_share X VARIES on ads
    "feed_save_button": (1017, 456),  # row_feed_button_save X=1017 STABLE
    "feed_double_tap": (540, 1415),  # Center of media area (ADB: [0,756][1080,2074])
    # Reels engagement (VERIFIED: ig_selectors.py Coords class)
    "reels_like_button": (1001, 1121),  # like_button (Coords.REELS_LIKE)
    "reels_comment_button": (1001, 1299),  # comment_button (Coords.REELS_COMMENT)
    "reels_share_button": (1001, 1655),  # direct_share_button (Coords.REELS_SHARE)
    "reels_save_button": (1001, 1833),  # save_button (Coords.REELS_SAVE)
    "reels_more_button": (1001, 2011),  # clips_ufi_more_button (Coords.REELS_MORE)
    # Post flow
    "next_button_top": (1000, 201),  # next_button_textview (media->edit)
    "next_button_bottom": (961, 2280),  # next_button_textview (edit->share)
    "caption_input": (540, 1053),  # caption_input_text_view
    "share_button": (540, 2279),  # share_footer_button
    # Legacy aliases (ADB-VERIFIED Feb 2026 — Y approximate)
    "like_button": (63, 456),
    "comment_button": (226, 456),
    "share_button_legacy": (517, 456),
    "follow_button": (950, 400),
    "post_button": (980, 100),
    "back_button": (100, 100),
    "accept_button": (540, 1600),
}

# Resource IDs for common Instagram elements (used by WebSocket modules)
IG_RESOURCE_IDS = {
    # ═══════════════════════════════════════════════════════════════
    # ALL IDs below are VERIFIED from old appium/modules/ig_selectors.py
    # and old appium XML dumps (Dec 2024). DO NOT invent new IDs.
    # ═══════════════════════════════════════════════════════════════
    # Navigation (VERIFIED: ig_selectors.py lines 25-38)
    "home_tab": "com.instagram.android:id/feed_tab",
    "reels_tab": "com.instagram.android:id/clips_tab",
    "search_tab": "com.instagram.android:id/search_tab",
    "messages_tab": "com.instagram.android:id/direct_tab",
    "profile_tab": "com.instagram.android:id/profile_tab",
    "feed_like_button": "com.instagram.android:id/row_feed_button_like",
    "feed_comment_button": "com.instagram.android:id/row_feed_button_comment",
    "feed_share_button": "com.instagram.android:id/row_feed_button_share",
    "feed_save_button": "com.instagram.android:id/row_feed_button_save",
    "feed_button_group": "com.instagram.android:id/row_feed_view_group_buttons",
    "tab_bar": "com.instagram.android:id/tab_bar",
    "tab_icon": "com.instagram.android:id/tab_icon",
    "tab_avatar": "com.instagram.android:id/tab_avatar",
    "creation_tab": "com.instagram.android:id/creation_tab",
    "action_bar_left": "com.instagram.android:id/action_bar_buttons_container_left",
    # Feed engagement (VERIFIED: ig_selectors.py lines 199-203)
    "feed_like": "com.instagram.android:id/row_feed_button_like",
    "feed_comment": "com.instagram.android:id/row_feed_button_comment",
    "feed_share": "com.instagram.android:id/row_feed_button_share",
    "feed_save": "com.instagram.android:id/row_feed_button_save",
    "feed_button_group": "com.instagram.android:id/row_feed_view_group_buttons",
    "feed_post_menu": "com.instagram.android:id/media_option_button",
    "feed_profile_name": "com.instagram.android:id/row_feed_photo_profile_name",
    # Reels engagement (VERIFIED: ig_selectors.py lines 160-173)
    "reels_like": "com.instagram.android:id/like_button",
    "reels_comment": "com.instagram.android:id/comment_button",
    "reels_share": "com.instagram.android:id/direct_share_button",
    "reels_save": "com.instagram.android:id/save_button",
    "reels_more": "com.instagram.android:id/clips_ufi_more_button_component",
    "reels_author_username": "com.instagram.android:id/clips_author_username",
    "reels_like_button": "com.instagram.android:id/like_button",
    "reels_comment_button": "com.instagram.android:id/comment_button",
    "reels_share_button": "com.instagram.android:id/direct_share_button",
    "reels_save_button": "com.instagram.android:id/save_button",
    "reels_more_button": "com.instagram.android:id/clips_ufi_more_button_component",
    "story_reply_bar": "com.instagram.android:id/reel_viewer_reply_bar",
    "story_message_composer": "com.instagram.android:id/message_composer_container",
    "story_view_root": "com.instagram.android:id/reel_viewer_root",
    "reels_inline_follow": "com.instagram.android:id/inline_follow_button",
    "reels_root_layout": "com.instagram.android:id/root_clips_layout",
    # Comment sheet (VERIFIED: ig_selectors.py lines 236-252)
    "comment_input": "com.instagram.android:id/layout_comment_thread_edittext",
    "comment_post_btn": "com.instagram.android:id/layout_comment_thread_post_button_icon",
    "comment_composer_parent": "com.instagram.android:id/comment_composer_parent_updated",
    "bottom_sheet_container": "com.instagram.android:id/bottom_sheet_container",
    # Create/Post flow (VERIFIED: ig_selectors.py lines 471-511)
    "post_tab": "com.instagram.android:id/cam_dest_feed",
    "story_tab": "com.instagram.android:id/cam_dest_story",
    "reel_tab": "com.instagram.android:id/cam_dest_clips",
    "live_tab": "com.instagram.android:id/cam_dest_live",
    "cancel_button": "com.instagram.android:id/action_bar_cancel",
    "next_button": "com.instagram.android:id/next_button_textview",
    "caption_input": "com.instagram.android:id/caption_input_text_view",
    "share_footer": "com.instagram.android:id/share_footer_button",
    "gallery_thumbnail": "com.instagram.android:id/gallery_grid_item_thumbnail",
    "gallery_preview_btn": "com.instagram.android:id/gallery_preview_button",
    "gallery_folder_menu": "com.instagram.android:id/gallery_folder_menu_tv",
    "crop_image_view": "com.instagram.android:id/crop_image_view",
    "new_post_title": "com.instagram.android:id/new_post_title",
    # Profile (VERIFIED: ig_selectors.py lines 388-454)
    "profile_follow_btn": "com.instagram.android:id/profile_header_follow_button",
    "profile_message_btn": "com.instagram.android:id/profile_header_message_button",
    "edit_profile_btn": "com.instagram.android:id/row_profile_header_edit_profile_button",
    "profile_username_container": "com.instagram.android:id/action_bar_username_container",
    "profile_username": "com.instagram.android:id/action_bar_title",
    "profile_chevron": "com.instagram.android:id/action_bar_title_chevron",
    "profile_image": "com.instagram.android:id/row_profile_header_imageview",
    "row_user_follow_btn": "com.instagram.android:id/row_user_access_follow_button",
    # Edit Profile (VERIFIED: APPIUM_DISCOVERY_EDIT_PROFILE.md)
    "edit_full_name": "com.instagram.android:id/full_name",
    "edit_username": "com.instagram.android:id/username",
    "edit_bio": "com.instagram.android:id/bio",
    "prism_input": "com.instagram.android:id/prism_form_field_container",
    "action_bar_save": "com.instagram.android:id/action_bar_button_action",
    "action_bar_back": "com.instagram.android:id/action_bar_button_back",
    "confirm_dialog_btn": "com.instagram.android:id/igds_alert_dialog_primary_button",
    # Search (VERIFIED: ig_selectors.py lines 349-384)
    "search_input": "com.instagram.android:id/action_bar_search_edit_text",
    "search_user_username": "com.instagram.android:id/row_search_user_username",
    "search_user_fullname": "com.instagram.android:id/row_search_user_fullname",
    "search_user_follow_btn": "com.instagram.android:id/row_search_user_follow_button",
    "search_back_btn": "com.instagram.android:id/action_bar_button_back",
    # Story tray (VERIFIED: ig_selectors.py lines 264-276)
    "story_tray": "com.instagram.android:id/reels_tray_container",
    "story_avatar_container": "com.instagram.android:id/avatar_container",
    "story_add_badge": "com.instagram.android:id/reel_empty_badge",
    # Story viewing (VERIFIED: ig_selectors.py lines 282-321)
    "story_viewer_root": "com.instagram.android:id/reel_viewer_root",
    "story_like_btn": "com.instagram.android:id/toolbar_like_button",
    "story_like_container": "com.instagram.android:id/toolbar_like_container",
    "story_reshare_btn": "com.instagram.android:id/toolbar_reshare_button",
    "story_progress_bar": "com.instagram.android:id/reel_viewer_progress_bar",
    "story_viewer_title": "com.instagram.android:id/reel_viewer_title",
    "story_composer_text": "com.instagram.android:id/composer_text",
    # Popup / Dialog dismissal (VERIFIED: ig_selectors.py lines 586-601)
    "popup_primary_btn": "com.instagram.android:id/igds_headline_primary_action_button",
    "popup_secondary_btn": "com.instagram.android:id/igds_headline_secondary_action_button",
    "alert_primary_btn": "com.instagram.android:id/igds_alert_dialog_primary_button",
    "alert_secondary_btn": "com.instagram.android:id/igds_alert_dialog_secondary_button",
    "modal_container": "com.instagram.android:id/modal_container",
    "overlay_container": "com.instagram.android:id/overlay_layout_container",
}

import random


def random_delay(min_ms: int, max_ms: int) -> int:
    return random.randint(min_ms, max_ms)


def auto_detect_device() -> str:
    """
    Auto-detect the first connected ADB device.
    Returns device ID or None if no devices connected.
    """
    try:
        result = subprocess.run(
            ["adb", "devices"], capture_output=True, text=True, timeout=5
        )
        if result.stdout:
            lines = result.stdout.strip().split("\n")
            for line in lines[1:]:  # Skip "List of devices attached"
                if "\t" in line and "device" in line:
                    device_id = line.split("\t")[0].strip()
                    if device_id:
                        return device_id
    except Exception as e:
        print(f"⚠️ Device auto-detection failed: {e}")
    return None


def get_device_id(config: dict) -> str:
    """
    Get device ID from config or auto-detect.
    Priority: config > auto-detect > hardcoded fallback
    """
    device_id = config.get("device_id")
    if device_id:
        return device_id

    detected = auto_detect_device()
    if detected:
        return detected

    # Fallback to common device ID
    return "1A121FDF60082H"


# ==================== MODULE: ENGAGEMENT ====================


def execute_engagement(config: dict) -> List[dict]:
    """
    Scroll through feed/reels, like posts - actually calls InstagramEngager.
    """
    from modules.engagement_module import InstagramEngager

    device_id = get_device_id(config)
    count = config.get("count", 15)
    like_chance = config.get("like_chance", 80)
    comment_chance = config.get("comment_chance", 15)
    user_id = config.get("user_id")  # For configurable settings

    actions = [
        build_progress(0, "Starting engagement module..."),
    ]

    try:
        engager = InstagramEngager(device_id=device_id, user_id=user_id)

        actions.append(build_progress(10, "Connecting to device..."))
        engager.connect()

        actions.append(build_progress(20, f"Engaging {count} posts..."))

        # Run engagement
        result = engager.engage_posts(
            count=count, like_chance=like_chance, comment_chance=comment_chance
        )

        engager.disconnect()

        if result:
            actions.append(build_progress(100, f"Engaged with {count} posts"))
            actions.append(
                build_complete(
                    True,
                    {
                        "postsEngaged": count,
                        "like_chance": like_chance,
                        "comment_chance": comment_chance,
                    },
                )
            )
        else:
            actions.append(build_complete(False, {"error": "Engagement failed"}))

    except Exception as e:
        actions.append(build_progress(100, f"Engagement failed: {str(e)[:100]}"))
        actions.append(build_complete(False, {"error": str(e)}))

    return actions


# ==================== MODULE: FOLLOW ====================


def execute_follow(config: dict) -> List[dict]:
    """
    Follow users - actually calls InstagramFollower.
    """
    from modules.follow_module import InstagramFollower

    device_id = config.get("device_id", "1A121FDF60082H")
    count = config.get("count", 5)
    profile_id = config.get("profile_id")

    actions = [
        build_progress(0, "Starting follow module..."),
    ]

    try:
        follower = InstagramFollower(device_id=device_id, profile_id=profile_id)

        actions.append(build_progress(10, "Connecting to device..."))
        follower.connect()

        actions.append(build_progress(20, f"Following {count} users..."))

        # Run follow
        result = follower.follow_users(count=count, profile_id=profile_id)

        follower.disconnect()

        if result:
            actions.append(build_progress(100, f"Followed {count} users"))
            actions.append(
                build_complete(True, {"usersFollowed": count, "result": result})
            )
        else:
            actions.append(build_complete(False, {"error": "Follow failed"}))

    except Exception as e:
        actions.append(build_progress(100, f"Follow failed: {str(e)[:100]}"))
        actions.append(build_complete(False, {"error": str(e)}))

    return actions


# ==================== MODULE: POST FEED ====================


def execute_post_feed(config: dict) -> List[dict]:
    """
    Post content to feed - actually calls InstagramPoster.
    """
    from modules.post_module import InstagramPoster

    device_id = config.get("device_id", "1A121FDF60082H")
    caption = config.get("caption", "")
    account_number = config.get("account_number", 1)
    profile_id = config.get("profile_id")

    actions = [
        build_progress(0, "Starting post to feed..."),
    ]

    try:
        poster = InstagramPoster(
            device_id=device_id, account_number=account_number, profile_id=profile_id
        )

        actions.append(build_progress(10, "Connecting to device..."))
        poster.connect()

        actions.append(build_progress(30, "Posting to feed..."))

        # The poster module handles selecting from gallery and posting
        result = poster.post_to_feed(caption=caption)

        poster.disconnect()

        if result:
            actions.append(build_progress(100, "Post published!"))
            actions.append(
                build_complete(True, {"action": "post_feed", "caption": caption[:50]})
            )
        else:
            actions.append(build_complete(False, {"error": "Post failed"}))

    except Exception as e:
        actions.append(build_progress(100, f"Post failed: {str(e)[:100]}"))
        actions.append(build_complete(False, {"error": str(e)}))

    return actions


# ==================== MODULE: POST STORY ====================


def execute_post_story(config: dict) -> List[dict]:
    """
    Post content to story - actually calls InstagramStoryPoster.
    """
    from modules.post_story_module import InstagramStoryPoster

    device_id = config.get("device_id", "1A121FDF60082H")
    link_url = config.get("link_url", "")
    account_number = config.get("account_number", 1)
    profile_id = config.get("profile_id")

    actions = [
        build_progress(0, "Starting story post..."),
    ]

    try:
        poster = InstagramStoryPoster(
            device_id=device_id, account_number=account_number
        )

        actions.append(build_progress(10, "Connecting to device..."))
        poster.connect()

        actions.append(build_progress(30, "Posting story..."))

        # Post story with optional link
        result = poster.post_story(link_url=link_url if link_url else None)

        poster.disconnect()

        if result:
            actions.append(build_progress(100, "Story posted!"))
            actions.append(
                build_complete(True, {"action": "post_story", "link_url": link_url})
            )
        else:
            actions.append(build_complete(False, {"error": "Story post failed"}))

    except Exception as e:
        actions.append(build_progress(100, f"Story post failed: {str(e)[:100]}"))
        actions.append(build_complete(False, {"error": str(e)}))

    return actions


# ==================== MODULE: AIRPLANE TOGGLE ====================


def execute_airplane_toggle(config: dict) -> List[dict]:
    """Toggle airplane mode to reset IP."""
    wait_seconds = config.get("wait_seconds", 5)

    return [
        build_progress(0, "Enabling airplane mode..."),
        build_shell("settings put global airplane_mode_on 1"),
        build_shell(
            "am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true"
        ),
        build_wait(wait_seconds * 1000),
        build_progress(50, "Disabling airplane mode..."),
        build_shell("settings put global airplane_mode_on 0"),
        build_shell(
            "am broadcast -a android.intent.action.AIRPLANE_MODE --ez state false"
        ),
        build_wait(3000),
        build_progress(100, "IP reset complete!"),
        build_complete(True, {"action": "airplane_toggle"}),
    ]


# ==================== MODULE: GALLERY CLEAN ====================


def execute_gallery_clean(config: dict) -> List[dict]:
    """Clean gallery/downloads."""
    return [
        build_progress(0, "Cleaning gallery..."),
        build_shell("rm -rf /sdcard/Download/ShadowPhone/*"),
        build_wait(500),
        build_shell("rm -rf /sdcard/DCIM/Camera/*"),
        build_wait(500),
        build_shell("rm -rf /sdcard/Pictures/Instagram/*"),
        build_wait(500),
        build_progress(100, "Gallery cleaned!"),
        build_complete(True, {"action": "gallery_clean"}),
    ]


# ==================== MODULE: IG LAUNCHER ====================


def execute_ig_launcher(config: dict) -> List[dict]:
    """Legacy REST fallback. Desktop execution uses the local Electron handler."""
    return [
        build_progress(0, "Launching Instagram..."),
        build_launch("com.instagram.android"),
        build_wait(3000),
        build_progress(50, "Handling popups..."),
        # Tap common popup dismiss locations
        build_tap(540, 1600, delay=500),  # "Not Now" / "Got it" button area
        build_wait(500),
        build_tap(540, 1200, delay=500),  # Secondary popup area
        build_wait(500),
        build_progress(75, "Navigating to home..."),
        # Tap home tab (resource-ID-backed coordinate from ig_selectors)
        build_tap(*SCREEN["home_icon"], delay=500),
        build_wait(1000),
        build_progress(100, "Instagram ready!"),
        build_complete(
            True, {"action": "ig_launcher", "resource_ids": IG_RESOURCE_IDS}
        ),
    ]


# ==================== MODULE: PROFILE SWITCH ====================


def execute_profile_switch(config: dict) -> List[dict]:
    """Switch GrapheneOS profile."""
    target = config.get("target_profile", 0)

    return [
        build_progress(0, f"Switching to profile {target}..."),
        # Open quick settings
        build_shell("input swipe 540 0 540 1000 200"),
        build_wait(500),
        build_shell("input swipe 540 0 540 500 200"),
        build_wait(1000),
        build_progress(30, "Opening user menu..."),
        # Tap user icon (varies by device)
        build_tap(920, 200, delay=500),
        build_wait(1500),
        build_progress(60, f"Selecting profile {target}..."),
        # Tap profile in list
        build_tap(540, 400 + (target * 150), delay=1000),
        build_wait(5000),  # Wait for profile switch
        build_progress(100, f"Switched to profile {target}!"),
        build_complete(True, {"action": "profile_switch", "target": target}),
    ]


# ==================== MODULE: VPN CONNECT ====================


def execute_vpn_connect(config: dict) -> List[dict]:
    """Connect to VPN."""
    return [
        build_progress(0, "Launching VPN..."),
        build_launch("ch.protonvpn.android"),
        build_wait(3000),
        build_progress(30, "Connecting to US Streaming..."),
        # Navigate to US Streaming
        build_tap(540, 400, delay=1000),  # Countries
        build_wait(1000),
        build_input("United States", delay=500),
        build_tap(540, 350, delay=1000),  # First result
        build_wait(1500),
        build_progress(60, "Selecting streaming server..."),
        build_tap(540, 600, delay=500),  # Streaming option
        build_wait(500),
        build_tap(800, 600, delay=1000),  # Connect button
        build_wait(5000),
        build_progress(100, "VPN connected!"),
        build_complete(True, {"action": "vpn_connect"}),
    ]


# ==================== MODULE: DELAY ====================


def execute_delay(config: dict) -> List[dict]:
    """Simple delay."""
    seconds = config.get("seconds", 5)

    return [
        build_progress(0, f"Waiting {seconds} seconds..."),
        build_wait(seconds * 1000),
        build_progress(100, "Delay complete"),
        build_complete(True),
    ]


# ==================== MODULE: DETECT ACCOUNTS ====================


def execute_detect_accounts(config: dict) -> List[dict]:
    """Detect Instagram accounts on device.
    Uses profile_tab and action_bar_username_container resource IDs via WS adapter."""
    return [
        build_progress(0, "Detecting Instagram accounts..."),
        build_launch("com.instagram.android"),
        build_wait(4000),
        build_progress(30, "Opening profile..."),
        build_tap(*SCREEN["profile_icon"]),  # profile_tab fallback coord
        build_wait(2000),
        build_progress(60, "Checking account menu..."),
        build_tap(540, 200, delay=500),  # action_bar_username_container area
        build_wait(2000),
        build_progress(100, "Scan complete"),
        build_complete(True, {"action": "detect_accounts"}),
    ]


# ==================== MODULE: REPOST ====================


def execute_repost(config: dict) -> List[dict]:
    """Repost content from another user."""
    source_user = config.get("source_username", "")

    actions = [
        build_progress(0, f"Starting repost from @{source_user}..."),
        build_launch("com.instagram.android"),
        build_wait(3000),
        build_progress(10, "Searching for user..."),
        build_tap(*SCREEN["search_icon"]),  # search_tab
        build_wait(1000),
        build_tap(540, 200),  # search_edit_text area
        build_wait(500),
        build_input(source_user, delay=1000),
        build_tap(540, 350, delay=1500),  # First result (row_search_user_username)
        build_wait(2000),
        build_progress(30, "Finding latest post..."),
        build_tap(200, 600, delay=1000),  # First post in grid
        build_wait(2000),
        build_progress(50, "Downloading content..."),
        build_tap(980, 100, delay=500),  # media_option_button (three dots)
        build_wait(1000),
        build_tap(540, 800, delay=500),  # Copy link option
        build_wait(1000),
        build_progress(70, "Preparing repost..."),
        build_keyevent(4),  # Back
        build_wait(500),
        build_keyevent(4),  # Back
        build_wait(500),
        build_tap(*SCREEN["profile_icon"]),  # profile_tab
        build_wait(2000),
        build_progress(90, "Posting..."),
        build_tap(*SCREEN["create_button"]),  # creation_tab (top-left)
        build_wait(1500),
        build_progress(100, "Repost initiated"),
        build_complete(True, {"action": "repost", "source": source_user}),
    ]
    return actions


# ==================== MODULE: EDIT PROFILE ====================


def execute_edit_profile(config: dict) -> List[dict]:
    """Edit Instagram profile.
    Note: For WebSocket execution, use run_edit_profile in ws_module_adapter
    which uses resource IDs (full_name, bio, action_bar_button_action).
    This static version uses coordinates as fallback."""
    bio = config.get("bio", "")
    name = config.get("name", "")
    website = config.get("website", "")

    actions = [
        build_progress(0, "Opening profile editor..."),
        build_launch("com.instagram.android"),
        build_wait(3000),
        build_tap(*SCREEN["profile_icon"]),  # profile_tab
        build_wait(2000),
        build_progress(20, "Entering edit mode..."),
        # edit_profile_btn: row_profile_header_edit_profile_button
        build_tap(540, 450, delay=1000),
        build_wait(2000),
    ]

    if name:
        actions.extend(
            [
                build_progress(40, "Updating name..."),
                # full_name resource ID field
                build_tap(540, 350, delay=500),
                build_shell("input keyevent --longpress 67"),
                build_input(name, delay=500),
                build_keyevent(4),
            ]
        )

    if bio:
        actions.extend(
            [
                build_progress(60, "Updating bio..."),
                # bio resource ID field
                build_tap(540, 550, delay=500),
                build_shell("input keyevent --longpress 67"),
                build_input(bio, delay=500),
                build_keyevent(4),
            ]
        )

    if website:
        actions.extend(
            [
                build_progress(80, "Updating website..."),
                build_tap(540, 750, delay=500),
                build_wait(1000),
                build_tap(540, 400, delay=500),
                build_input(website, delay=500),
                # action_bar_button_action (save/done checkmark)
                build_tap(980, 100, delay=500),
            ]
        )

    actions.extend(
        [
            build_progress(100, "Saving profile..."),
            # action_bar_button_action (save/done)
            build_tap(980, 100, delay=1000),
            build_wait(2000),
            build_complete(True, {"action": "edit_profile"}),
        ]
    )
    return actions


# ==================== MODULE: IG ACCOUNT SWITCH ====================


def execute_ig_account_switch(config: dict) -> List[dict]:
    """Switch Instagram accounts.
    Uses profile_tab, action_bar_username_container resource IDs via WS adapter."""
    target_index = config.get("target_index", 0)

    return [
        build_progress(0, "Opening account menu..."),
        build_launch("com.instagram.android"),
        build_wait(3000),
        build_tap(*SCREEN["profile_icon"]),  # profile_tab
        build_wait(2000),
        build_progress(30, "Opening account switcher..."),
        # action_bar_username_container or action_bar_title area
        build_tap(540, 200, delay=500),
        build_wait(1500),
        build_progress(60, f"Selecting account {target_index}..."),
        build_tap(540, 350 + (target_index * 100), delay=1000),
        build_wait(3000),
        build_progress(100, "Account switched!"),
        build_complete(True, {"action": "ig_account_switch", "target": target_index}),
    ]


# ==================== MODULE: STATS SCRAPER ====================


def execute_stats_scraper(config: dict) -> List[dict]:
    """
    Scrape account statistics - actually calls StatsScraper.
    """
    from modules.stats_scraper import StatsScraper

    device_id = config.get("device_id", "1A121FDF60082H")
    account_number = config.get("account_number", 0)
    target_username = config.get("target_username")  # Optional external profile

    actions = [
        build_progress(0, "Starting stats scraper..."),
    ]

    try:
        scraper = StatsScraper(device_id=device_id, account_number=account_number)

        if target_username:
            actions.append(
                build_progress(20, f"Scraping external profile: {target_username}")
            )
            stats = scraper.scrape_external_profile(target_username)
        else:
            actions.append(build_progress(20, "Scraping current profile stats..."))
            stats = scraper.scrape_current_profile()

        if stats:
            actions.append(
                build_progress(80, f"Got stats: {stats.get('followers', 0)} followers")
            )
            actions.append(build_progress(100, "Stats collected"))
            actions.append(
                build_complete(
                    True,
                    {
                        "action": "stats_scraper",
                        "stats": stats,
                        "posts": stats.get("posts", 0),
                        "followers": stats.get("followers", 0),
                        "following": stats.get("following", 0),
                    },
                )
            )
        else:
            actions.append(build_progress(100, "Could not read stats"))
            actions.append(build_complete(False, {"error": "Failed to scrape stats"}))

    except Exception as e:
        actions.append(build_progress(100, f"Stats scraper failed: {str(e)[:100]}"))
        actions.append(build_complete(False, {"error": str(e)}))

    return actions


# ==================== MODULE: THREADS POST ====================


def execute_threads_post(config: dict) -> List[dict]:
    """Post to Threads."""
    text = config.get("text", "")

    actions = [
        build_progress(0, "Launching Threads..."),
        build_launch("com.instagram.barcelona"),  # Threads package
        build_wait(3000),
        build_progress(20, "Creating post..."),
        build_tap(540, 2280, delay=500),  # New post button
        build_wait(1500),
    ]

    if text:
        actions.extend(
            [
                build_progress(50, "Adding text..."),
                build_tap(540, 400, delay=500),  # Text area
                build_input(text, delay=500),
            ]
        )

    actions.extend(
        [
            build_progress(80, "Publishing..."),
            build_tap(980, 100, delay=1000),  # Post button
            build_wait(3000),
            build_progress(100, "Posted to Threads!"),
            build_complete(True, {"action": "threads_post"}),
        ]
    )
    return actions


# ==================== MODULE: THREADS ENGAGE ====================


def execute_threads_engage(config: dict) -> List[dict]:
    """Engage on Threads."""
    count = config.get("count", 10)

    actions = [
        build_progress(0, "Launching Threads..."),
        build_launch("com.instagram.barcelona"),
        build_wait(3000),
    ]

    for i in range(count):
        percent = int(((i + 1) / count) * 100)
        delay = random_delay(2000, 5000)

        actions.extend(
            [
                build_progress(percent, f"Engaging post {i + 1}/{count}"),
                build_tap(100, 600, delay=300),  # Like button
                build_wait(500),
                build_swipe(540, 1600, 540, 400, duration=200),
                build_wait(delay),
            ]
        )

    actions.append(build_complete(True, {"action": "threads_engage", "count": count}))
    return actions


# ==================== MODULE: TIKTOK POST ====================


def execute_tiktok_post(config: dict) -> List[dict]:
    """Post to TikTok."""
    caption = config.get("caption", "")

    actions = [
        build_progress(0, "Launching TikTok..."),
        build_launch("com.zhiliaoapp.musically"),  # TikTok package
        build_wait(4000),
        build_progress(10, "Opening creator..."),
        build_tap(540, 2280, delay=500),  # Plus button (center)
        build_wait(2000),
        build_progress(30, "Selecting video..."),
        build_tap(100, 2100, delay=500),  # Upload
        build_wait(2000),
        build_tap(200, 400, delay=1000),  # First video
        build_wait(2000),
        build_progress(50, "Processing..."),
        build_tap(980, 2100, delay=500),  # Next
        build_wait(3000),
        build_tap(980, 2100, delay=500),  # Next again
        build_wait(2000),
    ]

    if caption:
        actions.extend(
            [
                build_progress(70, "Adding caption..."),
                build_tap(540, 300, delay=500),
                build_input(caption, delay=500),
            ]
        )

    actions.extend(
        [
            build_progress(90, "Posting..."),
            build_tap(540, 2100, delay=1000),  # Post button
            build_wait(5000),
            build_progress(100, "Posted to TikTok!"),
            build_complete(True, {"action": "tiktok_post"}),
        ]
    )
    return actions


# ==================== MODULE: TIKTOK ENGAGE ====================


def execute_tiktok_engage(config: dict) -> List[dict]:
    """Engage on TikTok."""
    count = config.get("count", 15)

    actions = [
        build_progress(0, "Launching TikTok..."),
        build_launch("com.zhiliaoapp.musically"),
        build_wait(4000),
    ]

    for i in range(count):
        percent = int(((i + 1) / count) * 100)
        delay = random_delay(3000, 8000)

        actions.extend(
            [
                build_progress(percent, f"Watching video {i + 1}/{count}"),
                build_wait(delay),  # Watch video
                build_tap(980, 1100, delay=200),  # Double-tap to like
                build_tap(980, 1100),
                build_wait(500),
                build_swipe(540, 1800, 540, 200, duration=150),  # Swipe up
                build_wait(500),
            ]
        )

    actions.append(build_complete(True, {"action": "tiktok_engage", "count": count}))
    return actions


# ==================== MODULE: TWITTER POST ====================


def execute_twitter_post(config: dict) -> List[dict]:
    """Post to Twitter/X."""
    text = config.get("text", "")

    actions = [
        build_progress(0, "Launching X..."),
        build_launch("com.twitter.android"),
        build_wait(3000),
        build_progress(20, "Creating post..."),
        build_tap(980, 2200, delay=500),  # Compose button
        build_wait(1500),
    ]

    if text:
        actions.extend(
            [
                build_progress(50, "Adding text..."),
                build_input(text, delay=500),
            ]
        )

    actions.extend(
        [
            build_progress(80, "Posting..."),
            build_tap(980, 100, delay=1000),  # Post button
            build_wait(3000),
            build_progress(100, "Posted to X!"),
            build_complete(True, {"action": "twitter_post"}),
        ]
    )
    return actions


# ==================== MODULE: TWITTER ENGAGE ====================


def execute_twitter_engage(config: dict) -> List[dict]:
    """Engage on Twitter/X."""
    count = config.get("count", 15)

    actions = [
        build_progress(0, "Launching X..."),
        build_launch("com.twitter.android"),
        build_wait(3000),
    ]

    for i in range(count):
        percent = int(((i + 1) / count) * 100)
        delay = random_delay(2000, 5000)

        actions.extend(
            [
                build_progress(percent, f"Engaging tweet {i + 1}/{count}"),
                build_tap(200, 800, delay=300),  # Like button
                build_wait(500),
                build_swipe(540, 1600, 540, 600, duration=200),
                build_wait(delay),
            ]
        )

    actions.append(build_complete(True, {"action": "twitter_engage", "count": count}))
    return actions


# ==================== MODULE: RANDOM DELAY ====================


def execute_random_delay(config: dict) -> List[dict]:
    """Random delay between min and max."""
    min_sec = config.get("min_seconds", 5)
    max_sec = config.get("max_seconds", 15)
    actual = random.randint(min_sec, max_sec)

    return [
        build_progress(0, f"Waiting {actual} seconds..."),
        build_wait(actual * 1000),
        build_progress(100, "Delay complete"),
        build_complete(True, {"waited": actual}),
    ]


# ==================== MODULE: DRIVE SYNC ====================


def execute_drive_sync(config: dict) -> List[dict]:
    """
    Sync from Google Drive - actually calls ImprovedDriveManager.
    """
    from modules.drive_module_improved import ImprovedDriveManager

    device_id = config.get("device_id", "1A121FDF60082H")
    folder_name = config.get("folder_name", "images")  # images, reels, stories
    account_number = config.get("account_number", 1)
    drive_url = config.get("drive_url")
    username = config.get("username")

    actions = [
        build_progress(0, "Initializing Drive sync..."),
    ]

    try:
        drive_mgr = ImprovedDriveManager(
            device_id=device_id,
            account_number=account_number,
            drive_url=drive_url,
            username=username,
        )

        actions.append(build_progress(10, "Opening Drive in browser..."))

        # Open Drive
        success = drive_mgr.open_drive_in_browser()
        if not success:
            actions.append(build_complete(False, {"error": "Failed to open Drive"}))
            return actions

        actions.append(build_progress(30, f"Navigating to {folder_name} folder..."))

        # Navigate to folder
        nav_success = drive_mgr.navigate_to_subfolder(folder_name)
        if not nav_success:
            actions.append(
                build_complete(False, {"error": f"Failed to find {folder_name} folder"})
            )
            return actions

        actions.append(build_progress(50, "Downloading first file..."))

        # Download first file
        download_result = drive_mgr.download_first_file(folder_context=folder_name)

        if download_result.get("success"):
            actions.append(
                build_progress(
                    100, f"Downloaded: {download_result.get('filename', 'file')}"
                )
            )
            actions.append(
                build_complete(
                    True,
                    {
                        "action": "drive_sync",
                        "folder": folder_name,
                        "filename": download_result.get("filename"),
                        "local_path": download_result.get("local_path"),
                    },
                )
            )
        else:
            actions.append(build_progress(100, "Download failed"))
            actions.append(
                build_complete(
                    False, {"error": download_result.get("error", "Download failed")}
                )
            )

    except Exception as e:
        actions.append(build_progress(100, f"Drive sync failed: {str(e)[:100]}"))
        actions.append(build_complete(False, {"error": str(e)}))

    return actions


# ==================== MODULE: ACCOUNT VALIDATOR ====================


def execute_account_validator(config: dict) -> List[dict]:
    """
    Validate all Instagram accounts on device - actually calls AccountValidator.
    """
    from modules.account_validator import AccountValidator

    device_id = config.get("device_id", "1A121FDF60082H")

    actions = [
        build_progress(0, "Starting account validation..."),
    ]

    try:
        validator = AccountValidator(device_id=device_id)

        actions.append(build_progress(20, "Scanning current profile..."))

        # Validate current profile
        result = validator.validate_current_profile()

        gmail_accounts = result.get("gmail", [])
        ig_accounts = result.get("ig", [])

        actions.append(
            build_progress(
                60, f"Found {len(gmail_accounts)} Gmail, {len(ig_accounts)} IG accounts"
            )
        )
        actions.append(build_progress(100, "Validation complete"))
        actions.append(
            build_complete(
                True,
                {
                    "action": "account_validator",
                    "gmail_accounts": gmail_accounts,
                    "ig_accounts": ig_accounts,
                    "gmail_count": len(gmail_accounts),
                    "ig_count": len(ig_accounts),
                },
            )
        )

    except Exception as e:
        actions.append(build_progress(100, f"Validation failed: {str(e)[:100]}"))
        actions.append(build_complete(False, {"error": str(e)}))

    return actions


def execute_validate_current(config: dict) -> List[dict]:
    """
    Validate current profile accounts - actually calls AccountValidator.
    """
    from modules.account_validator import AccountValidator

    device_id = config.get("device_id", "1A121FDF60082H")

    actions = [
        build_progress(0, "Validating current profile..."),
    ]

    try:
        validator = AccountValidator(device_id=device_id)

        actions.append(build_progress(20, "Scanning Gmail accounts..."))

        # Run actual validation on current profile
        result = validator.validate_current_profile()

        gmail_count = len(result.get("gmail", []))
        ig_count = len(result.get("ig", []))
        gmail_list = result.get("gmail", [])
        ig_list = result.get("ig", [])

        actions.append(
            build_progress(60, f"Found {gmail_count} Gmail, {ig_count} IG accounts")
        )
        actions.append(build_progress(100, "Current profile validated"))
        actions.append(
            build_complete(
                True,
                {
                    "action": "validate_current",
                    "gmail_accounts": gmail_list,
                    "ig_accounts": ig_list,
                    "gmail_count": gmail_count,
                    "ig_count": ig_count,
                },
            )
        )

    except Exception as e:
        actions.append(build_progress(100, f"Validation failed: {str(e)[:100]}"))
        actions.append(build_complete(False, {"error": str(e)}))

    return actions


def execute_validate_all(config: dict) -> List[dict]:
    """
    Validate all profiles - actually calls AccountValidator.
    Returns action sequence with real results embedded.
    """
    from modules.account_validator import AccountValidator

    secure = config.get("secure_mode", True)
    device_id = get_device_id(config)
    sync_airtable = config.get("sync_airtable", True)

    actions = [
        build_progress(
            0, f"Starting full validation ({'secure' if secure else 'quick'} mode)..."
        ),
    ]

    try:
        # Initialize validator
        validator = AccountValidator(device_id=device_id)

        actions.append(build_progress(10, "Getting profile list..."))

        # Get all profiles first
        profiles = validator.get_all_profiles()
        total_profiles = len(profiles)

        if total_profiles == 0:
            actions.append(build_progress(100, "No profiles found on device"))
            actions.append(build_complete(False, {"error": "No profiles found"}))
            return actions

        actions.append(
            build_progress(
                20, f"Found {total_profiles} profiles, starting validation..."
            )
        )

        # Run full validation
        results = validator.validate_all_profiles(secure=secure)

        # Compile summary
        total_gmail = 0
        total_ig = 0
        profile_summaries = []

        for profile_id, result in results.items():
            gmail_count = len(result.get("gmail", []))
            ig_count = len(result.get("ig", []))
            total_gmail += gmail_count
            total_ig += ig_count
            profile_summaries.append(
                {
                    "profile_id": profile_id,
                    "gmail_accounts": gmail_count,
                    "ig_accounts": ig_count,
                    "overflow_gmail": len(result.get("overflow_gmail", [])),
                    "overflow_ig": len(result.get("overflow_ig", [])),
                }
            )

        actions.append(
            build_progress(
                80,
                f"Validated {total_profiles} profiles: {total_gmail} Gmail, {total_ig} IG accounts",
            )
        )

        # Sync to Airtable if requested
        if sync_airtable:
            actions.append(build_progress(90, "Syncing to Airtable..."))
            try:
                validator.sync_to_airtable()
                actions.append(build_progress(95, "Airtable sync complete"))
            except Exception as e:
                actions.append(
                    build_progress(95, f"Airtable sync failed: {str(e)[:50]}")
                )

        actions.append(build_progress(100, f"All {total_profiles} profiles validated"))
        actions.append(
            build_complete(
                True,
                {
                    "action": "validate_all",
                    "profiles_scanned": total_profiles,
                    "total_gmail_accounts": total_gmail,
                    "total_ig_accounts": total_ig,
                    "profile_summaries": profile_summaries,
                },
            )
        )

    except Exception as e:
        actions.append(build_progress(100, f"Validation failed: {str(e)[:100]}"))
        actions.append(build_complete(False, {"error": str(e)}))

    return actions


def execute_account_creation(config: dict) -> List[dict]:
    """Create new Instagram account."""
    email_domain = config.get("email_domain", "gmail.com")
    return [
        build_progress(0, "Starting account creation..."),
        build_launch("com.instagram.android"),
        build_wait(3000),
        build_progress(10, "Looking for sign up option..."),
        build_tap(540, 1700, delay=500),  # Create new account
        build_wait(2000),
        build_progress(30, "Entering email..."),
        build_wait(2000),
        build_progress(50, "Setting up profile..."),
        build_wait(3000),
        build_progress(70, "Confirming details..."),
        build_wait(2000),
        build_progress(90, "Completing registration..."),
        build_wait(3000),
        build_progress(100, "Account creation flow initiated"),
        build_complete(
            True, {"action": "account_creation", "email_domain": email_domain}
        ),
    ]


def execute_ig_login(config: dict) -> List[dict]:
    """Login to existing Instagram account."""
    email = config.get("email", "")
    return [
        build_progress(0, f"Logging into Instagram: {email}..."),
        build_launch("com.instagram.android"),
        build_wait(3000),
        build_progress(20, "Finding login option..."),
        build_tap(540, 1600, delay=500),  # Log in button
        build_wait(2000),
        build_progress(40, "Entering credentials..."),
        build_tap(540, 500, delay=500),  # Email field
        build_input(email, delay=500),
        build_progress(60, "Entering password..."),
        build_wait(2000),
        build_progress(80, "Submitting login..."),
        build_tap(540, 1000, delay=500),  # Login button
        build_wait(5000),
        build_progress(100, "Login flow completed"),
        build_complete(True, {"action": "ig_login", "email": email}),
    ]


def execute_gmail_login(config: dict) -> List[dict]:
    """Add Gmail account to device."""
    email = config.get("email", "")
    return [
        build_progress(0, f"Adding Gmail account: {email}..."),
        build_launch("com.google.android.gm"),
        build_wait(3000),
        build_progress(20, "Opening account settings..."),
        build_tap(980, 200, delay=500),  # Profile icon
        build_wait(2000),
        build_progress(40, "Adding account..."),
        build_tap(540, 800, delay=500),  # Add account
        build_wait(2000),
        build_progress(60, "Entering credentials..."),
        build_input(email, delay=500),
        build_wait(3000),
        build_progress(80, "Confirming..."),
        build_wait(3000),
        build_progress(100, "Gmail account flow initiated"),
        build_complete(True, {"action": "gmail_login", "email": email}),
    ]


def execute_gmail_logout(config: dict) -> List[dict]:
    """Remove Gmail account from device."""
    email = config.get("email", "")
    return [
        build_progress(0, f"Removing Gmail account: {email}..."),
        build_launch("com.google.android.gm"),
        build_wait(3000),
        build_progress(30, "Opening account settings..."),
        build_tap(980, 200, delay=500),
        build_wait(2000),
        build_progress(60, "Removing account..."),
        build_wait(3000),
        build_progress(100, "Gmail removal flow completed"),
        build_complete(True, {"action": "gmail_logout", "email": email}),
    ]


def execute_ig_logout(config: dict) -> List[dict]:
    """Logout Instagram account."""
    username = config.get("username", "")
    return [
        build_progress(0, f"Logging out Instagram: @{username}..."),
        build_launch("com.instagram.android"),
        build_wait(3000),
        build_progress(20, "Opening profile..."),
        build_tap(*SCREEN["profile_icon"]),
        build_wait(2000),
        build_progress(40, "Opening settings..."),
        build_tap(980, 100, delay=500),  # Menu
        build_wait(1000),
        build_tap(540, 400, delay=500),  # Settings
        build_wait(2000),
        build_progress(60, "Finding logout..."),
        build_swipe(540, 1800, 540, 400, duration=300),
        build_wait(1000),
        build_progress(80, "Logging out..."),
        build_tap(540, 1600, delay=500),  # Log out
        build_wait(2000),
        build_progress(100, "Logout complete"),
        build_complete(True, {"action": "ig_logout", "username": username}),
    ]


def execute_content_manager(config: dict) -> List[dict]:
    """Manage content queue."""
    return [
        build_progress(0, "Loading content queue..."),
        build_wait(1000),
        build_progress(50, "Organizing content..."),
        build_wait(1000),
        build_progress(100, "Content queue ready"),
        build_complete(True, {"action": "content_manager"}),
    ]


def execute_airtable_sync(config: dict) -> List[dict]:
    """Sync data with Airtable."""
    return [
        build_progress(0, "Connecting to Airtable..."),
        build_wait(1000),
        build_progress(50, "Syncing data..."),
        build_wait(2000),
        build_progress(100, "Airtable sync complete"),
        build_complete(True, {"action": "airtable_sync"}),
    ]


# ==================== MODULE REGISTRY ====================

MODULE_HANDLERS = {
    # Instagram (12 modules)
    "engagement": execute_engagement,
    "follow": execute_follow,
    "post_feed": execute_post_feed,
    "post_story": execute_post_story,
    "repost": execute_repost,
    "edit_profile": execute_edit_profile,
    "ig_launcher": execute_ig_launcher,
    "ig_account_switch": execute_ig_account_switch,
    "stats_scraper": execute_stats_scraper,
    "detect_accounts": execute_detect_accounts,
    # Threads (2 modules)
    "threads_post": execute_threads_post,
    "threads_engage": execute_threads_engage,
    # TikTok (2 modules)
    "tiktok_post": execute_tiktok_post,
    "tiktok_engage": execute_tiktok_engage,
    # Twitter/X (2 modules)
    "twitter_post": execute_twitter_post,
    "twitter_engage": execute_twitter_engage,
    # Account Management (8 modules)
    "account_validator": execute_account_validator,
    "validate_current": execute_validate_current,
    "validate_all": execute_validate_all,
    "account_creation": execute_account_creation,
    # account_creation_phone intentionally absent — handled by WS_MODULE_HANDLERS only
    "ig_login": execute_ig_login,
    "gmail_login": execute_gmail_login,
    "gmail_logout": execute_gmail_logout,
    "ig_logout": execute_ig_logout,
    # System (6 modules)
    "airplane_toggle": execute_airplane_toggle,
    "gallery_clean": execute_gallery_clean,
    "profile_switch": execute_profile_switch,
    "vpn_connect": execute_vpn_connect,
    "delay": execute_delay,
    "random_delay": execute_random_delay,
    # Content (3 modules)
    "drive_sync": execute_drive_sync,
    "content_manager": execute_content_manager,
    "airtable_sync": execute_airtable_sync,
}

# ==================== API ENDPOINTS ====================


@app.get("/")
def root():
    return {"status": "ok", "service": "ShadowPhone Module Server"}


@app.get("/health")
def health():
    return {"status": "healthy"}


@app.get("/ready")
def ready():
    readiness = get_brain_readiness()
    if not readiness["ready"]:
        return JSONResponse(status_code=503, content=readiness)
    return readiness


@app.get("/modules")
def list_modules():
    """List all available modules."""
    # Include WS-native modules too so clients can accurately detect capability.
    # Backward compatible: `modules` stays a list of ids, `count` stays numeric.
    rest = list(MODULE_HANDLERS.keys())
    ws = list(WS_MODULE_HANDLERS.keys()) if "WS_MODULE_HANDLERS" in globals() else []
    merged = sorted(set(rest) | set(ws))
    return {"modules": merged, "count": len(merged), "rest": rest, "ws": ws}


@app.post("/execute")
def execute_module(
    request: ModuleRequest,
    authorization: str = Header(None),
    x_clerk_token: str = Header(None, alias="X-Clerk-Token"),
):
    """Execute a module and return action sequence."""
    # Verify auth and get Clerk user ID from JWT
    verified_user_id = verify_auth(authorization, x_clerk_token)

    handler = MODULE_HANDLERS.get(request.moduleId)
    if not handler:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown module: {request.moduleId}. Available: {list(MODULE_HANDLERS.keys())}",
        )

    # ==================== USAGE QUOTA CHECK ====================
    quota_info = None
    run_id = None

    # SECURITY: Use verified userId from JWT, fallback to request only if JWT not configured
    user_id = verified_user_id or request.userId

    if not user_id:
        raise HTTPException(
            status_code=401,
            detail="Authentication required: provide X-Clerk-Token header or userId",
        )

    # Log if we're using unverified userId (should only happen if CLERK_JWKS_URL not set)
    if not verified_user_id and request.userId:
        print(
            f"[Security Warning] Using unverified userId from request: {request.userId}"
        )

    if get_supabase():
        try:
            # Check and increment quota via RPC
            result = (
                get_supabase()
                .rpc("check_and_increment_usage", {"p_user_id": user_id})
                .execute()
            )

            if result.data and len(result.data) > 0:
                quota_data = result.data[0]
                quota_info = {
                    "allowed": quota_data.get("allowed", True),
                    "runs_today": quota_data.get("runs_today", 0),
                    "runs_limit": quota_data.get("runs_limit", 50),
                    "remaining": quota_data.get("remaining", 50),
                    "plan": quota_data.get("plan_name", "free"),
                    "is_expired": quota_data.get("is_expired", False),
                    "is_trial": quota_data.get("is_trial", False),
                    "trial_ends_at": quota_data.get("trial_ends_at"),
                }

                # Return 403 if subscription expired
                if quota_info["is_expired"]:
                    return JSONResponse(
                        status_code=403,
                        content={
                            "error": "Subscription expired",
                            "is_expired": True,
                            "was_trial": quota_info["is_trial"],
                            "plan": quota_info["plan"],
                            "message": "Please renew your subscription to continue",
                        },
                    )

                # Return 429 if quota exceeded
                if not quota_info["allowed"]:
                    return JSONResponse(
                        status_code=429,
                        content={
                            "error": "Daily quota exceeded",
                            "runs_today": quota_info["runs_today"],
                            "runs_limit": quota_info["runs_limit"],
                            "plan": quota_info["plan"],
                        },
                    )

            # Log module run start (use updated function signature)
            log_result = (
                get_supabase()
                .rpc(
                    "log_module_run",
                    {
                        "p_user_id": request.userId,
                        "p_module_id": request.moduleId,
                        "p_device_id": None,  # UUID, can pass device UUID if available
                        "p_profile_id": request.profileId,
                        "p_status": "started",
                        "p_config": sanitize_module_payload(request.config or {}),
                        "p_client_version": request.clientVersion,
                    },
                )
                .execute()
            )

            if log_result.data:
                run_id = log_result.data
                print(f"[Server] Logged run {run_id} for user {request.userId}")

        except Exception as e:
            print(f"[Server] Usage tracking error (non-fatal): {e}")
            # Continue execution even if tracking fails

    try:
        actions = handler(request.config or {})

        # Estimate duration
        total_ms = sum(a.get("ms", 0) + a.get("delay", 0) + 200 for a in actions)

        # ==================== TRACK ACTION IN DAILY_STATS ====================
        # Single RPC call — all logic (upsert + column mapping) is in Postgres
        if get_supabase() and user_id:
            try:
                get_supabase().rpc(
                    "track_daily_action",
                    {
                        "p_user_id": user_id,
                        "p_module_id": request.moduleId,
                    },
                ).execute()
                print(f"[Server] Tracked action via RPC: module={request.moduleId}")
            except Exception as track_err:
                print(f"[Server] daily_stats tracking error (non-fatal): {track_err}")

        response_data = {
            "actions": actions,
            "metadata": {
                "moduleId": request.moduleId,
                "deviceId": request.deviceId,
                "profileId": request.profileId,
                "estimatedDuration": total_ms,
                "actionCount": len(actions),
            },
        }

        # Include quota info in response
        if quota_info:
            response_data["quota"] = quota_info

        return response_data

    except Exception as e:
        # Log failed run
        if get_supabase() and run_id:
            try:
                get_supabase().rpc(
                    "complete_module_run",
                    {
                        "p_run_id": str(run_id),
                        "p_status": "failed",
                        "p_progress": 0,
                        "p_result": None,
                        "p_error_message": sanitize_module_payload(
                            {"message": str(e)}
                        )["message"],
                    },
                ).execute()
            except:
                pass
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/workflow")
def execute_workflow(request: WorkflowRequest, authorization: str = Header(None)):
    """Execute a full workflow across multiple profiles."""
    verify_auth(authorization)

    # Predefined workflows
    workflows = {
        "daily_farming": [
            ("ig_launcher", {}),
            ("engagement", {"count": 15}),
            ("follow", {"count": 5}),
            ("airplane_toggle", {"wait_seconds": 5}),
        ],
        "content_posting": [
            ("ig_launcher", {}),
            ("post_feed", {}),
            ("delay", {"seconds": 30}),
            ("post_story", {}),
        ],
        "account_warmup": [
            ("ig_launcher", {}),
            ("engagement", {"count": 10, "like_only": True}),
            ("delay", {"seconds": 60}),
            ("engagement", {"count": 5}),
        ],
    }

    workflow_steps = workflows.get(request.workflowId)
    if not workflow_steps:
        raise HTTPException(
            status_code=400, detail=f"Unknown workflow: {request.workflowId}"
        )

    all_actions = []

    for profile_idx, profile_id in enumerate(request.profiles):
        all_actions.append(
            build_progress(
                int((profile_idx / len(request.profiles)) * 100),
                f"Processing profile {profile_id}...",
            )
        )

        # Switch to profile
        all_actions.extend(execute_profile_switch({"target_profile": profile_idx}))

        # Run workflow steps
        for module_id, default_config in workflow_steps:
            step_config = {**default_config, **request.config}
            # Per-step toggle: missing/true = run (backward compatible), false = skip.
            if not step_config.get("enabled", True):
                continue
            handler = MODULE_HANDLERS.get(module_id)
            if handler:
                actions = handler(step_config)
                # Remove complete action from intermediate steps
                all_actions.extend([a for a in actions if a["type"] != "complete"])

    all_actions.append(
        build_complete(
            True,
            {
                "workflow": request.workflowId,
                "profilesProcessed": len(request.profiles),
            },
        )
    )

    return {
        "actions": all_actions,
        "metadata": {
            "workflowId": request.workflowId,
            "profiles": request.profiles,
            "estimatedDuration": len(all_actions) * 500,  # Rough estimate
        },
    }


# ==================== CONTENT SCRAPER ====================
# Cloud-based video acquisition and fingerprint breaking
# Endpoints: POST /content/scrape, GET /content/status/{job_id}

TEMP_DIR = Path("/tmp/shadowphone-content")
TEMP_DIR.mkdir(parents=True, exist_ok=True)
STORAGE_BUCKET = "content"

# In-memory job storage
content_jobs: Dict[str, Dict[str, Any]] = {}


class FingerprintOptions(BaseModel):
    metadataSpoof: bool = True
    pHashDisrupt: bool = True
    randomFlip: bool = True
    microZoom: bool = True
    audioShift: bool = True
    noiseOverlay: bool = True


class ScrapeRequest(BaseModel):
    userId: str
    url: str
    maxVideos: int = Field(default=10, ge=1, le=100)
    quality: str = "best"
    applyTemplate: bool = False
    caption: str = ""
    fingerprintOptions: FingerprintOptions = FingerprintOptions()
    cookies: Optional[str] = (
        None  # Base64-encoded Netscape cookie file content from user's browser
    )


class JobStatus(BaseModel):
    jobId: str
    status: str
    progress: int = 0
    videosDownloaded: int = 0
    totalVideos: int = 0
    downloadUrl: Optional[str] = None
    files: List[str] = []
    error: Optional[str] = None
    logs: Optional[str] = None


async def upload_to_storage(file_path: Path, job_id: str) -> str:
    """Upload file to Supabase Storage and return public URL"""
    if not SUPABASE_SERVICE_KEY:
        return f"/tmp/{job_id}/{file_path.name}"

    storage_path = f"{job_id}/{file_path.name}"

    # Map the content-type by extension so the Spoofer engine's .mov (Apple
    # QuickTime) output is served as video/quicktime, not mislabeled mp4.
    _ext = file_path.suffix.lower()
    _ctype = {
        ".mov": "video/quicktime", ".mp4": "video/mp4", ".webm": "video/webm",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    }.get(_ext, "application/octet-stream")

    async with httpx.AsyncClient() as client:
        with open(file_path, "rb") as f:
            file_data = f.read()

        response = await client.post(
            f"{SUPABASE_URL}/storage/v1/object/{STORAGE_BUCKET}/{storage_path}",
            headers={
                "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                "Content-Type": _ctype,
                "x-upsert": "true",
            },
            content=file_data,
            timeout=300,
        )

        if response.status_code not in [200, 201]:
            raise Exception(f"Upload failed: {response.text}")

    return f"{SUPABASE_URL}/storage/v1/object/public/{STORAGE_BUCKET}/{storage_path}"


async def download_videos(
    url: str,
    output_dir: Path,
    max_vids: int,
    quality: str,
    cookies_b64: Optional[str] = None,
) -> List[Path]:
    """Download videos using yt-dlp - supports cookies from user's browser"""
    import base64

    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"[yt-dlp] Starting download for: {url}")

    # Format selection matching VideoToolkit
    if quality == "720p":
        format_str = "bv*[height<=720]+ba/b[height<=720]/b"
    elif quality == "480p":
        format_str = "bv*[height<=480]+ba/b[height<=480]/b"
    else:
        format_str = "bv*+ba/b"  # Best quality

    # Determine if single video or channel/profile
    is_single = any(
        x in url
        for x in [
            "youtube.com/watch",
            "youtu.be/",
            "/shorts/",
            "/reel/",
            "/p/",
            "tiktok.com/@",
            "instagram.com/reel",
        ]
    )

    # Handle cookies from user's browser
    cookies_file = None
    if cookies_b64:
        try:
            cookies_data = base64.b64decode(cookies_b64)
            cookies_file = output_dir / "cookies.txt"
            cookies_file.write_bytes(cookies_data)
            print(f"[yt-dlp] Using user browser cookies ({len(cookies_data)} bytes)")
        except Exception as e:
            print(f"[yt-dlp] Cookie decode failed: {e}")

    # Build command - use yt-dlp nix binary directly (pip package removed to save RAM)
    # deno is installed via nixpacks and will be auto-detected by yt-dlp
    cmd = [
        "yt-dlp",
        "-P",
        str(output_dir),
        "-o",
        "%(id)s.%(ext)s",
        "-f",
        format_str,
        "--merge-output-format",
        "mp4",
        "--ignore-errors",
        "--no-overwrites",
        "--no-check-certificates",
        "--no-warnings",
    ]

    # Add cookies if provided
    if cookies_file and cookies_file.exists():
        cmd.extend(["--cookies", str(cookies_file)])

    if is_single:
        cmd.append("--no-playlist")
    else:
        cmd.extend(
            ["--playlist-items", f"1:{max_vids}", "--max-downloads", str(max_vids)]
        )

    cmd.append(url)

    print(f"[yt-dlp] Command: {' '.join(cmd)}")

    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )

    # Add timeout to prevent hanging (60 seconds for download)
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60.0)
    except asyncio.TimeoutError:
        print(f"[yt-dlp] Timeout after 60s - killing process")
        proc.kill()
        stdout, stderr = b"", b"Download timed out after 60 seconds"

    # Cleanup cookies file
    if cookies_file and cookies_file.exists():
        cookies_file.unlink()

    # Log output for debugging
    if stdout:
        print(f"[yt-dlp] stdout: {stdout.decode()[:500]}")
    if stderr:
        print(f"[yt-dlp] stderr: {stderr.decode()[:500]}")

    # Check for downloaded files (any video format)
    downloaded = (
        list(output_dir.glob("*.mp4"))
        + list(output_dir.glob("*.webm"))
        + list(output_dir.glob("*.mkv"))
        + list(output_dir.glob("*.mov"))
    )

    print(
        f"[yt-dlp] Downloaded {len(downloaded)} files: {[f.name for f in downloaded]}"
    )

    if not downloaded and proc.returncode != 0:
        error_msg = stderr.decode()[:500] if stderr else "Download failed"
        print(f"[yt-dlp] Error: {error_msg}")
        raise Exception(f"yt-dlp failed: {error_msg}")

    return downloaded


async def process_content_job(job_id: str, request: ScrapeRequest):
    """Background job processor for content scraping"""
    job_dir = TEMP_DIR / job_id
    download_dir = job_dir / "downloads"
    processed_dir = job_dir / "processed"

    try:
        content_jobs[job_id]["status"] = "downloading"
        content_jobs[job_id]["logs"] = "Starting download..."

        # Download (with optional cookies from user's browser)
        downloaded = await download_videos(
            request.url,
            download_dir,
            request.maxVideos,
            request.quality,
            request.cookies,
        )

        if not downloaded:
            raise Exception("No videos downloaded - check URL")

        content_jobs[job_id]["videosDownloaded"] = len(downloaded)
        content_jobs[job_id]["totalVideos"] = len(downloaded)
        content_jobs[job_id]["status"] = "processing"
        content_jobs[job_id]["logs"] = (
            f"Downloaded {len(downloaded)} videos. Processing..."
        )
        print(
            f"[Job {job_id[:8]}] Downloaded {len(downloaded)} videos, starting FFmpeg processing..."
        )

        # Process each video
        processed_dir.mkdir(parents=True, exist_ok=True)
        processed_files = []

        for i, video_path in enumerate(downloaded):
            # Spoofer engine (.mov, Apple QuickTime container): randomized visual
            # fingerprint-break (speed/eq/hue/gamma/zoom/grain) + audio pitch shift +
            # H.264 SEI strip + bitexact (kills "x264 core"/"Lavc" library tags) +
            # iPhone metadata + apple_container_patch. Strict upgrade over the old
            # fixed-value build_ffmpeg_filter+spoof_metadata. applyTemplate=False keeps
            # the scraped clip's original dimensions (no forced 1080x1920 white frame).
            output_path = processed_dir / f"processed_{video_path.stem}.mov"
            content_jobs[job_id]["logs"] = (
                f"Processing video {i + 1}/{len(downloaded)} (Spoofer engine)..."
            )
            print(f"[Job {job_id[:8]}] Processing {video_path.name}...")

            fp = request.fingerprintOptions
            poof = bool(
                fp.metadataSpoof or fp.pHashDisrupt or fp.microZoom
                or fp.audioShift or fp.noiseOverlay or fp.randomFlip
            )
            caption = request.caption if request.applyTemplate else ""
            cfg = _build_template_cfg(1080, 1920, 42, 40, 160, request.applyTemplate, poof)
            await asyncio.to_thread(
                process_video_sync, str(video_path), str(output_path), caption, cfg
            )

            url = await upload_to_storage(output_path, job_id)
            processed_files.append(url)

            progress = int((i + 1) / len(downloaded) * 100)
            content_jobs[job_id]["progress"] = progress
            content_jobs[job_id]["logs"] = f"Processed {i + 1}/{len(downloaded)} videos"

        # Complete
        content_jobs[job_id]["status"] = "complete"
        content_jobs[job_id]["progress"] = 100
        content_jobs[job_id]["files"] = processed_files
        content_jobs[job_id]["downloadUrl"] = (
            processed_files[0] if processed_files else None
        )
        content_jobs[job_id]["logs"] = (
            f"Complete! {len(processed_files)} videos processed."
        )

    except Exception as e:
        content_jobs[job_id]["status"] = "error"
        content_jobs[job_id]["error"] = str(e)
        content_jobs[job_id]["logs"] = f"Error: {str(e)}"

    finally:
        # Cleanup after 1 hour
        await asyncio.sleep(3600)
        if job_dir.exists():
            shutil.rmtree(job_dir, ignore_errors=True)


@app.get("/content/debug")
async def debug_content_tools():
    """Diagnostic endpoint to verify yt-dlp and FFmpeg are working on Railway"""
    results = {
        "build_version": BUILD_VERSION,
        "deno_version": None,  # Primary runtime for yt-dlp YouTube extraction
        "yt_dlp_version": None,
        "ffmpeg_version": None,
        "exiftool_version": None,
        "node_version": None,  # Fallback runtime
        "node_path": None,
        "test_download": None,
        "errors": [],
    }

    # Check Deno version (default runtime for yt-dlp YouTube extraction)
    try:
        proc = await asyncio.create_subprocess_exec(
            "deno",
            "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=10.0)
        results["deno_version"] = (
            stdout.decode().split("\n")[0].strip()
            if proc.returncode == 0
            else f"NOT INSTALLED: {stderr.decode()}"
        )
    except Exception as e:
        results["deno_version"] = f"ERROR: {str(e)}"

    # Check Node.js version (required for yt-dlp YouTube extraction)
    try:
        proc = await asyncio.create_subprocess_exec(
            "node",
            "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=10.0)
        results["node_version"] = (
            stdout.decode().strip()
            if proc.returncode == 0
            else f"NOT INSTALLED: {stderr.decode()}"
        )
    except Exception as e:
        results["node_version"] = f"ERROR: {str(e)}"

    # Find actual node path (critical for --js-runtimes)
    try:
        proc = await asyncio.create_subprocess_exec(
            "which",
            "node",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=10.0)
        results["node_path"] = (
            stdout.decode().strip()
            if proc.returncode == 0
            else f"NOT FOUND: {stderr.decode()}"
        )
    except Exception as e:
        results["node_path"] = f"ERROR: {str(e)}"

    # Check yt-dlp version (nix binary)
    try:
        proc = await asyncio.create_subprocess_exec(
            "yt-dlp",
            "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=10.0)
        if proc.returncode == 0:
            results["yt_dlp_version"] = stdout.decode().strip()
        else:
            # Fallback to yt-dlp directly
            proc2 = await asyncio.create_subprocess_exec(
                "yt-dlp",
                "--version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout2, stderr2 = await asyncio.wait_for(proc2.communicate(), timeout=10.0)
            results["yt_dlp_version"] = (
                stdout2.decode().strip()
                if proc2.returncode == 0
                else f"ERROR: {stderr2.decode()}"
            )
    except asyncio.TimeoutError:
        results["errors"].append("yt-dlp version check timed out")
    except Exception as e:
        results["errors"].append(f"yt-dlp error: {str(e)}")

    # Check FFmpeg
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10.0)
        results["ffmpeg_version"] = (
            stdout.decode().split("\n")[0] if proc.returncode == 0 else "NOT INSTALLED"
        )
    except Exception as e:
        results["errors"].append(f"ffmpeg error: {str(e)}")

    # Check exiftool
    try:
        proc = await asyncio.create_subprocess_exec(
            "exiftool",
            "-ver",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10.0)
        results["exiftool_version"] = (
            stdout.decode().strip() if proc.returncode == 0 else "NOT INSTALLED"
        )
    except Exception as e:
        results["errors"].append(f"exiftool error: {str(e)}")

    # Test actual download - using Instagram Reel (TikTok blocks cloud IPs)
    try:
        test_url = "https://www.instagram.com/reel/C3SN0JhOMoT/"
        test_dir = TEMP_DIR / "debug_test"
        test_dir.mkdir(parents=True, exist_ok=True)

        # deno is installed via nixpacks and auto-detected by yt-dlp
        proc = await asyncio.create_subprocess_exec(
            "yt-dlp",
            "-P",
            str(test_dir),
            "-o",
            "test.%(ext)s",
            "--format",
            "worst",  # Fastest download
            "--no-playlist",
            "--max-filesize",
            "10M",
            test_url,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60.0)

        # Check if file was created
        files = list(test_dir.glob("*"))
        if files:
            results["test_download"] = (
                f"SUCCESS: Downloaded {files[0].name} ({files[0].stat().st_size} bytes)"
            )
            # Cleanup
            shutil.rmtree(test_dir, ignore_errors=True)
        else:
            results["test_download"] = (
                f"FAILED: No file created. stdout={stdout.decode()[:500]}, stderr={stderr.decode()[:500]}"
            )
    except asyncio.TimeoutError:
        results["test_download"] = "TIMEOUT: Download took too long"
    except Exception as e:
        results["test_download"] = f"ERROR: {str(e)}"

    return results


@app.post("/content/scrape")
async def start_content_scrape(
    request: ScrapeRequest,
    background_tasks: BackgroundTasks,
    authorization: str = Header(None),
):
    """Start a content scraping job"""
    # Inline auth check - verify API secret
    if not authorization or authorization != f"Bearer {API_SECRET}":
        raise HTTPException(status_code=403, detail="Invalid API key")

    # Validate URL
    allowed = ["youtube.com", "youtu.be", "tiktok.com", "instagram.com"]
    if not any(domain in request.url for domain in allowed):
        raise HTTPException(
            status_code=400,
            detail="Invalid URL. Only YouTube, TikTok, and Instagram are supported.",
        )

    # Enforce monthly scrape quota and per-scrape caps for this generic endpoint
    quota = await check_scrape_quota(request.userId)
    if not quota.get("can_scrape", False):
        raise HTTPException(
            status_code=429,
            detail="Monthly scrape limit reached. Upgrade your plan for more scrapes!",
        )

    videos_per_scrape_limit = int(quota.get("videos_per_scrape", 50) or 50)
    if request.maxVideos > videos_per_scrape_limit:
        raise HTTPException(
            status_code=400,
            detail=f"Plan allows up to {videos_per_scrape_limit} videos per scrape.",
        )

    job_id = str(uuid.uuid4())

    platform = "youtube"
    lower_url = request.url.lower()
    if "tiktok.com" in lower_url:
        platform = "tiktok"
    elif "instagram.com" in lower_url:
        platform = "instagram"

    allowed_by_usage = await increment_scrape_quota(
        request.userId, job_id, platform, request.maxVideos
    )
    if not allowed_by_usage:
        raise HTTPException(
            status_code=429,
            detail="Monthly scrape limit reached. Upgrade your plan for more scrapes!",
        )

    content_jobs[job_id] = {
        "jobId": job_id,
        "userId": request.userId,
        "status": "queued",
        "progress": 0,
        "videosDownloaded": 0,
        "totalVideos": 0,
        "downloadUrl": None,
        "files": [],
        "error": None,
        "logs": "Job queued",
    }

    background_tasks.add_task(process_content_job, job_id, request)

    return {"jobId": job_id, "status": "queued", "message": "Job queued for processing"}


@app.get("/content/status/{job_id}")
async def get_content_status(job_id: str, authorization: str = Header(None)):
    """Get status of a content scraping job"""
    # Inline auth check
    if not authorization or authorization != f"Bearer {API_SECRET}":
        raise HTTPException(status_code=403, detail="Invalid API key")

    if job_id not in content_jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    return content_jobs[job_id]


# ==================== APIFY CLOUD SCRAPER API ====================
# Platform-specific endpoints for the Content Scraper UI

# Re-use the API_SECRET already declared at module level (from env vars, no fallback)
# API_SECRET is already set above -- do NOT re-declare with a hardcoded default
APIFY_API_TOKEN = os.getenv("APIFY_API_TOKEN", "")
APIFY_ACTORS = {
    "tiktok": "clockworks~tiktok-scraper",
    "instagram": "apify~instagram-scraper",
    "youtube": "streamers~youtube-scraper",
}

# Scraper job storage
scraper_jobs: Dict[str, Dict[str, Any]] = {}


class TikTokScrapeRequest(BaseModel):
    userId: str
    profiles: List[str] = []
    videoUrls: List[str] = []
    hashtags: List[str] = []
    maxVideos: int = Field(default=10, ge=1, le=50)
    fingerprint: bool = True
    downloadVideos: bool = True


class InstagramScrapeRequest(BaseModel):
    userId: str
    profiles: List[str] = []
    postUrls: List[str] = []
    hashtags: List[str] = []
    maxPosts: int = Field(default=10, ge=1, le=50)
    resultsType: str = "reels"  # Can be 'reels' or 'posts' from frontend toggle
    fingerprint: bool = True


class YouTubeScrapeRequest(BaseModel):
    userId: str
    channelUrls: List[str] = []
    videoUrls: List[str] = []
    searchQueries: List[str] = []
    maxVideos: int = Field(default=10, ge=1, le=50)
    shortsOnly: bool = True  # Only scrape Shorts by default
    includeCaptions: bool = False
    fingerprint: bool = True


async def check_scrape_quota(user_id: str) -> dict:
    """Check user's scrape quota via Supabase RPC"""
    if not get_supabase():
        # Default quota if Supabase not configured
        return {
            "can_scrape": True,
            "scrapes_remaining": 999,
            "scrapes_used": 0,
            "scrapes_limit": 999,
            "videos_per_scrape": 50,
        }

    try:
        result = (
            get_supabase().rpc("check_scrape_quota", {"p_user_id": user_id}).execute()
        )
        if result.data and len(result.data) > 0:
            row = result.data[0]
            return {
                "can_scrape": row.get("can_scrape", True),
                "scrapes_remaining": row.get("scrapes_remaining", 999),
                "scrapes_used": row.get("scrapes_used", 0),
                "scrapes_limit": row.get("scrapes_limit", 999),
                "videos_per_scrape": row.get("videos_per_scrape", 50),
                "resets_at": row.get("resets_at"),
            }
    except Exception as e:
        print(f"[Quota] Error checking quota: {e}")

    # Fail closed when Supabase is configured but quota check fails.
    return {
        "can_scrape": False,
        "scrapes_remaining": 0,
        "scrapes_used": 0,
        "scrapes_limit": 0,
        "videos_per_scrape": 0,
        "resets_at": None,
    }


async def increment_scrape_quota(
    user_id: str, job_id: str, platform: str, videos: int
) -> bool:
    """Record scrape usage in Supabase. Returns True if allowed, False if quota exceeded."""
    if not get_supabase():
        return True  # Allow if Supabase not configured

    try:
        result = (
            get_supabase()
            .rpc(
                "increment_scrape_count",
                {
                    "p_user_id": user_id,
                    "p_job_id": job_id,
                    "p_platform": platform,
                    "p_videos": videos,
                },
            )
            .execute()
        )

        if result.data is not None:
            print(f"[Quota] Recorded scrape for {user_id}: {platform}, {videos} videos")
            return result.data  # Returns True if allowed, False if limit exceeded
        return False
    except Exception as e:
        print(f"[Quota] Error recording usage: {e}")
        return False


async def run_apify_actor(actor_id: str, input_data: dict, timeout: int = 300) -> list:
    """Run Apify actor and return results"""
    if not APIFY_API_TOKEN:
        raise HTTPException(status_code=500, detail="APIFY_API_TOKEN not configured")

    async with httpx.AsyncClient(timeout=timeout) as client:
        # Start the actor run
        start_url = f"https://api.apify.com/v2/acts/{actor_id}/runs"
        headers = {"Authorization": f"Bearer {APIFY_API_TOKEN}"}

        response = await client.post(start_url, json=input_data, headers=headers)
        if response.status_code != 201:
            raise HTTPException(
                status_code=500, detail=f"Apify start failed: {response.text}"
            )

        run_data = response.json()["data"]
        run_id = run_data["id"]

        # Poll for completion
        status_url = f"https://api.apify.com/v2/acts/{actor_id}/runs/{run_id}"
        for _ in range(timeout // 5):
            await asyncio.sleep(5)
            status_response = await client.get(status_url, headers=headers)
            status = status_response.json()["data"]["status"]

            if status == "SUCCEEDED":
                # Get results
                dataset_id = status_response.json()["data"]["defaultDatasetId"]
                results_url = f"https://api.apify.com/v2/datasets/{dataset_id}/items"
                results_response = await client.get(results_url, headers=headers)
                return results_response.json()
            elif status in ["FAILED", "ABORTED", "TIMED-OUT"]:
                error_msg = status_response.json()["data"].get(
                    "statusMessage", "Unknown error"
                )
                print(f"[Apify] Run failed: {status} - {error_msg}")
                raise HTTPException(
                    status_code=500, detail=f"Apify run {status}: {error_msg}"
                )

        raise HTTPException(status_code=500, detail="Apify timeout")


async def process_apify_scrape(
    job_id: str, platform: str, input_data: dict, max_videos: int
):
    """Background task to process Apify scraping"""
    try:
        scraper_jobs[job_id]["status"] = "scraping"
        scraper_jobs[job_id]["logs"] = f"Running {platform} scraper..."

        actor_id = APIFY_ACTORS.get(platform)
        if not actor_id:
            raise Exception(f"Unknown platform: {platform}")

        results = await run_apify_actor(actor_id, input_data)

        # Extract video URLs from results based on platform
        video_urls = []
        for item in results[:max_videos]:
            if platform == "tiktok":
                # TikTok Apify output has mediaUrls array or webVideoUrl
                if item.get("mediaUrls") and len(item["mediaUrls"]) > 0:
                    url = item["mediaUrls"][0]
                else:
                    url = item.get("webVideoUrl")  # Fallback to web URL
            elif platform == "instagram":
                url = item.get("videoUrl") or item.get("displayUrl")
            elif platform == "youtube":
                # YouTube scraper returns 'url' field directly
                url = (
                    item.get("url")
                    or f"https://youtube.com/watch?v={item.get('id', '')}"
                )

            if url:
                video_urls.append(url)

        scraper_jobs[job_id]["status"] = "complete"
        scraper_jobs[job_id]["progress"] = 100
        scraper_jobs[job_id]["totalVideos"] = len(video_urls)
        scraper_jobs[job_id]["downloadedVideos"] = len(video_urls)
        scraper_jobs[job_id]["files"] = video_urls
        scraper_jobs[job_id]["logs"] = f"Found {len(video_urls)} videos"

    except Exception as e:
        scraper_jobs[job_id]["status"] = "error"
        scraper_jobs[job_id]["error"] = str(e)
        scraper_jobs[job_id]["logs"] = f"Error: {str(e)}"


def require_content_user(authorization, x_user_id, requested_user_id=None):
    if not API_SECRET or authorization != f"Bearer {API_SECRET}":
        raise HTTPException(status_code=403, detail="Invalid API key")
    if not isinstance(x_user_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", x_user_id):
        raise HTTPException(status_code=403, detail="Authenticated user is required")
    if requested_user_id is not None and requested_user_id != x_user_id:
        raise HTTPException(status_code=403, detail="User does not match authenticated account")
    return x_user_id


def get_owned_content_job(job_id, user_id):
    job = scraper_jobs.get(job_id)
    if not job or job.get("userId") != user_id:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get("/quota/{user_id}")
async def get_user_quota(user_id: str, authorization: str = Header(None), x_user_id: str = Header(None)):
    """Get user's scrape quota status"""
    require_content_user(authorization, x_user_id, user_id)

    quota = await check_scrape_quota(user_id)
    return quota


@app.post("/scrape/tiktok")
async def scrape_tiktok(
    request: TikTokScrapeRequest,
    background_tasks: BackgroundTasks,
    authorization: str = Header(None),
    x_user_id: str = Header(None),
):
    """Scrape TikTok videos via Apify"""
    user_id = require_content_user(authorization, x_user_id, request.userId)

    job_id = str(uuid.uuid4())

    # Build Apify input - matches clockworks/tiktok-scraper format
    # Only include non-empty arrays
    input_data = {
        "resultsPerPage": max(1, request.maxVideos),
        "shouldDownloadVideos": True,
        "shouldDownloadCovers": False,
        "shouldDownloadSubtitles": False,
        "shouldDownloadSlideshowImages": False,
        "profileScrapeSections": ["videos"],
        "profileSorting": "latest",
    }

    # Only add arrays if they have content
    if request.profiles:
        input_data["profiles"] = request.profiles
    if request.hashtags:
        input_data["hashtags"] = request.hashtags
    if request.videoUrls:
        input_data["postURLs"] = request.videoUrls

    scraper_jobs[job_id] = {
        "jobId": job_id,
        "userId": user_id,
        "platform": "tiktok",
        "status": "queued",
        "progress": 0,
        "totalVideos": 0,
        "downloadedVideos": 0,
        "files": [],
        "downloadUrl": None,
        "error": None,
        "logs": "Job queued...",
    }

    # Record quota usage in Supabase
    allowed = await increment_scrape_quota(
        request.userId, job_id, "tiktok", request.maxVideos
    )
    if not allowed:
        del scraper_jobs[job_id]
        raise HTTPException(
            status_code=429,
            detail="Monthly scrape limit reached. Upgrade your plan for more scrapes!",
        )

    background_tasks.add_task(
        process_apify_scrape, job_id, "tiktok", input_data, request.maxVideos
    )

    return {"jobId": job_id, "status": "queued"}


@app.post("/scrape/instagram")
async def scrape_instagram(
    request: InstagramScrapeRequest,
    background_tasks: BackgroundTasks,
    authorization: str = Header(None),
    x_user_id: str = Header(None),
):
    """Scrape Instagram posts/reels via Apify"""
    user_id = require_content_user(authorization, x_user_id, request.userId)

    job_id = str(uuid.uuid4())

    # Build Apify input based on what inputs are provided
    direct_urls = []
    for profile in request.profiles:
        clean = profile.strip().lstrip("@")
        if clean:
            direct_urls.append(f"https://www.instagram.com/{clean}/")
    for url in request.postUrls:
        if url.strip():
            direct_urls.append(url.strip())

    input_data = {
        "directUrls": direct_urls,
        "resultsType": request.resultsType,  # 'reels' or 'posts' from frontend toggle
        "resultsLimit": request.maxPosts,
        "searchType": "hashtag" if request.hashtags else "user",
        "search": request.hashtags[0] if request.hashtags else "",
    }

    scraper_jobs[job_id] = {
        "jobId": job_id,
        "userId": user_id,
        "platform": "instagram",
        "status": "queued",
        "progress": 0,
        "totalVideos": 0,
        "downloadedVideos": 0,
        "files": [],
        "downloadUrl": None,
        "error": None,
        "logs": "Job queued...",
    }

    # Record quota usage in Supabase
    allowed = await increment_scrape_quota(
        request.userId, job_id, "instagram", request.maxPosts
    )
    if not allowed:
        del scraper_jobs[job_id]
        raise HTTPException(
            status_code=429,
            detail="Monthly scrape limit reached. Upgrade your plan for more scrapes!",
        )

    background_tasks.add_task(
        process_apify_scrape, job_id, "instagram", input_data, request.maxPosts
    )

    return {"jobId": job_id, "status": "queued"}


@app.post("/scrape/youtube")
async def scrape_youtube(
    request: YouTubeScrapeRequest,
    background_tasks: BackgroundTasks,
    authorization: str = Header(None),
    x_user_id: str = Header(None),
):
    """Scrape YouTube videos via Apify"""
    user_id = require_content_user(authorization, x_user_id, request.userId)

    job_id = str(uuid.uuid4())

    # Build Apify input - matches streamers/youtube-scraper format
    # All URLs go into startUrls, search terms go into searchKeywords
    start_urls = []
    for url in request.channelUrls or []:
        start_urls.append({"url": url})
    for url in request.videoUrls or []:
        start_urls.append({"url": url})

    input_data = {
        "startUrls": start_urls,
        "searchQueries": request.searchQueries or [],
        "maxResults": 0 if request.shortsOnly else request.maxVideos,  # Regular videos
        "maxResultsShorts": request.maxVideos
        if request.shortsOnly
        else 0,  # Shorts only when toggle is on
        "maxResultStreams": 0,
        "downloadSubtitles": request.includeCaptions,
    }

    scraper_jobs[job_id] = {
        "jobId": job_id,
        "userId": user_id,
        "platform": "youtube",
        "status": "queued",
        "progress": 0,
        "totalVideos": 0,
        "downloadedVideos": 0,
        "files": [],
        "downloadUrl": None,
        "error": None,
        "logs": "Job queued...",
    }

    # Record quota usage in Supabase
    allowed = await increment_scrape_quota(
        request.userId, job_id, "youtube", request.maxVideos
    )
    if not allowed:
        del scraper_jobs[job_id]
        raise HTTPException(
            status_code=429,
            detail="Monthly scrape limit reached. Upgrade your plan for more scrapes!",
        )

    background_tasks.add_task(
        process_apify_scrape, job_id, "youtube", input_data, request.maxVideos
    )

    return {"jobId": job_id, "status": "queued"}


# ==================== VIDEO TEMPLATER ====================

TEMPLATE_TEMP_DIR = Path("/tmp/shadowphone-templates")
TEMPLATE_TEMP_DIR.mkdir(parents=True, exist_ok=True)
TEMPLATE_VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
TEMPLATE_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}


# ============================================================
# Spoofer templater engine (ported from Brands/Spoofer/templater.py)
# Grafted into the live templater so /template/upload gets iPhone-grade
# spoofing: emoji-aware PNG captions, iPhone metadata, Apple QuickTime
# container patch, bitexact. PIL import is guarded so a missing Pillow
# can NEVER crash this fleet-wide server (falls back to mono drawtext).
# ============================================================
import textwrap as _tmpl_textwrap
textwrap = _tmpl_textwrap
# Pillow is only needed by the templater's emoji-aware caption renderer
# (render_caption_png). Guard the import so a missing Pillow can NEVER crash
# module import and take down the shared TikTok/IG/YouTube scraper routes — the
# renderer falls back to monochrome drawtext when _HAS_PIL is False.
try:
    from PIL import Image, ImageDraw, ImageFont

    _HAS_PIL = True
except ImportError:
    _HAS_PIL = False

# ---- Spoofer engine identity constants (ported from Brands/Spoofer/templater.py) ----
IPHONES = ["iPhone 16 Pro Max", "iPhone 16 Pro", "iPhone 17 Pro Max", "iPhone 17 Pro"]
# Recent iOS build numbers (just the version — real iPhone metadata has NO "iOS " prefix).
IOS_VERSIONS = ["18.5", "18.4.1", "18.3.1", "18.2.1", "18.5", "18.4", "18.6.1"]
# US cities with their late-May DST UTC offset (hours) so creationdate TZ matches the GPS.
US_CITIES = [
    (34.0522, -118.2437, -7),  # Los Angeles PDT
    (40.7128, -74.0060, -4),   # New York EDT
    (41.8781, -87.6298, -5),   # Chicago CDT
    (29.7604, -95.3698, -5),   # Houston CDT
    (33.4484, -112.0740, -7),  # Phoenix MST (no DST)
    (32.7767, -96.7970, -5),   # Dallas CDT
    (37.7749, -122.4194, -7),  # San Francisco PDT
    (47.6062, -122.3321, -7),  # Seattle PDT
    (25.7617, -80.1918, -4),   # Miami EDT
    (33.7490, -84.3880, -4),   # Atlanta EDT
    (36.1699, -115.1398, -7),  # Las Vegas PDT
    (39.7392, -104.9903, -6),  # Denver MDT
]
# Linux font paths (provided by the Dockerfile's fonts-dejavu-core +
# fonts-noto-color-emoji apt packages).
EMOJI_FONT_DEFAULT = "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"
OVERLAY_POSITIONS = {"main-top", "main-bottom", "main-left", "main-right", "pip-br", "pip-bl"}

def build_iphone_meta():
    """A self-consistent recent 'shot on iPhone in the USA' identity: device,
    iOS build, US GPS (with matching timezone), and a recent capture instant
    expressed in both UTC (container dates) and local+offset (com.apple creationdate)."""
    from datetime import timezone, timedelta
    device = random.choice(IPHONES)
    software = random.choice(IOS_VERSIONS)
    lat0, lon0, off_h = random.choice(US_CITIES)
    lat = round(lat0 + random.uniform(-0.02, 0.02), 6)
    lon = round(lon0 + random.uniform(-0.02, 0.02), 6)
    alt = round(random.uniform(2, 180), 1)
    inst = datetime.now(timezone.utc) - timedelta(hours=random.uniform(1, 72))
    local = inst.astimezone(timezone(timedelta(hours=off_h)))
    return {
        "device": device,
        "software": software,
        "lat": lat, "lon": lon, "alt": alt,
        "utc_create": inst.strftime("%Y:%m:%d %H:%M:%S"),
        "utc_modify": (inst + timedelta(seconds=2)).strftime("%Y:%m:%d %H:%M:%S"),
        "local_create": local.strftime("%Y:%m:%d %H:%M:%S") + f"{off_h:+03d}:00",
        "local_naive": local.strftime("%Y:%m:%d %H:%M:%S"),  # EXIF DateTimeOriginal = local camera time
        "offset": f"{off_h:+03d}:00",
        "lens": f"{device} back triple camera 6.765mm f/1.78",
    }


def ffmpeg_escape_fontfile(path: str) -> str:
    """drawtext needs the Windows drive colon escaped: C:/.. -> C\\:/.."""
    return path.replace("\\", "/").replace(":", "\\:")


def escape_drawtext(text: str) -> str:
    # Straight apostrophes break drawtext's single-quoted text='...' (the \' escape
    # corrupts the filtergraph). Swap to the typographic apostrophe — renders
    # identically (nicer, even) and is not a special char.
    text = text.replace("'", "’")
    return (
        text.replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("%", "\\%")
    )


def run(cmd, timeout=300):
    # Safety net: a hung ffmpeg (e.g. -shortest waiting on a stream that never
    # ends) would otherwise block the whole batch forever. Kill + report instead.
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
        return proc.returncode, proc.stderr.decode("utf-8", "ignore")
    except subprocess.TimeoutExpired:
        return 124, f"ffmpeg timed out after {timeout}s"


def has_audio(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
         "stream=codec_type", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    ).stdout.strip()
    return bool(out)


def video_fps(path) -> str:
    """Return the source video's avg frame rate (e.g. '60/1') so the white
    canvas can match it — otherwise the color source defaults to 25fps and the
    overlay adopts that, downsampling the video."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=avg_frame_rate", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    ).stdout.strip()
    if "/" in out:
        num, den = out.split("/")
        if den not in ("0", "") and num not in ("0", ""):
            return out
    return "30/1"


def _is_emoji(ch):
    o = ord(ch)
    return (
        0x1F000 <= o <= 0x1FAFF or 0x2600 <= o <= 0x27BF or 0x2B00 <= o <= 0x2BFF
        or 0x2190 <= o <= 0x21FF or 0x2300 <= o <= 0x23FF or 0x25A0 <= o <= 0x25FF
        or 0xFE00 <= o <= 0xFE0F or 0x1F1E6 <= o <= 0x1F1FF
        or o in (0x2122, 0x2139, 0x203C, 0x2049, 0x200D, 0x20E3, 0x2934, 0x2935, 0x3030, 0x303D)
    )


def _emoji_runs(s):
    """Split a string into (is_emoji, substring) runs so text and emoji can be
    drawn with their own fonts (ZWJ sequences + variation selectors stay with
    the emoji run)."""
    out, cur, cur_e = [], "", None
    for ch in s:
        e = _is_emoji(ch)
        if cur and e != cur_e:
            out.append((cur_e, cur)); cur = ""
        cur += ch; cur_e = e
    if cur:
        out.append((cur_e, cur))
    return out


def _measure(d, s, tf, ef, escale=1.0):
    # escale scales emoji advance widths: Linux NotoColorEmoji is a bitmap-strike
    # font loaded at its native 109px strike, so its glyphs are downscaled by
    # escale (=target_size/strike) to sit inline with the text font.
    return sum(
        d.textlength(sub, font=ef) * escale if e else d.textlength(sub, font=tf)
        for e, sub in _emoji_runs(s)
    )


def _wrap_px(d, text, tf, ef, max_w, escale=1.0):
    """Greedy word-wrap by rendered pixel width (handles emoji widths), so lines
    never exceed the usable width regardless of font size or content."""
    lines, cur = [], ""
    for word in text.split(" "):
        trial = word if not cur else cur + " " + word
        if not cur or _measure(d, trial, tf, ef, escale) <= max_w:
            cur = trial
        else:
            lines.append(cur); cur = word
    if cur:
        lines.append(cur)
    return lines


def _resolve_emoji_font(path, fs):
    """Load the color-emoji font for a target pixel size fs.

    Scalable color fonts (Windows seguiemj COLR/CPAL) load at any size -> (font, 1.0).
    Bitmap-strike fonts (Debian fonts-noto-color-emoji = CBDT/CBLC, single 109px
    strike) raise OSError 'invalid pixel size' at arbitrary sizes; we load at the
    native strike and return a scale factor so the strike glyph is downscaled to fs.
    Returns (font_or_None, scale). font is None only if no strike loads at all
    (caller then falls back to the monochrome text font)."""
    try:
        return ImageFont.truetype(path, fs), 1.0
    except OSError:
        pass
    for strike in (109, 128, 96, 160, 64, 136, 32):
        try:
            return ImageFont.truetype(path, strike), fs / strike
        except OSError:
            continue
    return None, None


def _draw_emoji_run(base_img, sub, ef, escale, x, baseline):
    """Draw a color-emoji run onto base_img at (x, baseline) honoring escale.

    For escale==1.0 (scalable font) this is a plain draw. For bitmap-strike fonts
    we render the run at the native strike to its own RGBA, downscale by escale,
    and alpha-paste so color glyphs stay crisp at the smaller inline size.
    Returns the advance width (already scaled)."""
    pd = ImageDraw.Draw(base_img)
    advance = pd.textlength(sub, font=ef) * escale
    if escale == 1.0:
        pd.text((x, baseline), sub, font=ef, embedded_color=True, anchor="ls")
        return advance
    raw_w = max(1, int(pd.textlength(sub, font=ef)) + 8)
    raw_h = max(1, int(ef.size * 1.6))
    glyph_baseline = raw_h - int(ef.size * 0.3)  # baseline row inside the strike glyph image
    glyph = Image.new("RGBA", (raw_w, raw_h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glyph)
    gd.text((0, glyph_baseline), sub, font=ef, embedded_color=True, anchor="ls")
    sw, sh = max(1, int(raw_w * escale)), max(1, int(raw_h * escale))
    scaled = glyph.resize((sw, sh), Image.LANCZOS)
    # The glyph baseline scales with the image; align it to the text baseline so
    # emoji sit level with the text in the base image.
    paste_y = int(baseline - glyph_baseline * escale)
    base_img.alpha_composite(scaled, (int(x), paste_y))
    return advance


def render_caption_png(caption, width, header_height, max_font_size, text_font_path, emoji_font_path, out_png):
    """Render a caption (black text + COLOR emoji) to a transparent PNG sized to the
    header band. Auto-fits: pixel-wraps to the usable width and shrinks the font
    until all lines fit the header height, so short hooks stay big and long
    sentences scale down instead of clipping. ffmpeg can't draw color emoji via
    drawtext, so we overlay this PNG instead. Returns True on success."""
    if not _HAS_PIL:
        return False
    img = Image.new("RGBA", (width, header_height), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    side = 40
    usable = width - 2 * side
    avail_h = header_height - 16

    fs = max_font_size
    while True:
        text_font = ImageFont.truetype(text_font_path, fs)
        # Resolve the emoji font at this size. escale handles bitmap-strike fonts
        # (Linux NotoColorEmoji) that can't load at fs directly; a None font means
        # no color emoji available -> draw emoji with the text font (escale=1.0).
        emoji_font, escale = _resolve_emoji_font(emoji_font_path, fs)
        if emoji_font is None:
            emoji_font, escale = text_font, 1.0
        lines = _wrap_px(d, caption, text_font, emoji_font, usable, escale)
        line_height = int(fs * 1.2) + 6
        fits = len(lines) * line_height <= avail_h and all(_measure(d, l, text_font, emoji_font, escale) <= usable for l in lines)
        if fits or fs <= 26:
            break
        fs -= 4

    ascent, _ = text_font.getmetrics()
    total_h = len(lines) * line_height
    y_top = max(8, (header_height - total_h) // 2)
    for line in lines:
        line_w = _measure(d, line, text_font, emoji_font, escale)
        x = max(side, (width - line_w) / 2)
        baseline = y_top + ascent  # share one baseline so emoji sit level with text
        for e, sub in _emoji_runs(line):
            if e:
                x += _draw_emoji_run(img, sub, emoji_font, escale, x, baseline)
            else:
                d.text((x, baseline), sub, font=text_font, fill=(0, 0, 0, 255), anchor="ls")
                x += d.textlength(sub, font=text_font)
        y_top += line_height
    img.save(out_png)
    return True


def spoof_metadata_video(out_path, meta):
    """Write real iPhone QuickTime atoms: com.apple.quicktime.make/model/software
    (Keys group) + creationdate with TZ + location.ISO6709, plus UTC container/track
    dates. Strips any XMP and the ffmpeg encoder tag so it reads 1:1 as iPhone."""
    cmd = [
        "exiftool", "-overwrite_original", "-q",
        "-Keys:Make=Apple",
        f"-Keys:Model={meta['device']}",
        f"-Keys:Software={meta['software']}",
        f"-Keys:CreationDate={meta['local_create']}",
        f"-Keys:GPSCoordinates={meta['lat']}, {meta['lon']}, {meta['alt']}",
        f"-QuickTime:CreateDate={meta['utc_create']}",
        f"-QuickTime:ModifyDate={meta['utc_modify']}",
        f"-TrackCreateDate={meta['utc_create']}",
        f"-TrackModifyDate={meta['utc_modify']}",
        f"-MediaCreateDate={meta['utc_create']}",
        f"-MediaModifyDate={meta['utc_modify']}",
        "-XMP:all=", "-Encoder=",
        str(out_path),
    ]
    run(cmd)


_QT_CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"udta", b"edts"}


def _qt_walk(buf, start, end, target, out):
    i = start
    while i + 8 <= end:
        size = int.from_bytes(buf[i:i + 4], "big")
        typ = bytes(buf[i + 4:i + 8])
        hdr = 8
        if size == 1:
            size = int.from_bytes(buf[i + 8:i + 16], "big"); hdr = 16
        elif size == 0:
            size = end - i
        if size < hdr or i + size > end:
            break
        if typ == target:
            out.append((i, size, hdr))
        if typ in _QT_CONTAINERS or typ == b"stsd":
            child = i + hdr + (8 if typ == b"stsd" else 0)
            _qt_walk(buf, child, i + size, target, out)
        i += size


def apple_container_patch(path):
    """In-place (same-length, no atom resize → chunk offsets stay valid) patch of the
    container fields ffmpeg can't emit, to exact Apple values: ftyp minor_version=0,
    vmhd graphicsmode=ditherCopy + opcolor=0x8000, avc1 CompressorName='H.264'."""
    try:
        with open(path, "rb") as f:
            buf = bytearray(f.read())
    except OSError:
        return
    ft = []
    _qt_walk(buf, 0, len(buf), b"ftyp", ft)
    if ft:
        mv = ft[0][0] + ft[0][2] + 4
        buf[mv:mv + 4] = b"\x00\x00\x00\x00"
    vm = []
    _qt_walk(buf, 0, len(buf), b"vmhd", vm)
    for off, _, hdr in vm:
        p = off + hdr + 4
        buf[p:p + 8] = b"\x00\x40" + b"\x80\x00" * 3
    av = []
    _qt_walk(buf, 0, len(buf), b"avc1", av)
    for off, _, _ in av:
        cn = off + 8 + 42
        buf[cn:cn + 32] = bytes([5]) + b"H.264" + b"\x00" * 26
    with open(path, "wb") as f:
        f.write(buf)


def apply_overlay(main_path, overlay_path, out_path, width, height, position, opacity, split_ratio):
    """Composite an overlay clip onto the main video (vstack/hstack/PiP).

    Runs BEFORE template+spoof, mirroring the server pipeline. The overlay clip
    is looped to cover the full main-video duration.
    """
    import math

    opacity = max(0, min(100, int(opacity)))
    split_ratio = max(30, min(70, int(split_ratio)))
    main_ratio = split_ratio / 100.0
    opacity_f = opacity / 100.0
    if position not in OVERLAY_POSITIONS:
        position = "main-top"

    NORM = ",fps=30,setsar=1,format=yuv420p"
    NORM_ALPHA = ",fps=30,setsar=1,format=yuva420p"

    if position in ("main-top", "main-bottom"):
        main_h = math.floor(height * main_ratio / 2) * 2
        overlay_h = height - main_h
        parts = [
            f"[0:v]scale={width}:{main_h}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{main_h}:(ow-iw)/2:(oh-ih)/2:color=black{NORM}[main]",
            f"[1:v]scale={width}:{overlay_h}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{overlay_h}:(ow-iw)/2:(oh-ih)/2:color=black{NORM}[overlay_raw]",
        ]
        if opacity < 100:
            # Infinite black canvas (no :d=1) so opacity blend keeps the clip's
            # full looped length instead of truncating the stack to 1 second.
            parts += [
                f"color=black:s={width}x{overlay_h}{NORM}[ov_bg]",
                f"[overlay_raw]format=yuva420p,colorchannelmixer=aa={opacity_f}[ov_alpha]",
                f"[ov_bg][ov_alpha]overlay=0:0:shortest=1:format=auto,format=yuv420p[overlay]",
            ]
        else:
            parts.append("[overlay_raw]null[overlay]")
        parts.append(
            "[main][overlay]vstack=inputs=2[out]" if position == "main-top"
            else "[overlay][main]vstack=inputs=2[out]"
        )
    elif position in ("main-left", "main-right"):
        main_w = math.floor(width * main_ratio / 2) * 2
        overlay_w = width - main_w
        parts = [
            f"[0:v]scale={main_w}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={main_w}:{height}:(ow-iw)/2:(oh-ih)/2:color=black{NORM}[main]",
            f"[1:v]scale={overlay_w}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={overlay_w}:{height}:(ow-iw)/2:(oh-ih)/2:color=black{NORM}[overlay_raw]",
        ]
        if opacity < 100:
            parts += [
                f"color=black:s={overlay_w}x{height}{NORM}[ov_bg]",
                f"[overlay_raw]format=yuva420p,colorchannelmixer=aa={opacity_f}[ov_alpha]",
                f"[ov_bg][ov_alpha]overlay=0:0:shortest=1:format=auto,format=yuv420p[overlay]",
            ]
        else:
            parts.append("[overlay_raw]null[overlay]")
        parts.append(
            "[main][overlay]hstack=inputs=2[out]" if position == "main-left"
            else "[overlay][main]hstack=inputs=2[out]"
        )
    else:  # pip-br | pip-bl
        pip_w = math.floor(width * 0.25 / 2) * 2
        pip_h = math.floor(height * 0.25 / 2) * 2
        pad = 20
        x_expr = f"W-w-{pad}" if position == "pip-br" else str(pad)
        y_expr = f"H-h-{pad}"
        parts = [
            f"[0:v]scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black{NORM}[main]",
            f"[1:v]scale={pip_w}:{pip_h}:force_original_aspect_ratio=decrease{NORM_ALPHA}[pip_raw]",
        ]
        parts.append(f"[pip_raw]colorchannelmixer=aa={opacity_f}[pip]" if opacity < 100 else "[pip_raw]null[pip]")
        parts.append(f"[main][pip]overlay={x_expr}:{y_expr}:shortest=1:format=auto[out]")

    cmd = [
        "ffmpeg", "-y", "-i", str(main_path),
        "-stream_loop", "-1", "-i", str(overlay_path),
        "-filter_complex", ";".join(parts),
        "-map", "[out]", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-movflags", "+faststart", "-shortest",
        str(out_path),
    ]
    code, err = run(cmd)
    if code != 0:
        print(f"    overlay ffmpeg failed: {err[-400:]}")
        return False
    return True


def process_video_sync(src, out_path, caption, cfg):
    """Synchronous Spoofer video pipeline (ported from templater.process_video).
    Caption PNG overlay (color emoji) + bitexact encode + iPhone container/metadata.
    Invoked via asyncio.to_thread from apply_template_and_poof."""
    width, height = cfg["outputWidth"], cfg["outputHeight"]
    font_size, max_chars, header_height = cfg["fontSize"], cfg["maxCharsPerLine"], cfg["headerHeight"]
    apply_template, poof = cfg["applyTemplate"], cfg["applyPoof"]
    fontfile = ffmpeg_escape_fontfile(cfg["fontFile"])

    lines = textwrap.wrap(caption, width=max_chars) if caption else []
    padding = 20
    tsz = cfg.get("topSafeZone", 0)          # white space above caption (clears IG's top UI)
    vtop = tsz + header_height               # where the video starts
    video_w = width - (padding * 2)
    video_h = height - vtop - padding
    fps = video_fps(src)

    speed = round(random.uniform(0.98, 1.02), 3) if poof else 1.0
    brightness = round(random.uniform(-0.02, 0.02), 3) if poof else 0
    contrast = round(random.uniform(0.98, 1.02), 3) if poof else 1.0
    saturation = round(random.uniform(0.97, 1.03), 3) if poof else 1.0
    hue = round(random.uniform(-3, 3), 1) if poof else 0
    gamma = round(random.uniform(0.97, 1.03), 3) if poof else 1.0
    zoom = round(random.uniform(1.005, 1.015), 4) if poof else 1.0
    audio_pitch = round(random.uniform(0.97, 1.03), 3) if poof else 1.0
    noise_s = random.randint(1, 2) if poof else 0   # subtle grain — breaks hashes, ~invisible
    crf = random.randint(18, 20) if poof else 18      # near visually-lossless re-encode

    parts = [
        f"[0:v]setpts={1 / speed}*PTS[speed]",
        f"[speed]eq=brightness={brightness}:contrast={contrast}:saturation={saturation}:gamma={gamma},hue=h={hue}[color]",
        f"[color]scale=iw*{zoom}:ih*{zoom}:flags=lanczos,crop=iw/{zoom}:ih/{zoom}[zoomed]",
    ]
    scaled_in = "zoomed"
    if noise_s > 0:
        parts.append(f"[zoomed]noise=c0s={noise_s}:allf=t[noisy]")
        scaled_in = "noisy"

    cap_png = None
    if apply_template and caption and lines:
        parts += [
            f"[{scaled_in}]scale={video_w}:{video_h}:force_original_aspect_ratio=decrease:flags=lanczos[scaled]",
            f"color=c=white:s={width}x{height}:r={fps}[bg]",
            f"[bg][scaled]overlay=x={padding}+(({video_w}-overlay_w)/2):y={vtop}+(({video_h}-overlay_h)/2):shortest=1[canvas]",
        ]
        cap_png = Path(out_path).with_suffix(".cap.png")
        if render_caption_png(caption, width, header_height, font_size,
                              cfg["fontFile"], cfg.get("emojiFont", EMOJI_FONT_DEFAULT), str(cap_png)):
            # Overlay the rendered text+emoji PNG (color emoji that drawtext can't do),
            # placed just below the IG top-UI safe zone. eof_action=repeat holds the
            # single caption frame across the whole clip (no -loop 1 hang).
            parts.append(f"[canvas][1:v]overlay=0:{tsz}:format=auto:eof_action=repeat[out]")
        else:
            cap_png = None  # PIL unavailable -> fall back to monochrome drawtext
            line_height = font_size + 12
            start_y = max(10, (header_height - len(lines) * line_height) // 2)
            prev = "canvas"
            for i, line in enumerate(lines):
                y = start_y + (i * line_height)
                nxt = f"txt{i}" if i < len(lines) - 1 else "out"
                parts.append(
                    f"[{prev}]drawtext=fontfile='{fontfile}':text='{escape_drawtext(line)}':"
                    f"fontsize={font_size}:fontcolor=black:x=(w-text_w)/2:y={y}[{nxt}]"
                )
                prev = nxt
    elif apply_template:
        parts.append(f"[{scaled_in}]scale={video_w}:{video_h}:force_original_aspect_ratio=decrease:flags=lanczos[scaled]")
        parts.append(f"color=c=white:s={width}x{height}:r={fps}[bg]")
        parts.append(
            f"[bg][scaled]overlay=x={padding}+(({video_w}-overlay_w)/2):y={vtop}+(({video_h}-overlay_h)/2):shortest=1[out]"
        )
    else:
        parts.append(f"[{scaled_in}]null[out]")

    meta = build_iphone_meta()
    audio_present = has_audio(src)

    cmd = ["ffmpeg", "-y", "-i", str(src)]
    if cap_png:
        cmd += ["-i", str(cap_png)]  # caption PNG = input [1:v] (single frame, repeated by overlay)
    cmd += ["-filter_complex", ";".join(parts)]
    # filter_units=remove_types=6 strips ALL H.264 SEI — kills the "x264 - core NNN"
    # encoder signature in the bitstream (the #1 tell it isn't from a phone).
    # +bitexact + empty encoder tag remove ffmpeg's "Lavc/libx264" library strings.
    # Core Media handler names match a real iPhone's track handlers.
    cmd += ["-bsf:v", "filter_units=remove_types=6", "-fflags", "+bitexact", "-flags:v", "+bitexact"]
    if audio_present:
        # Resample to 48k FIRST so the pitch shift is sample-rate-independent
        # (a 44.1k source read as 48k would speed up ~8% and -shortest would
        # truncate the video). asetrate shifts pitch; atempo=speed/pitch then
        # makes audio duration match the video's setpts speed exactly.
        cmd += [
            "-af", f"aresample=48000,asetrate=48000*{audio_pitch},aresample=48000,atempo={round(speed / audio_pitch, 4)}",
            "-map", "[out]", "-map", "0:a?",
            "-metadata:s:a:0", "handler_name=Core Media Audio", "-metadata:s:a:0", "encoder=",
        ]
    else:
        # No audio stream: applying -af + -shortest makes ffmpeg wait forever on
        # an audio EOF that never comes (the hang). Drop audio entirely.
        cmd += ["-map", "[out]", "-an"]
    cmd += [
        "-map_metadata", "-1",
        "-c:v", "libx264", "-profile:v", "high", "-level", "4.2",
        "-preset", "fast", "-crf", str(crf),
        "-video_track_timescale", "600",  # Apple uses timescale 600 (ffmpeg defaults to 15360)
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        "-metadata:s:v:0", "handler_name=Core Media Video", "-metadata:s:v:0", "encoder=",
    ]
    if audio_present:
        cmd += ["-c:a", "aac", "-profile:a", "aac_low", "-b:a", "192k", "-ar", "48000"]
    cmd += ["-movflags", "+faststart", "-shortest", str(out_path)]  # .mov output -> qt brand
    code, err = run(cmd)
    if cap_png and Path(cap_png).exists():
        Path(cap_png).unlink(missing_ok=True)
    if code != 0:
        print(f"[Templater] Video ffmpeg failed: {err[-500:]}")
        return False
    if poof:
        spoof_metadata_video(out_path, meta)
    apple_container_patch(out_path)  # byte-match Apple muxer fields (minor/vmhd/avc1 name)
    return True


def process_image_sync(src, out_path, caption, cfg):
    """Synchronous Spoofer image pipeline (ported from templater.process_image).
    Caption PNG overlay (color emoji) + full iPhone EXIF rewrite.
    Invoked via asyncio.to_thread from apply_template_and_poof_image."""
    width, height = cfg["outputWidth"], cfg["outputHeight"]
    font_size, max_chars, header_height = cfg["fontSize"], cfg["maxCharsPerLine"], cfg["headerHeight"]
    apply_template, poof = cfg["applyTemplate"], cfg["applyPoof"]
    fontfile = ffmpeg_escape_fontfile(cfg["fontFile"])

    lines = textwrap.wrap(caption, width=max_chars) if caption else []
    padding = 20
    tsz = cfg.get("topSafeZone", 0)
    vtop = tsz + header_height
    image_w = width - (padding * 2)
    image_h = height - vtop - padding

    brightness = round(random.uniform(-0.02, 0.02), 3) if poof else 0
    contrast = round(random.uniform(0.98, 1.02), 3) if poof else 1.0
    saturation = round(random.uniform(0.97, 1.03), 3) if poof else 1.0
    hue = round(random.uniform(-2.5, 2.5), 1) if poof else 0
    gamma = round(random.uniform(0.97, 1.03), 3) if poof else 1.0
    zoom = round(random.uniform(1.002, 1.012), 4) if poof else 1.0
    noise_s = random.randint(1, 2) if poof else 0   # subtle grain for images too

    parts = [
        f"[0:v]eq=brightness={brightness}:contrast={contrast}:saturation={saturation}:gamma={gamma},hue=h={hue}[color]",
        f"[color]scale=iw*{zoom}:ih*{zoom}:flags=lanczos,crop=iw/{zoom}:ih/{zoom}[zoomed]",
    ]
    scaled_in = "zoomed"
    if noise_s > 0:
        parts.append(f"[zoomed]noise=c0s={noise_s}:allf=t[noisy]")
        scaled_in = "noisy"

    cap_png = None
    if apply_template and caption and lines:
        parts += [
            f"[{scaled_in}]scale={image_w}:{image_h}:force_original_aspect_ratio=decrease:flags=lanczos[scaled]",
            f"color=c=white:s={width}x{height}:d=1[bg]",
            f"[bg][scaled]overlay=x={padding}+(({image_w}-overlay_w)/2):y={vtop}+(({image_h}-overlay_h)/2):shortest=1[canvas]",
        ]
        cap_png = Path(out_path).with_suffix(".cap.png")
        if render_caption_png(caption, width, header_height, font_size,
                              cfg["fontFile"], cfg.get("emojiFont", EMOJI_FONT_DEFAULT), str(cap_png)):
            parts.append(f"[canvas][1:v]overlay=0:{tsz}:format=auto[out]")
        else:
            cap_png = None
            line_height = font_size + 12
            start_y = max(10, (header_height - len(lines) * line_height) // 2)
            prev = "canvas"
            for i, line in enumerate(lines):
                y = start_y + (i * line_height)
                nxt = f"txt{i}" if i < len(lines) - 1 else "out"
                parts.append(
                    f"[{prev}]drawtext=fontfile='{fontfile}':text='{escape_drawtext(line)}':"
                    f"fontsize={font_size}:fontcolor=black:x=(w-text_w)/2:y={y}[{nxt}]"
                )
                prev = nxt
    elif apply_template:
        parts.append(f"[{scaled_in}]scale={image_w}:{image_h}:force_original_aspect_ratio=decrease:flags=lanczos[scaled]")
        parts.append(f"color=c=white:s={width}x{height}:d=1[bg]")
        parts.append(
            f"[bg][scaled]overlay=x={padding}+(({image_w}-overlay_w)/2):y={vtop}+(({image_h}-overlay_h)/2):shortest=1[out]"
        )
    else:
        parts.append(f"[{scaled_in}]null[out]")

    cmd = ["ffmpeg", "-y", "-i", str(src)]
    if cap_png:
        cmd += ["-i", str(cap_png)]  # caption PNG = input [1:v]
    cmd += [
        "-filter_complex", ";".join(parts),
        "-map", "[out]", "-frames:v", "1", "-map_metadata", "-1", "-q:v", "2",
        str(out_path),
    ]
    code, err = run(cmd)
    if cap_png and Path(cap_png).exists():
        Path(cap_png).unlink(missing_ok=True)
    if code != 0:
        print(f"[Templater] Image ffmpeg failed: {err[-500:]}")
        return False

    if poof:
        m = build_iphone_meta()
        lat_ref = "N" if m["lat"] >= 0 else "S"
        lon_ref = "E" if m["lon"] >= 0 else "W"
        subsec = f"{random.randint(100, 999)}"
        # Match a real iPhone photo's EXIF exactly (Software is the bare version,
        # full LensModel/LensInfo, OffsetTime with TZ, GPS with refs, sRGB).
        run([
            "exiftool", "-overwrite_original", "-q", "-all=",
            f"-DateTimeOriginal={m['local_naive']}", f"-CreateDate={m['local_naive']}",
            f"-ModifyDate={m['local_naive']}",
            f"-OffsetTime={m['offset']}", f"-OffsetTimeOriginal={m['offset']}",
            f"-OffsetTimeDigitized={m['offset']}", f"-SubSecTimeOriginal={subsec}",
            "-Make=Apple", f"-Model={m['device']}", f"-Software={m['software']}",
            "-LensMake=Apple", f"-LensModel={m['lens']}",
            "-LensInfo=6.764999866-15.65999985mm f/1.779999971-2.8",
            "-Orientation#=1", "-ColorSpace=sRGB", "-ExifIFD:ColorSpace=sRGB",
            f"-GPSLatitude={abs(m['lat']):.6f}", f"-GPSLatitudeRef={lat_ref}",
            f"-GPSLongitude={abs(m['lon']):.6f}", f"-GPSLongitudeRef={lon_ref}",
            f"-GPSAltitude={m['alt']}", "-GPSAltitudeRef=0",
            str(out_path),
        ])
    return True


def _build_template_cfg(width, height, font_size, max_chars, header_height, apply_template, poof):
    """Map the deployed API's positional template args onto the flat Spoofer cfg dict.
    Linux font paths come from the Dockerfile apt packages; topSafeZone matches
    Spoofer config.json (the frontend never sends it)."""
    return {
        "outputWidth": width,
        "outputHeight": height,
        "fontSize": font_size,
        "maxCharsPerLine": max_chars,
        "headerHeight": header_height,
        "applyTemplate": apply_template,
        "applyPoof": poof,
        "topSafeZone": 250,
        "fontFile": "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "emojiFont": "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
    }

# ---- end Spoofer templater engine ----


async def process_template_job(
    job_id: str,
    file_paths: list,
    caption_text: str,
    caption_texts: list,
    caption_mode: str,
    apply_template: bool,
    apply_poof: bool,
    font_size: int,
    max_chars_per_line: int,
    header_height: int,
    user_id: str,
    overlay_enabled: bool = False,
    overlay_position: str = "main-top",
    overlay_opacity: int = 50,
    overlay_split_ratio: int = 50,
    overlay_mode: str = "sequential",
    overlay_paths: Optional[list] = None,
):
    """Background task: process uploaded videos with FFmpeg template, spoofing, and optional overlays."""
    import random as rng
    import textwrap

    job_dir = TEMPLATE_TEMP_DIR / job_id
    out_dir = job_dir / "output"
    out_dir.mkdir(parents=True, exist_ok=True)
    overlay_paths = overlay_paths or []

    total = len(file_paths)
    processed = 0
    output_urls = []

    allowed_positions = {
        "main-top",
        "main-bottom",
        "main-left",
        "main-right",
        "pip-br",
        "pip-bl",
    }
    if overlay_position not in allowed_positions:
        overlay_position = "main-top"
    if overlay_mode not in {"sequential", "random"}:
        overlay_mode = "sequential"
    overlay_opacity = max(10, min(100, int(overlay_opacity)))
    overlay_split_ratio = max(30, min(70, int(overlay_split_ratio)))
    us_city_coords = [
        (34.0522, -118.2437),  # Los Angeles, CA
        (40.7128, -74.0060),   # New York, NY
        (41.8781, -87.6298),   # Chicago, IL
        (29.7604, -95.3698),   # Houston, TX
        (33.4484, -112.0740),  # Phoenix, AZ
        (32.7767, -96.7970),   # Dallas, TX
        (37.7749, -122.4194),  # San Francisco, CA
        (47.6062, -122.3321),  # Seattle, WA
        (25.7617, -80.1918),   # Miami, FL
        (33.7490, -84.3880),   # Atlanta, GA
        (36.1699, -115.1398),  # Las Vegas, NV
    ]

    def pick_us_city_gps() -> tuple[float, float]:
        base_lat, base_lon = rng.choice(us_city_coords)
        return base_lat + rng.uniform(-0.01, 0.01), base_lon + rng.uniform(-0.01, 0.01)

    scraper_jobs[job_id]["status"] = "processing"
    scraper_jobs[job_id]["logs"] = f"Processing {total} files...\n"

    for i, input_path in enumerate(file_paths):
        try:
            input_file = Path(input_path)
            out_file = out_dir / f"templated_{i + 1}_{uuid.uuid4().hex[:8]}.mp4"

            # Pick caption per video
            selected_caption = ""
            valid_captions = [
                str(c).strip() for c in (caption_texts or []) if str(c).strip()
            ]
            if apply_template:
                if valid_captions:
                    if caption_mode == "random":
                        selected_caption = rng.choice(valid_captions)
                    elif caption_mode == "sequential":
                        selected_caption = valid_captions[i % len(valid_captions)]
                    else:
                        selected_caption = valid_captions[0]
                else:
                    selected_caption = caption_text or ""

            input_ext = input_file.suffix.lower()
            is_image = input_ext in TEMPLATE_IMAGE_EXTS
            if is_image:
                out_file = out_dir / f"templated_{i + 1}_{uuid.uuid4().hex[:8]}.jpg"
                # Spoofer engine: emoji-aware caption PNG + iPhone EXIF + sRGB.
                cfg = _build_template_cfg(
                    1080, 1920, font_size, max_chars_per_line, header_height,
                    apply_template, apply_poof,
                )
                scraper_jobs[job_id]["logs"] += (
                    f"[{i + 1}/{total}] Processing image {input_file.name} (Spoofer engine)...\n"
                )
                if overlay_enabled and overlay_paths:
                    scraper_jobs[job_id]["logs"] += (
                        f"[{i + 1}/{total}] Overlay skipped for image input\n"
                    )
                ok = await asyncio.to_thread(
                    process_image_sync,
                    str(input_file),
                    str(out_file),
                    selected_caption,
                    cfg,
                )
                if not ok:
                    scraper_jobs[job_id]["logs"] += (
                        f"[{i + 1}/{total}] Image processing failed\n"
                    )
                    continue
                if get_supabase() and out_file.exists():
                    storage_path = f"templates/{user_id}/{job_id}/{out_file.name}"
                    try:
                        with open(out_file, "rb") as f:
                            get_supabase().storage.from_("content").upload(
                                storage_path, f.read(), {"content-type": "image/jpeg"}
                            )
                        public_url = (
                            get_supabase()
                            .storage.from_("content")
                            .get_public_url(storage_path)
                        )
                        output_urls.append(public_url)
                        scraper_jobs[job_id]["logs"] += (
                            f"[{i + 1}/{total}] Uploaded ✓\n"
                        )
                    except Exception as upload_err:
                        scraper_jobs[job_id]["logs"] += (
                            f"[{i + 1}/{total}] Upload failed: {str(upload_err)[:100]}\n"
                        )
                else:
                    scraper_jobs[job_id]["logs"] += (
                        f"[{i + 1}/{total}] Processed (no storage configured)\n"
                    )

                processed += 1
                scraper_jobs[job_id]["downloadedVideos"] = processed
                scraper_jobs[job_id]["progress"] = int((processed / total) * 100)
                continue

            # Pick overlay clip per video
            selected_overlay = None
            if overlay_enabled and overlay_paths:
                if overlay_mode == "random":
                    selected_overlay = rng.choice(overlay_paths)
                else:
                    selected_overlay = overlay_paths[i % len(overlay_paths)]

            # === Spoofer engine: caption frame + iPhone metadata + Apple container ===
            out_file = out_dir / f"templated_{i + 1}_{uuid.uuid4().hex[:8]}.mov"
            cfg = _build_template_cfg(
                1080, 1920, font_size, max_chars_per_line, header_height,
                apply_template, apply_poof,
            )
            scraper_jobs[job_id]["logs"] += (
                f"[{i + 1}/{total}] Processing {input_file.name} (Spoofer engine)...\n"
            )

            # Faithful to the Spoofer pipeline: composite the overlay FIRST, then run
            # the spoof engine on the result, so the caption + iPhone metadata + Apple
            # QuickTime container land on the FINAL composited video (no post-spoof
            # re-encode that would strip the authentic qt container + bitexact).
            video_src = str(input_file)
            if selected_overlay:
                tmp_overlay = out_dir / f"ov_{i + 1}_{uuid.uuid4().hex[:8]}.mp4"
                scraper_jobs[job_id]["logs"] += (
                    f"[{i + 1}/{total}] Overlay <- {Path(selected_overlay).name} ({overlay_position})\n"
                )
                ov_ok = await asyncio.to_thread(
                    apply_overlay, str(input_file), str(selected_overlay), str(tmp_overlay),
                    1080, 1920, overlay_position, overlay_opacity, overlay_split_ratio,
                )
                if ov_ok:
                    video_src = str(tmp_overlay)
                else:
                    scraper_jobs[job_id]["logs"] += (
                        f"[{i + 1}/{total}] Overlay failed, continuing without it\n"
                    )
            ok = await asyncio.to_thread(
                process_video_sync, video_src, str(out_file), selected_caption, cfg
            )
            if not ok:
                scraper_jobs[job_id]["logs"] += (
                    f"[{i + 1}/{total}] Spoofer engine failed\n"
                )
                continue

            # Upload to Supabase Storage
            if get_supabase() and out_file.exists():
                storage_path = f"templates/{user_id}/{job_id}/{out_file.name}"
                try:
                    with open(out_file, "rb") as f:
                        get_supabase().storage.from_("content").upload(
                            storage_path, f.read(), {"content-type": "video/quicktime"}
                        )
                    public_url = (
                        get_supabase()
                        .storage.from_("content")
                        .get_public_url(storage_path)
                    )
                    output_urls.append(public_url)
                    scraper_jobs[job_id]["logs"] += f"[{i + 1}/{total}] Uploaded ✓\n"
                except Exception as upload_err:
                    scraper_jobs[job_id]["logs"] += (
                        f"[{i + 1}/{total}] Upload failed: {str(upload_err)[:100]}\n"
                    )
            else:
                scraper_jobs[job_id]["logs"] += (
                    f"[{i + 1}/{total}] Processed (no storage configured)\n"
                )

            processed += 1
            scraper_jobs[job_id]["downloadedVideos"] = processed
            scraper_jobs[job_id]["progress"] = int((processed / total) * 100)

        except Exception as e:
            scraper_jobs[job_id]["logs"] += f"[{i + 1}/{total}] Error: {str(e)[:100]}\n"

    # Cleanup temp files
    try:
        shutil.rmtree(job_dir, ignore_errors=True)
    except Exception:
        pass

    scraper_jobs[job_id]["status"] = "complete" if processed > 0 else "error"
    scraper_jobs[job_id]["progress"] = 100
    scraper_jobs[job_id]["files"] = output_urls
    if processed == 0:
        scraper_jobs[job_id]["error"] = "No files were processed successfully"
    scraper_jobs[job_id]["logs"] += f"\nDone: {processed}/{total} files processed\n"


class TemplateApplyRequest(BaseModel):
    model_config = {"extra": "forbid"}
    userId: str = Field(min_length=1, max_length=128)
    sourceJobId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    videoUrls: List[str] = Field(default_factory=list, max_length=20)
    captionText: str = Field(default="", max_length=4000)
    captionTexts: List[str] = Field(default_factory=list, max_length=50)
    captionMode: str = Field(default="single", pattern=r"^(single|sequential|random)$")
    applyTemplate: bool = True
    applyPoof: bool = True
    fontSize: int = Field(default=42, ge=20, le=120)
    maxCharsPerLine: int = Field(default=40, ge=10, le=120)
    headerHeight: int = Field(default=160, ge=60, le=600)


def is_allowed_template_source_url(value):
    from urllib.parse import urlsplit

    if not isinstance(value, str) or len(value) > 8192 or any(ord(char) < 32 for char in value):
        return False
    try:
        parsed = urlsplit(value)
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
            return False
        host = parsed.hostname or ""
        storage_host = urlsplit(SUPABASE_URL or "").hostname
        if storage_host and host == storage_host:
            return True
        cdn_domains = ("cdninstagram.com", "fbcdn.net", "tiktokcdn.com", "tiktokcdn-us.com", "tiktokv.com", "ibyteimg.com", "googlevideo.com")
        return any(host == domain or host.endswith("." + domain) for domain in cdn_domains)
    except ValueError:
        return False


async def process_template_source_job(job_id: str, source_urls: list, request: TemplateApplyRequest):
    job_dir = TEMPLATE_TEMP_DIR / job_id
    job = scraper_jobs[job_id]
    try:
        job_dir.mkdir(parents=True, exist_ok=True)
        job["status"] = "downloading"
        job["logs"] = "Downloading source job media...\n"
        paths = []
        total_bytes = 0
        media_types = {
            "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm",
            "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
        }
        async with httpx.AsyncClient(timeout=60, follow_redirects=False) as client:
            for index, url in enumerate(source_urls):
                if not is_allowed_template_source_url(url):
                    raise ValueError("Unsupported source URL")
                async with client.stream("GET", url) as response:
                    if response.status_code != 200:
                        raise ValueError("Source media download failed")
                    content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
                    extension = media_types.get(content_type)
                    if not extension:
                        raise ValueError("Source is not a supported media file")
                    if int(response.headers.get("content-length", "0")) > 50_000_000:
                        raise ValueError("Source media exceeds download limit")
                    path = job_dir / f"source_{index}{extension}"
                    size = 0
                    with open(path, "wb") as output:
                        async for chunk in response.aiter_bytes():
                            size += len(chunk)
                            total_bytes += len(chunk)
                            if size > 50_000_000 or total_bytes > 200_000_000:
                                raise ValueError("Source media exceeds download limit")
                            output.write(chunk)
                    if size == 0:
                        raise ValueError("Source media is empty")
                    paths.append(str(path))
        await process_template_job(
            job_id, paths, request.captionText, request.captionTexts, request.captionMode,
            request.applyTemplate, request.applyPoof, request.fontSize,
            request.maxCharsPerLine, request.headerHeight, request.userId,
        )
    except Exception:
        job["status"] = "error"
        job["error"] = "Could not prepare source media. Verify the source job files and try again."
        job["logs"] += "Source media preparation failed.\n"
        shutil.rmtree(job_dir, ignore_errors=True)


@app.post("/template/apply")
async def template_apply(
    request: TemplateApplyRequest,
    background_tasks: BackgroundTasks,
    authorization: str = Header(None),
    x_user_id: str = Header(None),
):
    user_id = require_content_user(authorization, x_user_id, request.userId)
    source_job = get_owned_content_job(request.sourceJobId, user_id)
    if source_job.get("status") != "complete":
        raise HTTPException(status_code=409, detail="Source job is not complete")
    source_files = source_job.get("files") or []
    selected = request.videoUrls or source_files
    if not selected or len(selected) > 20 or any(url not in source_files or not is_allowed_template_source_url(url) for url in selected):
        raise HTTPException(status_code=400, detail="Select up to 20 supported files from the source job")
    quota = await check_scrape_quota(user_id)
    if not quota.get("can_scrape", False):
        raise HTTPException(status_code=429, detail="Content quota exceeded")
    job_id = str(uuid.uuid4())
    scraper_jobs[job_id] = {
        "jobId": job_id, "userId": user_id, "sourceJobId": request.sourceJobId,
        "platform": "template", "status": "queued", "progress": 0,
        "totalVideos": len(selected), "downloadedVideos": 0, "files": [],
        "downloadUrl": None, "error": None, "logs": "Source media queued for processing...\n",
    }
    background_tasks.add_task(process_template_source_job, job_id, list(selected), request)
    return {"jobId": job_id, "status": "queued"}


@app.post("/template/upload")
async def template_upload(
    background_tasks: BackgroundTasks,
    files: List[UploadFile] = File(...),
    overlayClips: List[UploadFile] = File([]),
    userId: str = Form("anonymous"),
    captionText: str = Form(""),
    captionTexts: str = Form("[]"),
    captionMode: str = Form("single"),
    applyTemplate: str = Form("true"),
    applyPoof: str = Form("true"),
    overlayEnabled: str = Form("false"),
    overlayPosition: str = Form("main-top"),
    overlayOpacity: str = Form("50"),
    overlaySplitRatio: str = Form("50"),
    overlayMode: str = Form("sequential"),
    fontSize: str = Form("42"),
    maxCharsPerLine: str = Form("40"),
    headerHeight: str = Form("160"),
    authorization: str = Header(None),
    x_user_id: str = Header(None),
):
    """Upload media files for template processing (white frame + caption + fingerprint spoofing)."""
    user_id = require_content_user(authorization, x_user_id, userId)

    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")

    job_id = str(uuid.uuid4())
    job_dir = TEMPLATE_TEMP_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    overlay_dir = job_dir / "overlay"
    overlay_dir.mkdir(parents=True, exist_ok=True)

    def parse_bool(value: str, default: bool = False) -> bool:
        if value is None:
            return default
        return str(value).strip().lower() in {"1", "true", "yes", "on"}

    def parse_int(value: str, default: int, low: int, high: int) -> int:
        try:
            return max(low, min(high, int(value)))
        except Exception:
            return default

    try:
        parsed_caption_texts = json.loads(captionTexts) if captionTexts else []
        if not isinstance(parsed_caption_texts, list):
            parsed_caption_texts = []
    except Exception:
        parsed_caption_texts = []
    parsed_caption_texts = [
        str(c).strip() for c in parsed_caption_texts if str(c).strip()
    ]
    caption_mode = (
        captionMode if captionMode in {"single", "sequential", "random"} else "single"
    )
    overlay_enabled = parse_bool(overlayEnabled, False)
    overlay_mode = (
        overlayMode if overlayMode in {"sequential", "random"} else "sequential"
    )
    overlay_opacity = parse_int(overlayOpacity, 50, 10, 100)
    overlay_split_ratio = parse_int(overlaySplitRatio, 50, 30, 70)
    safe_font_size = parse_int(fontSize, 42, 20, 120)
    safe_max_chars = parse_int(maxCharsPerLine, 40, 10, 120)
    safe_header_height = parse_int(headerHeight, 160, 60, 600)

    # Save uploaded files to temp directory
    saved_paths = []
    for f in files:
        source_name = f.filename or f"upload_{len(saved_paths)}.bin"
        source_ext = Path(source_name).suffix.lower()
        if source_ext not in (TEMPLATE_VIDEO_EXTS | TEMPLATE_IMAGE_EXTS):
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file type: {source_ext}",
            )
        file_path = job_dir / f"input_{len(saved_paths)}_{uuid.uuid4().hex[:8]}{source_ext}"
        content = await f.read()
        with open(file_path, "wb") as out:
            out.write(content)
        saved_paths.append(str(file_path))

    # Save optional overlay clips
    overlay_paths = []
    if overlay_enabled and overlayClips:
        for idx, clip in enumerate(overlayClips):
            clip_name = clip.filename or f"overlay_{idx + 1}.mp4"
            clip_ext = Path(clip_name).suffix.lower()
            if clip_ext not in TEMPLATE_VIDEO_EXTS:
                raise HTTPException(
                    status_code=400,
                    detail=f"Overlay clip must be a video file, got: {clip_ext}",
                )
            clip_path = overlay_dir / f"overlay_{idx + 1}_{uuid.uuid4().hex[:8]}{clip_ext}"
            clip_content = await clip.read()
            if not clip_content:
                continue
            with open(clip_path, "wb") as out:
                out.write(clip_content)
            overlay_paths.append(str(clip_path))

    # Create job entry
    scraper_jobs[job_id] = {
        "jobId": job_id,
        "userId": user_id,
        "platform": "template",
        "status": "queued",
        "progress": 0,
        "totalVideos": len(saved_paths),
        "downloadedVideos": 0,
        "files": [],
        "downloadUrl": None,
        "error": None,
        "logs": (
            f"Uploaded {len(saved_paths)} files, queued for processing...\n"
            f"Template={'on' if parse_bool(applyTemplate, True) else 'off'}, "
            f"Poof={'on' if parse_bool(applyPoof, True) else 'off'}, "
            f"Overlay={'on' if (overlay_enabled and len(overlay_paths) > 0) else 'off'}\n"
        ),
    }

    # Process in background
    background_tasks.add_task(
        process_template_job,
        job_id,
        saved_paths,
        captionText,
        parsed_caption_texts,
        caption_mode,
        parse_bool(applyTemplate, True),
        parse_bool(applyPoof, True),
        safe_font_size,
        safe_max_chars,
        safe_header_height,
        userId,
        overlay_enabled and len(overlay_paths) > 0,
        overlayPosition,
        overlay_opacity,
        overlay_split_ratio,
        overlay_mode,
        overlay_paths,
    )

    return {"jobId": job_id, "status": "queued"}


@app.get("/job/{job_id}")
async def get_scrape_job_status(job_id: str, authorization: str = Header(None), x_user_id: str = Header(None)):
    """Get status of a scrape job"""
    user_id = require_content_user(authorization, x_user_id)
    return get_owned_content_job(job_id, user_id)


# ==================== AI ASSISTANT (GROQ) ====================

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")

# System prompt for the ShadowPhone AI Assistant
SHADOWPHONE_SYSTEM_PROMPT = """You are **AI Manager** - the expert assistant for Instagram automation and phone farm management.

## ⚠️ CRITICAL: DATA-ONLY RESPONSES
**YOU MUST ONLY USE THE ACTUAL DATA PROVIDED IN THE "USER'S CURRENT DASHBOARD DATA" SECTION BELOW.**
- If the data shows 0 phones connected, say "You have no phones connected."
- If the data shows "⚠️ No phones connected", tell the user they need to connect phones.
- NEVER assume, guess, or hallucinate information. ONLY use the exact numbers and data provided.
- If data is missing or shows warnings, TELL THE USER about these issues.
- Do NOT say "all phones are connected" unless the data explicitly shows connected phones with details.

## 🎯 Your Expertise
You are trained on everything ShadowPhone: setup, configuration, automation modules, growth strategies, and troubleshooting. You know:

### 📱 PHONE SETUP & HARDWARE
**ADB (Android Debug Bridge):**
- ADB is required to connect phones to ShadowPhone. It's a command-line tool that lets the app control Android devices.
- Install via: Android Platform Tools (download from Google)
- Enable USB Debugging: Settings → About Phone → Tap "Build Number" 7 times → Go back → Developer Options → Enable USB Debugging
- Connect phone via USB cable (data cable, not charge-only)
- First connection: Accept "Allow USB Debugging" prompt on phone
- Verify: Run `adb devices` - should show device serial

**Phone Setup Step-by-Step:**
1. Factory reset phone (Settings → System → Reset → Erase all data)
2. Skip Google account during setup (tap "Skip" or use dummy account)
3. Disable auto-updates: Play Store → Profile → Settings → Network preferences → Auto-update apps → Don't auto-update
4. Enable Developer Options and USB Debugging
5. Install Instagram from APK (not Play Store for version control)
6. Connect to ShadowPhone via USB
7. Phone appears in "Phones" tab automatically

**Bootloader & Rooting (Optional):**
- Bootloader unlocking: Required for some advanced features (custom ROMs, etc.)
- WARNING: Unlocking bootloader will factory reset the device
- Process varies by manufacturer (Samsung, Xiaomi, OnePlus have different methods)
- Most users do NOT need to root - ShadowPhone works with stock Android

**Recommended Phones:**
- Best: Google Pixel (easy to manage), Samsung A-series (affordable)
- Budget: Xiaomi Redmi devices, used Samsung S-series
- Avoid: Huawei (no Google services), very old devices (Android < 9)

### 🛫 AIRPLANE MODE (CRITICAL!)
**Why Airplane Mode is ESSENTIAL:**
- Instagram detects IP changes. If your phone switches towers/WiFi, you get flagged.
- Airplane mode ensures phone ONLY uses WiFi (through your proxy).
- This prevents accidental mobile data usage which reveals your real IP.
- ALWAYS keep airplane mode ON, then enable WiFi only.
- Every phone in your farm should follow this rule.

### 🌐 VPN vs PROXIES
**VPNs:**
- VPNs are NOT recommended for phone farms
- VPN IPs are often blacklisted by Instagram (shared IPs)
- VPNs add latency and can disconnect randomly
- Only use VPN for your main computer, not phones

**Proxies (Recommended):**
- Use residential or mobile proxies (NOT datacenter)
- Each phone should have its OWN proxy (1:1 ratio)
- Configure proxy in phone WiFi settings: Settings → WiFi → Long-press network → Modify → Advanced → Proxy ��������� Manual
- Enter proxy IP, port, username, password
- Recommended providers: Smartproxy, Bright Data, IPRoyal, Oxylabs
- Mobile proxies are best (4G/5G IPs) but expensive
- Residential proxies are good balance of quality/price

**Without Proxies:**
- You CAN run without proxies if all phones share your home WiFi
- But limit to 3-5 accounts max on same IP
- Actions should be spaced out more (slower automation)

### 📦 MODULES (Automation Features)
ShadowPhone has these automation modules:

**Content Posting:**
- `Post Reel`: Post videos/reels with caption, hashtags
- `Post Story`: Post to Instagram Stories
- `Post Carousel`: Post multiple images

**Engagement:**
- `Follow`: Follow users from target accounts/hashtags
- `Unfollow`: Unfollow non-followers or old follows
- `Like`: Like posts from feed, hashtags, or profiles
- `Comment`: Auto-comment on posts
- `DM`: Send direct messages to followers/targets

**Growth:**
- `Warm Account`: Gradual activity increase for new accounts
- `View Stories`: View stories of target accounts
- `Engage Target`: Combined like/comment/follow on target's followers

**Utilities:**
- `Switch Profile`: Change Instagram account on phone
- `Repost`: Download and repost content with new caption

### 🔥 ACCOUNT WARMUP
**New Account Strategy (First 2 weeks):**
- Week 1: Manual activity only - browse, like 5-10 posts/day, follow 3-5 accounts
- Week 2: Start light automation - 10-20 follows/day, 20-30 likes/day
- Week 3: Increase gradually - 30-50 follows, 50-100 likes
- Week 4+: Full automation within limits

**Daily Limits (Per Account):**
- Follows: 50-100/day (spread across hours)
- Likes: 100-200/day
- Comments: 20-50/day
- DMs: 20-50/day
- Stories viewed: 200-300/day

**Warmup Signs of Success:**
- No action blocks for 1 week = good standing
- Growing follower count = algorithm likes you
- Explore page exposure = healthy account

### 📊 WORKFLOWS
**What is a Workflow?**
- A workflow is a sequence of modules that run automatically
- Example: Morning workflow = Post Reel → View Stories → Follow 20 → Like 50

**Creating Workflows:**
- Go to Modules tab → Create Workflow
- Add modules in order you want them to run
- Set delays between modules (minimum 30 seconds)
- Schedule workflow for specific times

**Sample Workflows:**
1. **Morning Boost** (6 AM): Post Reel → View 50 Stories → Like 30 posts
2. **Engagement Run** (12 PM): Follow 30 targets → Comment 10 → Like 50
3. **Evening Cleanup** (8 PM): Unfollow 20 → Respond to DMs → Post Story

### ⚠️ AVOIDING BANS & ACTION BLOCKS
**Red Flags (Avoid These):**
- Too many actions too fast (follow 100 people in 5 minutes)
- Same exact comments copied repeatedly
- Following/unfollowing same accounts
- Using damaged proxies (datacenter, blacklisted IPs)
- Running 24/7 without breaks

**Safe Practices:**
- Use delays between actions (randomized, 30-90 seconds)
- Vary your comments (use multiple templates)
- Run 6-12 hours/day max, not 24/7
- Take 1 day off per week (Sunday = no automation)
- Mix automated + manual activity

**When You Get Action Blocked:**
- STOP all automation immediately
- Wait 24-48 hours before any activity
- Start with manual activity only
- Gradually resume automation after 1 week

### 💾 GOOGLE DRIVE INTEGRATION
- Used for storing content to post (reels, images)
- Setup: Settings → Integrations → Google Drive
- Create folder structure: Main Folder → reels/ + images/ + stories/
- Copy folder ID from URL and paste in account settings
- ShadowPhone pulls content automatically

### 💰 QUOTA & SUBSCRIPTION
- Free plan: Limited features, 3 accounts
- Starter ($97/mo): 10 accounts, basic modules
- Growth ($247/mo): 50 accounts, all modules, priority support
- Agency ($497/mo): Unlimited accounts, API access, white-label

### 🎭 THEME PAGES & BAB (BRAND AMBASSADOR) PAGES
**What are Theme Pages?**
- Niche-focused pages that curate/repost content (memes, motivation, fashion, fitness, etc.)
- Goal: Build large following → monetize through promos, shoutouts, affiliate links
- Examples: @successquotes, @luxurylifestyle, @gymfails

**Theme Page Strategy:**
- Pick a niche with high engagement (fitness, wealth, relationships, humor)
- Post 3-5 reels/day, all vertical Shorts-style content
- Use trending audio and hashtags
- Grow to 10K+ followers → offer paid promos

**BAB Pages (Brand Ambassador):**
- Pages promoting specific brands/models in exchange for commission
- Common in adult niche (OF/Fanvue), fashion, supplements
- Run multiple BAB pages per model for wider reach
- Each page = different angle/persona promoting same model

### 🔞 OF/FANVUE MODEL PROMOTION
**How ShadowPhone is Used for Model Promo:**
- Run 5-50+ accounts per model (theme page style)
- Each account reposts model's SFW teaser content
- Bio links to Linktree → OnlyFans/Fanvue
- Engagement modules drive traffic to profile

**Promo Account Strategy:**
- Create accounts with different "personas" (fan accounts, highlight pages)
- Mix content: model teasers + generic niche content (lifestyle, fashion)
- Don't make it obvious it's promo - blend in organically
- Use different proxies per account batch (same model)

**Content Workflow for OF Promo:**
1. Model provides SFW content (reels, pics)
2. Content goes to Google Drive folder
3. ShadowPhone auto-posts to all promo accounts
4. Each account has unique caption templates
5. Engagement modules run on each account

**Safety for Adult Niche:**
- NEVER post explicit content on Instagram - instant ban
- Keep it teasing/suggestive only
- Avoid banned hashtags (#onlyfans is banned)
- Use coded language ("link in bio", "exclusive content")

### 🎮 STREAMER CLIPPING & CONTENT TEMPLATING
**Streamer Content Strategy:**
- Clip highlights from Twitch/YouTube streams
- Template them (add captions, effects, branding)
- Post across multiple accounts targeting different audiences

**Clipping Workflow:**
1. Use clipping tools (StreamLadder, Medal.tv, or manual)
2. Export as vertical 9:16 format
3. Add captions via CapCut or similar
4. Upload to Google Drive
5. ShadowPhone distributes across accounts

**Account Segmentation for Streamers:**
- Main streamer account (official)
- Highlight accounts (@streamername_clips)
- Best-of accounts (@streamername_best)
- Niche-focused accounts (funny moments, fails, etc.)

**Content Templating:**
- Keep consistent branding (fonts, intro/outro)
- Add captions for silent viewing (80% of users watch without sound)
- Use platform-native features (Instagram fonts, stickers)

### 📱 MULTI-ACCOUNT PHONE FARM MANAGEMENT
**Phone Farm Structure:**
- Each phone = 1-5 Instagram accounts (via profiles)
- Each account should have its own proxy or shared residential IP
- Airplane mode ON + WiFi only on all devices

**Profile Distribution Strategy:**
- Don't put competing accounts on same phone (same niche = suspicious)
- Spread accounts across phones based on use case:
  - Phone 1: Model A promo accounts (3-5 accounts)
  - Phone 2: Model B promo accounts (3-5 accounts)
  - Phone 3: Theme pages (mixed niches)

**Simultaneous Posting Across Farm:**
- Use workflows to trigger same module across all phones
- Stagger posts by 5-30 minutes to avoid detection
- Vary captions/hashtags per account

**Running Loops Across Farm:**
- Set up recurring workflows that run daily
- Example: 6 AM - Post Reel on all accounts (staggered)
- Example: 12 PM - Engagement run on all accounts
- Example: 6 PM - Story post on all accounts

### 🔄 LOOP WORKFLOWS (RECURRING AUTOMATION)
**What is a Loop Workflow?**
- A workflow that repeats on schedule (hourly, daily, weekly)
- Runs automatically without manual trigger
- Perfect for ongoing growth automation

**Setting Up Loop Workflows:**
- Create workflow as normal
- Enable "Loop" toggle
- Set interval (every X hours/days)
- Set active hours (only run 6 AM - 10 PM)

**Sample Loop Workflows:**
1. **Morning Content Loop** (Daily 6-8 AM)
   - Post Reel → View 30 Stories → Like 20 posts
   
2. **Continuous Engagement Loop** (Every 4 hours)
   - Follow 10 targets → Like 30 posts → Comment 5

3. **Evening Growth Loop** (Daily 6-9 PM)
   - Post Story → Engage with top commenters → DM new followers

**Loop Safety:**
- Don't run 24/7 - set active hours (human-like schedule)
- Randomize actions between runs (±20% variation)
- Include mandatory rest day (Sunday = no loops)

### 🕐 OPTIMAL POSTING TIMES (BY TIMEZONE)
**US Audiences (EST/PST):**
- Best times: 6-9 AM EST, 11 AM-1 PM EST, 7-9 PM EST
- Peak engagement: Tuesday, Wednesday, Thursday
- Avoid: Monday morning (people catching up), Friday afternoon (checked out)

**General Best Times (EST/Local):**
| Day | Best Times |
|-----|------------|
| Monday | 6 AM, 10 AM, 10 PM |
| Tuesday | 2 AM, 4 AM, 9 AM |
| Wednesday | 7 AM, 8 AM, 11 PM |
| Thursday | 9 AM, 12 PM, 7 PM |
| Friday | 5 AM, 1 PM, 3 PM |
| Saturday | 11 AM, 7 PM, 8 PM |
| Sunday | 7 AM, 8 AM, 4 PM |

**Timezone Strategy for Global Reach:**
- If targeting US: Schedule posts for US prime time (EST)
- If targeting EU: Post during EU morning/lunch
- If mixed audience: Post twice daily at different times

**Posting Frequency by Account Size:**
- New accounts (0-1K): 1-2 posts/day max
- Growing (1K-10K): 2-3 posts/day
- Established (10K+): 3-5 posts/day + stories

**Reels vs Stories vs Posts:**
- Reels: Best for reach/discovery (post 1-2/day)
- Stories: Best for engagement (post 3-10/day)
- Regular posts: Declining reach, use sparingly

## 🧠 RESPONSE GUIDELINES
1. **Reference their actual data** - use their account names, stats, quota when advising
2. **Be specific** - don't say "post more", say "post 2 reels/week on Tuesday and Thursday at 6 PM"
3. **Prioritize safety** - if they're doing risky things, warn them
4. **Keep it concise** - users are busy, get to the point
5. **Use emojis sparingly** - max 2 per response
6. **Admit when unsure** - don't make up answers

## ⛔ NEVER DO
- Share API keys or passwords
- Recommend aggressive automation that risks bans
- Give legal/financial advice
- Discuss bypassing Instagram's terms in explicit terms
"""


class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class ChatRequest(BaseModel):
    userId: str
    messages: List[ChatMessage]
    dashboardData: Optional[Dict[str, Any]] = None  # User's accounts, stats, etc.


@app.post("/chat")
async def chat_with_assistant(request: ChatRequest, authorization: str = Header(None)):
    """AI Assistant chat endpoint using Groq (Llama 3.3 70B)"""
    if not authorization or authorization != f"Bearer {API_SECRET}":
        raise HTTPException(status_code=403, detail="Invalid API key")

    if not GROQ_API_KEY:
        raise HTTPException(status_code=500, detail="GROQ_API_KEY not configured")

    try:
        # Build comprehensive context from dashboard data
        context = "\n\n## 📊 USER'S CURRENT DASHBOARD DATA\n"

        if request.dashboardData:
            # Accounts
            accounts = request.dashboardData.get("accounts", [])
            if accounts:
                context += f"\n### Instagram Accounts ({len(accounts)} total)\n"
                for acc in accounts[:10]:  # Show up to 10 accounts
                    username = acc.get("username", "unknown")
                    followers = acc.get("followers", "N/A")
                    status = acc.get("status", "active")
                    drive_link = "✓ Connected" if acc.get("drive_link") else "✗ Not set"
                    context += f"- @{username}: {followers} followers, Status: {status}, Drive: {drive_link}\n"
            else:
                context += "\n### Instagram Accounts\n⚠️ No accounts added yet.\n"

            # Phones/Devices
            phones = request.dashboardData.get("phones", [])
            if phones:
                context += f"\n### Connected Phones ({len(phones)} devices)\n"
                for phone in phones[:5]:
                    serial = phone.get("serial", "unknown")[:12]
                    model = phone.get("model", "unknown")
                    brand = phone.get("brand", "unknown")
                    status = phone.get("status", "unknown")
                    battery = phone.get("battery", "N/A")
                    profiles = phone.get("profiles", 0)
                    context += f"- {brand} {model} ({serial}...): Status={status}, Battery={battery}%, {profiles} profiles\n"
            else:
                context += "\n### Connected Phones\n⚠️ No phones connected via USB. User should connect a phone with USB debugging enabled.\n"

            # User Settings
            settings = request.dashboardData.get("settings", {})
            if settings:
                context += "\n### User Configuration\n"
                plan = settings.get("plan", "free")
                proxy = (
                    "✓ Configured" if settings.get("proxy_configured") else "✗ Not set"
                )
                drive = (
                    "✓ Connected"
                    if settings.get("google_drive_connected")
                    else "✗ Not connected"
                )
                context += f"- Plan: {plan.upper()}\n"
                context += f"- Proxy: {proxy}\n"
                context += f"- Google Drive: {drive}\n"

            # Quota/Usage
            quota = request.dashboardData.get("quota", {})
            if quota:
                context += "\n### Current Usage & Limits\n"
                scrapes_used = quota.get("scrapes_used", 0)
                scrapes_limit = quota.get("scrapes_limit", 0)
                videos_per = quota.get("videos_per_scrape", 0)
                context += (
                    f"- Scrapes: {scrapes_used}/{scrapes_limit} used this month\n"
                )
                context += f"- Videos per scrape: {videos_per}\n"

            # Recent Activity/Analytics
            analytics = request.dashboardData.get("analytics", {})
            if analytics:
                context += "\n### Recent Analytics\n"
                posts_week = analytics.get("posts_this_week", 0)
                follows_today = analytics.get("follows_today", 0)
                likes_today = analytics.get("likes_today", 0)
                actions_today = analytics.get("total_actions_today", 0)
                context += f"- Posts this week: {posts_week}\n"
                context += f"- Follows today: {follows_today}\n"
                context += f"- Likes today: {likes_today}\n"
                context += f"- Total actions today: {actions_today}\n"

            # Integrations
            integrations = request.dashboardData.get("integrations", {})
            if integrations:
                context += "\n### Integrations\n"
                for name, status in integrations.items():
                    icon = "✓" if status else "✗"
                    context += f"- {name}: {icon}\n"

            # Recent Modules Run
            recent_modules = request.dashboardData.get("recentModules", [])
            if recent_modules:
                context += "\n### Recent Module Activity\n"
                for mod in recent_modules[:5]:
                    name = mod.get("name", "unknown")
                    status = mod.get("status", "unknown")
                    account = mod.get("account", "unknown")
                    context += f"- {name} on @{account}: {status}\n"
        else:
            context += "(No dashboard data provided - give general advice)\n"

        # Build Groq API request (OpenAI-compatible)
        groq_url = "https://api.groq.com/openai/v1/chat/completions"

        # Build message list with system prompt
        system_with_context = SHADOWPHONE_SYSTEM_PROMPT + context

        groq_messages = [{"role": "system", "content": system_with_context}]

        for msg in request.messages:
            groq_messages.append({"role": msg.role, "content": msg.content})

        headers = {
            "Authorization": f"Bearer {GROQ_API_KEY}",
            "Content-Type": "application/json",
        }

        payload = {
            "model": "llama-3.3-70b-versatile",
            "messages": groq_messages,
            "temperature": 0.7,
            "max_tokens": 1024,
        }

        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(groq_url, json=payload, headers=headers)

            if response.status_code != 200:
                error_text = response.text
                print(f"[Groq] Error: {response.status_code} - {error_text}")

                # Handle rate limit gracefully
                if response.status_code == 429:
                    return {
                        "role": "assistant",
                        "response": "I'm experiencing high demand right now. Please try again in a few seconds!",
                    }

                # Handle other errors
                raise HTTPException(
                    status_code=500, detail=f"Groq API error: {response.status_code}"
                )

            result = response.json()

            # Extract response text (OpenAI format)
            choices = result.get("choices", [])
            if choices and len(choices) > 0:
                assistant_message = (
                    choices[0]
                    .get("message", {})
                    .get("content", "I couldn't generate a response.")
                )
            else:
                assistant_message = "I couldn't generate a response."

            return {"role": "assistant", "response": assistant_message}

    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="AI request timed out")
    except Exception as e:
        print(f"[Groq] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== WEBSOCKET REAL-TIME EXECUTION ====================
# This is the NEW architecture where server controls modules in real-time
# via WebSocket, with Electron acting as a dumb relay for ADB commands.

# RemoteDevice powers real-time WebSocket execution. It is buried 6k lines deep,
# so a failure here (or in one of its transitive deps) must not crash the entire
# brain — every non-realtime endpoint should still serve. Mirrors the
# ws_module_adapter guard above. The ModuleAbortedError stub class is REQUIRED:
# other `except ModuleAbortedError` clauses reference the name at runtime, so a
# failed import without the stub would cascade into NameErrors.
try:
    from lib.remote_device import RemoteDevice, ModuleAbortedError

    REMOTE_DEVICE_AVAILABLE = True
    _REMOTE_DEVICE_IMPORT_ERROR = None
except Exception as e:
    REMOTE_DEVICE_AVAILABLE = False
    _REMOTE_DEVICE_IMPORT_ERROR = f"{type(e).__name__}: {e}"
    RemoteDevice = None

    class ModuleAbortedError(Exception):
        pass

    print(f"[Server] lib.remote_device unavailable: {_REMOTE_DEVICE_IMPORT_ERROR}")

# Boot banner — ONE grep-able line summarizing which optional/degradable
# subsystems actually loaded, so operators can see the brain's shape at a glance.
print(
    "[Server] subsystems: "
    f"slowapi={SLOWAPI_AVAILABLE} "
    f"ws_module_adapter={WS_ADAPTER_AVAILABLE} "
    f"discord_notifier={DISCORD_NOTIFIER_AVAILABLE} "
    f"runtime_telemetry={RuntimeSpan is not None} "
    f"remote_device={REMOTE_DEVICE_AVAILABLE}",
    flush=True,
)

# Track active WebSocket sessions
active_ws_sessions: Dict[str, dict] = {}

# WebSocket-based module handlers (these use RemoteDevice)
WS_MODULE_HANDLERS = {}  # Will be populated as we migrate modules

REQUIRED_BRAIN_WS_MODULES = frozenset(
    {
        "post_reel",
        "post_trial_reel",
        "post_story",
        "post_feed",
        "engagement",
        "view_stories",
        "follow",
        "unfollow",
        "ig_repost",
        "comments",
        "comment",
        "account_creation",
        "account_creation_phone",
        "ig_login",
        "edit_profile",
        "dm_automation",
    }
)


def get_brain_readiness(
    ws_handlers=None,
    adapted_handlers=None,
    adapter_failures=None,
):
    native = WS_MODULE_HANDLERS if ws_handlers is None else ws_handlers
    adapted = WS_ADAPTED_MODULES if adapted_handlers is None else adapted_handlers
    failures = (
        WS_ADAPTER_IMPORT_FAILURES
        if adapter_failures is None
        else adapter_failures
    )
    available = {
        module_id
        for module_id, handler in dict(native).items()
        if callable(handler)
    } | {
        module_id
        for module_id, handler in dict(adapted).items()
        if callable(handler)
    }
    missing = sorted(REQUIRED_BRAIN_WS_MODULES - available)
    adapter_dependencies = {
        "post_reel": {"post_trial_reel"},
        "post_trial_reel": {"post_trial_reel"},
        "post_story": {"post_story"},
        "post_feed": {"post_feed", "post_trial_reel"},
        "engagement": {"engagement"},
        "view_stories": {"view_stories"},
        "follow": {"follow"},
        "ig_repost": {"repost"},
        "comment": {"comment"},
        "account_creation": {"account_creation"},
        "ig_login": {"ig_login"},
        "edit_profile": {"edit_profile"},
    }
    required_failures = sorted(
        module_id
        for module_id, dependencies in adapter_dependencies.items()
        if dependencies & set(failures)
    )
    is_ready = not missing and not required_failures
    return {
        "status": "ready" if is_ready else "not_ready",
        "ready": is_ready,
        "missing_modules": missing,
        "failed_modules": required_failures,
        "required_count": len(REQUIRED_BRAIN_WS_MODULES),
    }


LOCAL_ONLY_WS_MODULES = frozenset(
    {
        "airplane_toggle",
        "gallery_clean",
        "gallery_cleaning",
        "wake_unlock",
        "delay",
        "random_delay",
        "conditional",
        "notification",
        "profile_switch",
        "list_profiles",
        "profile_create",
        "profile_delete",
        "ig_launcher",
        "ig_verification_recovery",
        "instagram_launcher",
        "ig_account_switch",
        "detect_accounts",
        "switch_account",
        "ig_switch_account",
        "stats_scraper",
        "ig_stats",
        "scrape_stats",
        "content_manager",
        "airtable_sync",
        "gmail_logout",
        "ig_logout",
        "vpn_connect",
        "ig_status_check",
        "account_insights",
        "push_content",
    }
)


def validate_ws_module_request(module_id):
    if module_id not in LOCAL_ONLY_WS_MODULES:
        return None
    return {
        "type": "error",
        "code": "E008",
        "reason": "local_only_module",
        "message": f"Module '{module_id}' runs only in the desktop executor",
    }


def count_active_devices_for_user(user_id: str) -> int:
    """Count how many devices this user currently has connected.
    Uses list() copy to avoid RuntimeError if dict changes during iteration."""
    try:
        sessions = list(active_ws_sessions.values())
        return len([s for s in sessions if s.get("user_id") == user_id])
    except RuntimeError:
        # Dict changed during iteration - retry with fresh copy
        return len(
            [
                s
                for s in list(active_ws_sessions.values())
                if s.get("user_id") == user_id
            ]
        )


async def check_concurrent_devices_ws(user_id: str) -> dict:
    """Check if user can connect another device (concurrent device limit)."""
    # LOCAL_MODE bypass — same rationale as check_user_quota_ws above.
    if os.getenv("LOCAL_MODE", "").lower() in ("1", "true", "yes"):
        return {"allowed": True, "current": 0, "limit": -1}
    if not user_id or user_id == "anonymous":
        return {
            "allowed": False,
            "current": 0,
            "limit": 0,
            "error": "Authentication required",
        }

    # Count current active devices for this user
    current_count = count_active_devices_for_user(user_id)

    if not get_supabase():
        # Dev mode - allow with warning
        return {"allowed": True, "current": current_count, "limit": 10, "plan": "dev"}

    try:
        result = (
            get_supabase()
            .rpc(
                "check_concurrent_devices",
                {"p_user_id": user_id, "p_current_count": current_count},
            )
            .execute()
        )

        if result.data and len(result.data) > 0:
            row = result.data[0]
            return {
                "allowed": row.get("allowed", False),
                "current": row.get("current_count", current_count),
                "limit": row.get("device_limit", 1),
                "plan": row.get("plan_name", "free"),
            }
        else:
            # Default: allow 1 device
            return {
                "allowed": current_count < 1,
                "current": current_count,
                "limit": 1,
                "plan": "free",
            }

    except Exception as e:
        print(f"[WS] Concurrent devices check error: {e}")
        # SECURITY: Fail-closed - reject on error
        return {"allowed": False, "current": current_count, "limit": 0, "error": str(e)}


async def check_user_quota_ws(user_id: str) -> dict:
    """Check user's quota for WebSocket execution using Supabase RPC.
    NOTE: This is READ-ONLY - does NOT increment the counter.
    Use check_and_increment_usage only when actually running a module.
    """
    # LOCAL_MODE bypass: when the brain is spawned by Electron on 127.0.0.1,
    # the user is already paying for ShadowPhone — there's no Supabase quota
    # to enforce because the brain isn't a shared multi-tenant cloud service.
    # The renderer that owns the local brain handle is the authoritative
    # quota check (it talks to Supabase directly for the parent app).
    if os.getenv("LOCAL_MODE", "").lower() in ("1", "true", "yes"):
        return {
            "allowed": True,
            "remaining": -1,
            "limit": -1,
            "plan": "local",
            "current_usage": 0,
        }
    print(f"[WS QUOTA DEBUG] Checking quota for user_id: '{user_id}'")

    # SECURITY: Reject anonymous/empty users
    if not user_id or user_id == "anonymous":
        print(f"[WS QUOTA DEBUG] REJECTED: user_id is empty or anonymous")
        return {
            "allowed": False,
            "remaining": 0,
            "limit": 0,
            "plan": "none",
            "error": "Authentication required",
        }

    if not get_supabase():
        # Dev mode - allow but with warning
        print("[WS] WARNING: Running without Supabase - quotas not enforced!")
        return {"allowed": True, "remaining": 999, "limit": 999, "plan": "dev"}

    try:
        # Use READ-ONLY check function (does NOT increment counter)
        # Increment only happens when module actually executes via check_and_increment_usage
        result = (
            get_supabase().rpc("check_usage_quota", {"p_user_id": user_id}).execute()
        )
        print(f"[WS QUOTA DEBUG] Supabase RPC result: {result.data}")

        if result.data and len(result.data) > 0:
            row = result.data[0]
            quota_result = {
                "allowed": row.get("allowed", False),
                "remaining": row.get("remaining", 0),
                "limit": row.get("runs_limit", 0),
                "plan": row.get("plan_name", "free"),
                "used_today": row.get("runs_today", 0),
                "is_expired": row.get("is_expired", False),
                "is_trial": row.get("is_trial", False),
            }
            print(f"[WS QUOTA DEBUG] Returning: {quota_result}")
            return quota_result
        else:
            # No data returned - user might not have settings, allow with free tier
            print(f"[WS] No quota data for {user_id} - defaulting to free tier")
            return {"allowed": True, "remaining": 10, "limit": 10, "plan": "free"}

    except Exception as e:
        print(f"[WS] Quota check error: {e}")
        # Log the full error for debugging
        import traceback

        traceback.print_exc()
        # SECURITY: Still fail-closed, but with better error info
        return {
            "allowed": False,
            "remaining": 0,
            "limit": 0,
            "plan": "error",
            "error": str(e),
        }


async def increment_user_quota_ws(user_id: str, module_id: str) -> dict:
    """Increment usage quota and log completed module run.
    This is called AFTER a module successfully executes.
    Returns quota info so UI can update remaining runs.
    """
    if not get_supabase():
        return {"success": True, "remaining": 999}

    try:
        # Increment the usage counter (this is where the actual quota burn happens)
        result = (
            get_supabase()
            .rpc("check_and_increment_usage", {"p_user_id": user_id})
            .execute()
        )

        quota_info = {}
        if result.data and len(result.data) > 0:
            row = result.data[0]
            quota_info = {
                "remaining": row.get("remaining", 0),
                "used_today": row.get("runs_today", 0),
                "limit": row.get("runs_limit", 0),
                "plan": row.get("plan_name", "free"),
            }

        # NOTE: module_runs telemetry is now written by the adapter
        # (lib/ws_module_adapter.execute_adapted_module) and the native
        # dispatch wrapper below — both start a row at status='running'
        # and update it with the real outcome (status, result, duration,
        # error_message, actions_count). This function ONLY burns quota
        # and reports remaining counters.

        print(f"[WS] Usage incremented for {user_id}: {quota_info}")
        return {"success": True, **quota_info}

    except Exception as e:
        print(f"[WS] Usage increment error: {e}")
        import traceback

        traceback.print_exc()
        return {"success": False, "error": str(e)}


async def check_actions_quota_ws(user_id: str, run_id: str = None) -> dict:
    """Check if user can perform more actions (per-run and per-day limits)."""
    if not user_id or user_id == "anonymous":
        return {"allowed": False, "remaining": 0, "error": "Authentication required"}

    if not get_supabase():
        # Dev mode - allow but with warning
        return {"allowed": True, "remaining": 999, "actions_limit": 999, "plan": "dev"}

    try:
        result = (
            get_supabase()
            .rpc("check_actions_quota", {"p_user_id": user_id, "p_run_id": run_id})
            .execute()
        )

        if result.data and len(result.data) > 0:
            row = result.data[0]
            return {
                "allowed": row.get("allowed", False),
                "actions_today": row.get("actions_today", 0),
                "actions_limit": row.get("actions_limit", 500),
                "actions_per_run_limit": row.get("actions_per_run_limit", 25),
                "remaining": row.get("remaining", 0),
                "plan": row.get("plan_name", "free"),
            }
        else:
            return {
                "allowed": True,
                "remaining": 500,
                "actions_limit": 500,
                "plan": "free",
            }

    except Exception as e:
        print(f"[WS] Actions quota check error: {e}")
        # SECURITY: Fail-closed - reject on error
        return {"allowed": False, "remaining": 0, "error": str(e)}


async def increment_action_count_ws(
    user_id: str, run_id: str = None, action_type: str = "unknown"
):
    """Increment action counter after successful action."""
    if not get_supabase():
        return

    try:
        get_supabase().rpc(
            "increment_action_count",
            {"p_user_id": user_id, "p_run_id": run_id, "p_action_type": action_type},
        ).execute()
    except Exception as e:
        print(f"[WS] Action count increment error: {e}")


def is_expected_websocket_disconnect_error(error: Exception) -> bool:
    message = str(error or "").lower()
    return (
        "cannot call \"receive\" once a disconnect message has been received" in message
        or "unexpected asgi message 'websocket.send', after sending 'websocket.close'" in message
    )


async def send_module_terminal(
    websocket,
    remote_device,
    module_span,
    module_id: str,
    result: dict,
    quota_result: dict,
) -> None:
    """Record any final observation before emitting the terminal WS envelope."""
    if module_span:
        screen_observation = None
        try:
            screen_observation = (
                await remote_device.refresh_screen_observation()
            ).to_summary_dict()
        except Exception:
            screen_observation = None
        try:
            result_data = result.get("data")
            module_span.success(
                success=bool(result.get("success", True)),
                quota_remaining=quota_result.get("remaining"),
                result_keys=(
                    sorted(result_data.keys())
                    if isinstance(result_data, dict)
                    else []
                ),
                log_count=len(remote_device.log_history),
                screen_observation=screen_observation,
            )
        except Exception:
            pass

    await websocket.send_json(
        {
            "type": "complete",
            "success": result.get("success", True),
            "code": result.get("code"),
            "error": result.get("error"),
            "data": result.get("data", {}),
            "logs": remote_device.log_history[-50:],
            "quota": quota_result,
        }
    )


@app.websocket("/ws/execute")
async def websocket_execute(websocket: WebSocket):
    """
    WebSocket endpoint for real-time module execution.

    Flow:
    1. Client connects with auth
    2. Client sends start_module
    3. Server runs module logic, sending commands
    4. Client executes commands, returns screen state
    5. Server continues until module complete

    This keeps ALL module logic on the server - client is just a dumb relay.
    """
    await websocket.accept()

    # Real-time execution needs RemoteDevice. If its import failed at boot,
    # reject cleanly with the captured reason instead of NameError-ing mid-run.
    if not REMOTE_DEVICE_AVAILABLE or RemoteDevice is None:
        await websocket.send_json(
            {
                "type": "error",
                "code": "E000",
                "message": f"real-time execution unavailable: {_REMOTE_DEVICE_IMPORT_ERROR}",
            }
        )
        await websocket.close()
        return

    session_id = str(uuid.uuid4())[:8]
    user_id = "anonymous"
    device_id = None

    print(f"[WS] New connection: {session_id}")

    try:
        # 1. Wait for authentication message
        auth_msg = await asyncio.wait_for(websocket.receive_json(), timeout=10.0)

        if auth_msg.get("type") != "connect":
            await websocket.send_json(
                {
                    "type": "error",
                    "code": "E007",
                    "message": "Expected 'connect' message first",
                }
            )
            await websocket.close()
            return

        # Validate API secret
        auth = auth_msg.get("auth", {})

        # Try JWT authentication first (preferred, more secure)
        jwt_token = auth.get("jwt_token")
        if jwt_token:
            # Try Clerk JWT verification first (RS256) - this is the primary auth method
            try:
                claims = verify_clerk_jwt(jwt_token)
                user_id = claims.get("sub")  # Clerk stores userId in 'sub' claim
                print(f"[WS] Clerk JWT auth success: {session_id} | user={user_id}")
            except HTTPException as e:
                # Clerk verification failed, try legacy HS256 module token
                jwt_result = verify_module_jwt(jwt_token)
                if jwt_result["valid"]:
                    user_id = jwt_result["user_id"]
                    print(
                        f"[WS] Module JWT auth success: {session_id} | user={user_id}"
                    )
                else:
                    # Both JWT verification methods failed
                    print(
                        f"[WS] JWT auth failed: {session_id} - {jwt_result['error']} (Clerk: {e.detail})"
                    )
                    await websocket.send_json(
                        {
                            "type": "error",
                            "code": "E007",
                            "message": f"JWT authentication failed: {jwt_result['error']}",
                        }
                    )
                    await websocket.close()
                    return
            except Exception as e:
                # Unexpected error during Clerk verification, try module JWT
                jwt_result = verify_module_jwt(jwt_token)
                if jwt_result["valid"]:
                    user_id = jwt_result["user_id"]
                    print(
                        f"[WS] Module JWT fallback success: {session_id} | user={user_id}"
                    )
                else:
                    print(f"[WS] JWT auth failed: {session_id} - {str(e)}")
                    await websocket.send_json(
                        {
                            "type": "error",
                            "code": "E007",
                            "message": f"JWT authentication failed: {str(e)}",
                        }
                    )
                    await websocket.close()
                    return

        # Fall back to legacy API secret (for backward compatibility during transition)
        elif API_SECRET and auth.get("api_secret") == API_SECRET:
            user_id = auth.get("user_id", "anonymous")
            print(f"[WS] Legacy secret auth: {session_id} | user={user_id}")

        # No valid auth provided
        elif API_SECRET:  # Secret required but not provided/invalid
            print(f"[WS] Auth failed for {session_id} - no valid auth")
            await websocket.send_json(
                {
                    "type": "error",
                    "code": "E007",
                    "message": "Authentication required. Please update your app to the latest version.",
                }
            )
            await websocket.close()
            return

        device_id = auth_msg.get("device_id")
        client_version = auth_msg.get("client_version", "unknown")
        auth_method = "jwt" if jwt_token else "secret"

        print(
            f"[WS] Authenticated: {session_id} | user={user_id} | device={device_id} | v={client_version} | auth={auth_method}"
        )

        # Check quota
        quota = await check_user_quota_ws(user_id)
        if not quota["allowed"]:
            await websocket.send_json(
                {
                    "type": "error",
                    "code": "E006",
                    "message": "Quota exceeded",
                    "quota": quota,
                }
            )
            await websocket.close()
            return

        # Check concurrent devices limit
        device_check = await check_concurrent_devices_ws(user_id)
        if not device_check["allowed"]:
            await websocket.send_json(
                {
                    "type": "error",
                    "code": "E010",
                    "message": f"Concurrent device limit reached ({device_check['current']}/{device_check['limit']})",
                    "concurrent_devices": device_check,
                }
            )
            await websocket.close()
            return

        # Send connected confirmation
        await websocket.send_json(
            {
                "type": "connected",
                "session_id": session_id,
                "quota": quota,
                "available_modules": list(WS_MODULE_HANDLERS.keys()),
            }
        )

        # Track session
        active_ws_sessions[session_id] = {
            "user_id": user_id,
            "device_id": device_id,
            "websocket": websocket,
            "started_at": datetime.now(),
            "current_module": None,
        }

        # Set Discord notifier user context for per-user webhooks
        if user_id and user_id != "anonymous":
            set_discord_user_id(user_id)
            print(f"[WS] Discord notifier user context set: {user_id[:8]}...")

        # 2. Main loop - wait for module execution requests
        while True:
            msg = await websocket.receive_json()
            msg_type = msg.get("type")

            if msg_type == "start_module":
                module_id = msg.get("module_id")
                config = msg.get("config", {})
                profile_id = msg.get("profile_id")

                ws_rejection = validate_ws_module_request(module_id)
                if ws_rejection:
                    await websocket.send_json(ws_rejection)
                    continue

                print(f"[WS] Starting module: {module_id} | session={session_id}")
                module_span = RuntimeSpan(
                    "module_execution",
                    session_id=session_id,
                    user_id=user_id,
                    device_id=device_id,
                    module_id=module_id,
                    profile_id=profile_id,
                    transport="websocket",
                    config_keys=sorted(list(config.keys())) if isinstance(config, dict) else [],
                ) if RuntimeSpan else None

                # Check if module exists in native WS handlers
                handler = WS_MODULE_HANDLERS.get(module_id)
                use_adapter = False

                if not handler:
                    # Fallback 1: Check WebSocket adapter for legacy modules
                    if WS_ADAPTER_AVAILABLE and module_id in WS_ADAPTED_MODULES:
                        print(f"[WS] Using adapter for module: {module_id}")
                        use_adapter = True
                    # Fallback 2: Check if it's a REST-only module. We almost
                    # always end up here because of adapter import failures
                    # (one bad module used to disable the WHOLE adapter),
                    # not because the module is actually REST-only — so
                    # report adapter state + failed-import list so the user
                    # gets an actionable error instead of "use REST API".
                    elif module_id in MODULE_HANDLERS:
                        diag = {
                            "ws_adapter_available": bool(WS_ADAPTER_AVAILABLE),
                            "adapted_module_count": len(WS_ADAPTED_MODULES) if WS_ADAPTED_MODULES else 0,
                            "adapter_import_failures": WS_ADAPTER_IMPORT_FAILURES if WS_ADAPTER_IMPORT_FAILURES else None,
                        }
                        msg = (
                            f"Module '{module_id}' is not registered on this brain."
                            f" ws_adapter_available={diag['ws_adapter_available']},"
                            f" adapted_modules={diag['adapted_module_count']}"
                        )
                        if diag["adapter_import_failures"]:
                            msg += f", adapter import failures: {diag['adapter_import_failures']}"
                        else:
                            msg += " (this module needs REST — check ig_launcher/profile_switch path in client)"
                        await websocket.send_json(
                            {
                                "type": "error",
                                "code": "E008",
                                "message": msg,
                                "diagnostics": diag,
                            }
                        )
                        continue
                    else:
                        await websocket.send_json(
                            {
                                "type": "error",
                                "code": "E008",
                                "message": f"Unknown module: {module_id}. Available: {list(WS_MODULE_HANDLERS.keys())[:10]}...",
                            }
                        )
                        continue

                # Create RemoteDevice for this session
                remote_device = RemoteDevice(websocket, device_id)
                if module_id == "account_creation_phone":
                    remote_device._account_creation_paid_boundary_reached = False
                active_ws_sessions[session_id]["current_module"] = module_id
                emit_runtime_event(
                    "module_execution.handler_selected",
                    session_id=session_id,
                    user_id=user_id,
                    device_id=device_id,
                    module_id=module_id,
                    profile_id=profile_id,
                    transport="websocket",
                    execution_path="adapter" if use_adapter else "native_ws_handler",
                )

                # Per-module persistent log (lazy import to avoid boot
                # ordering issues). Captures every step / schedule run
                # in <userData>/logs/<module_id>.log so users can ship
                # the file when something fails unexpectedly.
                _srv_log = None
                if not use_adapter:
                    try:
                        from lib.persistent_log import ModuleLogger as _SrvModLog
                        _srv_log = _SrvModLog(module_id)
                        _safe_cfg = sanitize_module_payload(config or {})
                        _srv_log.sync_log(
                            f"=== START {module_id} via=native "
                            f"device={device_id} cfg={_safe_cfg}"
                        )
                    except Exception:
                        _srv_log = None

                # Run the module
                try:
                    if use_adapter:
                        # Use the WebSocket adapter for legacy modules.
                        # The adapter handles module_runs telemetry
                        # (start/end) internally.
                        result = await execute_adapted_module(
                            module_id, remote_device, config,
                            user_id=user_id, profile_id=profile_id,
                        )
                    else:
                        # Native WS handler path — wrap so unhandled
                        # exceptions don't crash the WS loop and leave
                        # the renderer staring at a silent WS_CLOSED.
                        # Mirrors execute_adapted_module's pattern AND
                        # writes a module_runs row at start/end so the
                        # legacy native handlers (engagement_ws, etc.)
                        # also produce duration/result/error telemetry.
                        from lib.ws_module_adapter import (
                            _telemetry_start as _ws_tel_start,
                            _telemetry_end as _ws_tel_end,
                        )
                        native_run_id = _ws_tel_start(
                            module_id, user_id, device_id, profile_id, config or {}
                        )
                        try:
                            result = await handler(remote_device, config, profile_id)
                            if module_id == "account_creation_phone":
                                if isinstance(result, dict) and not result.get("success", False):
                                    result_data = result.setdefault("data", {})
                                    if isinstance(result_data, dict):
                                        paid_boundary_reached = bool(getattr(
                                            remote_device,
                                            "_account_creation_paid_boundary_reached",
                                            False,
                                        ))
                                        result_data["paid_order_created"] = paid_boundary_reached
                                        cancellation_safe = bool(
                                            result_data.get("sms_order_cancelled")
                                            and not result_data.get("sms_order_reconciliation_required")
                                        )
                                        if (
                                            (not paid_boundary_reached and not result_data.get("uncertain_outcome"))
                                            or cancellation_safe
                                        ):
                                            result_data["credential_reservation_release_safe"] = True
                                result = sanitize_account_creation_phone_result(result, config)
                        except ModuleAbortedError:
                            if module_id == "account_creation_phone":
                                cancellation = {
                                    "attempted": False,
                                    "cancelled": False,
                                    "refund_requested": False,
                                    "reconciliation_required": False,
                                }
                                sms_state = getattr(remote_device, "_account_creation_sms_state", None)
                                if isinstance(sms_state, dict):
                                    cancellation = await cancel_smspool_order_if_safe(
                                        sms_state.get("order_id"),
                                        sms_state.get("api_key"),
                                        code_received=bool(sms_state.get("code_received")),
                                        code_submitted=bool(sms_state.get("code_submitted")),
                                        provider=sms_state.get("provider", "smspool"),
                                        api_username=sms_state.get("api_username", ""),
                                    )
                                    remote_device._account_creation_sms_state = None
                                    if cancellation.get("cancelled"):
                                        await remote_device.send_log(
                                            "phone-signup: unused SMS order cancelled after abort; refund requested"
                                        )
                                reconciliation_required = bool(cancellation.get("reconciliation_required"))
                                remote_device._account_creation_abort_outcome = sanitize_account_creation_phone_result(
                                    {
                                        "success": False,
                                        "code": "ACCOUNT_CREATION_ABORTED",
                                        "error": "Account creation was cancelled.",
                                        "data": {
                                            "retryable": not reconciliation_required,
                                            "uncertain_outcome": reconciliation_required,
                                            "manual_action_required": reconciliation_required,
                                            "sms_order_cancelled": bool(cancellation.get("cancelled")),
                                            "sms_refund_requested": bool(cancellation.get("refund_requested")),
                                            "sms_order_reconciliation_required": reconciliation_required,
                                            "credential_reservation_release_safe": bool(cancellation.get("cancelled")) and not reconciliation_required,
                                            "paid_order_created": bool(getattr(
                                                remote_device,
                                                "_account_creation_paid_boundary_reached",
                                                False,
                                            )),
                                        },
                                    },
                                    config,
                                )
                            raise
                        except Exception as _native_e:
                            import traceback as _tb_native
                            account_creation_cleanup = None
                            if module_id == "account_creation_phone":
                                sms_state = getattr(remote_device, "_account_creation_sms_state", None)
                                if isinstance(sms_state, dict):
                                    account_creation_cleanup = await cancel_smspool_order_if_safe(
                                        sms_state.get("order_id"),
                                        sms_state.get("api_key"),
                                        code_received=bool(sms_state.get("code_received")),
                                        code_submitted=bool(sms_state.get("code_submitted")),
                                        provider=sms_state.get("provider", "smspool"),
                                        api_username=sms_state.get("api_username", ""),
                                    )
                                    remote_device._account_creation_sms_state = None
                                public_native_error = (
                                    "Account creation stopped unexpectedly. Check the phone and SMSPool active orders before retrying."
                                )
                            else:
                                public_native_error = f"{type(_native_e).__name__}: {_native_e}"
                            _safe_native_error = sanitize_module_payload(
                                {"message": public_native_error}
                            )["message"]
                            if _srv_log:
                                try:
                                    _srv_log.sync_log(
                                        f"ERROR: {module_id} native handler raised "
                                        f"{type(_native_e).__name__}: {_safe_native_error}"
                                    )
                                except Exception:
                                    pass
                            try:
                                await remote_device.send_log(
                                    f"ERROR in {module_id}: {public_native_error}"
                                )
                            except Exception:
                                pass
                            err_str = public_native_error
                            if module_id == "account_creation_phone":
                                cleanup = account_creation_cleanup or {}
                                err_data = {
                                    "retryable": False,
                                    "manual_action_required": True,
                                    "sms_order_cancelled": bool(cleanup.get("cancelled")),
                                    "sms_refund_requested": bool(cleanup.get("refund_requested")),
                                    "sms_order_reconciliation_required": bool(cleanup.get("reconciliation_required")),
                                    "credential_reservation_release_safe": bool(cleanup.get("cancelled")) and not bool(cleanup.get("reconciliation_required")),
                                    "paid_order_created": bool(getattr(
                                        remote_device,
                                        "_account_creation_paid_boundary_reached",
                                        False,
                                    )),
                                }
                            else:
                                err_data = {"traceback_tail": _tb_native.format_exc().splitlines()[-5:]}
                            _ws_tel_end(
                                native_run_id, user_id, module_id,
                                False, err_data, err_str,
                            )
                            result = {
                                "success": False,
                                "code": "ACCOUNT_CREATION_HANDLER_ERROR" if module_id == "account_creation_phone" else None,
                                "error": err_str,
                                "data": err_data,
                            }
                        else:
                            # Success path for native handler — close the
                            # telemetry row with the real outcome.
                            _ok = bool(result.get("success", True)) if isinstance(result, dict) else False
                            _data = result.get("data") if isinstance(result, dict) else None
                            _err = result.get("error") if isinstance(result, dict) else None
                            _ws_tel_end(
                                native_run_id, user_id, module_id,
                                _ok, _data if isinstance(_data, dict) else {}, _err,
                            )
                    if _srv_log:
                        try:
                            _ok = result.get("success") if isinstance(result, dict) else None
                            _err = (result.get("error") if isinstance(result, dict) else "") or ""
                            _safe_end_error = sanitize_module_payload(
                                {"message": _err[:160]}
                            )["message"]
                            _srv_log.sync_log(
                                f"END {module_id} success={_ok} error={_safe_end_error}"
                            )
                        except Exception:
                            pass

                    # Track usage FIRST so we get updated quota info
                    quota_result = {"remaining": None}
                    if result.get("success"):
                        quota_result = await increment_user_quota_ws(user_id, module_id)

                    await send_module_terminal(
                        websocket,
                        remote_device,
                        module_span,
                        module_id,
                        result,
                        quota_result,
                    )

                    print(
                        f"[WS] Module complete: {module_id} | success={result.get('success')} | remaining={quota_result.get('remaining')}"
                    )

                except ModuleAbortedError:
                    print(
                        f"[WS] Module aborted by user: {module_id} | session={session_id}"
                    )
                    if module_span:
                        module_span.aborted(log_count=len(remote_device.log_history))
                    try:
                        abort_outcome = getattr(remote_device, "_account_creation_abort_outcome", None)
                        if not isinstance(abort_outcome, dict):
                            abort_outcome = {
                                "code": "ACCOUNT_CREATION_ABORTED" if module_id == "account_creation_phone" else "MODULE_ABORTED",
                                "error": "Cancelled by user",
                                "data": {},
                            }
                        await websocket.send_json(
                            {
                                "type": "complete",
                                "success": False,
                                "aborted": True,
                                "code": abort_outcome.get("code"),
                                "error": abort_outcome.get("error", "Cancelled by user"),
                                "data": abort_outcome.get("data", {}),
                                "logs": remote_device.log_history[-50:],
                            }
                        )
                    except Exception:
                        pass  # Client may have already disconnected

                except Exception as e:
                    print(f"[WS] Module error: {module_id} | {e}")
                    if module_span:
                        module_span.failure(e, log_count=len(remote_device.log_history))
                    await websocket.send_json(
                        {
                            "type": "complete",
                            "success": False,
                            "error": str(e),
                            "logs": remote_device.log_history[-50:],
                        }
                    )

                active_ws_sessions[session_id]["current_module"] = None

            elif msg_type == "ping":
                await websocket.send_json({"type": "pong"})

            elif msg_type == "disconnect":
                print(f"[WS] Client requested disconnect: {session_id}")
                break

            else:
                print(f"[WS] Unknown message type: {msg_type}")

    except WebSocketDisconnect:
        print(f"[WS] Disconnected: {session_id}")
    except asyncio.TimeoutError:
        print(f"[WS] Timeout waiting for auth: {session_id}")
        await websocket.close()
    except Exception as e:
        if is_expected_websocket_disconnect_error(e):
            print(f"[WS] Disconnected: {session_id}")
        else:
            print(f"[WS] Error in session {session_id}: {e}")
            try:
                await websocket.send_json(
                    {"type": "error", "code": "E999", "message": str(e)}
                )
            except:
                pass
    finally:
        active_ws_sessions.pop(session_id, None)
        print(f"[WS] Session ended: {session_id}")


# ==================== WEBSOCKET MODULE IMPLEMENTATIONS ====================
# These are the migrated modules that use RemoteDevice



async def execute_engagement_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based engagement module (unified).
    Routes to the correct handler based on 'source' config:
    - feed (default): Home feed engagement
    - reels: Reels tab engagement
    - hashtag: Hashtag-based engagement
    - explore: Explore page engagement
    """
    # Route to specialized handler based on source config
    source = config.get("source", "feed")
    if source == "reels":
        return await execute_reels_engagement_ws(device, config, profile_id)
    elif source == "hashtag":
        return await execute_hashtag_engagement_ws(device, config, profile_id)
    elif source == "explore":
        return await execute_explore_engagement_ws(device, config, profile_id)
    elif source == "split":
        # Old appium engage_split pattern: 33% feed, 67% reels in one session
        import random

        total = int(config.get("count", 15) or 15)
        count_min = int(config.get("count_min", total) or total)
        count_max = int(config.get("count_max", total) or total)
        if count_min != count_max:
            total = random.randint(min(count_min, count_max), max(count_min, count_max))

        if "feed_ratio_min" in config or "feed_ratio_max" in config:
            ratio_min = float(config.get("feed_ratio_min", 0.25) or 0.25)
            ratio_max = float(config.get("feed_ratio_max", 0.45) or 0.45)
            feed_ratio = random.uniform(min(ratio_min, ratio_max), max(ratio_min, ratio_max))
        else:
            feed_ratio = float(config.get("feed_ratio", 0.33) or 0.33)

        feed_count = int(round(total * feed_ratio))
        if total > 1:
            feed_count = max(1, min(feed_count, total - 1))
        reels_count = total - feed_count

        await device.send_log(f"Split engage: {feed_count} feed + {reels_count} reels")

        like_min = int(config.get("like_chance_min", config.get("like_chance", 80)) or 80)
        like_max = int(config.get("like_chance_max", config.get("like_chance", like_min)) or like_min)
        comment_min = int(config.get("comment_chance_min", config.get("comment_chance", 15)) or 15)
        comment_max = int(config.get("comment_chance_max", config.get("comment_chance", comment_min)) or comment_min)
        session_like_chance = random.randint(min(like_min, like_max), max(like_min, like_max))
        session_comment_chance = random.randint(min(comment_min, comment_max), max(comment_min, comment_max))

        # Phase 1: Feed
        feed_config = {
            **config,
            "count": feed_count,
            "source": "feed",
            "like_chance": session_like_chance,
            "comment_chance": session_comment_chance,
        }
        feed_result = await execute_engagement_ws(device, feed_config, profile_id)

        # Brief pause between phases
        await device.wait(random.randint(2000, 5000))

        # Phase 2: Reels
        reels_config = {
            **config,
            "count": reels_count,
            "source": "reels",
            "like_chance": session_like_chance,
            "comment_chance": session_comment_chance,
        }
        reels_result = await execute_reels_engagement_ws(
            device, reels_config, profile_id
        )

        # Merge stats
        feed_data = feed_result.get("data", {})
        reels_data = reels_result.get("data", {})
        return {
            "success": feed_result.get("success", False)
            or reels_result.get("success", False),
            "data": {
                "posts_viewed": feed_data.get("posts_viewed", 0)
                + reels_data.get("posts_viewed", reels_data.get("reels_viewed", 0)),
                "likes": feed_data.get("likes", 0) + reels_data.get("liked", 0),
                "comments": feed_data.get("comments", 0)
                + reels_data.get("commented", 0),
                "skipped": feed_data.get("skipped", 0) + reels_data.get("skipped", 0),
                "ads_skipped": feed_data.get("ads_skipped", 0)
                + reels_data.get("ads_skipped", 0),
                "feed_count": feed_count,
                "reels_count": reels_count,
            },
        }

    # Default: HOME FEED engagement
    # Uses resource IDs from ig_selectors.py golden reference:
    #   Like: com.instagram.android:id/row_feed_button_like
    #   Comment: com.instagram.android:id/row_feed_button_comment
    #   Comment input: com.instagram.android:id/layout_comment_thread_edittext
    #   Comment post: com.instagram.android:id/layout_comment_thread_post_button_icon
    import random

    count = config.get("count", 10)
    like_chance = config.get("like_chance", 80)
    comment_chance = config.get("comment_chance", 15)
    account_id = config.get("account_id")
    user_id = config.get("user_id")
    delay_min = config.get("delay_min", 1)
    delay_max = config.get("delay_max", 3)

    # Option to only like (no comments)
    like_only = config.get("like_only", False)
    if like_only:
        comment_chance = 0

    await device.send_progress(0, f"Feed engage: {count} posts...")

    # Pre-fetch comments from pool if account is assigned one
    comment_pool_lines = []
    if account_id and comment_chance > 0:
        comment = await get_comment_for_account(account_id, user_id)
        if comment:
            try:
                if get_supabase():
                    acc_res = (
                        get_supabase()
                        .from_("instagram_accounts")
                        .select("comment_pool_id")
                        .eq("id", account_id)
                        .single()
                        .execute()
                    )
                    if acc_res.data and acc_res.data.get("comment_pool_id"):
                        pool_res = (
                            get_supabase()
                            .from_("content_pools")
                            .select("content")
                            .eq("id", acc_res.data["comment_pool_id"])
                            .single()
                            .execute()
                        )
                        if pool_res.data:
                            content = pool_res.data.get("content", "")
                            comment_pool_lines = [
                                l.strip()
                                for l in content.split("\n")
                                if l.strip() and not l.strip().startswith("#")
                            ]
            except Exception:
                pass

    # Fallback default comments (ADB-safe, no emojis)
    if not comment_pool_lines:
        comment_pool_lines = [
            "fire",
            "so fire",
            "love this",
            "so good",
            "amazing",
            "incredible",
            "wow",
            "this is everything",
            "perfect",
            "obsessed",
            "iconic",
            "goals",
            "vibe",
            "mood",
            "need this",
            "slay",
            "sheesh",
            "this made my day",
            "cant stop watching",
            "literally perfect",
            "insane",
            "best thing ever",
            "unreal",
            "too good",
            "living for this",
        ]

    stats = {"posts_viewed": 0, "likes": 0, "comments": 0, "skipped": 0, "ads_skipped": 0}

    try:
        # Pre-launch cleanup: 2x back to clear any hanging/stuck screens
        await device.send_progress(3, "Clearing stuck screens...")
        await device.back()
        await device.wait(500)
        await device.back()
        await device.wait(500)

        # Launch Instagram
        await device.send_progress(5, "Launching Instagram...")
        await device.launch_app("com.instagram.android", wait_after=3000)

        # Dismiss popups
        await device.send_progress(8, "Checking for popups...")
        await device.dismiss_common_popups()

        # Ensure we're on HOME FEED — tap bottom-nav Home tab directly
        # DO NOT use navigate_to_home() here — it uses content-description
        # "Home" which matches the Instagram logo at (540, 201) and opens
        # the Following/Favorites dropdown instead of the Home tab.
        await device.send_progress(10, "Ensuring Home Feed...")
        await device.tap(108, 2274, wait_after=800)
        await device.dismiss_common_popups()

        # Scroll past story tray to first post (humanized)
        # Story tray is ~345px tall [275-620]. Need to scroll ~600-900px to clear it
        # and land on the first post. Vary speed so it doesn't look mechanical.
        sx = random.randint(460, 620)
        await device.swipe(
            sx,
            random.randint(1500, 1700),
            sx + random.randint(-15, 15),
            random.randint(700, 1000),
            random.randint(350, 600),
        )
        await device.wait(random.randint(800, 1500))

        # Engage with feed posts
        for i in range(count):
            progress = 15 + int((i / count) * 80)
            await device.send_progress(progress, f"Feed post {i + 1}/{count}...")

            stats["posts_viewed"] += 1

            # Snapshot stats to detect if we engage this iteration
            prev_likes = stats["likes"]
            prev_comments = stats["comments"]

            # Get screen XML for detection
            await device.get_screen()

            # Skip sponsored/ad posts
            if device.is_sponsored("feed"):
                stats["skipped"] += 1
                stats["ads_skipped"] += 1
                await device.send_log("Skipping sponsored post")
                await device.swipe(
                    random.randint(480, 600),
                    1500,
                    random.randint(480, 600),
                    random.randint(600, 900),
                    random.randint(250, 400),
                )
                await device.wait(random.randint(400, 800))
                continue

            # Humanized viewing time (from old appium module patterns)
            view_type = random.choices(
                ["quick_scroll", "brief_view", "engaged_view", "deep_view"],
                weights=[0.15, 0.35, 0.35, 0.15],
            )[0]
            view_times = {
                "quick_scroll": (200, 500),
                "brief_view": (500, 1000),
                "engaged_view": (1000, 1800),
                "deep_view": (1800, 3000),
            }
            vmin, vmax = view_times[view_type]
            await device.wait(random.randint(vmin, vmax))

            # ── Micro-behaviors (low frequency, fast execution) ────────
            # 6% chance: tap username to peek at profile, then back
            if view_type == "deep_view" and random.random() < 0.06:
                username_el = device.find_element_by_resource_id(
                    "com.instagram.android:id/row_feed_textview_username"
                )
                if username_el:
                    await device.tap(username_el[0], username_el[1], wait_after=500)
                    await device.wait(random.randint(400, 800))
                    await device.back()
                    await device.wait(random.randint(200, 400))

            # Like based on chance (scaled by view type like old appium)
            view_multiplier = {
                "quick_scroll": 0.2,
                "brief_view": 0.5,
                "engaged_view": 1.0,
                "deep_view": 1.2,
            }[view_type]
            effective_like = like_chance * view_multiplier / 100

            if random.random() < effective_like:
                await device.get_screen()
                if device.is_liked():
                    await device.send_log("Already liked, skipping", "DEBUG")
                else:
                    # Use feed-specific like button resource ID
                    like_btn = device.find_element_by_resource_id(
                        "com.instagram.android:id/row_feed_button_like"
                    )
                    if like_btn:
                        await device.tap(like_btn[0], like_btn[1], wait_after=300)
                        stats["likes"] += 1
                    else:
                        # Fallback: double-tap center of media area (from ig_selectors FeedCoords)
                        await device.double_tap_to_like(540, 1477)
                        stats["likes"] += 1
                    await device.wait(random.randint(200, 500))

            # Comment based on chance (only on longer views, like old appium)
            if view_type in ["engaged_view", "deep_view"] and not like_only:
                effective_comment = comment_chance * view_multiplier / 100
                if random.random() < effective_comment:
                    # Open comment sheet via resource ID (verified from ig_selectors)
                    comment_btn = device.find_element_by_resource_id(
                        "com.instagram.android:id/row_feed_button_comment"
                    )
                    if not comment_btn:
                        comment_btn = device.find_element_by_content_description(
                            "Comment"
                        )

                    if comment_btn:
                        await device.tap(
                            comment_btn[0], comment_btn[1], wait_after=800
                        )

                        # Tap input field (verified resource ID from ig_selectors)
                        await device.get_screen()
                        input_field = device.find_element_by_resource_id(
                            "com.instagram.android:id/layout_comment_thread_edittext"
                        )
                        if input_field:
                            await device.tap(
                                input_field[0], input_field[1], wait_after=500
                            )
                        else:
                            # ⚠️ Fallback — comment sheet position is DYNAMIC
                            await device.tap(543, 1435, wait_after=500)

                        # Type comment
                        chosen_comment = random.choice(comment_pool_lines)
                        await device.input_text(chosen_comment)
                        await device.wait(1000)

                        # Tap Post button via resource ID (NOT enter key - more reliable)
                        await device.get_screen()
                        post_btn = device.find_element_by_resource_id(
                            "com.instagram.android:id/layout_comment_thread_post_button_icon"
                        )
                        if post_btn:
                            await device.tap(post_btn[0], post_btn[1], wait_after=800)
                        else:
                            # ⚠️ Fallback — comment sheet position is DYNAMIC
                            await device.tap(977, 1441, wait_after=800)

                        stats["comments"] += 1

                        # Close comment sheet (press back twice like old appium)
                        await device.back()
                        await device.wait(300)
                        await device.back()
                        await device.wait(500)

            # ── Post-aware scroll-to-next ──────────────────────────────
            # Feed posts vary wildly in height (515px image → 1680px reel).
            # Fixed scroll distances land mid-post or skip posts entirely.
            # Solution: use the Like button Y as anchor — it's always at the
            # bottom of the current post. Scroll enough to clear it off screen.

            scroll_x = random.randint(460, 620)
            did_engage = (
                stats["likes"] > prev_likes or stats["comments"] > prev_comments
            )

            # Find the like button to calculate ideal scroll distance
            await device.get_screen()
            like_anchor = device.find_element_by_resource_id(
                "com.instagram.android:id/row_feed_button_like"
            )
            if like_anchor:
                # Like button Y tells us where the post bottom is.
                # Scroll so like button goes above ~200px (next post header area).
                # Add jitter so it's not pixel-perfect every time.
                ideal_scroll = like_anchor[1] - random.randint(100, 300)
                if like_anchor[1] < 750:
                    ideal_scroll = random.randint(850, 1450)
                min_scroll = random.randint(1050, 1450)
                ideal_scroll = max(min_scroll, min(ideal_scroll, 2200))  # clamp
                # For tall posts: phone deceleration means we need to over-scroll
                # by ~20% to actually move the right distance
                if ideal_scroll > 900:
                    ideal_scroll = int(ideal_scroll * 1.2)
            else:
                ideal_scroll = random.randint(1050, 1800)  # fallback

            if random.random() < 0.18:
                ideal_scroll = max(ideal_scroll, random.randint(1450, 2200))
            ideal_scroll = min(ideal_scroll, 2100)

            # Pick scroll style based on context
            if did_engage:
                scroll_style = random.choices(
                    ["slow_drag", "normal", "quick_flick"],
                    weights=[0.5, 0.4, 0.1],
                )[0]
            elif view_type == "quick_scroll":
                scroll_style = random.choices(
                    ["quick_flick", "normal", "burst"],
                    weights=[0.45, 0.35, 0.20],
                )[0]
            else:
                scroll_style = random.choices(
                    ["slow_drag", "normal", "quick_flick", "burst"],
                    weights=[0.15, 0.45, 0.25, 0.15],
                )[0]

            if scroll_style == "burst":
                # Multi-scroll burst: 2-3 rapid small scrolls (skipping content)
                burst_count = random.randint(2, 3)
                for _ in range(burst_count):
                    s_amt = random.randint(700, 1200)
                    s_dur = random.randint(120, 250)
                    s_y = random.randint(1500, 1800)
                    await device.swipe(
                        scroll_x + random.randint(-30, 30),
                        s_y,
                        scroll_x + random.randint(-30, 30),
                        s_y - s_amt,
                        s_dur,
                    )
                    await device.wait(random.randint(80, 250))
            elif scroll_style == "quick_flick":
                # Fast flick — use ideal_scroll + overshoot
                scroll_amount = ideal_scroll + random.randint(50, 200)
                scroll_duration = random.randint(150, 280)
                start_y = min(1900, 400 + scroll_amount)
                end_y = max(start_y - scroll_amount, 300)
                await device.swipe(
                    scroll_x,
                    start_y,
                    scroll_x + random.randint(-15, 15),
                    end_y,
                    scroll_duration,
                )
            elif scroll_style == "slow_drag":
                # Slow deliberate drag — use ideal_scroll with slight undershoot
                scroll_amount = ideal_scroll + random.randint(-100, 50)
                scroll_amount = max(650, scroll_amount)
                scroll_duration = random.randint(550, 900)
                start_y = min(1800, 400 + scroll_amount)
                await device.swipe(
                    scroll_x,
                    start_y,
                    scroll_x + random.randint(-25, 25),
                    start_y - scroll_amount,
                    scroll_duration,
                )
            else:
                # Normal scroll — use ideal_scroll with natural jitter
                scroll_amount = ideal_scroll + random.randint(-80, 100)
                scroll_amount = max(700, scroll_amount)
                # Faster duration for larger scrolls (more momentum)
                if scroll_amount > 1200:
                    scroll_duration = random.randint(200, 350)
                else:
                    scroll_duration = random.randint(300, 550)
                start_y = min(1900, 300 + scroll_amount)
                end_y = max(start_y - scroll_amount, 200)
                await device.swipe(
                    scroll_x,
                    start_y,
                    scroll_x + random.randint(-20, 20),
                    end_y,
                    scroll_duration,
                )
                # For tall posts: verify scroll landed properly
                # If like button is still in same position, do a correction scroll
                if ideal_scroll > 900:
                    await device.wait(300)
                    await device.get_screen()
                    new_like = device.find_element_by_resource_id(
                        "com.instagram.android:id/row_feed_button_like"
                    )
                    if new_like and like_anchor and abs(new_like[1] - like_anchor[1]) < 150:
                        # Didn't scroll far enough — correction swipe
                        correction = random.randint(400, 700)
                        await device.swipe(
                            scroll_x, 1500, scroll_x, 1500 - correction,
                            random.randint(200, 350),
                        )

            # Scroll-back micro-behavior: ~15% chance of overshooting then
            # scrolling back up slightly (very human pattern)
            if scroll_style != "burst" and random.random() < 0.15:
                await device.wait(random.randint(100, 300))
                back_amount = random.randint(100, 350)
                back_y = random.randint(800, 1200)
                await device.swipe(
                    scroll_x + random.randint(-10, 10),
                    back_y,
                    scroll_x + random.randint(-10, 10),
                    back_y + back_amount,
                    random.randint(200, 400),
                )

            # ── Reels leak guard ─────────────────────────────────────
            # Only trigger if we FULLY left the feed and landed on the
            # Reels tab. The clips_viewer_view_pager element appears on
            # normal feed video posts too — checking it alone causes
            # constant false resets. Only reset if we see both the viewer
            # AND the bottom nav Reels tab is selected (highlighted).
            await device.get_screen()
            reels_tab_selected = (
                device.find_element_by_resource_id_in_bounds(
                    "com.instagram.android:id/clips_tab",
                    min_y=1950,
                )
                or device.find_element_by_content_description_exact_in_bounds(
                    "Reels",
                    min_y=1950,
                )
            )
            # Check if feed-specific elements are MISSING (we actually left the feed)
            feed_indicator = device.find_element_by_resource_id(
                "com.instagram.android:id/row_feed_button_like"
            ) or device.find_element_by_content_description("Instagram Home Feed")
            if reels_tab_selected and not feed_indicator:
                await device.send_log(
                    "Reels tab detected — navigating back to Home"
                )
                await device.back()
                await device.wait(500)
                await device.tap(108, 2274, wait_after=800)
                await device.dismiss_common_popups()
                # Scroll past story tray
                await device.swipe(
                    random.randint(480, 600),
                    1500,
                    random.randint(480, 600),
                    random.randint(1000, 1200),
                    random.randint(300, 500),
                )
                await device.wait(random.randint(800, 1200))

            # Humanized delay — triangular distribution clusters around
            # the midpoint instead of uniform random (more realistic)
            base_delay_s = random.triangular(delay_min, delay_max, delay_min * 1.3)
            # Context adjustment: faster after bursts/flicks, slower after engagement
            if scroll_style == "burst":
                base_delay_s *= random.uniform(0.3, 0.6)
            elif did_engage:
                base_delay_s *= random.uniform(1.1, 1.6)
            await device.wait(int(base_delay_s * 1000))

        await device.send_progress(
            100, f"Done! {stats['likes']} likes, {stats['comments']} comments in feed"
        )

        return {"success": True, "data": stats}

    except Exception as e:
        return {"success": False, "error": str(e)}




async def execute_unfollow_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based unfollow module.
    Unfollows users from your Following list.

    Flow:
    1. Navigate to Profile > Following
    2. Find users with "Following" button
    3. Tap to unfollow and confirm
    4. Scroll for more users

    Note: Instagram limits unfollows heavily. Doing too many too fast
    will result in action blocks. This module adds human-like delays.
    """
    import random

    count = config.get("count", 10)

    # Randomize count if range provided
    count_min = config.get("count_min", count)
    count_max = config.get("count_max", count)
    if count_min != count_max:
        count = random.randint(count_min, count_max)

    await device.send_log(f"Starting unfollow session: target {count} users")
    await device.send_progress(0, "Opening Instagram...")

    try:
        # Launch Instagram
        await device.launch_app("com.instagram.android", wait_after=3000)
        await device.dismiss_common_popups()

        await device.send_progress(10, "Going to profile...")

        # Navigate to profile
        await device.navigate_to_profile()
        await device.wait(1500)
        await device.get_screen()

        await device.send_progress(20, "Opening Following list...")

        # Find and tap "Following" count on profile
        # Look for text that matches following count pattern
        following_btn = (
            device.find_element_by_text("following")
            or device.find_element_by_text("Following")
            or device.find_element_by_resource_id(
                "com.instagram.android:id/row_profile_header_following_container"
            )
        )

        if following_btn:
            await device.tap(following_btn[0], following_btn[1], wait_after=800)
        else:
            # Fallback: tap in the middle area where following count usually is
            await device.tap(540, 400, wait_after=800)

        await device.wait(1500)
        await device.get_screen()

        unfollowed = 0
        skipped = 0

        await device.send_progress(30, "Starting unfollows...")

        for i in range(count * 2):  # Try more times in case some fail
            if unfollowed >= count:
                break

            progress = 30 + int((unfollowed / count) * 60)
            await device.send_progress(
                progress, f"Unfollowing {unfollowed + 1}/{count}..."
            )

            await device.get_screen()

            # Check for action blocked
            if await device.handle_action_blocked():
                await device.send_log(
                    "Action blocked! Stopping unfollow session.", "WARN"
                )
                break

            # Find "Following" button (not "Follow" which means not following)
            following_btn = device.find_element_by_text("Following")

            if following_btn:
                # Human-like delay before tapping
                await device.wait(random.randint(500, 1200))

                await device.tap(following_btn[0], following_btn[1], wait_after=800)

                # Handle the confirmation dialog
                await device.get_screen()

                # Look for "Unfollow" confirmation button in the dialog
                unfollow_confirm = device.find_element_by_text("Unfollow")

                if unfollow_confirm:
                    await device.tap(
                        unfollow_confirm[0], unfollow_confirm[1], wait_after=800
                    )
                    unfollowed += 1
                    await device.send_log(f"Unfollowed user {unfollowed}/{count}")
                else:
                    # Dialog may say something different, try to find any confirmation
                    await device.get_screen()
                    confirm = (
                        device.find_element_by_text("Yes")
                        or device.find_element_by_text("OK")
                        or device.find_element_by_text("Confirm")
                    )
                    if confirm:
                        await device.tap(confirm[0], confirm[1], wait_after=800)
                        unfollowed += 1
                    else:
                        # Tap away to dismiss if no confirmation found
                        await device.back()
                        skipped += 1

                # Random delay between unfollows
                await device.wait(random.randint(1500, 3500))
            else:
                skipped += 1

            # Scroll to load more following users
            if (i + 1) % 4 == 0 or not following_btn:
                await device.scroll_down(amount=500)
                await device.wait(random.randint(800, 1500))

        await device.send_progress(100, f"Unfollowed {unfollowed} users!")
        await device.send_log(
            f"Unfollow session complete: {unfollowed} unfollowed, {skipped} skipped"
        )

        return {
            "success": True,
            "data": {
                "unfollowed": unfollowed,
                "skipped": skipped,
                "target_count": count,
            },
        }

    except Exception as e:
        await device.send_log(f"Unfollow error: {str(e)}", "ERROR")
        return {"success": False, "error": str(e)}



DM_REQUIRED = {"usernames", "message"}
DM_COUNT_MIN = 1
DM_COUNT_MAX = 20


def normalize_dm_config(config: dict) -> dict:
    if not isinstance(config, dict):
        raise ValueError("DM automation config must be an object")

    raw_usernames = config.get("usernames", [])
    if isinstance(raw_usernames, str):
        candidates = raw_usernames.replace("\n", ",").split(",")
    elif isinstance(raw_usernames, (list, tuple, set)):
        candidates = raw_usernames
    else:
        candidates = []

    usernames = []
    seen = set()
    for candidate in candidates:
        username = str(candidate or "").strip().lstrip("@").strip().casefold()
        if not username:
            continue
        if not re.fullmatch(r"[a-z0-9._]{1,30}", username):
            raise ValueError(f"Invalid Instagram username: {candidate}")
        if username not in seen:
            usernames.append(username)
            seen.add(username)

    message = str(config.get("message") or "").strip()
    missing = []
    if not usernames:
        missing.append("usernames")
    if not message:
        missing.append("message")
    if missing:
        raise ValueError(f"DM automation requires non-empty {', '.join(missing)}")

    count = config.get("count", 5)
    if (
        isinstance(count, bool)
        or not isinstance(count, int)
        or not DM_COUNT_MIN <= count <= DM_COUNT_MAX
    ):
        raise ValueError(
            f"DM automation count must be an integer from {DM_COUNT_MIN} to {DM_COUNT_MAX}"
        )

    normalized = dict(config)
    normalized["usernames"] = usernames
    normalized["message"] = message
    normalized["count"] = count
    return normalized


async def execute_dm_automation_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    try:
        config = normalize_dm_config(config)
    except ValueError as error:
        return {"success": False, "error": str(error)}

    message_template = config["message"]
    usernames = config["usernames"][: config["count"]]
    target_count = len(usernames)
    sent = 0
    failed = 0
    recipient_results = []
    active_record = None
    cleanup = {"inbox_verified": False, "home_verified": False}

    inbox_ids = {
        "com.instagram.android:id/action_bar_inbox_button",
        "com.instagram.android:id/direct_tab",
    }
    inbox_labels = {"direct", "messenger", "messages"}
    compose_ids = {
        "com.instagram.android:id/action_bar_button_action",
        "com.instagram.android:id/creation_entrypoint",
    }
    compose_labels = {"new message", "compose"}
    search_ids = {
        "com.instagram.android:id/search_edit_text",
        "com.instagram.android:id/action_bar_search_edit_text",
    }
    username_row_ids = {
        "com.instagram.android:id/row_search_user_username",
    }
    selected_recipient_ids = {
        "com.instagram.android:id/recipient_picker_selected_item_username",
        "com.instagram.android:id/direct_recipient_user",
        "com.instagram.android:id/selected_user_username",
    }
    chat_action_ids = {
        "com.instagram.android:id/action_bar_button_action",
    }
    thread_header_ids = {
        "com.instagram.android:id/action_bar_title",
        "com.instagram.android:id/direct_thread_title",
        "com.instagram.android:id/thread_title",
    }
    composer_ids = {
        "com.instagram.android:id/row_thread_composer_edittext",
    }
    send_ids = {
        "com.instagram.android:id/row_thread_composer_send_button_container",
        "com.instagram.android:id/row_thread_composer_send_button",
    }
    outgoing_message_ids = {
        "com.instagram.android:id/outgoing_message_text",
        "com.instagram.android:id/direct_outgoing_message_text",
        "com.instagram.android:id/direct_text_message_text_view",
        "com.instagram.android:id/row_thread_message_text",
    }
    exact_back_ids = {
        "com.instagram.android:id/action_bar_button_back",
        "com.instagram.android:id/action_bar_back_button",
    }
    inbox_state_ids = {
        "com.instagram.android:id/direct_inbox_recycler_view",
        "com.instagram.android:id/direct_inbox_search_bar",
    }
    home_id = "com.instagram.android:id/feed_tab"

    def normalize_label(value) -> str:
        return " ".join(html.unescape(str(value or "")).strip().split()).casefold()

    def normalize_username(value) -> str:
        return normalize_label(value).lstrip("@").strip()

    def normalize_message_value(value) -> str:
        return str(value or "").replace("\r\n", "\n").replace("\r", "\n")

    def nodes(xml: str):
        return re.findall(r"<node\b[^>]*>", xml or "", re.DOTALL)

    def attr(node: str, name: str) -> str:
        match = re.search(rf'{re.escape(name)}="([^"]*)"', node, re.DOTALL)
        return html.unescape(match.group(1)) if match else ""

    def center(node: str):
        match = re.search(
            r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
            node,
        )
        if not match:
            return None
        x1, y1, x2, y2 = map(int, match.groups())
        return ((x1 + x2) // 2, (y1 + y2) // 2)

    def exact_control(
        xml: str,
        *,
        resource_ids,
        labels=None,
        require_selected=None,
    ):
        wanted_ids = {normalize_label(value) for value in resource_ids}
        wanted_labels = {normalize_label(value) for value in (labels or set())}
        matches = []
        for node in nodes(xml):
            if normalize_label(attr(node, "resource-id")) not in wanted_ids:
                continue
            if 'clickable="true"' not in node.lower() or 'enabled="true"' not in node.lower():
                continue
            if require_selected is not None:
                selected = attr(node, "selected").casefold() == "true"
                if selected != require_selected:
                    continue
            if wanted_labels:
                node_labels = {
                    normalize_label(attr(node, "text")),
                    normalize_label(attr(node, "content-desc")),
                }
                if not (node_labels & wanted_labels):
                    continue
            target = center(node)
            if target:
                matches.append(target)
        return matches[0] if len(matches) == 1 else None

    def exact_recipient_row(xml: str, username: str):
        wanted = normalize_username(username)
        matches = []
        for node in nodes(xml):
            if normalize_label(attr(node, "resource-id")) not in {
                normalize_label(value) for value in username_row_ids
            }:
                continue
            labels = {
                normalize_username(attr(node, "text")),
                normalize_username(attr(node, "content-desc")),
            }
            if wanted not in labels:
                continue
            target = center(node)
            if target:
                matches.append(target)
        return matches[0] if len(matches) == 1 else None

    def selected_recipient_verified(xml: str, username: str) -> bool:
        wanted = normalize_username(username)
        wanted_ids = {normalize_label(value) for value in selected_recipient_ids}
        selected_nodes = []
        for node in nodes(xml):
            if normalize_label(attr(node, "resource-id")) not in wanted_ids:
                continue
            selected = (
                attr(node, "selected").casefold() == "true"
                or attr(node, "checked").casefold() == "true"
            )
            labels = {
                normalize_username(attr(node, "text")),
                normalize_username(attr(node, "content-desc")),
            }
            if selected:
                selected_nodes.append(labels)
        return len(selected_nodes) == 1 and wanted in selected_nodes[0]

    def thread_header_verified(xml: str, username: str) -> bool:
        wanted = normalize_username(username)
        wanted_ids = {normalize_label(value) for value in thread_header_ids}
        for node in nodes(xml):
            if normalize_label(attr(node, "resource-id")) not in wanted_ids:
                continue
            labels = {
                normalize_username(attr(node, "text")),
                normalize_username(attr(node, "content-desc")),
            }
            if wanted in labels:
                return True
        return False

    def composer_control(xml: str):
        return exact_control(xml, resource_ids=composer_ids)

    def composer_message_verified(xml: str, message: str) -> bool:
        wanted = normalize_message_value(message)
        wanted_ids = {normalize_label(value) for value in composer_ids}
        matches = []
        for node in nodes(xml):
            if normalize_label(attr(node, "resource-id")) not in wanted_ids:
                continue
            if 'clickable="true"' not in node.lower() or 'enabled="true"' not in node.lower():
                continue
            values = {
                normalize_message_value(attr(node, "text")),
                normalize_message_value(attr(node, "content-desc")),
            }
            if wanted in values:
                matches.append(node)
        return len(matches) == 1

    def inbox_verified(xml: str) -> bool:
        wanted_ids = {normalize_label(value) for value in inbox_state_ids}
        return any(
            normalize_label(attr(node, "resource-id")) in wanted_ids
            for node in nodes(xml)
        )

    def home_selected(xml: str) -> bool:
        wanted = normalize_label(home_id)
        return any(
            normalize_label(attr(node, "resource-id")) == wanted
            and attr(node, "selected").casefold() == "true"
            for node in nodes(xml)
        )

    def outgoing_message_count(xml: str, message: str) -> int:
        wanted = normalize_message_value(message)
        wanted_ids = {normalize_label(value) for value in outgoing_message_ids}
        sent_specific_ids = {
            normalize_label("com.instagram.android:id/outgoing_message_text"),
            normalize_label("com.instagram.android:id/direct_outgoing_message_text"),
        }
        count = 0
        for node in nodes(xml):
            resource_id = normalize_label(attr(node, "resource-id"))
            if resource_id not in wanted_ids:
                continue
            text = normalize_message_value(attr(node, "text"))
            description = normalize_message_value(attr(node, "content-desc"))
            exact_sent_description = description == f"You sent {wanted}"
            if (text == wanted or exact_sent_description) and (
                resource_id in sent_specific_ids or exact_sent_description
            ):
                count += 1
        return count

    def verification_outcome(stage: str):
        return {
            "success": False,
            "error": "verification_required",
            "code": "verification_required",
            "data": {
                "stage": stage,
                "manual_action_required": True,
                "recovery_required": True,
                "recovery": {
                    "module_id": "ig_verification_recovery",
                    "target_profile_required": True,
                    "sequence": [
                        "airplane_on",
                        "profile_switch",
                        "airplane_off",
                        "instagram_launch",
                    ],
                },
            },
        }

    def blocker_outcome(stage: str):
        return {
            "success": False,
            "error": "action_blocked",
            "code": "action_blocked",
            "data": {"stage": stage, "retryable": False},
        }

    async def refresh_guard(stage: str):
        await device.get_screen()
        xml = device.current_screen or ""
        ig_nodes = [
            node
            for node in nodes(xml)
            if normalize_label(attr(node, "package")) == "com.instagram.android"
        ]
        conversation_surface_ids = {
            normalize_label(value)
            for value in outgoing_message_ids
            | composer_ids
            | {
                "com.instagram.android:id/outgoing_draft_preview",
                "com.instagram.android:id/direct_message_preview",
                "com.instagram.android:id/message_text",
            }
        }
        normal_surface_ids = {
            normalize_label(value)
            for value in (
                inbox_ids
                | inbox_state_ids
                | compose_ids
                | search_ids
                | username_row_ids
                | selected_recipient_ids
                | chat_action_ids
                | thread_header_ids
                | composer_ids
                | send_ids
                | exact_back_ids
                | {home_id}
            )
        }
        modal_root_ids = {
            normalize_label(value)
            for value in {
                "com.instagram.android:id/dialog_root",
                "com.instagram.android:id/igds_dialog_container",
                "com.instagram.android:id/alert_dialog",
                "android:id/parentPanel",
            }
        }
        modal_marker_ids = {
            normalize_label(value)
            for value in {
                "com.instagram.android:id/igds_headline_body",
                "com.instagram.android:id/dialog_message",
                "com.instagram.android:id/challenge_message",
                "com.instagram.android:id/checkpoint_message",
                "android:id/message",
            }
        }
        screen_resource_ids = {
            normalize_label(attr(node, "resource-id")) for node in ig_nodes
        }
        has_modal_structure = bool(
            screen_resource_ids & (modal_root_ids | modal_marker_ids)
        )
        has_normal_surface = bool(screen_resource_ids & normal_surface_ids)
        terminal_signals = []
        for node in ig_nodes:
            resource_id = normalize_label(attr(node, "resource-id"))
            if resource_id in conversation_surface_ids:
                continue
            if (
                not has_modal_structure
                and has_normal_surface
                and resource_id not in modal_marker_ids
            ):
                continue
            terminal_signals.extend(
                normalize_label(value).replace("’", "'").replace("`", "'")
                for value in (
                    attr(node, "text"),
                    attr(node, "content-desc"),
                    attr(node, "resource-id"),
                )
                if normalize_label(value)
            )

        verification_markers = (
            "confirm you're human",
            "confirm you are human",
            "challenge required",
            "help us confirm",
            "verify your identity",
            "confirm it's you",
        )
        blocker_markers = (
            "action blocked",
            "try again later",
            "we restrict certain activity",
            "please wait a few minutes",
            "too many requests",
            "temporarily blocked",
            "feedback_required",
        )
        if any(
            marker in signal
            for marker in verification_markers
            for signal in terminal_signals
        ):
            return verification_outcome(stage)
        if any(
            marker in signal
            for marker in blocker_markers
            for signal in terminal_signals
        ):
            return blocker_outcome(stage)
        return None

    def complete_recipient_results(records):
        by_username = {
            normalize_username(record.get("username")): dict(record)
            for record in records
        }
        completed = []
        for username in usernames:
            existing = by_username.get(normalize_username(username))
            if existing is not None:
                completed.append(existing)
                continue
            completed.append(
                {
                    "username": username,
                    "success": False,
                    "stage": "skipped",
                    "error": "run_stopped_before_attempt",
                    "send_attempted": False,
                    "delivery_state": "not_attempted",
                    "retryable": True,
                    "skipped": True,
                }
            )
        return completed

    def with_progress(outcome: dict, current_recipient=None):
        records = list(recipient_results)
        extra_failed = 0
        if current_recipient is not None:
            record = dict(current_recipient)
            record["success"] = False
            record["stage"] = outcome.get("data", {}).get("stage", record["stage"])
            record["retryable"] = False
            if record["send_attempted"]:
                record["delivery_state"] = "unknown"
            records.append(record)
            extra_failed = 1
        completed_records = complete_recipient_results(records)
        any_send_attempted = any(record.get("send_attempted") for record in records)
        delivery_ambiguous = bool(
            current_recipient is not None
            and current_recipient.get("send_attempted")
            and current_recipient.get("delivery_state") != "confirmed"
        )
        data = dict(outcome.get("data") or {})
        data.update(
            {
                "sent": sent,
                "failed": failed + extra_failed,
                "skipped": sum(record.get("skipped", False) for record in completed_records),
                "target_count": target_count,
                "recipients": completed_records,
                "cleanup": dict(cleanup),
            }
        )
        if any_send_attempted:
            data["retryable"] = False
        if delivery_ambiguous:
            data["delivery_unknown"] = True
            return {**outcome, "error": "delivery_unknown", "data": data}
        return {**outcome, "data": data}

    async def ensure_inbox(stage: str):
        for attempt in range(3):
            guard = await refresh_guard(f"{stage}_{attempt}")
            if guard:
                return False, guard
            xml = device.current_screen or ""
            if inbox_verified(xml):
                return True, None
            back_control = exact_control(
                xml,
                resource_ids=exact_back_ids,
                labels={"Back"},
            )
            if not back_control:
                return False, None
            await device.tap(back_control[0], back_control[1], wait_after=700)
        guard = await refresh_guard(f"{stage}_final")
        if guard:
            return False, guard
        return inbox_verified(device.current_screen or ""), None

    async def rest_home():
        guard = await refresh_guard("rest_home_start")
        if guard:
            return False, guard
        xml = device.current_screen or ""
        if home_selected(xml):
            return True, None
        if not inbox_verified(xml):
            inbox_ok, guard = await ensure_inbox("rest_home_inbox")
            if guard or not inbox_ok:
                return False, guard
            xml = device.current_screen or ""
        home_control = exact_control(
            xml,
            resource_ids={home_id},
            labels={"Home"},
            require_selected=False,
        )
        if home_control:
            await device.tap(home_control[0], home_control[1], wait_after=700)
        else:
            back_control = exact_control(
                xml,
                resource_ids=exact_back_ids,
                labels={"Back"},
            )
            if not back_control:
                return False, None
            await device.tap(back_control[0], back_control[1], wait_after=700)
        guard = await refresh_guard("rest_home_verify")
        if guard:
            return False, guard
        return home_selected(device.current_screen or ""), None

    async def pre_send_failure(record: dict, stage: str, error: str):
        nonlocal failed, active_record
        record.update(
            {
                "success": False,
                "stage": stage,
                "error": error,
                "send_attempted": False,
                "delivery_state": "not_attempted",
                "retryable": True,
            }
        )
        recipient_results.append(record)
        failed += 1
        active_record = None
        inbox_ok, guard = await ensure_inbox(f"cleanup_{stage}")
        cleanup["inbox_verified"] = inbox_ok
        return inbox_ok, guard

    async def initial_failure(error: str, stage: str, retryable: bool = True):
        home_ok, guard = await rest_home()
        if guard:
            return with_progress(guard)
        cleanup["home_verified"] = home_ok
        completed_records = complete_recipient_results(recipient_results)
        return {
            "success": False,
            "error": error,
            "data": {
                "stage": stage,
                "sent": sent,
                "failed": failed,
                "skipped": sum(record.get("skipped", False) for record in completed_records),
                "target_count": target_count,
                "recipients": completed_records,
                "retryable": retryable,
                "cleanup": dict(cleanup),
            },
        }

    await device.send_log(f"Starting DM automation for {target_count} recipient(s)")
    await device.send_progress(0, "Starting DM automation...")

    try:
        guard = await refresh_guard("launch_preflight")
        if guard:
            return with_progress(guard)
        if not home_selected(device.current_screen or ""):
            await device.launch_app("com.instagram.android", wait_after=3000)
            guard = await refresh_guard("launch_complete")
            if guard:
                return with_progress(guard)

        xml = device.current_screen or ""
        inbox_control = exact_control(
            xml,
            resource_ids=inbox_ids,
            labels=inbox_labels,
        )
        if not inbox_control:
            return await initial_failure("dm_inbox_control_missing", "open_inbox")
        await device.tap(inbox_control[0], inbox_control[1], wait_after=1000)
        guard = await refresh_guard("inbox_opened")
        if guard:
            return with_progress(guard)
        if not inbox_verified(device.current_screen or ""):
            return await initial_failure("dm_inbox_not_verified", "open_inbox")
        cleanup["inbox_verified"] = True

        delivery_unknown = False
        stop_run = False
        for index, username in enumerate(usernames):
            progress = 10 + int(((index + 1) / target_count) * 80)
            await device.send_progress(progress, f"Messaging @{username}...")
            record = {
                "username": username,
                "success": False,
                "stage": "inbox",
                "send_attempted": False,
                "delivery_state": "not_attempted",
                "retryable": True,
            }
            active_record = record

            guard = await refresh_guard(f"recipient_{index}_inbox")
            if guard:
                return with_progress(guard, record)
            xml = device.current_screen or ""
            if not inbox_verified(xml):
                inbox_ok, guard = await ensure_inbox(f"recipient_{index}_recover_inbox")
                if guard:
                    return with_progress(guard, record)
                if not inbox_ok:
                    await pre_send_failure(record, "inbox_unverified", "dm_inbox_not_verified")
                    break
                xml = device.current_screen or ""

            compose_control = exact_control(
                xml,
                resource_ids=compose_ids,
                labels=compose_labels,
            )
            if not compose_control:
                can_continue, guard = await pre_send_failure(
                    record, "compose_missing", "compose_control_missing"
                )
                if guard:
                    return with_progress(guard)
                if not can_continue:
                    break
                continue
            cleanup["inbox_verified"] = False
            await device.tap(compose_control[0], compose_control[1], wait_after=700)
            guard = await refresh_guard(f"recipient_{index}_compose_opened")
            if guard:
                return with_progress(guard, record)

            xml = device.current_screen or ""
            search_control = exact_control(xml, resource_ids=search_ids)
            if not search_control:
                can_continue, guard = await pre_send_failure(
                    record, "search_missing", "recipient_search_control_missing"
                )
                if guard:
                    return with_progress(guard)
                if not can_continue:
                    break
                continue
            await device.tap(search_control[0], search_control[1], wait_after=300)
            guard = await refresh_guard(f"recipient_{index}_search_focused")
            if guard:
                return with_progress(guard, record)
            await device.input_text(username, clear_first=True)
            guard = await refresh_guard(f"recipient_{index}_search_results")
            if guard:
                return with_progress(guard, record)

            xml = device.current_screen or ""
            recipient_control = exact_recipient_row(xml, username)
            if not recipient_control:
                can_continue, guard = await pre_send_failure(
                    record, "recipient_missing", "exact_recipient_not_found"
                )
                if guard:
                    return with_progress(guard)
                if not can_continue:
                    break
                continue
            await device.tap(recipient_control[0], recipient_control[1], wait_after=700)
            guard = await refresh_guard(f"recipient_{index}_selected")
            if guard:
                return with_progress(guard, record)

            xml = device.current_screen or ""
            if not selected_recipient_verified(xml, username):
                can_continue, guard = await pre_send_failure(
                    record, "recipient_selection", "selected_recipient_not_verified"
                )
                if guard:
                    return with_progress(guard)
                if not can_continue:
                    break
                continue
            chat_control = exact_control(
                xml,
                resource_ids=chat_action_ids,
                labels={"Chat", "Next"},
            )
            if not chat_control:
                can_continue, guard = await pre_send_failure(
                    record, "chat_action_missing", "chat_action_not_verified"
                )
                if guard:
                    return with_progress(guard)
                if not can_continue:
                    break
                continue
            await device.tap(chat_control[0], chat_control[1], wait_after=1000)
            guard = await refresh_guard(f"recipient_{index}_thread_opened")
            if guard:
                return with_progress(guard, record)

            xml = device.current_screen or ""
            if not thread_header_verified(xml, username):
                can_continue, guard = await pre_send_failure(
                    record, "thread_identity", "thread_recipient_not_verified"
                )
                if guard:
                    return with_progress(guard)
                if not can_continue:
                    break
                continue
            composer = composer_control(xml)
            if not composer:
                can_continue, guard = await pre_send_failure(
                    record, "composer_missing", "exact_composer_not_found"
                )
                if guard:
                    return with_progress(guard)
                if not can_continue:
                    break
                continue

            previous_outgoing = outgoing_message_count(xml, message_template)
            await device.tap(composer[0], composer[1], wait_after=300)
            guard = await refresh_guard(f"recipient_{index}_composer_focused")
            if guard:
                return with_progress(guard, record)
            focused_xml = device.current_screen or ""
            if not thread_header_verified(focused_xml, username):
                can_continue, guard = await pre_send_failure(
                    record, "thread_identity", "thread_recipient_changed"
                )
                if guard:
                    return with_progress(guard)
                if not can_continue:
                    break
                continue
            if not composer_control(focused_xml):
                can_continue, guard = await pre_send_failure(
                    record, "composer_missing", "exact_composer_lost_before_typing"
                )
                if guard:
                    return with_progress(guard)
                if not can_continue:
                    break
                continue

            await device.input_text(message_template, typing_mode="human")
            guard = await refresh_guard(f"recipient_{index}_message_typed")
            if guard:
                return with_progress(guard, record)
            xml = device.current_screen or ""
            if not thread_header_verified(xml, username) or not composer_control(xml):
                can_continue, guard = await pre_send_failure(
                    record, "thread_identity", "thread_or_composer_lost_before_send"
                )
                if guard:
                    return with_progress(guard)
                if not can_continue:
                    break
                continue
            if not composer_message_verified(xml, message_template):
                can_continue, guard = await pre_send_failure(
                    record, "composer_content", "composer_message_not_exact"
                )
                if guard:
                    return with_progress(guard)
                if not can_continue:
                    break
                continue
            send_control = exact_control(
                xml,
                resource_ids=send_ids,
                labels={"Send"},
            )
            if not send_control:
                can_continue, guard = await pre_send_failure(
                    record, "send_missing", "exact_send_control_not_found"
                )
                if guard:
                    return with_progress(guard)
                if not can_continue:
                    break
                continue

            record["send_attempted"] = True
            await device.tap(send_control[0], send_control[1], wait_after=700)

            delivery_confirmed = False
            for poll in range(4):
                guard = await refresh_guard(f"recipient_{index}_send_verify_{poll}")
                if guard:
                    return with_progress(guard, record)
                xml = device.current_screen or ""
                if (
                    thread_header_verified(xml, username)
                    and composer_control(xml)
                    and outgoing_message_count(xml, message_template) > previous_outgoing
                ):
                    delivery_confirmed = True
                    break
                if poll < 3:
                    await device.wait(400)

            if not delivery_confirmed:
                record.update(
                    {
                        "success": False,
                        "stage": "delivery_verification",
                        "error": "delivery_unknown_after_send",
                        "delivery_state": "unknown",
                        "retryable": False,
                    }
                )
                recipient_results.append(record)
                failed += 1
                active_record = None
                delivery_unknown = True
                inbox_ok, guard = await ensure_inbox("cleanup_delivery_unknown")
                cleanup["inbox_verified"] = inbox_ok
                if guard:
                    return with_progress(guard)
                stop_run = True
                break

            record.update(
                {
                    "success": True,
                    "stage": "delivery_confirmed",
                    "delivery_state": "confirmed",
                    "retryable": False,
                }
            )
            recipient_results.append(record)
            sent += 1
            active_record = None
            await device.send_log(f"Confirmed DM delivery to @{username}")

            inbox_ok, guard = await ensure_inbox(f"recipient_{index}_cleanup")
            cleanup["inbox_verified"] = inbox_ok
            if guard:
                return with_progress(guard)
            if not inbox_ok:
                stop_run = True
                break

        home_ok, guard = await rest_home()
        if guard:
            return with_progress(guard)
        cleanup["home_verified"] = home_ok

        success = (
            not stop_run
            and not delivery_unknown
            and failed == 0
            and sent == target_count
            and home_ok
        )
        if success:
            error = None
        elif delivery_unknown:
            error = "delivery_unknown"
        elif not home_ok:
            error = "dm_cleanup_home_unverified"
        else:
            error = "dm_automation_partial_failure"
        any_send_attempted = any(
            record.get("send_attempted") for record in recipient_results
        )
        overall_retryable = not any_send_attempted and not delivery_unknown and all(
            record.get("retryable", False)
            for record in recipient_results
            if not record.get("success")
        )

        await device.send_progress(100, f"Confirmed {sent}/{target_count} DMs")
        await device.send_log(f"DM automation complete: {sent} confirmed, {failed} failed")
        result = {
            "success": success,
            "data": {
                "sent": sent,
                "failed": failed,
                "skipped": target_count - sent - failed,
                "target_count": target_count,
                "recipients": complete_recipient_results(recipient_results),
                "retryable": overall_retryable,
                "cleanup": cleanup,
            },
        }
        if error:
            result["error"] = error
        return result

    except Exception as error:
        await device.send_log(f"DM automation error: {str(error)}", "ERROR")
        result_error = str(error)
        retryable = True
        if active_record is not None and active_record not in recipient_results:
            record = dict(active_record)
            record["success"] = False
            record["error"] = str(error)
            if record.get("send_attempted"):
                record["stage"] = "delivery_verification"
                record["delivery_state"] = "unknown"
                record["retryable"] = False
                result_error = "delivery_unknown"
                retryable = False
            else:
                record["stage"] = "runtime_error_before_send"
                record["delivery_state"] = "not_attempted"
                record["retryable"] = True
            recipient_results.append(record)
            failed += 1
        if any(record.get("send_attempted") for record in recipient_results):
            retryable = False
        completed_records = complete_recipient_results(recipient_results)
        return {
            "success": False,
            "error": result_error,
            "data": {
                "sent": sent,
                "failed": failed,
                "skipped": sum(record.get("skipped", False) for record in completed_records),
                "target_count": target_count,
                "recipients": completed_records,
                "retryable": retryable,
                "cleanup": cleanup,
            },
        }


async def execute_comment_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based comment module.
    Uses RemoteDevice to send commands to Electron client via WebSocket.
    """
    import random

    count = config.get("count", 5)
    comments = config.get(
        "comments",
        [
            "🔥",
            "💯",
            "Nice!",
            "Amazing 🙌",
            "Love this!",
            "👏",
            "❤️",
            "So good!",
            "Great content!",
            "💪",
        ],
    )

    await device.send_progress(0, f"Initializing commenter ({count} comments)...")

    stats = {"commented": 0, "failed": 0}

    try:
        # Launch Instagram
        await device.send_progress(5, "Launching Instagram...")
        await device.launch_app("com.instagram.android", wait_after=3000)

        # Dismiss popups
        await device.send_progress(8, "Checking for popups...")
        await device.dismiss_common_popups()

        # Navigate to home feed
        # DO NOT use find_element_by_content_description("Home") — it matches
        # the Instagram logo at (540, 201) which opens Following/Favorites dropdown!
        # ig_ui_map: Home tab [0,2211][216,2337] center (108,2274)
        await device.send_progress(10, "Navigating to home feed...")
        await device.tap(108, 2274, wait_after=2000)

        await device.wait(1500)

        # Comment on posts
        for i in range(count):
            progress = 15 + int((i / count) * 80)
            await device.send_progress(
                progress, f"Commenting on post {i + 1}/{count}..."
            )

            # Wait to simulate viewing
            await device.wait(random.randint(1500, 3000))

            # Refresh screen state
            await device.get_screen()

            # Find and tap comment icon
            comment_icon = device.find_element_by_resource_id(
                "com.instagram.android:id/row_feed_button_comment"
            ) or device.find_element_by_content_description("Comment")

            if comment_icon:
                await device.tap(comment_icon[0], comment_icon[1], wait_after=2000)

                # Tap input field to focus
                await device.get_screen()
                input_field = device.find_element_by_resource_id(
                    "com.instagram.android:id/layout_comment_thread_edittext"
                )
                if input_field:
                    await device.tap(input_field[0], input_field[1], wait_after=500)

                # Type comment
                comment_text = random.choice(comments)
                await device.input_text(comment_text)
                await device.wait(random.randint(800, 1500))

                # Find and tap Post button (resource-id first, then text, then fallback)
                await device.get_screen()
                post_btn = device.find_element_by_resource_id(
                    "com.instagram.android:id/layout_comment_thread_post_button_icon"
                ) or device.find_element_by_text("Post")
                if post_btn:
                    await device.tap(post_btn[0], post_btn[1], wait_after=800)
                    stats["commented"] += 1
                else:
                    # Fallback coordinate from ig_ui_map
                    await device.tap(977, 1441, wait_after=800)
                    stats["commented"] += 1

                # Close comment sheet: back to dismiss keyboard, back to close sheet
                await device.back()
                await device.wait(400)
                await device.back()
                await device.wait(600)
            else:
                stats["failed"] += 1

            # Scroll to next post
            await device.scroll_feed()
            await device.wait(500)

        await device.send_progress(100, f"Posted {stats['commented']} comments!")

        return {"success": True, "data": stats}

    except Exception as e:
        return {"success": False, "error": str(e)}


async def execute_hashtag_engagement_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based hashtag engagement module.
    Uses RemoteDevice to send commands to Electron client via WebSocket.
    """
    import random

    # Support both single hashtag (from unified module) and array (from legacy/workflow)
    single_hashtag = config.get("hashtag", "")
    hashtags = config.get("hashtags", [])
    if single_hashtag and not hashtags:
        hashtags = [single_hashtag]
    if not hashtags:
        hashtags = ["photography", "travel"]
    # Clean hashtags - remove # prefix if present
    hashtags = [h.lstrip("#").strip() for h in hashtags if h.strip()]

    likes_per_hashtag = config.get("likes_per_hashtag", config.get("count", 10))
    like_chance = config.get("like_chance", 80)

    await device.send_progress(0, f"Hashtag engage: {', '.join(hashtags)}...")

    stats = {"total_liked": 0, "hashtags_engaged": 0}

    try:
        # Launch Instagram
        await device.send_progress(5, "Launching Instagram...")
        await device.launch_app("com.instagram.android", wait_after=3000)

        # Dismiss popups
        await device.dismiss_common_popups()

        for idx, hashtag in enumerate(hashtags):
            base_progress = 10 + int((idx / len(hashtags)) * 80)
            await device.send_progress(base_progress, f"Searching #{hashtag}...")

            # Navigate to search
            await device.get_screen()
            search_icon = device.find_element_by_resource_id(
                "com.instagram.android:id/search_tab"
            )
            if search_icon:
                await device.tap(search_icon[0], search_icon[1], wait_after=800)
        else:
            await device.tap(
                756, 2274, wait_after=800
            )  # ig_ui_map: Search tab center (756, 2274)

            await device.wait(1000)

            # Find and tap search bar
            await device.get_screen()
            search_bar = device.find_element_by_resource_id(
                "com.instagram.android:id/action_bar_search_edit_text"
            )
            if search_bar:
                await device.tap(search_bar[0], search_bar[1], wait_after=1000)
            else:
                await device.tap(
                    540, 200, wait_after=1000
                )  # Fallback search bar coords

            # Type hashtag
            await device.input_text(f"#{hashtag}")
            await device.wait(1500)

            # Tap first result (hashtag row)
            await device.get_screen()
            hashtag_result = device.find_element_by_text(f"#{hashtag}")
            if hashtag_result:
                await device.tap(hashtag_result[0], hashtag_result[1], wait_after=2000)
            else:
                # Try tapping first result area
                await device.tap(540, 400, wait_after=2000)

            await device.wait(1500)

            # Engage with posts in hashtag feed
            for i in range(likes_per_hashtag):
                progress = base_progress + int(
                    (i / likes_per_hashtag) * (80 / len(hashtags))
                )
                await device.send_progress(
                    progress, f"#{hashtag}: Liking post {i + 1}/{likes_per_hashtag}..."
                )

                # Humanized viewing time
                await device.wait(random.randint(1500, 4000))

                # Random like (tap like button with resource ID)
                if random.randint(1, 100) <= like_chance:
                    if await device.find_and_tap_like_button():
                        stats["total_liked"] += 1

                # Scroll to next post (moderate feed scroll, not full-page snap)
                sx = random.randint(460, 620)
                scroll_amt = random.randint(800, 1400)
                scroll_dur = random.randint(250, 500)
                sy = random.randint(1500, 1800)
                await device.swipe(
                    sx, sy, sx + random.randint(-20, 20), sy - scroll_amt, scroll_dur
                )
                await device.wait(random.randint(400, 900))

            stats["hashtags_engaged"] += 1

            # Go back to home for next hashtag
            await device.back()
            await device.wait(500)
            await device.back()
            await device.wait(500)

        await device.send_progress(
            100,
            f"Liked {stats['total_liked']} posts from {stats['hashtags_engaged']} hashtags!",
        )

        return {"success": True, "data": stats}

    except Exception as e:
        return {"success": False, "error": str(e)}


# Register WebSocket handlers
# NOTE: Handlers are registered via .update() calls AFTER they're defined below
WS_MODULE_HANDLERS = {
    # Core modules will be added via .update() after function definitions
}


async def execute_explore_engagement_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based explore engagement module.
    Uses RemoteDevice to send commands to Electron client via WebSocket.
    """
    import random

    count = config.get("count", 15)
    like_chance = config.get("like_chance", 75)

    await device.send_progress(0, f"Initializing explore engager ({count} posts)...")

    stats = {"engaged": 0, "liked": 0}

    try:
        # Launch Instagram
        await device.send_progress(5, "Launching Instagram...")
        await device.launch_app("com.instagram.android", wait_after=3000)

        # Dismiss popups
        await device.dismiss_common_popups()

        # Navigate to Explore/Search tab
        # ig_ui_map: Search tab content-desc="Search and Explore" [216,2227][432,2400] center (324,2313)
        await device.send_progress(10, "Navigating to Explore...")
        await device.get_screen()

        search_icon = device.find_element_by_content_description(
            "Search and Explore"
        ) or device.find_element_by_content_description("Search")
        if search_icon:
            await device.tap(search_icon[0], search_icon[1], wait_after=2000)
        else:
            await device.tap(
                756, 2274, wait_after=2000
            )  # ADB-VERIFIED Search tab center

        await device.wait(1500)

        # Tap on first explore post to enter feed mode
        await device.send_progress(15, "Opening explore feed...")
        await device.tap(270, 600, wait_after=2000)  # First post in explore grid

        # Engage with explore posts
        for i in range(count):
            progress = 20 + int((i / count) * 75)
            await device.send_progress(progress, f"Engaging post {i + 1}/{count}...")

            stats["engaged"] += 1

            # Humanized viewing time
            view_time = int(random.triangular(1500, 5000, 2500))
            await device.wait(view_time)

            # Random like (use proper double-tap method)
            if random.randint(1, 100) <= like_chance:
                await device.get_screen()
                if not device.is_liked():
                    # Try resource ID first, then double-tap
                    liked = await device.find_and_tap_like_button()
                    if not liked:
                        await device.double_tap_to_like(
                            random.randint(400, 680), random.randint(1000, 1400)
                        )
                    stats["liked"] += 1

            # Scroll to next post (moderate feed scroll)
            sx = random.randint(460, 620)
            scroll_amt = random.randint(800, 1400)
            scroll_dur = random.randint(250, 500)
            sy = random.randint(1500, 1800)
            await device.swipe(
                sx, sy, sx + random.randint(-20, 20), sy - scroll_amt, scroll_dur
            )
            await device.wait(random.randint(400, 900))

        await device.send_progress(
            100,
            f"Engaged with {stats['engaged']} explore posts ({stats['liked']} liked)!",
        )

        return {"success": True, "data": stats}

    except Exception as e:
        return {"success": False, "error": str(e)}


async def execute_account_validator_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based current-profile validator.
    Mirrors legacy behavior: scan Gmail + IG accounts, enforce 5-per-profile caps,
    and return overflow + basic matching diagnostics.
    """
    def _uniq(items: List[str]) -> List[str]:
        seen = set()
        out: List[str] = []
        for item in items:
            normalized = (item or "").strip().lower()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            out.append(normalized)
        return out

    def _extract_emails(xml: str) -> List[str]:
        if not xml:
            return []
        out: List[str] = []
        patterns = [
            r'text="([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})"',
            r'content-desc="([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})"',
            r"Account\s*\{\s*name=([^,]+),\s*type=com\.google\}",
        ]
        for pat in patterns:
            out.extend(re.findall(pat, xml))
        return _uniq(out)

    def _looks_like_ig_login(xml: str) -> bool:
        lower = (xml or "").lower()
        return (
            "log in" in lower
            and ("password" in lower or "username, email" in lower)
        ) or ("create new account" in lower and "instagram" in lower)

    def _normalize_username(value: str) -> str:
        return (value or "").strip().lstrip("@").lower()

    def _normalize_email(value: str) -> str:
        return (value or "").strip().lower()

    def _is_switcher_open(xml: str) -> bool:
        """
        Detect whether the Instagram account-switcher sheet is truly open.
        Important: "Select account" appears on the profile title even when the
        switcher is closed, so we do not use it as a standalone signal.
        """
        raw = xml or ""
        lower = raw.lower()
        explicit_markers = (
            "add instagram account",
            "create new account",
            "log into existing account",
            "log in to existing account",
            "use another account",
        )
        if any(marker in lower for marker in explicit_markers):
            return True

        # Resource-id based fallback for switcher/account-row layouts.
        return bool(
            re.search(
                r'resource-id="[^"]*(?:account_switcher|switcher_sheet|account_row|account_name|row_user)[^"]*"',
                raw,
                re.IGNORECASE,
            )
        )

    def _extract_ig_usernames(xml: str, current_username: str = "") -> List[str]:
        if not xml:
            return [current_username] if current_username else []

        usernames: List[str] = []

        # Prefer resource-bound usernames from account switcher layouts.
        scoped_patterns = [
            r'resource-id="[^"]*(?:account_name|account_row|row_user|username|switcher)[^"]*"[^>]*text="([a-zA-Z0-9._]{3,30})"',
            r'text="([a-zA-Z0-9._]{3,30})"[^>]*resource-id="[^"]*(?:account_name|account_row|row_user|username|switcher)[^"]*"',
            r'content-desc="([a-zA-Z0-9._]{3,30}),\s*select account"',
        ]
        for pat in scoped_patterns:
            usernames.extend(re.findall(pat, xml, re.IGNORECASE))

        # Account-switcher rows can also expose usernames in content-desc,
        # e.g. "ocojili715, 15 notifications".
        if _is_switcher_open(xml):
            desc_based = re.findall(
                r'content-desc="([a-zA-Z0-9._]{3,30})(?:,\s*\d+\s+notifications?)?"',
                xml,
                re.IGNORECASE,
            )
            usernames.extend(desc_based)

        if current_username:
            usernames.append(_normalize_username(current_username))

        # Filter obvious non-username tokens that may appear in switcher sheets.
        blacklist = {
            "profile",
            "cancel",
            "accounts",
            "center",
            "meta",
            "notifications",
            "create",
            "new",
            "add",
            "instagram",
            "account",
            "open",
            "overflow",
            "menu",
            "other",
            "logo",
        }
        filtered: List[str] = []
        for item in usernames:
            candidate = _normalize_username(item)
            if (
                candidate
                and any(ch.isalpha() for ch in candidate)
                and candidate not in blacklist
            ):
                filtered.append(candidate)

        return _uniq(filtered)

    def _normalize_expected_accounts(raw_expected) -> List[Dict[str, str]]:
        if not isinstance(raw_expected, list):
            return []

        normalized: List[Dict[str, str]] = []
        for item in raw_expected:
            if isinstance(item, dict):
                username = _normalize_username(str(item.get("username", "")))
                email = _normalize_email(str(item.get("email", "")))
                recovery_email = _normalize_email(str(item.get("recovery_email", "")))
                phone_profile_id = str(item.get("phone_profile_id", "")).strip()
                profile_ref = str(item.get("profile_id", "")).strip()
                device_ref = str(item.get("device_id", "")).strip()
                account_id = str(item.get("id", "")).strip()
            elif isinstance(item, str):
                raw = item.strip()
                if "@" in raw:
                    email = _normalize_email(raw)
                    username = _normalize_username(raw.split("@", 1)[0])
                else:
                    username = _normalize_username(raw)
                    email = ""
                recovery_email = ""
                phone_profile_id = ""
                profile_ref = ""
                device_ref = ""
                account_id = ""
            else:
                continue

            if not username and not email:
                continue

            normalized.append(
                {
                    "id": account_id,
                    "username": username,
                    "email": email,
                    "recovery_email": recovery_email,
                    "phone_profile_id": phone_profile_id,
                    "profile_id": profile_ref,
                    "device_id": device_ref,
                }
            )

        seen = set()
        out: List[Dict[str, str]] = []
        for row in normalized:
            key = (row.get("username", ""), row.get("email", ""))
            if key in seen:
                continue
            seen.add(key)
            out.append(row)
        return out

    def _is_device_unavailable_error(err: Exception) -> bool:
        msg = str(err or "").lower()
        return (
            "device not found" in msg
            or "no devices/emulators found" in msg
            or "device offline" in msg
            or "device unauthorized" in msg
            or "cannot find the file specified" in msg
        )

    await device.send_progress(0, "Validating current profile accounts...")

    # Fast preflight so we fail with a clear message when ADB loses the phone.
    try:
        await device.shell("getprop ro.product.model")
    except Exception as e:
        if _is_device_unavailable_error(e):
            return {
                "success": False,
                "error": "Phone connection lost. Reconnect the selected device and run Validate again.",
            }
        return {
            "success": False,
            "error": f"Could not communicate with the phone: {e}",
        }

    # Profile metadata
    current_user = (await device.shell("am get-current-user") or "").strip()
    profile_name = f"user_{current_user or profile_id}"
    users_raw = await device.shell("pm list users")
    if users_raw:
        for line in users_raw.splitlines():
            match = re.search(r"UserInfo\{(\d+):([^:]+):", line)
            if match and match.group(1) == current_user:
                profile_name = match.group(2).strip()
                break

    # Optional expected account records supplied by dashboard context.
    raw_expected_accounts = _normalize_expected_accounts(config.get("expected_accounts", []))

    # ---- Gmail scan ----
    await device.send_progress(15, "Scanning Gmail accounts...")
    gmail_accounts: List[str] = []
    try:
        await device.launch_app("com.google.android.gm", wait_after=800)
        await device.wait(550)
        await device.get_screen()

        # Dismiss common onboarding prompts that block picker.
        if device.text_on_screen("Got it") or device.text_on_screen("GOT IT"):
            got_it = device.find_element_by_text("Got it") or device.find_element_by_text(
                "GOT IT"
            )
            if got_it:
                await device.tap(got_it[0], got_it[1], wait_after=350)
                await device.get_screen()

        if device.text_on_screen("TAKE ME TO GMAIL") or device.text_on_screen(
            "Take me to Gmail"
        ):
            take_me = device.find_element_by_text("TAKE ME TO GMAIL") or device.find_element_by_text(
                "Take me to Gmail"
            )
            if take_me:
                await device.tap(take_me[0], take_me[1], wait_after=450)
                await device.get_screen()

        # Open account picker.
        avatar = (
            device.find_element_by_resource_id("com.google.android.gm:id/account_avatar")
            or device.find_element_by_resource_id(
                "com.google.android.gm:id/og_apd_ring_view"
            )
            or device.find_element_by_content_description("Show navigation drawer")
        )
        if avatar:
            await device.tap(avatar[0], avatar[1], wait_after=350)
        else:
            width, height = await device.get_screen_size()
            await device.tap(int(width * 0.91), int(height * 0.085), wait_after=350)

        gmail_xml = await device.get_screen()
        gmail_accounts = _extract_emails(gmail_xml or "")
    except Exception as e:
        if _is_device_unavailable_error(e):
            await device.send_log(
                "Gmail scan failed because the phone disconnected from ADB."
            )
            return {
                "success": False,
                "error": "Phone connection lost during Gmail scan. Reconnect and retry Validate.",
            }
        await device.send_log(f"Gmail UI scan failed: {e}")

    if not gmail_accounts:
        try:
            dumpsys_accounts = await device.shell("dumpsys account")
            gmail_accounts = _extract_emails(dumpsys_accounts or "")
        except Exception:
            pass

    # Clean up Gmail task state for downstream modules.
    try:
        await device.shell("am force-stop com.google.android.gm")
        await device.wait(200)
    except Exception:
        pass
    try:
        await device.home()
    except Exception as e:
        if _is_device_unavailable_error(e):
            return {
                "success": False,
                "error": "Phone connection lost while returning to Home. Reconnect and retry Validate.",
            }
        raise

    # ---- Instagram scan ----
    await device.send_progress(55, "Scanning Instagram accounts...")
    ig_accounts: List[str] = []
    current_username = ""
    try:
        await device.launch_app("com.instagram.android", wait_after=800)
        await device.dismiss_common_popups()
        screen_xml = await device.get_screen()

        if not _looks_like_ig_login(screen_xml or ""):
            await device.navigate_to_profile()
            await device.wait(320)
            await device.get_screen()
            current_username = (
                device.get_text_content("com.instagram.android:id/action_bar_large_title")
                or device.get_text_content("com.instagram.android:id/action_bar_title")
                or ""
            )
            current_username = _normalize_username(current_username)

            switcher_xml = await device.get_screen()
            switcher_open = False

            # Prefer tapping account title area first (stable and non-disruptive).
            for rid in [
                "com.instagram.android:id/action_bar_large_title",
                "com.instagram.android:id/action_bar_title",
                "com.instagram.android:id/action_bar_new_title_container",
            ]:
                title_btn = device.find_element_by_resource_id(rid)
                if not title_btn:
                    continue
                await device.tap(title_btn[0], title_btn[1], wait_after=320)
                switcher_xml = await device.get_screen()
                if _is_switcher_open(switcher_xml or ""):
                    switcher_open = True
                    break

            # Fallback: long-press profile tab only when title tap did not open switcher.
            if not switcher_open:
                # 2.19.0: same y>=2000 bounds guard as the other Profile-tab
                # lookups in this file (account creation, ig_account_switch).
                # On Reels feed the content-desc "Profile" matches the reel
                # creator's profile link in the reel header, not bottom-nav.
                profile_tab = device.find_element_by_resource_id(
                    "com.instagram.android:id/profile_tab"
                )
                if not profile_tab:
                    candidate = device.find_element_by_content_description("Profile")
                    if candidate and candidate[1] >= 2000:
                        profile_tab = candidate
                if profile_tab:
                    await device.swipe(
                        int(profile_tab[0]),
                        int(profile_tab[1]),
                        int(profile_tab[0]),
                        int(profile_tab[1]),
                        900,
                        wait_after=380,
                    )
                    switcher_xml = await device.get_screen()

            ig_accounts = _extract_ig_usernames(
                switcher_xml or "", current_username=current_username
            )

            # Close switcher/panel if still open.
            if _is_switcher_open(switcher_xml or ""):
                await device.back()
                await device.wait(120)
    except Exception as e:
        if _is_device_unavailable_error(e):
            await device.send_log(
                "Instagram scan failed because the phone disconnected from ADB."
            )
            return {
                "success": False,
                "error": "Phone connection lost during Instagram scan. Reconnect and retry Validate.",
            }
        await device.send_log(f"Instagram scan failed: {e}")
        if current_username:
            ig_accounts = [current_username]

    # Enforce legacy per-profile caps.
    active_gmail = gmail_accounts[:5]
    active_ig = ig_accounts[:5]
    overflow_gmail = gmail_accounts[5:] if len(gmail_accounts) > 5 else []
    overflow_ig = ig_accounts[5:] if len(ig_accounts) > 5 else []

    # Matching diagnostics:
    # 1) heuristic local-part matching (legacy)
    # 2) explicit saved pair matching when expected_accounts is provided
    gmail_bases = {_normalize_username(e.split("@", 1)[0]) for e in active_gmail if "@" in e}
    ig_set = {_normalize_username(u) for u in active_ig}
    matched = sorted(gmail_bases.intersection(ig_set))
    gmail_without_ig = sorted(gmail_bases.difference(ig_set))
    ig_without_gmail = sorted(ig_set.difference(gmail_bases))

    expected_accounts = raw_expected_accounts
    if expected_accounts:
        filtered_expected = [
            row
            for row in expected_accounts
            if not row.get("phone_profile_id")
            or str(row.get("phone_profile_id")).strip() == str(current_user).strip()
        ]
        if filtered_expected:
            expected_accounts = filtered_expected

    saved_pairs = None
    if expected_accounts:
        expected_usernames = {
            _normalize_username(row.get("username", ""))
            for row in expected_accounts
            if row.get("username")
        }
        expected_emails = {
            _normalize_email(row.get("email", ""))
            for row in expected_accounts
            if row.get("email")
        }
        gmail_set = {_normalize_email(e) for e in active_gmail}

        per_account = []
        fully_matched_pairs = []
        missing_instagram_for_saved = []
        missing_gmail_for_saved = []

        for row in expected_accounts:
            username = _normalize_username(row.get("username", ""))
            email = _normalize_email(row.get("email", ""))
            recovery_email = _normalize_email(row.get("recovery_email", ""))
            ig_present = bool(username) and username in ig_set
            gmail_present = bool(email) and email in gmail_set
            recovery_present = bool(recovery_email) and recovery_email in gmail_set
            pair_valid = ig_present and (gmail_present or recovery_present)

            per_account.append(
                {
                    "id": row.get("id", ""),
                    "username": username,
                    "email": email,
                    "recovery_email": recovery_email,
                    "instagram_present": ig_present,
                    "gmail_present": gmail_present,
                    "recovery_gmail_present": recovery_present,
                    "pair_valid": pair_valid,
                }
            )

            if pair_valid:
                fully_matched_pairs.append(username or email)
            if username and not ig_present:
                missing_instagram_for_saved.append(username)
            if email and not gmail_present and not recovery_present:
                missing_gmail_for_saved.append(email)

        saved_pairs = {
            "total_expected": len(expected_accounts),
            "fully_matched_pairs": sorted(_uniq(fully_matched_pairs)),
            "missing_instagram_for_saved": sorted(_uniq(missing_instagram_for_saved)),
            "missing_gmail_for_saved": sorted(_uniq(missing_gmail_for_saved)),
            "unexpected_instagram_on_device": sorted(
                ig_set.difference(expected_usernames)
            ),
            "unexpected_gmail_on_device": sorted(gmail_set.difference(expected_emails)),
            "per_account": per_account,
        }

    await device.send_log(
        f"Gmail accounts detected: {len(gmail_accounts)} (active {len(active_gmail)}, overflow {len(overflow_gmail)})"
    )
    await device.send_log(
        f"Instagram accounts detected: {len(ig_accounts)} (active {len(active_ig)}, overflow {len(overflow_ig)})"
    )
    if overflow_gmail or overflow_ig:
        await device.send_log("Profile exceeds legacy 5-account cap")
    if saved_pairs:
        await device.send_log(
            f"Saved account pair check: {len(saved_pairs['fully_matched_pairs'])}/{saved_pairs['total_expected']} matched for current profile"
        )
    else:
        await device.send_log(
            "No saved account pairs provided; falling back to heuristic local-part matching."
        )

    await device.send_progress(100, "Current profile validation complete")
    return {
        "success": True,
        "data": {
            "action": "validate_current",
            "profile_id": current_user or profile_id,
            "profile_name": profile_name,
            "gmail_accounts": active_gmail,
            "ig_accounts": active_ig,
            "overflow_gmail": overflow_gmail,
            "overflow_ig": overflow_ig,
            "gmail_count": len(gmail_accounts),
            "ig_count": len(ig_accounts),
            "limits": {"gmail_max": 5, "ig_max": 5},
            "matching": {
                "matched_usernames": matched,
                "gmail_without_matching_ig": gmail_without_ig,
                "ig_without_matching_gmail": ig_without_gmail,
                **({"saved_pairs": saved_pairs} if saved_pairs is not None else {}),
            },
        },
    }





# ═══════════════════════════════════════════════════════════════════
# INSTAGRAM SELECTORS (from IG Appium ig_selectors.py)
# ═══════════════════════════════════════════════════════════════════
IG_SELECTORS = {
    # Bottom Navigation (New Layout Dec 2024)
    "HOME_TAB": "com.instagram.android:id/feed_tab",
    "REELS_TAB": "com.instagram.android:id/clips_tab",
    "SEARCH_TAB": "com.instagram.android:id/search_tab",
    "PROFILE_TAB": "com.instagram.android:id/profile_tab",
    # Engagement Buttons
    "REELS_LIKE_BTN": "com.instagram.android:id/like_button",
    "REELS_COMMENT_BTN": "com.instagram.android:id/comment_button",
    "FEED_LIKE_BTN": "com.instagram.android:id/row_feed_button_like",
    "FEED_COMMENT_BTN": "com.instagram.android:id/row_feed_button_comment",
    # Comment Sheet
    "COMMENT_INPUT": "com.instagram.android:id/layout_comment_thread_edittext",
    "COMMENT_POST_BTN": "com.instagram.android:id/layout_comment_thread_post_button_icon",
}

# Coordinates for 1080x2400 resolution
IG_COORDS = {
    "HOME_TAB": (108, 2274),
    "REELS_TAB": (324, 2274),
    "SEARCH_TAB": (756, 2274),
    "PROFILE_TAB": (972, 2274),
    "DOUBLE_TAP_CENTER": (540, 1200),  # Reels/Stories
    "FEED_DOUBLE_TAP": (540, 1415),  # Feed posts (ADB: media center Feb 2026)
    # ⚠️ Comment sheet position is DYNAMIC — these are approximate fallbacks
    "COMMENT_INPUT": (543, 1435),  # ADB Feb 2026 (no keyboard state)
    "COMMENT_POST": (977, 1441),  # ADB Feb 2026 (post_button_icon center)
}


async def execute_reels_engagement_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based Reels engagement module.
    Scrolls through Instagram Reels and engages with likes/comments.

    This is one of the most important engagement modules as Reels
    are where Instagram's algorithm gives the most organic reach.

    Features:
    - Human-like random viewing times
    - Configurable like/comment chances
    - Uses comment pool from account settings if available
    - Double-tap to like (more natural than button)
    """
    import random

    count = config.get("count", 10)
    like_chance = config.get("like_chance", 80)
    comment_chance = config.get("comment_chance", 15)
    like_only = config.get("like_only", False)
    account_id = config.get("account_id")
    user_id = config.get("user_id")

    # Randomize count if range provided
    count_min = config.get("count_min", count)
    count_max = config.get("count_max", count)
    if count_min != count_max:
        count = random.randint(count_min, count_max)

    # Get comments from pool or use defaults
    comment_pool = config.get("comments", [])
    if not comment_pool and account_id and comment_chance > 0 and not like_only:
        comment = await get_comment_for_account(account_id, user_id)
        if comment:
            # Try to get full pool
            try:
                if get_supabase():
                    acc_res = (
                        get_supabase()
                        .from_("instagram_accounts")
                        .select("comment_pool_id")
                        .eq("id", account_id)
                        .single()
                        .execute()
                    )
                    if acc_res.data and acc_res.data.get("comment_pool_id"):
                        pool_res = (
                            get_supabase()
                            .from_("content_pools")
                            .select("content")
                            .eq("id", acc_res.data["comment_pool_id"])
                            .single()
                            .execute()
                        )
                        if pool_res.data:
                            content = pool_res.data.get("content", "")
                            comment_pool = [
                                l.strip()
                                for l in content.split("\n")
                                if l.strip() and not l.strip().startswith("#")
                            ]
            except Exception:
                pass

    # Fallback comments (ADB-safe, no emojis - from old appium engagement_module)
    if not comment_pool:
        comment_pool = [
            "fire",
            "so fire",
            "love this",
            "so good",
            "amazing",
            "incredible",
            "wow",
            "this is everything",
            "perfect",
            "obsessed",
            "iconic",
            "goals",
            "vibe",
            "mood",
            "need this",
            "slay",
            "sheesh",
            "this made my day",
            "cant stop watching",
            "literally perfect",
            "insane",
            "best thing ever",
            "unreal",
            "too good",
            "living for this",
        ]

    if like_only:
        comment_chance = 0

    await device.send_log(
        f"Starting Reels engagement: {count} reels, {like_chance}% like, {comment_chance}% comment"
    )
    await device.send_progress(0, "Initializing reels engagement...")

    stats = {"liked": 0, "commented": 0, "scrolled": 0, "viewed": 0}

    try:
        # Pre-launch cleanup: 2x back to clear any hanging/stuck screens
        await device.send_progress(3, "Clearing stuck screens...")
        await device.back()
        await device.wait(500)
        await device.back()
        await device.wait(500)

        # Launch Instagram
        await device.send_progress(5, "Launching Instagram...")
        await device.launch_app("com.instagram.android", wait_after=3000)

        # Dismiss any popups
        await device.dismiss_common_popups()

        # Navigate to Reels tab
        await device.send_progress(10, "Navigating to Reels...")
        if not await device.navigate_to_reels():
            return {"success": False, "error": "Failed to navigate to Reels tab"}
        await device.dismiss_common_popups()

        # ── Engage with reels ──────────────────────────────────────
        if not await device.verify_on_reels_tab():
            await device.send_log(
                "Reels surface not confirmed; retrying bottom-nav navigation",
                "WARN",
            )
            if await device.is_in_story_view():
                await device.back()
                await device.wait(800)
            if not await device.navigate_to_reels():
                return {"success": False, "error": "Failed to navigate to Reels tab"}

        # Real reel-scrolling behavior:
        #   - Most reels: rapid skip (0.5-2s) -- user isn't interested
        #   - Some: partial watch (2-5s) -- held attention briefly
        #   - Fewer: full watch (5-12s) -- genuinely engaged
        #   - Rare: rewatch / linger (12-25s) -- loved it
        # Likes/comments only happen on longer watches (never on skips).
        # Scroll is always a full-page snap (reels are vertical pager).

        for i in range(count):
            progress = 15 + int((i / count) * 80)
            await device.send_progress(progress, f"Viewing reel {i + 1}/{count}...")

            stats["viewed"] += 1

            # Skip sponsored/ad reels — check for visible "Sponsored" label
            await device.get_screen()
            is_ad_reel = device.is_sponsored("reel")
            if is_ad_reel:
                stats.setdefault("ads_skipped", 0)
                stats["ads_skipped"] += 1
                await device.send_log("Skipping sponsored reel")
                # Quick swipe to next reel
                await device.swipe(
                    random.randint(400, 680), 1800,
                    random.randint(400, 680), 400,
                    random.randint(150, 250),
                )
                await device.wait(random.randint(300, 600))
                continue

            # Pick viewing behavior (weighted like real usage)
            view_type = random.choices(
                ["rapid_skip", "partial_watch", "full_watch", "linger"],
                weights=[0.30, 0.35, 0.25, 0.10],
            )[0]

            view_ranges = {
                "rapid_skip": (300, 1000),
                "partial_watch": (1000, 3000),
                "full_watch": (3000, 6000),
                "linger": (6000, 12000),
            }
            vmin, vmax = view_ranges[view_type]
            # Triangular distribution clusters toward middle (more natural)
            view_time = int(random.triangular(vmin, vmax, (vmin + vmax) * 0.45))
            await device.wait(view_time)

            # Like -- only on partial_watch or longer, scaled by how long we watched
            like_multiplier = {
                "rapid_skip": 0.0,
                "partial_watch": 0.4,
                "full_watch": 1.0,
                "linger": 1.3,
            }[view_type]
            effective_like = (like_chance / 100) * like_multiplier

            if random.random() < effective_like:
                # Double-tap center for reels (more human than button tap)
                if random.random() < 0.6:
                    await device.double_tap_to_like(
                        random.randint(400, 680), random.randint(900, 1300)
                    )
                    stats["liked"] += 1
                else:
                    if await device.find_and_tap_like_button():
                        stats["liked"] += 1
                await device.wait(random.randint(200, 600))

            # Comment -- only on full_watch or linger
            comment_multiplier = {
                "rapid_skip": 0.0,
                "partial_watch": 0.0,
                "full_watch": 0.8,
                "linger": 1.5,
            }[view_type]
            effective_comment = (comment_chance / 100) * comment_multiplier

            if random.random() < effective_comment and not like_only:
                await device.get_screen()
                comment_btn = (
                    device.find_element_by_resource_id(
                        "com.instagram.android:id/comment_button"
                    )
                    or device.find_element_by_content_description("Comment")
                    or device.find_element_by_resource_id(
                        "com.instagram.android:id/row_feed_button_comment"
                    )
                )

                if comment_btn:
                    await device.tap(comment_btn[0], comment_btn[1], wait_after=800)

                    chosen_comment = random.choice(comment_pool)

                    # Tap input field
                    await device.get_screen()
                    input_field = device.find_element_by_resource_id(
                        "com.instagram.android:id/layout_comment_thread_edittext"
                    )
                    if input_field:
                        await device.tap(input_field[0], input_field[1], wait_after=500)
                    else:
                        await device.tap(543, 1435, wait_after=500)

                    await device.input_text(chosen_comment)
                    await device.wait(random.randint(800, 1500))

                    # Tap post button
                    await device.get_screen()
                    post_btn = device.find_element_by_resource_id(
                        "com.instagram.android:id/layout_comment_thread_post_button_icon"
                    )
                    if post_btn:
                        await device.tap(post_btn[0], post_btn[1], wait_after=800)
                    else:
                        await device.tap(977, 1441, wait_after=800)

                    stats["commented"] += 1
                    await device.send_log(f"Commented: {chosen_comment[:15]}...")

                    # Close comment sheet: back to dismiss keyboard, back to close sheet
                    await device.back()
                    await device.wait(400)
                    await device.back()
                    await device.wait(600)

            # ── Scroll to next reel ───────────────────────────────
            # Reels are a vertical ViewPager -- a full-page snap swipe.
            # But real humans vary their flick speed and starting position.
            scroll_x = random.randint(400, 680)

            if view_type == "rapid_skip":
                # Fast aggressive flick -- barely watched, moving on
                start_y = random.randint(1800, 2000)
                end_y = random.randint(300, 600)
                dur = random.randint(120, 220)
            elif view_type == "linger":
                # Slow deliberate swipe after watching the whole thing
                start_y = random.randint(1600, 1900)
                end_y = random.randint(400, 700)
                dur = random.randint(350, 550)
            else:
                # Normal swipe
                start_y = random.randint(1700, 2000)
                end_y = random.randint(300, 650)
                dur = random.randint(200, 400)

            await device.swipe(
                scroll_x,
                start_y,
                scroll_x + random.randint(-20, 20),
                end_y,
                dur,
            )
            stats["scrolled"] += 1

            # Post-scroll pause -- shorter after skips, longer after engagement
            if view_type == "rapid_skip":
                await device.wait(random.randint(80, 300))
            else:
                await device.wait(random.randint(300, 800))

            # ~8% chance of a "scroll back up" to rewatch (very human on reels)
            if view_type in ("full_watch", "linger") and random.random() < 0.08:
                await device.send_log("Rewatching previous reel", "DEBUG")
                await device.swipe(
                    scroll_x,
                    random.randint(400, 700),
                    scroll_x,
                    random.randint(1700, 2000),
                    random.randint(250, 400),
                )
                # Watch again for a bit
                await device.wait(random.randint(2000, 6000))
                # Then scroll past it again
                await device.swipe(
                    scroll_x,
                    random.randint(1800, 2000),
                    scroll_x,
                    random.randint(300, 600),
                    random.randint(180, 350),
                )
                await device.wait(random.randint(200, 500))

            # Every 5 reels, check for action blocked
            if i > 0 and i % 5 == 0:
                await device.get_screen()
                if await device.handle_action_blocked():
                    await device.send_log(
                        "Action blocked detected, stopping early", "WARN"
                    )
                    break

        await device.send_progress(
            100, f"Done! {stats['liked']} likes, {stats['commented']} comments"
        )
        await device.send_log(f"Reels engagement complete: {stats}")

        return {"success": True, "data": stats}

    except Exception as e:
        await device.send_log(f"Reels engagement error: {str(e)}", "ERROR")
        return {"success": False, "error": str(e)}


async def execute_feed_engagement_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based Home Feed engagement module.
    Uses RemoteDevice to send commands to Electron client via WebSocket.
    """
    import random

    count = config.get("count", 10)
    like_chance = config.get("like_chance", 70)
    comment_chance = config.get("comment_chance", 10)
    comments = config.get(
        "comments",
        [
            "fire",
            "so fire",
            "love this",
            "so good",
            "amazing",
            "incredible",
            "wow",
            "perfect",
            "obsessed",
            "iconic",
            "goals",
            "vibe",
            "mood",
            "slay",
            "sheesh",
        ],
    )

    await device.send_progress(0, "Initializing feed engagement...")

    stats = {"liked": 0, "commented": 0, "scrolled": 0, "viewed": 0, "ads_skipped": 0}

    try:
        # Launch Instagram
        await device.send_progress(5, "Launching Instagram...")
        await device.launch_app("com.instagram.android", wait_after=3000)

        # Dismiss popups
        await device.dismiss_common_popups()

        # Navigate to Home tab
        # DO NOT use find_element_by_content_description("Home") — it matches
        # the Instagram logo at (540, 201) which opens Following/Favorites dropdown!
        # ig_ui_map: Home tab [0,2211][216,2337] center (108,2274)
        await device.send_progress(10, "Navigating to Home Feed...")
        await device.tap(108, 2274, wait_after=2000)

        await device.wait(1500)

        # ── Engage with feed posts ─────────────────────────────────
        # Feed scrolling is NOT like Reels (no snap pager). Users scroll
        # varying distances -- sometimes barely nudging to read a caption,
        # sometimes flicking past multiple posts. Mix of speeds is key.

        for i in range(count):
            progress = 15 + int((i / count) * 80)
            await device.send_progress(progress, f"Engaging post {i + 1}/{count}...")
            stats["viewed"] += 1

            await device.get_screen()
            if device.is_sponsored("feed"):
                stats["ads_skipped"] += 1
                await device.send_log("Skipping sponsored feed post")
                await device.swipe(
                    random.randint(460, 620),
                    random.randint(1500, 1850),
                    random.randint(460, 620),
                    random.randint(500, 850),
                    random.randint(160, 280),
                )
                stats["scrolled"] += 1
                await device.wait(random.randint(250, 600))
                continue

            # Humanized viewing time -- varies by "interest"
            view_type = random.choices(
                ["skip", "glance", "read", "study"],
                weights=[0.15, 0.35, 0.35, 0.15],
            )[0]
            view_ranges = {
                "skip": (400, 1000),
                "glance": (1000, 2500),
                "read": (2500, 5000),
                "study": (5000, 8000),
            }
            vmin, vmax = view_ranges[view_type]
            await device.wait(int(random.triangular(vmin, vmax, vmin * 1.3)))

            # Like -- scaled by view type (never like what you skip)
            like_mult = {"skip": 0.0, "glance": 0.3, "read": 1.0, "study": 1.2}[
                view_type
            ]
            if random.random() < (like_chance / 100) * like_mult:
                if await device.find_and_tap_like_button():
                    stats["liked"] += 1
                    await device.wait(random.randint(200, 500))

            # Comment -- only on read/study
            comment_mult = {"skip": 0.0, "glance": 0.0, "read": 0.8, "study": 1.5}[
                view_type
            ]
            if random.random() < (comment_chance / 100) * comment_mult:
                await device.get_screen()
                comment_icon = device.find_element_by_resource_id(
                    "com.instagram.android:id/row_feed_button_comment"
                ) or device.find_element_by_content_description("Comment")

                if comment_icon:
                    await device.tap(comment_icon[0], comment_icon[1], wait_after=2000)

                    # Tap input field to focus
                    await device.get_screen()
                    input_field = device.find_element_by_resource_id(
                        "com.instagram.android:id/layout_comment_thread_edittext"
                    )
                    if input_field:
                        await device.tap(input_field[0], input_field[1], wait_after=500)

                    await device.input_text(random.choice(comments))
                    await device.wait(random.randint(800, 1500))

                    # Tap Post button
                    await device.get_screen()
                    post_btn = device.find_element_by_resource_id(
                        "com.instagram.android:id/layout_comment_thread_post_button_icon"
                    )
                    if post_btn:
                        await device.tap(post_btn[0], post_btn[1], wait_after=800)
                    else:
                        await device.tap(977, 1441, wait_after=800)
                    stats["commented"] += 1

                    # Close comment sheet: back to dismiss keyboard, back to close sheet
                    await device.back()
                    await device.wait(400)
                    await device.back()
                    await device.wait(600)

            # ── Humanized feed scroll ─────────────────────────────
            # Feed posts vary in height (image vs carousel vs video).
            # Real users mix short nudges, normal scrolls, and fast flicks.
            sx = random.randint(460, 620)

            if view_type == "skip":
                # Fast flick past -- big distance, short duration
                scroll_amt = random.randint(1200, 1800)
                scroll_dur = random.randint(150, 280)
            elif view_type == "study":
                # Slow scroll after engaging with content
                scroll_amt = random.randint(850, 1300)
                scroll_dur = random.randint(450, 750)
            elif view_type == "glance":
                # Medium-fast scroll
                scroll_amt = random.randint(1100, 1700)
                scroll_dur = random.randint(200, 400)
            else:
                # Normal moderate scroll
                scroll_amt = random.randint(950, 1600)
                scroll_dur = random.randint(300, 550)

            sy = random.randint(1500, 1900)
            await device.swipe(
                sx,
                sy,
                sx + random.randint(-25, 25),
                max(250, sy - scroll_amt),
                scroll_dur,
            )
            stats["scrolled"] += 1

            # ~12% overshoot-then-scroll-back (very human)
            if random.random() < 0.12:
                await device.wait(random.randint(100, 300))
                back_y = random.randint(700, 1000)
                await device.swipe(
                    sx,
                    back_y,
                    sx,
                    back_y + random.randint(150, 400),
                    random.randint(200, 400),
                )

            # Post-scroll delay
            await device.wait(random.randint(300, 800))

        await device.send_progress(
            100, f"Done! Liked {stats['liked']}, commented {stats['commented']}"
        )

        return {"success": True, "data": stats}

    except Exception as e:
        return {"success": False, "error": str(e)}


async def execute_ig_status_check_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    Navigate to Instagram Account Status page and read the 4 status items:
      1. Removed content and messaging issues
      2. Limits to your reach
      3. Features you can't use
      4. Monetization
    Taps into each item's sub-page to read actual OK/flagged status,
    since the main page only shows labels with no status indicators.
    Returns structured JSON result for display + DB persistence.
    """

    def _center(bounds_str: str):
        m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds_str)
        if not m:
            return None
        x1, y1, x2, y2 = map(int, m.groups())
        return ((x1 + x2) // 2, (y1 + y2) // 2)

    def _find_by_text(xml: str, text: str):
        escaped = re.escape(text)
        for pattern in [
            rf'text="{escaped}"[^/]*?bounds="([^"]+)"',
            rf'bounds="([^"]+)"[^/]*?text="{escaped}"',
        ]:
            m = re.search(pattern, xml, re.DOTALL)
            if m:
                return _center(m.group(1))
        return None

    def _find_by_content_desc(xml: str, text: str):
        escaped = re.escape(text)
        m = re.search(
            rf'content-desc="{escaped}"[^/]*?bounds="([^"]+)"',
            xml, re.DOTALL
        )
        if m:
            return _center(m.group(1))
        return None

    def _find_hamburger(xml: str):
        for desc in ["Options", "Open Menu", "Navigation Menu", "Menu", "More options"]:
            m = re.search(
                rf'content-desc="{re.escape(desc)}"[^/]*?bounds="([^"]+)"',
                xml, re.DOTALL
            )
            if m:
                pos = _center(m.group(1))
                if pos:
                    return pos
        for rid in ["options_menu", "hamburger", "overflow"]:
            m = re.search(
                rf'resource-id="[^"]*{rid}[^"]*"[^/]*?bounds="([^"]+)"',
                xml, re.IGNORECASE | re.DOTALL
            )
            if m:
                pos = _center(m.group(1))
                if pos:
                    return pos
        return None

    def _extract_username(xml: str) -> str:
        for m in re.finditer(r'text="([^"]{3,30})"[^/]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml, re.DOTALL):
            val = m.group(1)
            cy = (int(m.group(3)) + int(m.group(5))) // 2
            if cy < 900 and re.match(r'^[a-zA-Z0-9._]{3,30}$', val) and val not in ("Account Status", "Learn more"):
                return val
        return None

    # ── Status item definitions ──────────────────────────────────────
    # Each item: (key, label_on_main_page, ok_signals, flagged_signals)
    # The module taps into each item's sub-page, reads the text, and
    # checks for ok/flagged signals in the full sub-page text.
    STATUS_ITEMS = [
        (
            "removed_content",
            "Removed content and messaging issues",
            ["not affected right now", "thank you for following our community"],
            ["violation", "issue found", "you are at risk of losing"],
        ),
        (
            "reach_limits",
            "Limits to your reach",
            ["don't have limits", "no limits to your account", "can be recommended"],
            ["cannot be recommended", "not available to people under"],
        ),
        (
            "features",
            "Features you can't use",
            ["can use all instagram features", "you have access to features"],
            ["following feature", "commenting feature", "going live feature", "features have been disabled"],
        ),
        (
            "monetization",
            "Monetization",
            ["eligible to monetize", "you can monetize", "monetization is available"],
            ["unable to monetize", "policy violation", "not eligible", "ineligible", "you'll need to resolve"],
        ),
    ]

    async def _check_item_subpage(device, xml_main, key, label, ok_signals, flagged_signals):
        """Tap into a status item, read sub-page, determine status, go back."""
        pos = _find_by_content_desc(xml_main, label) or _find_by_text(xml_main, label)
        if not pos:
            return {"key": key, "label": label, "status": "unknown"}

        await device.tap(pos[0], pos[1], wait_after=1500)
        sub_xml = await device.get_screen()
        lower = sub_xml.lower()

        status = "unknown"
        for sig in flagged_signals:
            if sig in lower:
                status = "flagged"
                break
        if status == "unknown":
            for sig in ok_signals:
                if sig in lower:
                    status = "ok"
                    break

        await device.back()
        await device.wait(800)
        return {"key": key, "label": label, "status": status}

    try:
        await device.send_progress(5, "Launching Instagram...")
        await device.launch_app("com.instagram.android", wait_after=3000)

        await device.send_progress(15, "Opening profile tab...")
        await device.tap(972, 2274, wait_after=800)

        await device.send_progress(25, "Opening settings menu...")
        xml = await device.get_screen()
        hamburger = _find_hamburger(xml)
        if hamburger:
            await device.tap(hamburger[0], hamburger[1], wait_after=800)
        else:
            await device.tap(1039, 106, wait_after=800)

        await device.send_progress(35, "Scrolling to Account Status...")
        status_pos = None
        for _ in range(5):
            await device.swipe(540, 1600, 540, 700, 350, wait_after=700)
            xml = await device.get_screen()
            status_pos = _find_by_text(xml, "Account Status")
            if status_pos:
                break

        if not status_pos:
            return {"success": False, "error": "Could not find 'Account Status' in the menu. Try scrolling further or check Instagram version."}

        await device.send_progress(45, "Opening Account Status page...")
        await device.tap(status_pos[0], status_pos[1], wait_after=1500)

        # Read main Account Status page
        xml_main = await device.get_screen()
        username = _extract_username(xml_main)

        # Check each status item by tapping into its sub-page
        items = []
        for i, (key, label, ok_sigs, flagged_sigs) in enumerate(STATUS_ITEMS):
            pct = 50 + (i * 10)
            await device.send_progress(pct, f"Checking {label}...")

            # Re-read main page before each tap (screen may have shifted)
            if i > 0:
                xml_main = await device.get_screen()

            result = await _check_item_subpage(
                device, xml_main, key, label, ok_sigs, flagged_sigs
            )
            items.append(result)

        statuses = [item["status"] for item in items]
        # Growth-critical: only these 2 determine if posting should be blocked
        GROWTH_KEYS = {"removed_content", "reach_limits"}
        growth_items = [i for i in items if i["key"] in GROWTH_KEYS]
        growth_flagged = any(i["status"] == "flagged" for i in growth_items)
        if growth_flagged:
            overall = "flagged"
        elif all(i["status"] == "ok" for i in growth_items):
            overall = "ok"
        else:
            overall = "partial"

        ok_count = sum(1 for s in statuses if s == "ok")
        total = len(items)
        status_data = {
            "username": username,
            "overall": overall,
            "items": items,
            "checked_at": datetime.utcnow().isoformat() + "Z",
            "message": f"Status check complete — {ok_count}/{total} OK",
        }

        # Return to home
        await device.send_progress(92, "Returning to home...")
        await device.back()
        await device.wait(500)
        await device.back()
        await device.wait(400)
        await device.tap(108, 2274, wait_after=500)

        await device.send_progress(100, status_data["message"])
        return {"success": True, "data": {"action": "ig_status_check", **status_data}}

    except Exception as e:
        return {"success": False, "error": str(e)}


def _safe_register_ws_handlers(label: str, factory):
    """Register a batch of WS module handlers, isolating registration errors.

    Before this, any NameError inside one of the WS_MODULE_HANDLERS.update({...})
    blocks would fire at module load time (the dict literal evaluates every
    function reference) → uvicorn never starts → users see persistent
    "brain down" with no useful log line. Wrapping the dict construction in
    a lambda defers evaluation until inside a try/except, so a typo or a
    removed function in ONE block only loses that block's handlers instead
    of taking down the whole brain.
    """
    try:
        handlers = factory()
        if not isinstance(handlers, dict):
            raise TypeError(f"factory must return dict, got {type(handlers).__name__}")
        WS_MODULE_HANDLERS.update(handlers)
    except Exception as e:
        print(f"[server] WS_MODULE_HANDLERS registration block '{label}' FAILED: {type(e).__name__}: {e}")
        print(f"[server]   → modules in this block will be unreachable until fixed; other blocks unaffected")


# Update the WebSocket handlers registry with all new modules
_safe_register_ws_handlers("core_unfollow_engagement_account", lambda: {
        # Core Instagram modules
        # NOTE: engagement, post_feed, follow, and story_viewer are adapter-owned.
        # profile_switch, airplane_toggle, detect_accounts, and ig_launcher are
        # desktop-local. The adapter-first guarantee is enforced by the
        # WS_MODULE_HANDLERS.pop loop at the bottom of this file.
        "unfollow": execute_unfollow_ws,  # Unfollow users
        # Engagement variants (not in adapter — keep native)
        "explore_engagement": execute_explore_engagement_ws,
        "reels_engagement": execute_reels_engagement_ws,
        "feed_engagement": execute_feed_engagement_ws,
        "hashtag_engagement": execute_hashtag_engagement_ws,
        # Account management (not in adapter — keep native)
        "account_validator": execute_account_validator_ws,
        "validate_current": execute_account_validator_ws,  # Alias
    })



async def execute_ig_login_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based Instagram login module.
    Logs into Instagram with username and password.
    """
    username = config.get("username", "")
    password = config.get("password", "")

    if not username or not password:
        return {"success": False, "error": "Username and password required"}

    await device.send_progress(0, "Opening Instagram...")

    await device.launch_app("com.instagram.android", wait_after=3000)
    await device.dismiss_common_popups()

    await device.send_progress(15, "Checking login status...")

    await device.get_screen()

    # Check if already logged in
    if device.text_on_screen("Your story") or device.find_element_by_resource_id(
        "com.instagram.android:id/tab_bar"
    ):
        return {
            "success": True,
            "data": {"message": "Already logged in", "already_logged_in": True},
        }

    await device.send_progress(25, "Entering credentials...")

    # Find username field
    username_field = device.find_element_by_text(
        "Phone number, username or email"
    ) or device.find_element_by_resource_id("com.instagram.android:id/login_username")
    if username_field:
        await device.tap(username_field[0], username_field[1])
        await device.wait(500)
        await device.input_text(username)
    await device.wait(500)

    await device.send_progress(40, "Entering password...")

    # Find password field
    await device.get_screen()
    password_field = device.find_element_by_text(
        "Password"
    ) or device.find_element_by_resource_id("com.instagram.android:id/password")
    if password_field:
        await device.tap(password_field[0], password_field[1])
        await device.wait(500)
        await device.input_text(password)
    await device.wait(500)

    await device.send_progress(55, "Logging in...")

    # Tap Login button
    await device.get_screen()
    login_btn = device.find_element_by_text("Log in") or device.find_element_by_text(
        "Log In"
    )
    if login_btn:
        await device.tap(login_btn[0], login_btn[1])
    await device.wait(5000)

    await device.send_progress(75, "Checking login result...")

    await device.get_screen()

    # Handle popups
    await device.dismiss_common_popups()

    await device.get_screen()

    # Check if login succeeded
    if device.text_on_screen("Your story") or device.find_element_by_resource_id(
        "com.instagram.android:id/tab_bar"
    ):
        await device.send_progress(100, "Login successful!")
        return {
            "success": True,
            "data": {"message": "Login successful", "username": username},
        }
    elif device.text_on_screen("incorrect") or device.text_on_screen("wrong"):
        return {
            "success": False,
            "error": "Invalid credentials",
            "data": {"username": username},
        }
    elif device.text_on_screen("verification") or device.text_on_screen("code"):
        return {
            "success": False,
            "error": "Verification required",
            "data": {"username": username, "needs_verification": True},
        }
    else:
        return {
            "success": False,
            "error": "Login failed - unknown state",
            "data": {"username": username},
        }


async def execute_ig_logout_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based Instagram logout module.
    Logs out of the current Instagram account.
    """
    await device.send_progress(0, "Opening Instagram...")

    if not await device.is_on_home_screen():
        await device.launch_app("com.instagram.android", wait_after=3000)

    await device.dismiss_common_popups()

    await device.send_progress(20, "Navigating to settings...")

    # Go to profile
    await device.navigate_to_profile()
    await device.wait(1500)

    # Tap hamburger menu
    await device.get_screen()
    menu_btn = device.find_element_by_resource_id(
        "com.instagram.android:id/action_bar_overflow_icon"
    )
    if menu_btn:
        await device.tap(menu_btn[0], menu_btn[1])
    else:
        await device.tap(1000, 150)  # Try top-right corner
    await device.wait(1500)

    await device.send_progress(40, "Opening settings...")

    # Tap Settings
    await device.get_screen()
    settings = device.find_element_by_text(
        "Settings and privacy"
    ) or device.find_element_by_text("Settings")
    if settings:
        await device.tap(settings[0], settings[1])
    await device.wait(1500)

    await device.send_progress(60, "Scrolling to logout...")

    # Scroll down to find logout
    for _ in range(3):
        await device.scroll_down(500)
        await device.wait(500)
        await device.get_screen()
        if device.text_on_screen("Log out"):
            break

    await device.send_progress(75, "Logging out...")

    # Tap Logout
    logout_btn = device.find_element_by_text("Log out")
    if logout_btn:
        await device.tap(logout_btn[0], logout_btn[1])
        await device.wait(1500)

        # Confirm logout
        await device.get_screen()
        confirm = device.find_element_by_text("Log Out") or device.find_element_by_text(
            "Log out"
        )
        if confirm:
            await device.tap(confirm[0], confirm[1])
        await device.wait(3000)

    await device.send_progress(100, "Logged out!")

    return {"success": True, "data": {"message": "Logged out successfully"}}


async def execute_ig_account_switch_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based Instagram account switch module.

    Flow (validated live on Pixel 6 / IG Android 16):
      1. Launch IG
      2. Tap the bottom-nav Profile tab (content-desc="Profile") to navigate there
      3. LONG-PRESS the same Profile tab — opens the account-switcher bottom sheet
         (NOT a tap on the action_bar_title — that was the pre-2024 flow and now
         opens the profile editor instead)
      4. Parse the sheet for accounts. The sheet contains:
           - One row per logged-in IG account (text=<username>)
           - selected="true" on the currently-active row
           - "Add Instagram account", "Go to Accounts Center" footers
      5. If target_username == currently-selected → no-op success
      6. If target_username is in the sheet but not selected → tap it
      7. If target_username is not in the sheet at all → return clear error
         ("not logged in on this profile — add it via Create IG Account first")
      8. If no target_username given → return current account info, no switch
    """
    target_username = (config.get("target_username") or config.get("account_username") or "").lstrip("@").strip()

    await device.send_progress(0, "Opening Instagram...")

    try:
        await device.launch_app("com.instagram.android", wait_after=3000)
        await device.dismiss_common_popups()

        await device.send_progress(20, "Navigating to Profile tab...")
        await device.get_screen()

        # 2.19.0: prefer resource-id `profile_tab` over content-desc("Profile").
        # The content-desc lookup matches the FIRST node with that desc — on
        # the Reels feed that's the reel creator's profile link inside the
        # reel header (at the TOP of the screen), not the bottom-nav. Long-
        # pressing the wrong target opens the creator's profile page instead
        # of the account switcher and the run dies with "Add Instagram
        # account row not found". Same fix as 2.18.19 for account creation,
        # missed here. Resource-id is unique and stable across IG tabs.
        prof = device.find_element_by_resource_id("com.instagram.android:id/profile_tab")
        if not prof:
            candidate = device.find_element_by_content_description("Profile")
            # Only accept content-desc match if it's in the bottom-nav area
            # (y >= 2000 on 1080x2400 Pixel 6). Anything higher = creator link.
            if candidate and candidate[1] >= 2000:
                prof = candidate
        if prof:
            tab_x, tab_y = prof[0], prof[1]
        else:
            # Last-resort fallback: bottom-right corner of typical phone screen.
            tab_x, tab_y = 972, 2274

        # 2.19.1: long-press the profile tab DIRECTLY without a preceding
        # tap. The old flow (tap → wait 1500ms → long-press) put IG into a
        # state where the long-press got interpreted as a tap-then-drag
        # instead of opening the account switcher sheet — the switcher
        # never appeared and downstream parsing read the profile-page
        # stats as fake account names. The same pattern from
        # `execute_account_creation_phone_ws` (which works) is
        # long-press-directly + 1200ms hold + 2000ms wait. Match it here.
        await device.send_progress(40, "Long-pressing profile tab to open switcher...")
        await device.shell(f"input swipe {tab_x} {tab_y} {tab_x} {tab_y} 1200")
        await device.wait(2000)

        await device.get_screen()
        sheet_xml = device.current_screen or ""

        # Sanity check: did the switcher sheet actually appear? The footer
        # "Add Instagram account" / "Add account" is a reliable marker.
        sheet_open = (
            "Add Instagram account" in sheet_xml
            or "Add account" in sheet_xml
            or "Accounts Center" in sheet_xml
        )
        if not sheet_open:
            # Retry long-press once — IG sometimes swallows the first gesture
            await device.send_progress(50, "Retrying long-press...")
            await device.swipe(tab_x, tab_y, tab_x, tab_y, 1800)
            await device.wait(1500)
            await device.get_screen()
            sheet_xml = device.current_screen or ""
            sheet_open = (
                "Add Instagram account" in sheet_xml
                or "Add account" in sheet_xml
                or "Accounts Center" in sheet_xml
            )

        # 2.19.1: if the switcher sheet never opened after both long-press
        # attempts, the screen is still the profile page (or wherever the
        # tap landed). Parsing it as the sheet picks up profile-stats text
        # like "0 posts" / "0 followers" / counts / nearby usernames and
        # reports them as "available accounts" — total garbage. Bail early
        # with a clear error so the user knows the long-press itself didn't
        # work, not that the target account is missing.
        if not sheet_open:
            return {
                "success": False,
                "error": (
                    "Could not open the account switcher sheet (long-press on the "
                    "profile tab did nothing or landed on the wrong screen). "
                    "Open IG manually, long-press the bottom-nav profile icon, and "
                    "confirm the switcher sheet appears."
                ),
                "code": "ig_switcher_did_not_open",
                "data": {"target": target_username, "sheet_open": False},
            }

        # Parse the sheet for accounts + which one is currently selected.
        # Pattern: text="username" ... selected="true|false" ... bounds="[x1,y1][x2,y2]"
        import re as _re
        account_re = _re.compile(
            r'text="([^"]+)"[^>]*?selected="(true|false)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
        )
        sheet_accounts = []  # [(username, is_selected, center_x, center_y), ...]
        for m in account_re.finditer(sheet_xml):
            uname = m.group(1).strip()
            # Skip non-username sheet items
            if uname.lower() in {
                "add instagram account", "add account", "go to accounts center",
                "accounts center", "switch accounts", "cancel",
            }:
                continue
            # 2.19.1: tighter username filter. The old `{1,30}` accepted single
            # digits "0" and short words "posts" / "followers" / "friends" —
            # those are profile-page stats text, NOT IG usernames. Real IG
            # handles are >= 3 chars, contain a letter, and aren't pure digits.
            if not _re.match(r"^(?=.{3,30}$)(?=.*[A-Za-z])[A-Za-z0-9._]+$", uname):
                continue
            is_sel = m.group(2) == "true"
            cx = (int(m.group(3)) + int(m.group(5))) // 2
            cy = (int(m.group(4)) + int(m.group(6))) // 2
            sheet_accounts.append((uname, is_sel, cx, cy))

        currently_selected = next((a[0] for a in sheet_accounts if a[1]), None)

        await device.send_progress(
            60,
            f"Sheet open={sheet_open} accounts={[a[0] for a in sheet_accounts]} current={currently_selected}",
        )

        # No target given → return current state, no switch
        if not target_username:
            # Close the sheet
            await device.back()
            await device.send_progress(100, f"No target — on @{currently_selected}")
            return {
                "success": True,
                "data": {
                    "current_account": currently_selected,
                    "available": [a[0] for a in sheet_accounts],
                    "switched": False,
                },
            }

        # Already on the target account → no-op success
        if currently_selected and currently_selected.lower() == target_username.lower():
            await device.back()  # close the sheet
            await device.send_progress(100, f"Already on @{target_username}")
            return {
                "success": True,
                "data": {
                    "current_account": currently_selected,
                    "switched": False,
                    "reason": "already_on_target",
                },
            }

        # Target is in the sheet but not selected → tap it
        target_row = next(
            (a for a in sheet_accounts if a[0].lower() == target_username.lower()),
            None,
        )
        if target_row:
            uname, _is_sel, cx, cy = target_row
            await device.send_progress(75, f"Tapping @{uname} at ({cx},{cy})...")
            await device.tap(cx, cy, wait_after=3500)

            # Verify the switch
            await device.get_screen()
            after_xml = device.current_screen or ""
            # If the new profile screen shows the target username anywhere, count as success
            if target_username.lower() in after_xml.lower():
                await device.send_progress(100, f"Switched to @{target_username}")
                return {
                    "success": True,
                    "data": {
                        "switched_to": target_username,
                        "previous_account": currently_selected,
                        "switched": True,
                    },
                }
            # Otherwise still likely succeeded, IG sometimes shows a loading state
            await device.send_progress(100, f"Tapped @{target_username} (verification inconclusive)")
            return {
                "success": True,
                "data": {
                    "switched_to": target_username,
                    "previous_account": currently_selected,
                    "switched": True,
                    "verified": False,
                },
            }

        # Target not in the sheet → close + return clear error.
        # 2.19.1: was `await device.input_keyevent(4)` — that method doesn't
        # exist on RemoteDevice. Use the shell pass-through (KEYCODE_BACK=4)
        # which is what every other call site does.
        await device.shell("input keyevent 4")
        available_names = [a[0] for a in sheet_accounts]
        return {
            "success": False,
            "error": (
                f"@{target_username} is not logged in on this phone profile. "
                f"Available accounts: {available_names or 'none'}. "
                f"Use Create IG Account or Add Instagram first."
            ),
            "data": {
                "target": target_username,
                "current_account": currently_selected,
                "available": available_names,
                "sheet_open": sheet_open,
            },
        }

    except Exception as e:
        return {"success": False, "error": str(e)}



def _read_repost_count(xml: str) -> Optional[int]:
    """Extract the post's current repost count from a UFI-bar XML dump.

    The repost UFI element renders a TextView next to the icon with the
    raw integer (e.g. "945" or "1.2K"). We grab the count adjacent to
    the reposts_ufi_icon node. Returns None when not parseable so the
    caller can fall back to UI-state heuristics.
    """
    if not xml:
        return None
    # Match a TextView whose text is a numeric/short-form value sitting
    # near the reposts_ufi_icon. Use a narrow window so we don't pick up
    # unrelated counts (likes, comments, sends).
    m = re.search(
        r'reposts_ufi_icon[^/]*?/>\s*<node[^>]*text="([0-9.,KMB]+)"',
        xml,
        re.DOTALL,
    )
    if not m:
        m = re.search(
            r'text="([0-9.,KMB]+)"[^/]*?/>\s*<node[^>]*reposts_ufi_icon',
            xml,
            re.DOTALL,
        )
    if not m:
        return None
    raw = m.group(1).strip().replace(",", "")
    # Convert short-forms (1.2K, 45M) to int
    try:
        if raw.endswith("K"):
            return int(float(raw[:-1]) * 1_000)
        if raw.endswith("M"):
            return int(float(raw[:-1]) * 1_000_000)
        if raw.endswith("B"):
            return int(float(raw[:-1]) * 1_000_000_000)
        return int(float(raw))
    except (ValueError, TypeError):
        return None



async def execute_threads_engage_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based Threads engagement module.
    Engages with content on the Threads feed.
    """
    count = config.get("count", 10)
    like_enabled = config.get("like", True)
    reply_enabled = config.get("reply", False)

    await device.send_progress(0, f"Starting Threads engagement ({count} posts)...")

    await device.launch_app("com.instagram.barcelona", wait_after=4000)
    await device.dismiss_common_popups()

    await device.send_progress(10, "Navigating to feed...")

    # Go to home tab
    await device.get_screen()
    home_tab = device.find_element_by_resource_id("com.instagram.barcelona:id/home_tab")
    if home_tab:
        await device.tap(home_tab[0], home_tab[1])
    await device.wait(2000)

    engaged = 0

    for i in range(count * 2):  # Loop more to account for failures
        if engaged >= count:
            break

        progress = 10 + int((engaged / count) * 85)
        await device.send_progress(progress, f"Engaging {engaged + 1}/{count}...")

        await device.get_screen()

        # Like current post
        if like_enabled:
            like_btn = device.find_element_by_resource_id(
                "com.instagram.barcelona:id/like_button"
            )
            if like_btn:
                await device.tap(like_btn[0], like_btn[1])
                await device.wait(1000)
                engaged += 1

        # Scroll to next post
        await device.scroll_down(600)
        await device.wait(1500)

    await device.send_progress(100, f"Engaged with {engaged} Threads posts!")

    return {"success": True, "data": {"engaged": engaged, "target_count": count}}



# Add final batch of modules
# NOTE: threads_post is adapter-owned. vpn_connect and stats_scraper are
# desktop-local. threads_engage stays because the adapter only ships
# threads_engagement (no `_engage` alias).
_safe_register_ws_handlers("threads_engage_alias", lambda: {
        "threads_engage": execute_threads_engage_ws,
    })



async def execute_tiktok_engage_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based TikTok engagement module.
    Engages with TikTok content (like, follow).
    """
    count = config.get("count", 10)
    like_enabled = config.get("like", True)
    follow_enabled = config.get("follow", False)

    await device.send_progress(0, f"Starting TikTok engagement ({count} videos)...")

    await device.launch_app("com.zhiliaoapp.musically", wait_after=4000)

    await device.send_progress(10, "Navigating to For You page...")

    # Make sure on For You page
    await device.get_screen()
    foryou = device.find_element_by_text("For You")
    if foryou:
        await device.tap(foryou[0], foryou[1])
    await device.wait(2000)

    engaged = 0

    for i in range(count):
        progress = 10 + int((engaged / count) * 85)
        await device.send_progress(progress, f"Engaging {engaged + 1}/{count}...")

        await device.get_screen()

        # Like video
        if like_enabled:
            # Double tap to like
            await device.double_tap_to_like()
            await device.wait(800)

        # Follow creator
        if follow_enabled:
            follow_btn = device.find_element_by_resource_id(
                "com.zhiliaoapp.musically:id/follow_button"
            )
            if follow_btn:
                await device.tap(follow_btn[0], follow_btn[1])
                await device.wait(500)

        engaged += 1

        # Scroll to next video
        await device.swipe(540, 1800, 540, 400, 200)
        await device.wait(2000)

    await device.send_progress(100, f"Engaged with {engaged} TikTok videos!")

    return {
        "success": True,
        "data": {"engaged": engaged, "liked": engaged if like_enabled else 0},
    }



async def execute_twitter_engage_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based Twitter/X engagement module.
    Engages with Twitter content (like, retweet).
    """
    count = config.get("count", 10)
    like_enabled = config.get("like", True)
    retweet_enabled = config.get("retweet", False)

    await device.send_progress(0, f"Starting Twitter engagement ({count} tweets)...")

    await device.launch_app("com.twitter.android", wait_after=4000)

    await device.send_progress(10, "On timeline...")

    # Ensure on Home
    await device.get_screen()
    home_btn = device.find_element_by_resource_id("com.twitter.android:id/home")
    if home_btn:
        await device.tap(home_btn[0], home_btn[1])
    await device.wait(2000)

    engaged = 0

    for i in range(count * 2):
        if engaged >= count:
            break

        progress = 10 + int((engaged / count) * 85)
        await device.send_progress(progress, f"Engaging {engaged + 1}/{count}...")

        await device.get_screen()

        # Like tweet
        if like_enabled:
            like_btn = device.find_element_by_resource_id("com.twitter.android:id/like")
            if like_btn:
                await device.tap(like_btn[0], like_btn[1])
                await device.wait(500)
                engaged += 1

        # Retweet
        if retweet_enabled:
            retweet_btn = device.find_element_by_resource_id(
                "com.twitter.android:id/retweet"
            )
            if retweet_btn:
                await device.tap(retweet_btn[0], retweet_btn[1])
                await device.wait(500)
                # Tap Repost to confirm
                await device.get_screen()
                repost = device.find_element_by_text("Repost")
                if repost:
                    await device.tap(repost[0], repost[1])
                await device.wait(500)

        # Scroll to next tweets
        await device.scroll_down(600)
        await device.wait(1500)

    await device.send_progress(100, f"Engaged with {engaged} tweets!")

    return {"success": True, "data": {"engaged": engaged, "target_count": count}}


# ==================== REDDIT WS HANDLERS ====================

REDDIT_PACKAGE = "com.reddit.frontpage"


async def _reddit_go_to_create(device: RemoteDevice) -> bool:
    """Navigate to the Create tab in Reddit."""
    await device.get_screen()

    # Preferred: bottom nav label
    create_btn = device.find_element_by_text("Create")
    if create_btn:
        await device.tap(create_btn[0], create_btn[1], wait_after=800)
        return True

    # Fallback: tap center-bottom (Create is usually center in bottom nav)
    w, h = await device.get_screen_size()
    await device.tap(w // 2, int(h * 0.94), wait_after=800)
    return True


async def _reddit_select_image_post_type(device: RemoteDevice) -> bool:
    """Select IMAGE post type on the composer row."""
    await device.get_screen()

    # In our XML dumps the icon has content-desc="IMAGE"
    img_icon = device.find_element_by_content_description("IMAGE")
    if img_icon:
        await device.tap(img_icon[0], img_icon[1], wait_after=1200)
        return True

    # Fallback: some builds show a text label
    if await device.tap_element(text="Image"):
        return True

    # Last resort: tap on the second post-type slot area
    w, h = await device.get_screen_size()
    await device.tap(int(w * 0.22), int(h * 0.94), wait_after=1200)
    return True


async def _reddit_select_video_post_type(device: RemoteDevice) -> bool:
    """Select VIDEO post type on the composer row."""
    await device.get_screen()

    vid_icon = device.find_element_by_content_description("VIDEO")
    if vid_icon:
        await device.tap(vid_icon[0], vid_icon[1], wait_after=1200)
        return True

    if await device.tap_element(text="Video"):
        return True

    # Last resort: tap on the third post-type slot area
    w, h = await device.get_screen_size()
    await device.tap(int(w * 0.32), int(h * 0.94), wait_after=1200)
    return True


async def _reddit_pick_gallery_image(device: RemoteDevice, image_index: int) -> bool:
    """Pick media from Reddit's gallery picker."""
    await device.get_screen()

    # The gallery picker grid uses com.reddit.frontpage:id/container for tiles (camera is first tile).
    tiles = device.find_all_elements_by_resource_id("com.reddit.frontpage:id/container")
    if not tiles or len(tiles) < 2:
        # Try tapping a likely first media tile area
        w, h = await device.get_screen_size()
        await device.tap(int(w * 0.5), int(h * 0.32), wait_after=800)
    else:
        safe_idx = max(0, int(image_index or 0))
        pick_idx = min(1 + safe_idx, len(tiles) - 1)  # +1 to skip camera tile
        x, y = tiles[pick_idx]
        await device.tap(x, y, wait_after=800)

    # Tap "Add" to confirm selection
    await device.get_screen()
    if not await device.tap_element(text="Add"):
        await device.tap_element(resource_id="com.reddit.frontpage:id/next")
    await device.wait(1000)
    return True


async def _reddit_set_subreddit(device: RemoteDevice, subreddit: str) -> bool:
    """Set subreddit/community for the post composer."""
    target = (subreddit or "").strip()
    if not target:
        return True
    if target.lower().startswith("r/"):
        target = target[2:].strip()
    if not target:
        return True

    await device.get_screen()
    # Already selected?
    if device.text_on_screen(f"r/{target}"):
        return True

    # Tap community selector (Compose resource-id in XML dumps)
    if not await device.tap_element(resource_id="community_selector"):
        # Fallback: tap community name if visible
        await device.tap_element(resource_id="community_name")

    await device.wait(1200)
    await device.get_screen()

    # Search field in the selector screen
    if not await device.tap_element(resource_id="search_field"):
        await device.tap_element(text="Search")

    await device.wait(300)
    # Using r/<name> works best with Reddit typeahead
    await device.input_text(f"r/{target}", clear_first=True)
    await device.wait(1200)
    await device.enter()
    await device.wait(1200)
    await device.get_screen()

    # Try tapping an exact-ish result first, otherwise tap near the first result.
    res = device.find_element_by_text(f"r/{target}") or device.find_element_by_text(
        target
    )
    if res:
        await device.tap(res[0], res[1], wait_after=800)
        return True

    w, h = await device.get_screen_size()
    await device.tap(w // 2, int(h * 0.30), wait_after=800)
    return True


async def _reddit_set_title(device: RemoteDevice, title: str) -> bool:
    """Fill the title field in the composer."""
    t = (title or "").strip()
    if not t:
        return False

    await device.get_screen()
    if not await device.tap_element(resource_id="post_title_field"):
        # Fallback: tap on the "Title" hint
        await device.tap_element(text="Title")
    await device.wait(250)

    # Clear existing best-effort, then type.
    try:
        await device.select_all_and_delete()
    except Exception:
        pass
    await device.input_text(t, clear_first=False)
    await device.wait(500)
    return True


async def execute_reddit_post_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based Reddit image post module.
    Uses the Electron WS client as a relay for ADB.
    """
    subreddit = config.get("subreddit") or ""
    image_index = int(config.get("image_index") or 0)
    provided_title = config.get("title") or ""
    reddit_post_type = (
        (config.get("reddit_post_type") or config.get("post_type") or "image")
        .strip()
        .lower()
    )
    reddit_title_template = (config.get("reddit_title_template") or "").strip()

    account_id = config.get("account_id") or ""
    user_id = config.get("user_id") or ""

    # Allow per-run profile switching (GrapheneOS user profiles)
    if profile_id:
        await device.send_progress(0, f"Switching phone profile to {profile_id}...")
        await device.switch_profile(str(profile_id))

    await device.send_progress(5, "Opening Reddit...")
    await device.launch_app(REDDIT_PACKAGE, wait_after=4000)

    await device.send_progress(15, "Opening composer...")
    await _reddit_go_to_create(device)

    if reddit_post_type not in ("image", "video"):
        return {
            "success": False,
            "error": f"Unsupported reddit_post_type: {reddit_post_type}",
        }

    await device.send_progress(25, f"Selecting {reddit_post_type} post type...")
    if reddit_post_type == "video":
        await _reddit_select_video_post_type(device)
    else:
        await _reddit_select_image_post_type(device)

    await device.send_progress(40, "Picking an image from gallery...")
    await _reddit_pick_gallery_image(device, image_index=image_index)

    await device.send_progress(55, f"Selecting subreddit: r/{subreddit or '?'}")
    await _reddit_set_subreddit(device, subreddit=subreddit)

    # Title resolution: explicit config → title_template → subreddit caption → caption pool → fallback
    title = (provided_title or "").strip()
    if not title and reddit_title_template and subreddit:
        sub_clean = subreddit.strip()
        if sub_clean.lower().startswith("r/"):
            sub_clean = sub_clean[2:].strip()
        # Minimal templating; keep deterministic and safe.
        title = (
            reddit_title_template.replace("{subreddit}", sub_clean).replace(
                "{rsubreddit}", f"r/{sub_clean}"
            )
        ).strip()
    if not title and account_id and subreddit:
        title = await get_reddit_title_for_account_subreddit(
            account_id=account_id, subreddit=subreddit, user_id=user_id or None
        )
    if not title and account_id:
        title = await get_caption_for_account(
            account_id=account_id, user_id=user_id or None
        )
    if not title:
        title = "New post"

    await device.send_progress(70, "Adding title...")
    await _reddit_set_title(device, title=title)

    await device.send_progress(85, "Posting...")
    await device.get_screen()
    post_btn = device.find_element_by_text("Post") or device.find_element_by_text(
        "post"
    )
    if post_btn:
        await device.tap(post_btn[0], post_btn[1], wait_after=5000)
    else:
        # Fallback: top-right is usually the Post button
        w, _h = await device.get_screen_size()
        await device.tap(int(w * 0.92), 90, wait_after=5000)

    await device.send_progress(100, "Reddit post complete.")
    return {
        "success": True,
        "data": {
            "subreddit": subreddit,
            "title": title[:120],
            "image_index": image_index,
        },
    }


async def execute_reddit_batch_post_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based Reddit batch posting module.
    Posts images to multiple subreddits with randomized delays.
    """
    subreddits = config.get("subreddits") or []
    if isinstance(subreddits, str):
        subreddits = [s.strip() for s in subreddits.split(",") if s.strip()]

    count = int(config.get("count") or 1)
    delay_min = int(config.get("delay_min") or 30)
    delay_max = int(config.get("delay_max") or 90)
    reddit_post_type = (
        (config.get("reddit_post_type") or config.get("post_type") or "image")
        .strip()
        .lower()
    )
    reddit_title_template = (config.get("reddit_title_template") or "").strip()

    account_id = config.get("account_id") or ""
    user_id = config.get("user_id") or ""

    if not subreddits:
        return {
            "success": False,
            "error": "No subreddits provided. Assign subreddits in Accounts first.",
        }

    # Allow per-run profile switching (GrapheneOS user profiles)
    if profile_id:
        await device.send_progress(0, f"Switching phone profile to {profile_id}...")
        await device.switch_profile(str(profile_id))

    import random

    chosen = subreddits[:]
    random.shuffle(chosen)
    chosen = chosen[: max(1, min(count, len(chosen)))]

    await device.send_progress(
        5, f"Opening Reddit for batch posting ({len(chosen)} posts)..."
    )
    await device.launch_app(REDDIT_PACKAGE, wait_after=4000)

    results = []
    for idx, sub in enumerate(chosen):
        if device.aborted:
            raise ModuleAbortedError("Task cancelled by user")

        await device.send_progress(
            10 + int((idx / max(1, len(chosen))) * 80),
            f"Posting {idx + 1}/{len(chosen)} to r/{sub}...",
        )

        # Resolve title for subreddit
        title = ""
        if reddit_title_template and sub:
            sub_clean = sub.strip()
            if sub_clean.lower().startswith("r/"):
                sub_clean = sub_clean[2:].strip()
            title = (
                reddit_title_template.replace("{subreddit}", sub_clean).replace(
                    "{rsubreddit}", f"r/{sub_clean}"
                )
            ).strip()
        if account_id and sub:
            title = await get_reddit_title_for_account_subreddit(
                account_id=account_id, subreddit=sub, user_id=user_id or None
            )
        if not title and account_id:
            title = await get_caption_for_account(
                account_id=account_id, user_id=user_id or None
            )
        if not title:
            title = "New post"

        one = await execute_reddit_post_ws(
            device,
            {
                **config,
                "subreddit": sub,
                "title": title,
                "reddit_post_type": reddit_post_type,
                # Best-effort: vary image index across batch
                "image_index": int(config.get("image_index") or 0) + idx,
            },
            profile_id=None,  # already switched above
        )
        results.append({"subreddit": sub, "success": bool(one.get("success"))})

        # Randomized delay between posts (skip after last)
        if idx < len(chosen) - 1:
            wait_s = random.randint(
                min(delay_min, delay_max), max(delay_min, delay_max)
            )
            await device.send_log(f"Waiting {wait_s}s before next post...")
            await device.wait(wait_s * 1000)

    await device.send_progress(
        100, f"Batch posting complete ({len(results)} attempted)."
    )
    return {"success": True, "data": {"attempted": len(results), "results": results}}


async def execute_reddit_edit_profile_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based Reddit profile edit module.
    Best-effort updates display name and bio (About you).
    """
    display_name = (config.get("display_name") or "").strip()
    bio = (config.get("bio") or "").strip()

    if not display_name and not bio:
        return {"success": False, "error": "display_name or bio required"}

    if profile_id:
        await device.send_progress(0, f"Switching phone profile to {profile_id}...")
        await device.switch_profile(str(profile_id))

    await device.send_progress(5, "Opening Reddit...")
    await device.launch_app(REDDIT_PACKAGE, wait_after=4000)

    await device.send_progress(15, "Opening profile menu...")
    await device.get_screen()
    # Home XML dump uses resource-id="avatar" for the top-right profile button
    if not await device.tap_element(resource_id="avatar"):
        # Fallback: tap top-right corner
        w, _h = await device.get_screen_size()
        await device.tap(int(w * 0.92), 210, wait_after=1200)

    await device.get_screen()
    # Some builds show a menu item like "My profile"
    if device.text_on_screen("My profile"):
        await device.tap_element(text="My profile")
    elif device.text_on_screen("Profile"):
        await device.tap_element(text="Profile")
    await device.wait(2000)

    await device.send_progress(30, "Opening Edit Profile...")
    await device.get_screen()
    if not await device.tap_element(text="Edit"):
        # Profile page has an Edit button; fallback coordinate
        await device.tap(360, 670, wait_after=1200)

    await device.wait(2000)

    changed = {}
    await device.get_screen()

    if display_name:
        await device.send_log("Setting display name...")
        if await device.tap_element(resource_id="display_name"):
            await device.wait(250)
            await device.input_text(display_name, clear_first=True)
            changed["display_name"] = True

    if bio:
        await device.send_log("Setting bio...")
        if await device.tap_element(resource_id="about_field"):
            await device.wait(250)
            await device.input_text(bio, clear_first=True)
            changed["bio"] = True

    await device.send_progress(80, "Saving...")
    await device.get_screen()
    if not await device.tap_element(text="Save"):
        await device.tap_element(resource_id="save_button")
    await device.wait(2500)

    await device.send_progress(100, "Profile updated.")
    return {"success": True, "data": {"changed": changed}}


# Add TikTok and Twitter modules to registry
# NOTE: tiktok_post, twitter_post intentionally removed — handled by
# lib/ws_modules/* via the WS adapter. tiktok_engage / twitter_engage stay
# because the adapter ships tiktok_engagement / twitter_engagement (no
# `_engage` aliases).
_safe_register_ws_handlers("engage_aliases_and_reddit", lambda: {
        "tiktok_engage": execute_tiktok_engage_ws,
        "twitter_engage": execute_twitter_engage_ws,
        # Reddit (GrapheneOS-focused, not in adapter — keep native)
        "reddit_post": execute_reddit_post_ws,
        "reddit_batch_post": execute_reddit_batch_post_ws,
        "reddit_edit_profile": execute_reddit_edit_profile_ws,
    })


# ==================== NEW WS HANDLERS: Account, Drive, Airtable ====================


async def execute_account_creation_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based Instagram account creation module.
    Full auto flow: Gmail check → IG signup → email code → profile setup.
    Ported from account_creation_module.instagram_create_account.
    """
    import random
    import re as _re_acct

    email = str(config.get("email", "") or "").strip()
    password = str(config.get("password", "") or "").strip()
    ig_name = str(config.get("ig_name", config.get("name", "")) or "").strip()
    ig_username_raw = config.get("ig_username", config.get("username", None))
    ig_username = (
        str(ig_username_raw).strip() if ig_username_raw is not None else None
    ) or None
    create_ig = _coerce_bool(config.get("create_ig", True), True)
    skip_gmail_login = _coerce_bool(config.get("skip_gmail_login", False), False)
    gmail_password = str(config.get("gmail_password", "") or "").strip()
    recovery_email = str(config.get("recovery_email", "") or "").strip()
    use_custom_birthday = _coerce_bool(config.get("use_custom_birthday", False), False)
    birthday_month = config.get("birthday_month")
    birthday_day = config.get("birthday_day")
    birthday_year = config.get("birthday_year")

    if not email:
        return {"success": False, "error": "Email is required for IG creation"}
    if create_ig and not password:
        return {
            "success": False,
            "error": "Account password is required for IG creation",
        }
    if create_ig and not ig_name:
        return {"success": False, "error": "Name is required for IG creation"}

    await device.send_progress(0, "Checking device accounts...")

    def _short_error(error: object, max_len: int = 220) -> str:
        """Compact noisy ADB/client errors before sending them to the dashboard."""
        text = " ".join(str(error or "").split())
        return text[:max_len] + ("..." if len(text) > max_len else "")

    async def _tap_next_fast(settle_ms: int = 2400) -> None:
        """Advance through Next without tapping the Gboard punctuation row."""
        await device.get_screen()
        before_screen = device.current_screen or ""
        before_lower = before_screen.lower()

        async def _wait_for_transition(poll_ms: int = 300) -> bool:
            elapsed = 0
            while elapsed < settle_ms:
                await device.wait(poll_ms)
                await device.get_screen()
                if device.current_screen and device.current_screen != before_screen:
                    return True
                elapsed += poll_ms
            return False

        def _same_google_step(screen_xml: str) -> bool:
            lower = (screen_xml or "").lower()
            if "email or phone" in before_lower or "forgot email" in before_lower:
                return "email or phone" in lower or "forgot email" in lower
            if "enter your password" in before_lower or "show password" in before_lower:
                return "enter your password" in lower or "show password" in lower
            return False

        keyboard_visible = (
            "com.google.android.inputmethod" in before_lower
            or "gboard" in before_lower
        )
        google_signin_screen = (
            "email or phone" in before_lower
            or "forgot email" in before_lower
            or "enter your password" in before_lower
            or "show password" in before_lower
            or ("sign in" in before_lower and "google" in before_lower)
        )
        if keyboard_visible and google_signin_screen:
            await device.send_log("Google sign-in keyboard detected; pressing Enter for Next")
            await device.enter()
            await device.wait(500)
            await device.get_screen()
            if not _same_google_step(device.current_screen or ""):
                return

            width, height = await device.get_screen_size()
            await device.send_log("Google sign-in still on same step; tapping keyboard action")
            await device.tap(int(width * 0.93), int(height * 0.92), wait_after=500)
            await _wait_for_transition()
            return

        next_btn = device.find_element_by_text("Next")
        if next_btn:
            await device.tap(next_btn[0], next_btn[1], wait_after=500)
        else:
            await device.enter()
            await device.wait(500)

        await _wait_for_transition()

    async def _handle_add_phone_number_screen_if_present() -> bool:
        """
        Handle Google's optional "Add phone number?" checkpoint:
        scroll down the webview, tap Skip, then return True if handled.
        """
        await device.get_screen()
        screen_xml = (device.current_screen or "").lower()

        # Guard: only run this logic on the specific phone-number checkpoint.
        on_phone_screen = (
            "add phone number" in screen_xml
            or ("yes, i" in screen_xml and "skip" in screen_xml and "google accounts" in screen_xml)
        )
        if not on_phone_screen:
            return False

        await device.send_log("ℹ️ Add phone number checkpoint detected — scrolling to Skip")
        width, height = await device.get_screen_size()

        for _ in range(3):
            # Prefer direct skip tap if visible/clickable.
            skip_btn = device.find_element_by_text(
                "Skip"
            ) or device.find_element_by_content_description("Skip")
            if skip_btn:
                await device.tap(skip_btn[0], skip_btn[1], wait_after=600)
                await device.get_screen()
                after = (device.current_screen or "").lower()
                if "add phone number" not in after:
                    await device.send_log("✅ Skipped optional phone-number step")
                    return True

            # Scroll down the webview content to reveal/activate footer actions.
            await device.swipe(
                int(width * 0.50),
                int(height * 0.84),
                int(width * 0.50),
                int(height * 0.28),
                300,
                wait_after=400,
            )
            await device.get_screen()

        # Last-resort tap in lower-left footer where Skip sits on this screen family.
        await device.send_log("⚠️ Skip not found after scroll — trying footer-left fallback tap")
        await device.tap(int(width * 0.10), int(height * 0.93), wait_after=600)
        await device.get_screen()
        return "add phone number" not in (device.current_screen or "").lower()

    async def _tap_agree_fast(
        wait_after_ms: int = 850, allow_fallback: bool = False
    ) -> bool:
        """Tap agreement CTA across terms/privacy variants."""
        await device.get_screen()
        screen_xml = device.current_screen or ""
        labels = {
            "i agree",
            "agree and continue",
            "agree",
            "accept",
            "accept all",
            "i accept",
        }

        nodes: list[dict] = []
        screen_w = 1080
        screen_h = 2400
        for node_match in _re_acct.finditer(r"<node\b[^>]*>", screen_xml):
            node = node_match.group(0)
            bounds_match = _re_acct.search(
                r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node
            )
            if not bounds_match:
                continue

            x1, y1, x2, y2 = map(int, bounds_match.groups())
            screen_w = max(screen_w, x2)
            screen_h = max(screen_h, y2)

            text_match = _re_acct.search(r'text="([^"]*)"', node)
            desc_match = _re_acct.search(r'content-desc="([^"]*)"', node)
            rid_match = _re_acct.search(r'resource-id="([^"]*)"', node)
            cls_match = _re_acct.search(r'class="([^"]*)"', node)

            text_val = (text_match.group(1) if text_match else "") or ""
            desc_val = (desc_match.group(1) if desc_match else "") or ""
            rid_val = (rid_match.group(1) if rid_match else "") or ""
            cls_val = (cls_match.group(1) if cls_match else "") or ""

            nodes.append(
                {
                    "x1": x1,
                    "y1": y1,
                    "x2": x2,
                    "y2": y2,
                    "cx": (x1 + x2) // 2,
                    "cy": (y1 + y2) // 2,
                    "w": max(1, x2 - x1),
                    "h": max(1, y2 - y1),
                    "text": text_val,
                    "desc": desc_val,
                    "rid": rid_val,
                    "cls": cls_val,
                    "clickable": 'clickable="true"' in node.lower(),
                    "enabled": 'enabled="true"' in node.lower(),
                    "normalized": f"{text_val} {desc_val}".strip().lower(),
                }
            )

        # Prefer exact, clickable CTA labels first (avoids matching body text like "By tapping I agree...").
        for n in nodes:
            if not n["clickable"] or not n["enabled"]:
                continue
            if n["w"] >= int(screen_w * 0.94) and n["h"] >= int(screen_h * 0.55):
                continue
            t = (n["text"] or "").strip().lower()
            d = (n["desc"] or "").strip().lower()
            if t in labels or d in labels:
                await device.tap(n["cx"], n["cy"], wait_after=wait_after_ms)
                return True

        def _is_link_like(n: dict) -> bool:
            low = n["normalized"]
            return any(
                k in low
                for k in (
                    "terms",
                    "privacy",
                    "cookies",
                    "learn more",
                    "already have an account",
                )
            )

        # Ranked CTA candidates from XML.
        best: tuple[int, int, float] | None = None
        for n in nodes:
            if not n["clickable"] or not n["enabled"]:
                continue
            if n["w"] >= int(screen_w * 0.94) and n["h"] >= int(screen_h * 0.55):
                continue
            if _is_link_like(n):
                continue

            score = 0.0
            low = n["normalized"]
            cls_low = (n["cls"] or "").lower()
            rid_low = (n["rid"] or "").lower()

            if "i agree" in low:
                score += 100
            elif "agree and continue" in low:
                score += 92
            elif low == "agree":
                score += 84
            elif "accept all" in low:
                score += 80
            elif "accept" in low:
                score += 74

            if "button" in cls_low:
                score += 25
            if "button" in rid_low or "primary" in rid_low:
                score += 12
            if n["w"] >= int(screen_w * 0.52):
                score += 34
            if n["h"] >= 80:
                score += 8
            if int(screen_h * 0.38) <= n["cy"] <= int(screen_h * 0.72):
                score += 18
            if n["cy"] >= int(screen_h * 0.86):
                # Avoid bottom links like "I already have an account".
                score -= 30
            if low in ("loading", ""):
                # Some IG builds briefly expose the CTA as a wide button with no text or "Loading".
                score += 16

            if best is None or score > best[2]:
                best = (n["cx"], n["cy"], score)

        if best and best[2] >= 40:
            await device.send_log(
                f"ℹ️ Terms CTA heuristic tap at ({best[0]}, {best[1]})"
            )
            await device.tap(best[0], best[1], wait_after=wait_after_ms)
            return True

        if not allow_fallback:
            return False

        # Safe coordinate fallback for terms sheet primary CTA region.
        width, height = await device.get_screen_size()
        await device.tap(int(width * 0.50), int(height * 0.50), wait_after=wait_after_ms)
        await device.get_screen()
        return not _is_ig_terms_screen()

    def _is_ig_terms_screen(screen_xml: str | None = None) -> bool:
        """Detect Instagram terms/privacy agreement screen after signup."""
        lower = (screen_xml if screen_xml is not None else (device.current_screen or "")).lower()
        return any(
            marker in lower
            for marker in (
                "agree to instagram",
                "terms and policies",
                "by tapping i agree",
                "instagram's terms",
                "privacy policy",
                "terms of use",
                "i agree",
            )
        )

    def _is_ig_human_verification_checkpoint(screen_xml: str | None = None) -> bool:
        """
        Detect IG checkpoint: "Confirm you're human to use your account, <username>".
        This usually means account risk/2FA challenge and should stop automation.
        """
        raw = screen_xml if screen_xml is not None else (device.current_screen or "")
        lower = raw.lower()
        normalized = lower.replace("’", "'").replace("`", "'")
        has_checkpoint_text = (
            "confirm you're human to use your account" in normalized
            or (
                "confirm you're human" in normalized
                and "to use your account" in normalized
            )
        )
        has_continue_cta = (
            'content-desc="continue"' in normalized
            or 'text="continue"' in normalized
        )
        return (
            has_checkpoint_text
            and has_continue_cta
            and 'package="com.instagram.android"' in normalized
        )

    async def _abort_if_ig_human_verification_checkpoint(
        stage: str,
    ) -> dict | None:
        """Return a standardized error payload if IG human-checkpoint is visible."""
        await device.get_screen()
        if not _is_ig_human_verification_checkpoint():
            return None
        await device.send_log(
            f"⚠️ IG human-verification checkpoint detected at {stage}; stopping account creation."
        )
        return {
            "success": False,
            "error": "Instagram checkpoint detected: 'Confirm you're human to use your account'. Manual verification/2FA is required.",
            "data": {
                "checkpoint": "ig_confirm_human",
                "stage": stage,
                "manual_action_required": True,
            },
        }

    def _normalize_ui_label(value: str | None) -> str:
        return " ".join(str(value or "").strip().split()).lower()

    def _find_clickable_target(
        labels: list[str] | None = None,
        resource_ids: list[str] | None = None,
    ) -> tuple[int, int] | None:
        """Find clickable+enabled node center by exact text/content-desc or resource-id."""
        screen_xml = device.current_screen or ""
        if not screen_xml:
            return None

        label_set = {
            _normalize_ui_label(label)
            for label in (labels or [])
            if str(label or "").strip()
        }
        rid_set = {
            str(rid or "").strip().lower()
            for rid in (resource_ids or [])
            if str(rid or "").strip()
        }

        for node_match in _re_acct.finditer(r"<node\b[^>]*>", screen_xml):
            node = node_match.group(0)
            node_lower = node.lower()
            if 'clickable="true"' not in node_lower or 'enabled="true"' not in node_lower:
                continue

            bounds_match = _re_acct.search(
                r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                node,
            )
            if not bounds_match:
                continue
            x1, y1, x2, y2 = map(int, bounds_match.groups())
            cx, cy = (x1 + x2) // 2, (y1 + y2) // 2

            rid_match = _re_acct.search(r'resource-id="([^"]*)"', node)
            rid_val = ((rid_match.group(1) if rid_match else "") or "").strip().lower()
            if rid_set and rid_val:
                for rid in rid_set:
                    if rid_val == rid or rid_val.endswith(rid):
                        return (cx, cy)

            if label_set:
                text_match = _re_acct.search(r'text="([^"]*)"', node)
                desc_match = _re_acct.search(r'content-desc="([^"]*)"', node)
                text_val = _normalize_ui_label(text_match.group(1) if text_match else "")
                desc_val = _normalize_ui_label(desc_match.group(1) if desc_match else "")
                if text_val in label_set or desc_val in label_set:
                    return (cx, cy)

        return None

    async def _tap_clickable_target(
        labels: list[str] | None = None,
        resource_ids: list[str] | None = None,
        wait_after_ms: int = 700,
        refresh_screen: bool = True,
    ) -> bool:
        if refresh_screen:
            await device.get_screen()
        target = _find_clickable_target(labels=labels, resource_ids=resource_ids)
        if not target:
            return False
        await device.tap(target[0], target[1], wait_after=wait_after_ms)
        return True

    async def _tap_text_or_desc(
        labels: list[str],
        wait_after_ms: int = 700,
        allow_partial: bool = False,
        refresh_screen: bool = True,
    ) -> bool:
        """Tap first matching text/content-desc label."""
        if await _tap_clickable_target(
            labels=labels, wait_after_ms=wait_after_ms, refresh_screen=refresh_screen
        ):
            return True

        if not allow_partial:
            return False

        if refresh_screen:
            await device.get_screen()
        for label in labels:
            target = device.find_element_by_text(label) or device.find_element_by_content_description(label)
            if target:
                await device.tap(target[0], target[1], wait_after=wait_after_ms)
                return True
        return False

    async def _tap_permission_deny(wait_after_ms: int = 700) -> bool:
        """Dismiss Android permission popups with deny action."""
        await device.get_screen()
        deny = (
            device.find_element_by_resource_id(
                "com.android.permissioncontroller:id/permission_deny_button"
            )
            or device.find_element_by_resource_id(
                "com.android.permissioncontroller:id/permission_deny_and_dont_ask_again_button"
            )
            or device.find_element_by_resource_id("android:id/button2")
        )
        if deny:
            await device.tap(deny[0], deny[1], wait_after=wait_after_ms)
            return True

        # Text fallback for apostrophe variants.
        return await _tap_text_or_desc(
            ["Don\u2019t allow", "Don't allow", "Deny", "No thanks"],
            wait_after_ms=wait_after_ms,
            allow_partial=False,
            refresh_screen=False,
        )

    async def _tap_top_right_action(wait_after_ms: int = 700) -> None:
        """Fallback tap where Instagram commonly places Skip/Next in onboarding."""
        width, height = await device.get_screen_size()
        await device.tap(int(width * 0.92), int(height * 0.085), wait_after=wait_after_ms)

    async def _finish_post_signup() -> dict | None:
        """Handle post-signup onboarding stack (Skip / Not now / permission / Got it)."""

        def _is_logged_in_home_screen(lower_xml: str) -> bool:
            return (
                "your story" in lower_xml
                or "com.instagram.android:id/tab_bar" in lower_xml
                or "com.instagram.android:id/feed_tab" in lower_xml
                or "com.instagram.android:id/profile_tab" in lower_xml
            )

        idle_rounds = 0
        onboarding_markers = (
            "add profile photo",
            "find your friends",
            "find friends faster",
            "relevant friend suggestions",
            "facebook",
            "discover people",
            "sync your contacts",
            "turn on notifications",
            "save your login info",
            "complete your profile",
            "welcome to instagram",
            "i already have an account",
            "see more of what you love",
            "swipe to easily access",
            "add a mobile number",
        )

        # 12 rounds is enough — empirically the onboarding stack has
        # ~5-7 screens and each round handles one screen. 18 was paranoid
        # padding; if we haven't landed on the logged-in home by round 12
        # something's stuck and more loops won't help.
        for _ in range(12):
            await device.get_screen()
            screen_xml = (device.current_screen or "")
            lower = screen_xml.lower()

            if _is_ig_human_verification_checkpoint(screen_xml):
                await device.send_log(
                    "⚠️ IG human-verification checkpoint detected during post-signup onboarding."
                )
                return {
                    "success": False,
                    "error": "Instagram checkpoint detected: 'Confirm you're human to use your account'. Manual verification/2FA is required.",
                    "data": {
                        "checkpoint": "ig_confirm_human",
                        "stage": "post_signup_onboarding",
                        "manual_action_required": True,
                    },
                }

            # Already in logged-in shell/home.
            if _is_logged_in_home_screen(lower):
                await device.send_log("Logged-in home detected after onboarding.")
                return None

            acted = False

            # If Instagram opened Android Settings (notification preferences),
            # back out and continue onboarding in-app.
            if (
                'package="com.android.settings"' in screen_xml
                or "com.android.settings:id/" in lower
            ):
                await device.send_log("Android Settings opened during onboarding; going back.")
                await device.back()
                await device.wait(500)
                acted = True

            # Contacts onboarding after terms: prefer the exact top Skip. The
            # shared helper only falls back to Next on the legacy no-Skip UI.
            on_contacts_screen = (not acted) and (
                "connect_contacts_title_igds" in lower
                or "allow access to your contacts to make it easier to find your friends on instagram" in lower
            )
            if on_contacts_screen:
                if await handle_account_creation_phone_contacts_prompt(device):
                    acted = True

            # Optional "Add profile photo" onboarding.
            if not acted and (
                "add profile photo" in lower
                or "create a profile that shows your vibe" in lower
            ):
                if await _tap_clickable_target(
                    resource_ids=["com.instagram.android:id/action_bar_action_text"],
                    wait_after_ms=700,
                    refresh_screen=False,
                ) or await _tap_text_or_desc(
                    ["Skip", "SKIP"],
                    700,
                    allow_partial=False,
                    refresh_screen=False,
                ):
                    acted = True
                elif await _tap_clickable_target(
                    resource_ids=["igds_button"],
                    wait_after_ms=700,
                    refresh_screen=False,
                ) or await _tap_text_or_desc(
                    ["Done", "DONE"],
                    700,
                    allow_partial=False,
                    refresh_screen=False,
                ):
                    acted = True

            # "Turn on notifications" screen — tap Next to open Android settings, back out, then Skip
            if not acted and "turn on notifications" in lower:
                next_btn = device.find_element_by_text("Next") or device.find_element_by_text("NEXT")
                if next_btn:
                    await device.send_log("Notifications screen — tapping Next to open settings")
                    await device.tap(next_btn[0], next_btn[1], wait_after=800)

                    # Keep pressing back until we leave Android Settings and return to IG
                    for _back_attempt in range(4):
                        await device.get_screen()
                        settings_xml = (device.current_screen or "")
                        in_settings = (
                            'package="com.android.settings"' in settings_xml
                            or "com.android.settings:id/" in settings_xml.lower()
                            or "all instagram notifications" in settings_xml.lower()
                            or "notification" in settings_xml.lower() and "com.android.settings" in settings_xml
                        )
                        if not in_settings:
                            break
                        await device.send_log(f"Still in Android Settings — pressing back ({_back_attempt + 1}/4)")
                        await device.back()
                        await device.wait(800)

                    # Now back in IG — Skip should be visible (top-right)
                    await device.get_screen()
                    skip_btn = (
                        device.find_element_by_text("Skip")
                        or device.find_element_by_text("SKIP")
                        or device.find_element_by_content_description("Skip")
                    )
                    if skip_btn:
                        await device.tap(skip_btn[0], skip_btn[1], wait_after=700)
                        await device.send_log("Notifications screen — tapped Skip after settings round-trip")
                    else:
                        not_now = device.find_element_by_text("Not now") or device.find_element_by_text("Not Now")
                        if not_now:
                            await device.tap(not_now[0], not_now[1], wait_after=700)
                        else:
                            await device.back()
                            await device.wait(500)
                        await device.send_log("Notifications screen — dismissed via fallback")
                    acted = True

            # Optional Facebook-connect checkpoint.
            if not acted and (
                "connect to facebook" in lower
                or "connect a facebook page" in lower
            ):
                if await _tap_text_or_desc(
                    ["Skip", "SKIP"],
                    700,
                    allow_partial=False,
                    refresh_screen=False,
                ):
                    acted = True

            # "Get more relevant friend suggestions" — tap Skip (top-right), NOT Continue
            if not acted and (
                "relevant friend suggestions" in lower
                or "find your facebook friends" in lower
                or ("accounts center" in lower and "facebook" in lower)
            ):
                skip_btn = (
                    device.find_element_by_text("Skip")
                    or device.find_element_by_text("SKIP")
                    or device.find_element_by_content_description("Skip")
                )
                if skip_btn:
                    await device.tap(skip_btn[0], skip_btn[1], wait_after=700)
                    await device.send_log("Friend suggestions screen — tapped Skip")
                    acted = True

            # Handle "Do you want to find friends faster?" confirmation dialog explicitly
            if not acted and (
                "find friends faster" in lower
                or "do you want to find friends" in lower
                or ("yes, follow friends" in lower and "no, skip" in lower)
            ):
                no_skip = (
                    device.find_element_by_text("No, skip")
                    or device.find_element_by_text("No, Skip")
                )
                if no_skip:
                    await device.tap(no_skip[0], no_skip[1], wait_after=700)
                    await device.send_log("Dismissed 'find friends faster' dialog — No, skip")
                    acted = True

            if not acted and await _tap_permission_deny(700):
                await device.send_log("Dismissed permission popup (Do not allow).")
                acted = True
            elif await _tap_text_or_desc(
                ["Skip", "SKIP"],
                700,
                allow_partial=False,
                refresh_screen=False,
            ):
                acted = True
            elif await _tap_text_or_desc(
                ["Not now", "Not Now"],
                700,
                allow_partial=False,
                refresh_screen=False,
            ):
                acted = True
            elif await _tap_text_or_desc(
                ["No, skip", "No, Skip"],
                700,
                allow_partial=False,
                refresh_screen=False,
            ):
                acted = True
            elif await _tap_text_or_desc(
                ["Got it", "GOT IT"],
                700,
                allow_partial=False,
                refresh_screen=False,
            ):
                acted = True
            elif await _tap_text_or_desc(
                ["Done", "DONE"],
                700,
                allow_partial=False,
                refresh_screen=False,
            ):
                acted = True
            elif await _tap_text_or_desc(
                ["Next", "NEXT"],
                700,
                allow_partial=False,
                refresh_screen=False,
            ):
                acted = True
            elif any(marker in lower for marker in onboarding_markers):
                await _tap_top_right_action(700)
                acted = True

            if acted:
                idle_rounds = 0
                continue

            idle_rounds += 1
            if idle_rounds >= 2:
                return None
            await device.wait(220)

    async def _is_signup_screen() -> bool:
        """Return True once we leave login and enter account creation screens."""
        await device.get_screen()
        signup_markers = [
            "Sign up with email",
            "Create a username",
            "Create a new Instagram account in this Accounts Center",
            "What's your email",
            "What's your mobile number",
            "Enter confirmation code",
            "Create a password",
            "I agree",
        ]
        return any(device.text_on_screen(marker) for marker in signup_markers)

    async def _tap_sign_up_with_email() -> bool:
        """Tap the email signup option across IG variants."""
        labels = [
            "Sign up with email",
            "Sign up with Email",
            "Sign up with email address",
            "Use email",
        ]
        for label in labels:
            target = device.find_element_by_text(
                label
            ) or device.find_element_by_content_description(label)
            if target:
                await device.send_log(f"Email signup CTA found ({label}), tapping...")
                await device.tap(target[0], target[1], wait_after=950)
                await device.get_screen()
                return True
        return False

    async def _tap_create_account_entrypoint() -> bool:
        """
        Handle old/new/onboarding Instagram signup entry layouts before email step.

        Old layout example:
        - Login form + "Forgot password?"
        - Bottom CTA "Create new account" near Meta logo

        New layout variants may expose:
        - "Create account"
        - "Sign up"

        Onboarding layout may expose:
        - "Join Instagram"
        - "Get started"
        """

        def _find_signup_cta() -> tuple[int, int, str] | None:
            cta_labels = [
                "Create new account",
                "Create account",
                "Sign up",
                "Get started",
                "Get Started",
            ]
            for label in cta_labels:
                coords = device.find_element_by_text(label)
                if coords:
                    return (coords[0], coords[1], label)
                coords = device.find_element_by_content_description(label)
                if coords:
                    return (coords[0], coords[1], label)
            return None

        for attempt in range(4):
            await device.get_screen()
            screen_xml = (device.current_screen or "").lower()

            # If IG already moved to signup, we are done.
            if await _is_signup_screen():
                return True

            is_old_layout = (
                "forgot password?" in screen_xml
                and (
                    "create new account" in screen_xml
                    or "meta logo" in screen_xml
                    or "username, email or mobile number" in screen_xml
                )
            )

            is_new_layout = (
                (
                    "create account" in screen_xml
                    or "sign up" in screen_xml
                    or "log in to existing account" in screen_xml
                    or "log into existing account" in screen_xml
                )
                and not is_old_layout
            )

            is_onboarding_layout = (
                "join instagram" in screen_xml
                or "get started" in screen_xml
                or "i already have an account" in screen_xml
            )

            cta = _find_signup_cta()
            if cta:
                cta_x, cta_y, cta_label = cta
                layout_name = (
                    "old"
                    if is_old_layout
                    else "new"
                    if is_new_layout
                    else "onboarding"
                    if is_onboarding_layout
                    else "unknown"
                )
                await device.send_log(
                    f"Signup CTA found ({layout_name} layout: {cta_label}), tapping..."
                )
                await device.tap(cta_x, cta_y, wait_after=1050)
                if await _is_signup_screen():
                    return True
                # New onboarding path: Get started -> Sign up with email.
                if "get started" in cta_label.lower():
                    await _tap_sign_up_with_email()
                    if await _is_signup_screen():
                        return True
                continue

            # No direct match found: use layout-aware fallback taps.
            width, height = await device.get_screen_size()
            center_x = width // 2
            if is_old_layout:
                # Old login page keeps CTA near the bottom.
                await device.send_log(
                    "Old login layout detected; using bottom CTA fallback tap."
                )
                await device.tap(center_x, int(height * 0.88), wait_after=1200)
            elif is_new_layout:
                # Newer variants often position signup CTA a bit higher.
                await device.send_log(
                    "New login layout detected; using mid-lower CTA fallback tap."
                )
                await device.tap(center_x, int(height * 0.80), wait_after=1200)
            elif is_onboarding_layout:
                await device.send_log(
                    "Onboarding layout detected; using Get started fallback tap."
                )
                await device.tap(center_x, int(height * 0.83), wait_after=1050)
                await _tap_sign_up_with_email()
            else:
                # Unknown layout: nudge viewport and retry discovery.
                await device.send_log(
                    f"Signup CTA not found (attempt {attempt + 1}/4), retrying..."
                )
                await device.swipe(540, 1850, 540, 1200, 300, wait_after=700)

            if await _is_signup_screen():
                return True

        return False

    def _first_edittext_value() -> str | None:
        """Read the visible value from the first EditText on the current screen."""
        if not device.current_screen:
            return None
        match = _re_acct.search(
            r'<node[^>]*class="android\.widget\.EditText"[^>]*text="([^"]*)"',
            device.current_screen,
            _re_acct.IGNORECASE | _re_acct.DOTALL,
        )
        if not match:
            return None
        value = match.group(1).strip()
        return value or None

    async def _is_username_first_signup_screen() -> bool:
        """Detect IG variants that ask for username before email/code."""
        await device.get_screen()
        lower = (device.current_screen or "").lower()
        return "create a username" in lower and "username" in lower

    async def _handle_accounts_center_prompt_if_present() -> bool:
        """
        Handle the current IG Accounts Center branch after username entry.
        For fresh phone-profile accounts we intentionally choose the standalone
        email/mobile route instead of attaching to the logged-in account center.
        """
        await device.get_screen()
        lower = (device.current_screen or "").lower()
        if "create a new instagram account in this accounts center" not in lower:
            return False

        await device.send_log(
            "Accounts Center prompt detected; choosing standalone email/mobile route."
        )
        standalone = (
            device.find_element_by_text("No, use mobile number or email")
            or device.find_element_by_text("Use mobile number or email")
            or device.find_element_by_content_description(
                "No, use mobile number or email"
            )
        )
        if standalone:
            await device.tap(standalone[0], standalone[1], wait_after=1200)
            return True

        width, height = await device.get_screen_size()
        await device.tap(width // 2, int(height * 0.88), wait_after=1200)
        return True

    async def _handle_username_first_signup_if_present() -> tuple[bool, str | None]:
        """
        Newer Instagram builds can start signup with "Create a username".
        Handle that branch before the legacy email-first Gmail verification flow.
        """
        if not await _is_username_first_signup_screen():
            return False, None

        await device.send_log("Instagram username-first signup flow detected.")
        final_username = None

        input_field = device.find_element_by_class("android.widget.EditText")
        if input_field:
            await device.tap(input_field[0], input_field[1], wait_after=300)

        if ig_username:
            await device.select_all_and_delete()
            await device.wait(120)
            await device.input_text(ig_username)
            await device.wait(180)
            final_username = ig_username
        else:
            suggested = _first_edittext_value()
            if suggested and _re_acct.fullmatch(r"[a-z0-9_.]{3,30}", suggested):
                final_username = suggested

        await _tap_next_fast(2200)
        await _handle_accounts_center_prompt_if_present()

        await device.get_screen()
        if device.text_on_screen("Create a password"):
            await device.send_progress(58, "Setting password...")
            password_field = device.find_element_by_class("android.widget.EditText")
            if password_field:
                await device.tap(password_field[0], password_field[1], wait_after=350)
            await device.input_text(password)
            await device.wait(250)
            await _tap_next_fast(2200)

        return True, final_username

    async def _is_ig_verification_screen() -> bool:
        """Detect IG email-code verification step during signup."""
        await device.get_screen()
        verification_markers = [
            "Enter confirmation code",
            "Confirmation code",
            "check your email",
            "get the code",
            "Resend confirmation code",
        ]
        return any(device.text_on_screen(marker) for marker in verification_markers)

    async def _is_ig_login_screen() -> bool:
        """Detect IG login screen to avoid typing verification code in username field."""
        await device.get_screen()
        has_user_field = (
            device.text_on_screen("Username, email or mobile number")
            or device.text_on_screen("Phone number, username or email")
            or device.text_on_screen("Username, email address, or mobile number")
        )
        has_password = device.text_on_screen("Password")
        has_login = device.text_on_screen("Log in") or device.text_on_screen("Log In")
        return bool(has_user_field and has_password and has_login)

    async def _foreground_package() -> str:
        """Best-effort foreground package detection."""
        out = await device.shell("dumpsys activity activities")
        matches = _re_acct.findall(r"([a-zA-Z0-9_.]+)/[a-zA-Z0-9_.$]+", out or "")
        return matches[-1] if matches else ""

    def _is_recents_screen() -> bool:
        xml = (device.current_screen or "").lower()
        return (
            "com.android.launcher3" in xml
            or "quickstep" in xml
            or "clear all" in xml
            or "recent apps" in xml
        )

    async def _switch_to_app_from_recents(app_name: str, package: str = "") -> bool:
        """Recents-first switch with retries/swipes; verifies target package when provided."""
        candidates = [
            app_name,
            app_name.upper(),
            app_name.lower(),
            package,
        ]

        for attempt in range(3):
            await device.send_log(
                f"Switching via recents to {app_name} (attempt {attempt + 1}/3)..."
            )
            await device.keyevent(187)
            await device.wait(500)
            await device.get_screen()

            if not _is_recents_screen():
                # Gesture fallback for devices where KEYCODE_APP_SWITCH is ignored.
                await device.swipe(540, 2350, 540, 1150, 420, wait_after=650)
                await device.get_screen()

            if _is_recents_screen():
                for cand in candidates:
                    if not cand:
                        continue
                    app_card = device.find_element_by_text(
                        cand
                    ) or device.find_element_by_content_description(cand)
                    if app_card:
                        await device.tap(app_card[0], app_card[1], wait_after=1200)
                        if package:
                            current = await _foreground_package()
                            if current and package in current:
                                return True
                            # One retry inside the chosen app card
                            await device.wait(450)
                            current = await _foreground_package()
                            if current and package in current:
                                return True
                            continue
                        return True

            # Swipe recents cards and try direct "last app" toggle.
            await device.swipe(900, 1200, 220, 1200, 280, wait_after=450)
            await device.get_screen()
            await device.swipe(220, 1200, 900, 1200, 280, wait_after=450)
            await device.keyevent(187)
            await device.wait(400)
            if package:
                current = await _foreground_package()
                if current and package in current:
                    return True

        return False

    async def _restore_ig_verification_context(signup_email: str) -> bool:
        """
        Return to IG verification screen safely.
        If IG fell back to login while checking Gmail, rebuild to code step.
        """
        switched = await _switch_to_app_from_recents("Instagram", "com.instagram.android")
        if not switched:
            await device.send_log(
                "Recents switch to Instagram failed; using launch_app fallback."
            )
            await device.launch_app("com.instagram.android", wait_after=1000)
            await device.get_screen()

        for attempt in range(3):
            if await _is_ig_verification_screen():
                return True

            if await _is_ig_login_screen():
                await device.send_log(
                    "Instagram returned to login screen while fetching code; restoring signup step..."
                )
                if not await _tap_create_account_entrypoint():
                    await device.send_log(
                        "Could not tap signup entrypoint from login; retrying app restore..."
                    )
                    if attempt < 2:
                        await _switch_to_app_from_recents(
                            "Instagram", "com.instagram.android"
                        )
                        await device.launch_app("com.instagram.android", wait_after=900)
                        continue
                    return False

                await device.get_screen()
                await _tap_sign_up_with_email()

                input_field = device.find_element_by_class("android.widget.EditText")
                if input_field:
                    await device.tap(input_field[0], input_field[1], wait_after=350)
                await device.select_all_and_delete()
                await device.input_text(signup_email)
                await device.wait(250)
                await _tap_next_fast(2200)

                if await _is_ig_verification_screen():
                    return True

            if attempt < 2:
                await device.launch_app("com.instagram.android", wait_after=900)

        return False

    try:
        # ── Step 1: Gmail enumeration (via Gmail app — profile-scoped) ──
        await device.send_progress(5, "Getting Gmail accounts for this profile...")

        gmail_accounts = []
        try:
            # Open Gmail app (runs inside the profile's sandbox = correct
            # scope — dumpsys account via adb shell user 0 would only see
            # user 0's accounts, missing profile-scoped ones).
            await device.launch_app("com.google.android.gm", wait_after=900)

            # Tap profile icon (top-right) to show account picker. Trimmed
            # the standalone 800ms wait — wait_after=500 on the tap covers
            # the slide-in animation and the next get_screen pays for its
            # own settle.
            await device.tap(980, 200, wait_after=500)

            # Get screen XML and scrape gmail addresses
            screen_xml = await device.get_screen()
            if screen_xml:
                for m in _re_acct.finditer(
                    r'text="([a-zA-Z0-9_.+\-]+@gmail\.com)"', screen_xml
                ):
                    addr = m.group(1).strip().lower()
                    if addr not in gmail_accounts:
                        gmail_accounts.append(addr)

            # Force-stop Gmail to ensure clean state for login step
            await device.shell("am force-stop com.google.android.gm")
            await device.home()
        except Exception as e:
            await device.send_log(
                f"Gmail app check failed ({_short_error(e)}), falling back to dumpsys"
            )
            # Fallback: dumpsys (less accurate but works without Gmail app)
            result = await device.shell("dumpsys account")
            if result:
                for m in _re_acct.finditer(
                    r"Account\s*\{\s*name=([^,]+),\s*type=com\.google\}", result
                ):
                    addr = m.group(1).strip().lower()
                    if "@" in addr and addr not in gmail_accounts:
                        gmail_accounts.append(addr)

        gmail_count = len(gmail_accounts)
        await device.send_log(
            f"📧 Found {gmail_count} Gmail account{'s' if gmail_count != 1 else ''} on this profile"
        )

        if gmail_count >= 5:
            return {
                "success": False,
                "error": "Profile is full (5 Gmail accounts). Use a different profile.",
            }

        if not create_ig:
            await device.send_progress(100, "Account check complete!")
            return {
                "success": True,
                "data": {
                    "gmail_count": gmail_count,
                    "gmail_slots_left": 5 - gmail_count,
                    "accounts": gmail_accounts,
                },
            }

        # ── Step 2: Gmail login (add account to profile if not already there) ──
        effective_gmail_pw = gmail_password or password
        email_already_on_profile = email.lower() in [a.lower() for a in gmail_accounts]

        if not skip_gmail_login and effective_gmail_pw and not email_already_on_profile:
            await device.send_progress(10, f"Logging into Gmail: {email}...")
            gmail_result = await execute_gmail_login_ws(
                device,
                {
                    "email": email,
                    "password": effective_gmail_pw,
                    "recovery_email": recovery_email,
                },
                profile_id,
            )
            if not gmail_result.get("success"):
                gmail_error = str(gmail_result.get("error") or "unknown error")
                if not gmail_error.lower().startswith("gmail login failed:"):
                    gmail_error = f"Gmail login failed: {gmail_error}"
                return {
                    "success": False,
                    "error": gmail_error,
                }
            await device.send_log("✅ Gmail account added to profile")
        elif email_already_on_profile:
            await device.send_log(
                f"📧 {email} already on this profile, skipping Gmail login"
            )

        # ── Step 3: Launch Instagram ──
        await device.send_progress(20, "Launching Instagram...")
        await device.launch_app("com.instagram.android", wait_after=800)
        await device.dismiss_common_popups()
        await device.get_screen()

        # ── Step 4: If already logged in, use Add Instagram account flow ──
        # 2.16.60: do NOT log out — that nukes the existing account on this
        # profile. Use IG's native long-press-on-profile-tab → Add Instagram
        # account → Create new account flow, which keeps the existing account
        # logged in alongside the new one. Falls back to logout if the
        # long-press flow can't find the bottom sheet.
        if device.text_on_screen("Your story") or device.text_on_screen("your story"):
            await device.send_log(
                "⚠️ Already logged in — using Add Instagram account flow"
            )

            # Land on profile tab so the long-press hits the right area
            await device.tap(972, 2274, wait_after=700)
            await device.get_screen()

            # Long-press the profile tab (swipe in-place, 800ms hold).
            # This opens IG's account switcher bottom sheet.
            await device.swipe(972, 2274, 972, 2274, 800, wait_after=1200)
            await device.get_screen()

            add_ig_btn = (
                device.find_element_by_content_description("Add Instagram account")
                or device.find_element_by_text("Add Instagram account")
            )

            if add_ig_btn:
                await device.send_log("📂 Account switcher opened — tapping Add Instagram account")
                await device.tap(add_ig_btn[0], add_ig_btn[1], wait_after=2000)
                await device.get_screen()

                # 2.16.60: bail out early + cleanly if IG/Google throws a
                # phone-verification challenge before we even reach signup.
                _challenge_text = (device.current_screen or "").lower()
                if (
                    "verify your phone number" in _challenge_text
                    or "verify it's you" in _challenge_text
                    or "verify it’s you" in _challenge_text
                ):
                    await device.send_log(
                        "🛑 Phone-verify challenge detected on Add account path — cannot proceed"
                    )
                    return {
                        "success": False,
                        "error": "Phone verification required (account is gated by Google SMS 2FA)",
                        "data": {"needs_phone_verification": True, "email": email},
                    }

                create_btn = (
                    device.find_element_by_content_description("Create new account")
                    or device.find_element_by_text("Create new account")
                )
                if create_btn:
                    await device.tap(create_btn[0], create_btn[1], wait_after=1500)
                    await device.send_log("✅ Tapped Create new account — proceeding to signup")
                    await device.get_screen()
                else:
                    await device.send_log(
                        "⚠️ Add screen shown but Create new account button not found — proceeding anyway"
                    )
            else:
                # Fallback: long-press didn't open the sheet → use logout flow
                await device.send_log(
                    "⚠️ Long-press didn't open account switcher — falling back to logout"
                )
                # Hamburger menu
                await device.tap(996, 202, wait_after=700)

                # Scroll down to find Log out — bail as soon as it appears
                logout_all = None
                logout_single = None
                for _ in range(6):
                    await device.swipe(540, 1800, 540, 600, 350, wait_after=300)
                    await device.get_screen()
                    logout_all = device.find_element_by_text("Log out all accounts")
                    if logout_all:
                        break
                    logout_single = (
                        device.find_element_by_text("Log out")
                        or device.find_element_by_text("Log Out")
                    )
                    if logout_single:
                        break

                if logout_all:
                    await device.tap(logout_all[0], logout_all[1], wait_after=800)
                    await device.get_screen()
                    confirm = device.find_element_by_text("Log out")
                    if confirm:
                        await device.tap(confirm[0], confirm[1], wait_after=1200)
                    await device.send_log("✅ Logged out all existing accounts (fallback)")
                elif logout_single:
                    await device.tap(
                        logout_single[0], logout_single[1], wait_after=800
                    )
                    await device.get_screen()
                    confirm = device.find_element_by_text(
                        "Log out"
                    ) or device.find_element_by_text("Log Out")
                    if confirm:
                        await device.tap(confirm[0], confirm[1], wait_after=1200)
                    await device.send_log("✅ Logged out existing account (fallback)")
                else:
                    await device.send_log(
                        "⚠️ Could not find Log out button after scrolling"
                    )

                await device.get_screen()

        # ── Step 5: Click Create new account ──
        await device.send_progress(28, "Starting signup flow...")
        if not await _tap_create_account_entrypoint():
            return {
                "success": False,
                "error": "Could not find signup entry point (old/new login layout)",
            }

        await device.get_screen()

        final_username = None
        username_first_flow, username_first_value = (
            await _handle_username_first_signup_if_present()
        )
        if username_first_value:
            final_username = username_first_value

        if not username_first_flow:
            # ── Step 6: Sign up with email ──
            await _tap_sign_up_with_email()

            # ── Step 7: Enter email ──
            await device.send_progress(33, "Entering email...")
            input_field = device.find_element_by_class("android.widget.EditText")
            if input_field:
                await device.tap(input_field[0], input_field[1], wait_after=500)
            await device.input_text(email)
            await device.wait(250)

            await _tap_next_fast(2200)

            # ── Step 8: Get verification code from Gmail ──
            await device.send_progress(38, "Waiting for verification code from Gmail...")
            code = await _ig_get_code_from_gmail(device, email)

            if not code:
                return {
                    "success": False,
                    "error": "Failed to get Instagram verification code from Gmail",
                }

            # ── Step 9: Switch back to Instagram and enter code ──
            await device.send_progress(52, "Entering verification code...")
            if not await _restore_ig_verification_context(email):
                return {
                    "success": False,
                    "error": "Instagram left the verification step while checking Gmail.",
                }
            if await _is_ig_login_screen():
                return {
                    "success": False,
                    "error": "Instagram returned to login screen; verification code entry aborted safely.",
                }

            input_field = device.find_element_by_class("android.widget.EditText")
            if input_field:
                await device.tap(input_field[0], input_field[1], wait_after=500)
            await device.input_text(code)
            await device.wait(250)

            await _tap_next_fast(2200)

            # ── Step 10: Create password ──
            await device.send_progress(58, "Setting password...")
            await device.get_screen()
            input_field = device.find_element_by_class("android.widget.EditText")
            if input_field:
                await device.tap(input_field[0], input_field[1], wait_after=500)
            await device.input_text(password)
            await device.wait(250)

            await _tap_next_fast(2200)

            # Handle "This password matches your existing account" dialog
            await device.get_screen()
            if device.text_on_screen("password matches") or device.text_on_screen("CREATE NEW ACCOUNT"):
                await device.send_log("Password-matches-existing dialog detected — tapping Create New Account")
                create_new = (
                    device.find_element_by_text("CREATE NEW ACCOUNT")
                    or device.find_element_by_text("Create new account")
                    or device.find_element_by_text("Create New Account")
                )
                if create_new:
                    await device.tap(create_new[0], create_new[1], wait_after=2000)
                else:
                    # Fallback — the CREATE button is usually android:id/button2
                    btn = device.find_element_by_resource_id("android:id/button2")
                    if btn:
                        await device.tap(btn[0], btn[1], wait_after=2000)
                await device.get_screen()

        else:
            await device.send_log(
                "Username/password were handled before birthday; skipping legacy email-code step."
            )

        # ── Steps 11-13: Birthday, Name, Username (adaptive order) ──
        # Instagram A/B tests the order of these screens.
        # Instead of assuming a fixed order, detect what's on screen and handle it.
        birthday_done = False
        name_done = False
        username_done = False
        birthday_override = None
        if use_custom_birthday:
            try:
                month_i = int(birthday_month)
                day_i = int(birthday_day)
                year_i = int(birthday_year)
                if 1 <= month_i <= 12 and 1 <= day_i <= 31 and 1900 <= year_i <= 2012:
                    birthday_override = {"month": month_i, "day": day_i, "year": year_i}
                    await device.send_log(f"📅 Using custom birthday: {month_i:02d}/{day_i:02d}/{year_i}")
                else:
                    await device.send_log("⚠️ Custom birthday out of bounds; falling back to random 2003-2007.")
            except Exception:
                await device.send_log("⚠️ Invalid custom birthday values; falling back to random 2003-2007.")

        for _adaptive_round in range(8):
            await device.get_screen()
            lower = (device.current_screen or "").lower()

            checkpoint_error = await _abort_if_ig_human_verification_checkpoint(f"adaptive_round_{_adaptive_round}")
            if checkpoint_error:
                return checkpoint_error

            # Detect: Birthday screen
            if not birthday_done and ("what's your birthday" in lower or "birthday" in lower or "set date" in lower):
                await device.send_progress(64, "Setting birthday...")
                birthday_ok = await _ig_set_random_birthday(device, birthday_override=birthday_override)
                if not birthday_ok:
                    return {"success": False, "error": "Failed to set birthday (SET button was not confirmed)."}
                await _tap_next_fast(950)
                birthday_done = True
                continue

            # Detect: Username screen (separate, not combined with name)
            if not username_done and ("create a username" in lower) and "full name" not in lower:
                await device.send_progress(76, "Setting username...")
                import random as _rng

                async def _clear_username_field():
                    """Clear pre-filled username using X button or select-all-delete."""
                    await device.get_screen()
                    # Try the X (clear) button first — IG shows it next to the field
                    clear_btn = device.find_element_by_content_description("Clear username")
                    if not clear_btn:
                        # Look for any clickable element that looks like a clear/X button near the field
                        import re as _re_clear
                        if device.current_screen:
                            # Find EditText bounds first
                            et_match = _re_clear.search(
                                r'class="android\.widget\.EditText"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                                device.current_screen,
                            )
                            if et_match:
                                et_right = int(et_match.group(3))
                                et_cy = (int(et_match.group(2)) + int(et_match.group(4))) // 2
                                # The X button is usually just right of the field
                                clear_btn = (et_right + 30, et_cy)
                    if clear_btn:
                        await device.tap(clear_btn[0], clear_btn[1], wait_after=500)
                    else:
                        # Fallback: tap field, select all, delete
                        input_field = device.find_element_by_class("android.widget.EditText")
                        if input_field:
                            await device.tap(input_field[0], input_field[1], wait_after=300)
                        await device.select_all_and_delete()
                        await device.wait(200)

                # Clear the pre-filled username
                await _clear_username_field()
                await device.wait(300)

                # Limit base username to 12 chars to leave room for suffixes
                base_username = ig_username[:28] if ig_username else ig_name.lower().replace(" ", ".").replace("'", "")[:12]
                candidate = base_username
                max_attempts = 6

                for uname_attempt in range(max_attempts):
                    if uname_attempt > 0:
                        # Clear and try with random suffix
                        await _clear_username_field()
                        await device.wait(200)
                        suffix = str(_rng.randint(10, 9999))
                        candidate = f"{base_username[:24]}{suffix}"

                    await device.input_text(candidate)
                    # Poll for IG's validation verdict instead of a blind 2s
                    # sleep. IG usually paints the green tick / error within
                    # 400-900ms; bail as soon as either signal lands. Worst-
                    # case ceiling stays at ~1.9s (300+200+200+200+300+700ms
                    # of cumulative sleeps incl. get_screen RTT) so we don't
                    # regress on slow networks.
                    is_valid = False
                    has_error = False
                    uname_lower = ""
                    for _step_ms in (300, 200, 200, 200, 300):
                        await device.wait(_step_ms)
                        await device.get_screen()
                        uname_lower = (device.current_screen or "").lower()
                        is_valid = (
                            "input username is valid" in uname_lower
                            or device.find_element_by_content_description("Input Username is valid")
                        )
                        has_error = (
                            "isn't available" in uname_lower
                            or "must be under" in uname_lower
                            or "can only include" in uname_lower
                            or "not available" in uname_lower
                            or "already taken" in uname_lower
                        )
                        if is_valid or has_error:
                            break

                    if is_valid and not has_error:
                        await device.send_log(f"✅ Username accepted: {candidate}")
                        final_username = candidate
                        break
                    elif has_error:
                        await device.send_log(f"⚠️ Username '{candidate}' rejected, trying variant...")
                    else:
                        # No clear signal — assume it's fine
                        await device.send_log(f"Username set to: {candidate} (no error detected)")
                        final_username = candidate
                        break
                else:
                    # All attempts failed — use whatever is in the field
                    await device.send_log(f"⚠️ Could not find valid username after {max_attempts} attempts, proceeding with last try")
                    final_username = candidate

                await _tap_next_fast(950)
                username_done = True
                continue

            # Detect: Name screen (or combined name+username)
            if not name_done and ("what's your name" in lower or "full name" in lower):
                await device.send_progress(70, f"Setting name: {ig_name}...")
                combined_screen = device.text_on_screen("Full name") and device.text_on_screen("Username")

                all_edits = []
                if device.current_screen:
                    for m in _re_acct.finditer(
                        r'class="android\.widget\.EditText"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                        device.current_screen,
                    ):
                        cx = (int(m.group(1)) + int(m.group(3))) // 2
                        cy = (int(m.group(2)) + int(m.group(4))) // 2
                        all_edits.append((cx, cy))
                    if not all_edits:
                        for m in _re_acct.finditer(
                            r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*class="android\.widget\.EditText"',
                            device.current_screen,
                        ):
                            cx = (int(m.group(1)) + int(m.group(3))) // 2
                            cy = (int(m.group(2)) + int(m.group(4))) // 2
                            all_edits.append((cx, cy))

                if all_edits:
                    await device.tap(all_edits[0][0], all_edits[0][1], wait_after=320)
                await device.input_text(ig_name)
                await device.wait(120)

                if combined_screen and len(all_edits) >= 2 and not username_done:
                    import random as _rng2
                    await device.send_progress(76, "Setting username...")
                    await device.tap(all_edits[1][0], all_edits[1][1], wait_after=300)
                    await device.select_all_and_delete()
                    await device.wait(200)

                    base_uname = ig_username or ig_name.lower().replace(" ", ".").replace("'", "")[:20]
                    candidate_uname = base_uname
                    for u_attempt in range(6):
                        if u_attempt > 0:
                            await device.select_all_and_delete()
                            await device.wait(150)
                            candidate_uname = f"{base_uname[:25]}{_rng2.randint(10, 9999)}"
                        await device.input_text(candidate_uname)
                        # Poll for IG validation verdict instead of blind 1.5s.
                        is_ok = False
                        has_err = False
                        u_lower = ""
                        for _step_ms in (300, 200, 200, 300):
                            await device.wait(_step_ms)
                            await device.get_screen()
                            u_lower = (device.current_screen or "").lower()
                            is_ok = "input username is valid" in u_lower or device.find_element_by_content_description("Input Username is valid")
                            has_err = "isn't available" in u_lower or "must be under" in u_lower or "not available" in u_lower
                            if is_ok or has_err:
                                break
                        if is_ok and not has_err:
                            final_username = candidate_uname
                            break
                        elif not has_err:
                            final_username = candidate_uname
                            break
                    else:
                        final_username = candidate_uname
                    username_done = True

                await _tap_next_fast(950)
                name_done = True
                continue

            # Detect: Password screen (IG sometimes shows this in adaptive order)
            if "create a password" in lower or ("password" in lower and "at least 6" in lower):
                await device.send_progress(58, "Setting password...")
                await device.send_log("Password screen detected in adaptive flow")
                password_field = device.find_element_by_class("android.widget.EditText")
                if password_field:
                    await device.tap(password_field[0], password_field[1], wait_after=350)
                await device.input_text(password)
                await device.wait(250)
                await _tap_next_fast(2200)
                continue

            # Detect: Terms/agree screen — all profile steps done
            if "i agree" in lower or "agree to" in lower or "terms" in lower:
                await device.send_log("Reached terms screen — profile setup complete.")
                break

            # Detect: Edit how you'll appear (combined screen variant)
            if "edit how you" in lower:
                # Same as name screen — handle it
                continue

            # Unknown screen — tap Next if available and continue
            next_btn = device.find_element_by_text("Next") or device.find_element_by_content_description("Next")
            if next_btn:
                await device.send_log(f"Adaptive: unknown screen, tapping Next (round {_adaptive_round})")
                await device.tap(next_btn[0], next_btn[1], wait_after=800)
                continue

            break  # No action possible, exit loop

        # ── Step 14: Accept terms / privacy policy ──
        await device.send_progress(82, "Accepting terms...")
        await device.get_screen()
        checkpoint_error = await _abort_if_ig_human_verification_checkpoint(
            "before_terms"
        )
        if checkpoint_error:
            return checkpoint_error
        terms_accepted = False
        for attempt in range(1, 9):
            checkpoint_error = await _abort_if_ig_human_verification_checkpoint(
                f"terms_loop_{attempt}"
            )
            if checkpoint_error:
                return checkpoint_error

            if not _is_ig_terms_screen():
                terms_accepted = True
                break

            await _tap_agree_fast(950, allow_fallback=True)
            await device.wait(180)
            await device.get_screen()
            if not _is_ig_terms_screen():
                terms_accepted = True
                break
            if attempt in (3, 6):
                # Occasionally CTA sits slightly out of viewport after transitions.
                await device.swipe(540, 1900, 540, 1450, 220, wait_after=220)

        if not terms_accepted and _is_ig_terms_screen():
            await device.send_log("❌ Could not confirm Instagram terms acceptance.")
            return {
                "success": False,
                "error": "Could not click Instagram terms acceptance (I agree).",
            }

        # ── Step 15: Post-signup screens ──
        await device.send_progress(90, "Finishing setup...")
        post_signup_result = await _finish_post_signup()
        if post_signup_result:
            return post_signup_result
        await device.get_screen()
        post_signup_lower = (device.current_screen or "").lower()
        if (
            "your story" in post_signup_lower
            or "com.instagram.android:id/tab_bar" in post_signup_lower
            or "com.instagram.android:id/feed_tab" in post_signup_lower
            or "com.instagram.android:id/profile_tab" in post_signup_lower
        ):
            await device.send_log("✅ Account creation completion confirmed (home shell).")
        else:
            await device.send_log(
                "⚠️ Post-signup ended without explicit home marker; proceeding cautiously."
            )

        await device.send_progress(100, "Instagram account created!")
        await device.send_log(
            f"✅ IG account created! Email: {email}, Username: {final_username or 'auto'}"
        )

        return {
            "success": True,
            "data": {
                "email": email,
                "username": final_username,
                "name": ig_name,
                "gmail_count": gmail_count,
            },
        }

    except Exception as e:
        return {"success": False, "error": str(e)}


def detect_account_creation_phone_profile_state(xml):
    xml = xml or ""
    has_existing = (
        "Add Instagram account" in xml
        or "Your story" in xml
        or "tab_avatar" in xml
        or "action_bar_inbox_button" in xml
        or "com.instagram.android:id/reels_tray_container" in xml
        or "com.instagram.android:id/swipeable_nav_view_pager_inner_recycler_view" in xml
        or "com.instagram.android:id/profile_action_bar" in xml
        or 'resource-id="com.instagram.android:id/profile_tab"' in xml
        or 'content-desc="Instagram Home Feed"' in xml
    )
    is_fresh = (not has_existing) and (
        "Create new account" in xml
        and ("Log in" in xml or "username, email" in xml.lower() or "Use another profile" in xml)
    )
    is_fresh_v2 = (not has_existing) and (
        "Join Instagram" in xml and "Get started" in xml and "I already have a profile" in xml
    )
    return has_existing, is_fresh, is_fresh_v2


async def detect_account_creation_phone_profile_state_live(device, attempts=4, wait_ms=1200):
    state = (False, False, False)
    for attempt in range(attempts):
        await device.get_screen()
        state = detect_account_creation_phone_profile_state(device.current_screen)
        if any(state):
            return state
        if attempt + 1 < attempts:
            await device.wait(wait_ms)
    return state


def find_account_creation_phone_profile_tab(device):
    find_in_bounds = getattr(device, "find_element_by_resource_id_in_bounds", None)
    if callable(find_in_bounds):
        target = find_in_bounds(
            "com.instagram.android:id/profile_tab",
            min_y=2000,
        )
        if target:
            return target

    target = device.find_element_by_resource_id("com.instagram.android:id/profile_tab")
    if target and target[1] >= 2000:
        return target

    target = device.find_element_by_content_description("Profile")
    if target and target[1] >= 2000:
        return target
    return None


def extract_account_creation_phone_profile_username(xml):
    import re

    for node in re.findall(r"<node\b[^>]*>", xml or ""):
        if 'resource-id="com.instagram.android:id/action_bar_title"' not in node:
            continue
        match = re.search(r'text="([A-Za-z0-9._]{1,30})"', node)
        if match:
            return match.group(1).lower()
    return None


async def verify_account_creation_phone_logout_cleanup(
    device,
    expected_fresh=False,
    expected_username=None,
):
    await device.shell("am force-stop com.instagram.android")
    await device.launch_app("com.instagram.android", wait_after=3000)
    has_existing, is_fresh, is_fresh_v2 = await detect_account_creation_phone_profile_state_live(
        device,
        attempts=3,
        wait_ms=750,
    )
    normalized_screen = (device.current_screen or "").lower().replace("’", "'")
    if "confirm you're human" in normalized_screen:
        return False
    if expected_fresh:
        return is_fresh or is_fresh_v2
    if not has_existing or not expected_username:
        return False

    profile_tab = find_account_creation_phone_profile_tab(device)
    if not profile_tab:
        return False
    await device.tap(profile_tab[0], profile_tab[1], wait_after=1200)
    await device.get_screen()
    active_username = extract_account_creation_phone_profile_username(device.current_screen)
    return active_username == str(expected_username).strip().lstrip("@").lower()


def find_account_creation_phone_exact_skip(device, xml):
    import re

    find_by_id = getattr(device, "find_element_by_resource_id", lambda _resource_id: None)
    for node in re.findall(r"<node\b[^>]*>", xml or ""):
        text_match = re.search(r'text="([^"]*)"', node)
        desc_match = re.search(r'content-desc="([^"]*)"', node)
        labels = {
            (text_match.group(1) if text_match else "").strip().lower(),
            (desc_match.group(1) if desc_match else "").strip().lower(),
        }
        if "skip" not in labels:
            continue
        if 'resource-id="com.instagram.android:id/action_bar_action_text"' in node:
            target = find_by_id("com.instagram.android:id/action_bar_action_text")
            if target:
                return target
        bounds = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
        if bounds:
            x1, y1, x2, y2 = map(int, bounds.groups())
            return ((x1 + x2) // 2, (y1 + y2) // 2)

    if "skip" not in (xml or "").lower():
        return None
    return (
        device.find_element_by_content_description("Skip")
        or device.find_element_by_text("Skip", exact=True)
    )


def find_account_creation_phone_logout_target(xml, username):
    import re

    expected = f"log out {str(username or '').strip().lstrip('@').lower()}"
    if expected == "log out ":
        return None
    for node in re.findall(r"<node\b[^>]*>", xml or ""):
        text_match = re.search(r'text="([^"]*)"', node)
        if not text_match or text_match.group(1).strip().lower() != expected:
            continue
        bounds = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
        if bounds:
            x1, y1, x2, y2 = map(int, bounds.groups())
            return ((x1 + x2) // 2, (y1 + y2) // 2)
    return None


async def tap_account_creation_phone_next(device, attempts=3):
    for attempt in range(attempts):
        await device.get_screen()
        find_by_id = getattr(device, "find_element_by_resource_id", lambda _resource_id: None)
        target = (
            find_by_id("com.instagram.android:id/bb_primary_action_container")
            or find_by_id("com.instagram.android:id/button_text")
            or device.find_element_by_content_description("Next")
            or device.find_element_by_text("Next")
        )
        if target:
            await device.tap(target[0], target[1], wait_after=4000)
            return True
        if attempt + 1 < attempts:
            await device.wait(750)
    await device.send_log("phone-signup: Next button not found after live screen refresh", "WARN")
    return False


async def handle_account_creation_phone_notification_prompt(device):
    xml = device.current_screen or ""
    in_notification_settings = (
        "com.android.settings:id/collapsing_toolbar" in xml
        and (
            "All Instagram notifications" in xml
            or "You haven't allowed notifications from this app" in xml
        )
    )
    is_notification_intro = "Turn on notifications" in xml or "turn on notifications" in xml.lower()
    if not in_notification_settings and not is_notification_intro:
        return False

    if in_notification_settings:
        await device.send_log("phone-signup: notification Settings opened, returning to Instagram")
        await device.shell("input keyevent KEYCODE_BACK")
        await device.wait(2500)
        await device.get_screen()

    find_by_id = getattr(device, "find_element_by_resource_id", lambda _resource_id: None)
    skip = (
        find_by_id("com.instagram.android:id/action_bar_action_text")
        or device.find_element_by_content_description("Skip")
        or device.find_element_by_text("Skip")
    )
    if skip:
        await device.send_log("phone-signup: skip notification onboarding")
        await device.tap(skip[0], skip[1], wait_after=2500)
        return True

    if is_notification_intro:
        back = (
            find_by_id("com.instagram.android:id/action_bar_button_back")
            or device.find_element_by_content_description("Back")
        )
        if back:
            await device.send_log("phone-signup: skip notification onboarding via Back")
            await device.tap(back[0], back[1], wait_after=2500)
            return True

    return await tap_account_creation_phone_next(device)


async def handle_account_creation_phone_contacts_prompt(device):
    xml = device.current_screen or ""
    lower_xml = xml.lower()
    is_contacts_intro = (
        "connect_contacts_sync_button" in xml
        or "connect_contacts_title_igds" in lower_xml
        or "next, you can allow access to your contacts" in lower_xml
        or "allow access to your contacts to make it easier to find your friends on instagram" in lower_xml
    )
    is_contacts_settings_prompt = (
        "open settings" in lower_xml
        and "contacts" in lower_xml
        and ("turn on" in lower_xml or "permissions" in lower_xml)
    )
    if not is_contacts_intro and not is_contacts_settings_prompt:
        return False

    if is_contacts_settings_prompt:
        await device.send_log("phone-signup: contacts Settings prompt opened, returning to Instagram")
        await device.shell("input keyevent KEYCODE_BACK")
        await device.wait(1200)
        await device.get_screen()

    for attempt in range(3):
        xml = device.current_screen or ""
        skip = find_account_creation_phone_exact_skip(device, xml)
        if skip:
            await device.send_log("phone-signup: skip contacts onboarding")
            await device.tap(skip[0], skip[1], wait_after=2500)
            return True
        if attempt < 2:
            await device.wait(500)
            await device.get_screen()

    if is_contacts_settings_prompt:
        return True
    xml = device.current_screen or ""
    is_legacy_no_skip = (
        (
            "connect_contacts_sync_button" in xml
            or "connect_contacts_title_igds" in xml.lower()
            or "next, you can allow access to your contacts" in xml.lower()
            or "allow access to your contacts to make it easier to find your friends on instagram" in xml.lower()
        )
        and "skip" not in xml.lower()
    )
    if is_legacy_no_skip:
        return await tap_account_creation_phone_next(device)
    await device.send_log("phone-signup: contacts Skip not found after live screen refresh", "WARN")
    return True


def find_account_creation_phone_terms_i_agree_button(xml):
    import re

    candidates = []
    pattern = re.compile(
        r'<node[^>]*(?:text="I agree"|content-desc="I agree")[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
        re.IGNORECASE,
    )
    for match in pattern.finditer(xml or ""):
        x1, y1, x2, y2 = map(int, match.groups())
        width, height = x2 - x1, y2 - y1
        candidates.append((width * height, (x1 + x2) // 2, (y1 + y2) // 2))
    if not candidates:
        return None
    bottom = [candidate for candidate in candidates if candidate[2] >= 1000]
    return max(bottom or candidates)[1:]


def account_creation_phone_profile_matches(xml, username):
    import re

    for node in re.findall(r"<node\b[^>]*>", xml or ""):
        text_match = re.search(r'text="([^"]*)"', node)
        if (
            'resource-id="com.instagram.android:id/action_bar_title"' in node
            and text_match
            and text_match.group(1) == username
        ):
            return True
    return False


async def verify_account_creation_phone_profile(device, username, attempts=6, wait_ms=1200):
    for attempt in range(attempts):
        await device.get_screen()
        if account_creation_phone_profile_matches(device.current_screen, username):
            return True
        if attempt + 1 < attempts:
            await device.wait(wait_ms)
    return False


def account_creation_phone_is_home_feed(xml, username=None):
    xml = xml or ""
    is_home = (
        'content-desc="Instagram Home Feed"' in xml
        or "com.instagram.android:id/action_bar_inbox_button" in xml
        or "com.instagram.android:id/reels_tray_container" in xml
    )
    return is_home and (not username or username in xml)


def account_creation_phone_advanced_past_sms_code(xml):
    xml = xml or ""
    if "Enter the confirmation code" in xml or "Code input entry field" in xml:
        return False
    post_code_markers = (
        "Create a password",
        "Set date",
        "What's your birthday",
        "What's your name",
        "Add your name",
        "Create a username",
        "Add a username",
        "Agree to Instagram",
        'content-desc="I agree"',
        "Lets get started",
        "Let's get started",
    )
    return any(marker in xml for marker in post_code_markers) or detect_account_creation_phone_profile_state(xml)[0]


async def submit_account_creation_phone_sms_code(device, attempts=3):
    for attempt in range(attempts):
        await device.get_screen()
        if account_creation_phone_advanced_past_sms_code(device.current_screen):
            await device.send_log("phone-signup: SMS code auto-submitted and advanced")
            return True
        find_by_id = getattr(device, "find_element_by_resource_id", lambda _resource_id: None)
        target = (
            find_by_id("com.instagram.android:id/bb_primary_action_container")
            or find_by_id("com.instagram.android:id/button_text")
            or device.find_element_by_content_description("Next")
            or device.find_element_by_text("Next")
        )
        if target:
            await device.tap(target[0], target[1], wait_after=4000)
            return True
        if attempt + 1 < attempts:
            await device.wait(750)
    await device.send_log("phone-signup: SMS code submit control not found", "WARN")
    return False


async def execute_account_creation_phone_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """Phone-only IG account creation via smspool. Validated 2026-05-26.

    Auto-detects fresh profile vs profile with existing IG accounts and picks
    the right navigation path. Both converge on the mobile-number entry screen,
    then smspool buys the selected US or GB number, the brain waits for the SMS code,
    enters it, and completes the rest of the signup. No Gmail, no reCAPTCHA.
    """
    import random as _r_acp
    import re as _re_acp
    import string as _str_acp

    cfg_username = str(config.get("ig_username", config.get("username", "")) or "").strip().lstrip("@")
    cfg_password = str(config.get("password", config.get("ig_password", "")) or "")
    cfg_name = str(config.get("ig_name", config.get("name", "")) or "").strip()
    sms_provider = str(config.get("sms_provider", "smspool") or "smspool").strip().lower()
    smspool_key = str(config.get("textverified_api_key" if sms_provider == "textverified" else "smspool_api_key", "") or "").strip()
    textverified_username = str(config.get("textverified_api_username", "") or "").strip()
    smspool_country = str(config.get("smspool_country", "US") or "US").strip().upper()
    try:
        sms_max_price = float(config.get("sms_max_price_usd", 0.50))
    except (TypeError, ValueError):
        sms_max_price = 0
    if (sms_provider not in {"smspool", "textverified"} or not (0.01 <= sms_max_price <= 100)
            or abs(sms_max_price * 100 - round(sms_max_price * 100)) > 1e-8):
        return {"success": False, "code": "SMS_PROVIDER_INVALID", "error": "Choose a supported SMS provider and a valid maximum price."}
    if sms_provider == "textverified" and smspool_country != "US":
        return {"success": False, "code": "SMS_PROVIDER_COUNTRY_INVALID", "error": "TextVerified supports US numbers in this flow."}
    textverified_client = None
    if sms_provider == "textverified":
        from textverified_sms import TextVerifiedSms
        textverified_client = TextVerifiedSms(smspool_key, textverified_username)

    if not cfg_password.strip():
        return {
            "success": False,
            "code": "EXPLICIT_PASSWORD_REQUIRED",
            "error": "Enter an explicit password before starting account creation.",
        }
    profile_failure = await validate_account_creation_phone_profile(device, config, profile_id)
    if profile_failure:
        return profile_failure
    if not smspool_key or (sms_provider == "textverified" and not textverified_username):
        return {"success": False, "error": "Save your SMS provider credentials in Settings before creating an account."}
    if smspool_country not in {"US", "GB"}:
        return {
            "success": False,
            "code": "SMSPOOL_COUNTRY_INVALID",
            "error": "Choose SMSPool country US or GB before starting account creation.",
        }

    def _rand(n, chars=_str_acp.ascii_lowercase + _str_acp.digits):
        return "".join(_r_acp.choices(chars, k=n))

    desired_username = cfg_username or ("eva" + _rand(7))
    desired_password = cfg_password
    desired_name = cfg_name or desired_username

    async def _type_in_focused_edit(text: str) -> bool:
        await device.get_screen()
        xml = device.current_screen or ""
        m = _re_acp.search(
            r'<node[^>]*class="android\.widget\.EditText"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
            xml,
        )
        if not m:
            await device.send_log("phone-signup: no EditText on screen for requested value", "WARN")
            return False
        cx = (int(m.group(1)) + int(m.group(3))) // 2
        cy = (int(m.group(2)) + int(m.group(4))) // 2
        await device.tap(cx, cy, wait_after=400)
        await device.shell("input keycombination 113 29")
        await device.wait(200)
        await device.shell("input keyevent KEYCODE_DEL")
        await device.wait(150)
        await device.input_text(text, typing_mode="human")
        await device.wait(700)
        return True

    async def _tap_next() -> bool:
        return await tap_account_creation_phone_next(device)

    async def _set_birthday_1996():
        # 2.18.16: this used to only type "1996" into the last EditText, never
        # set month/day, and never confirmed SET was tapped — which is why
        # every phone-signup ran past birthday with a broken date and IG
        # silently dropped the account at finalize. The real Android system
        # DatePicker uses 3 NumberPickers (NOT EditTexts) with
        # resource-id="android:id/numberpicker_input" on the selected value
        # and resource-id="android:id/button1" for SET. The full
        # implementation already exists in _ig_set_random_birthday — it
        # reads NumberPicker column bounds, steps each column via
        # top/bottom taps, verifies the values via numberpicker_input text,
        # and loops the SET tap until the picker dialog actually closes.
        # Reuse it. Returns True on confirmed SET.
        return await _ig_set_random_birthday(device)

    await device.send_progress(2, "Detecting profile state...")
    await device.launch_app("com.instagram.android", wait_after=3500)
    has_existing, is_fresh, is_fresh_v2 = await detect_account_creation_phone_profile_state_live(device)
    profile_was_fresh = bool(is_fresh or is_fresh_v2)
    previous_username = None
    xml = device.current_screen or ""
    # 2.18.25: detect the new "Join Instagram" landing variant. IG shipped this
    # to fresh profiles/installs at some point in 2026: instead of the classic
    # "Create new account" button, the welcome screen shows "Get started" +
    # "I already have a profile". Tapping Get started jumps STRAIGHT to the
    # mobile-number screen — no username/password/birthday/name prompts before
    # the SMS step. The collection order flips to:
    #   mobile -> code -> password -> Set date dialog -> birthday confirm
    #     -> name -> username (pre-filled suggestion) -> terms -> onboarding
    # Live-walked 2026-05-26 by Anyro on user 35 -> walker875893 created
    # end-to-end. Treat is_fresh_v2 as a sibling of is_fresh; the post-SMS
    # screen-driven loop handles each subsequent screen by content match.
    await device.send_log(f"phone-signup: state has_existing={has_existing} is_fresh={is_fresh} is_fresh_v2={is_fresh_v2}")

    if has_existing:
        await device.send_progress(10, "Existing IG found, long-pressing profile tab...")
        # 2.18.19: was previously using find_element_by_content_description("Profile")
        # which on the Reels feed matched the FIRST content-desc="Profile" node — that
        # turned out to be the reel creator's "Profile" link in the reel header, NOT
        # the bottom-nav Profile tab. Long-pressing the creator's profile navigated
        # to their profile page instead of opening the account switcher.
        # The bottom-nav Profile tab is uniquely identified by
        # `com.instagram.android:id/profile_tab` (resource-id), which IG keeps stable
        # across feed/reels/explore/inbox/profile tabs. Use it first; fall back to
        # the content-desc lookup only with a bounds guard requiring the element to
        # be in the bottom nav area (y >= 2000 on 1080x2400 Pixel 6).
        prof = find_account_creation_phone_profile_tab(device)
        # Last-resort fallback: hardcoded coord of the bottom-nav profile tab on
        # 1080x2400 Pixel 6 (the most common ShadowPhone device).
        px, py = (prof[0], prof[1]) if prof else (972, 2274)
        await device.tap(px, py, wait_after=1200)
        await device.get_screen()
        previous_username = extract_account_creation_phone_profile_username(device.current_screen)
        if not previous_username:
            return {
                "success": False,
                "error": "Could not verify the active Instagram account before opening account creation. No SMS order was purchased.",
            }
        prof = find_account_creation_phone_profile_tab(device)
        px, py = (prof[0], prof[1]) if prof else (972, 2274)
        await device.send_log(f"phone-signup: long-press profile tab at ({px}, {py}) {'via resource-id' if prof else 'via fallback coords'}")
        await device.shell(f"input swipe {px} {py} {px} {py} 1200")
        await device.wait(2000)

        add = device.find_element_by_content_description("Add Instagram account") or device.find_element_by_text("Add Instagram account")
        if not add:
            return {"success": False, "error": "Add Instagram account row not found in profile switcher — long-press may have hit the wrong target. Re-open IG and try again."}
        await device.tap(add[0], add[1], wait_after=3000)

        crt = device.find_element_by_content_description("Create new account") or device.find_element_by_text("Create new account")
        if not crt:
            return {"success": False, "error": "Create new account button not found on Add screen"}
        await device.tap(crt[0], crt[1], wait_after=3500)

        await device.send_progress(20, f"Entering username @{desired_username}...")
        await _type_in_focused_edit(desired_username)
        await _tap_next()

        await device.get_screen()
        xml = device.current_screen or ""
        if "use mobile number or email" in xml.lower() or "Accounts Center" in xml:
            use = (
                device.find_element_by_content_description("No, use mobile number or email")
                or device.find_element_by_content_description("Use mobile number or email")
                or device.find_element_by_text("Use mobile number or email")
            )
            if use:
                await device.tap(use[0], use[1], wait_after=3500)

        await device.get_screen()
        xml = device.current_screen or ""
        if "Create a password" in xml or "Password" in xml:
            await device.send_progress(28, "Setting password...")
            await _type_in_focused_edit(desired_password)
            await _tap_next()

        await device.get_screen()
        xml = device.current_screen or ""
        if "birthday" in xml.lower() or "Set date" in xml:
            if not await _set_birthday_1996():
                return {"success": False, "error": "Failed to set birthday (SET tap was not confirmed)."}
            await _tap_next()

    elif is_fresh:
        await device.send_progress(10, "Fresh profile, tapping Create new account...")
        crt = device.find_element_by_content_description("Create new account") or device.find_element_by_text("Create new account")
        if not crt:
            return {"success": False, "error": "Create new account button not on welcome screen"}
        await device.tap(crt[0], crt[1], wait_after=3500)
    elif is_fresh_v2:
        # 2.18.25 — new Join Instagram landing. One tap on Get started jumps
        # us straight to the mobile-number screen.
        await device.send_progress(10, "Fresh v2 landing, tapping Get started...")
        gs = (
            device.find_element_by_content_description("Get started")
            or device.find_element_by_text("Get started")
        )
        if not gs:
            return {"success": False, "error": "Get started button not on Join Instagram landing"}
        await device.tap(gs[0], gs[1], wait_after=3500)
    else:
        return {
            "success": False,
            "code": "INSTAGRAM_SIGNUP_SCREEN_UNAVAILABLE",
            "error": "Instagram did not show a readable login or profile screen. Open Instagram on the selected Android profile and let it finish loading before trying again. No SMS number was purchased.",
        }

    await device.get_screen()
    xml = device.current_screen or ""
    if "mobile number" not in xml.lower() and "phone number" not in xml.lower():
        return {"success": False, "error": f"Did not reach mobile-number screen. Screen: {xml[:300]}"}

    async def _record_sms_order(value):
        encoded = base64.urlsafe_b64encode(value.encode("utf-8")).decode("ascii").rstrip("=")
        await device.send_progress(41, f"account-recovery-order-secret:{encoded}")

    await device.send_progress(40, f"Buying one {smspool_country} SMS number from {sms_provider} (limit ${sms_max_price:.2f})...")
    profile_failure = await validate_account_creation_phone_profile(device, config, profile_id)
    if profile_failure:
        return profile_failure
    if textverified_client:
        async def _verify_before_textverified_purchase():
            failure = await validate_account_creation_phone_profile(device, config, profile_id)
            if failure:
                raise ValueError("The target Android profile changed before purchase")

        sms = await textverified_client.buy(sms_max_price, on_order=_record_sms_order, before_purchase=_verify_before_textverified_purchase)
    else:
        profile_failure = await validate_account_creation_phone_profile(device, config, profile_id)
        if profile_failure:
            return profile_failure
        sms = await smspool_buy_number(
            smspool_key,
            service=SMSPOOL_SERVICE_INSTAGRAM,
            country=smspool_country,
            max_price=sms_max_price,
        )
    if not sms["ok"]:
        return {
            "success": False,
            "error": sms["error"],
            "code": sms.get("code", "smspool_buy_failed"),
            "data": {
                "retryable": not bool(sms.get("reconciliation_required")),
                "manual_action_required": bool(sms.get("manual_action_required")),
                "uncertain_outcome": bool(sms.get("reconciliation_required")),
                "sms_order_reconciliation_required": bool(sms.get("reconciliation_required")),
            },
        }
    phone = sms["phone"]
    order_id = sms["order_id"]
    device._account_creation_paid_boundary_reached = True
    code_received = False
    code_submitted = False
    device._account_creation_sms_state = {
        "order_id": order_id,
        "provider": sms_provider,
        "api_username": textverified_username,
        "api_key": smspool_key,
        "code_received": False,
        "code_submitted": False,
    }
    encoded_order_id = base64.urlsafe_b64encode(order_id.encode("utf-8")).decode("ascii").rstrip("=")
    await device.send_progress(41, f"account-recovery-order-secret:{encoded_order_id}")
    await device.send_log("phone-signup: SMS number acquired")

    async def _fail_before_code(error, failure_code):
        cancellation = await cancel_smspool_order_if_safe(
            order_id,
            smspool_key,
            code_received=code_received,
            code_submitted=code_submitted,
            provider=sms_provider,
            api_username=textverified_username,
        )
        device._account_creation_sms_state = None
        if cancellation.get("cancelled"):
            await device.send_log("phone-signup: unused SMS order cancelled; refund requested")
        elif cancellation.get("attempted"):
            await device.send_log("phone-signup: SMS order cancellation was not confirmed", "WARN")
        return {
            "success": False,
            "error": error,
            "code": failure_code,
            "data": {
                "sms_order_cancelled": bool(cancellation.get("cancelled")),
                "sms_refund_requested": bool(cancellation.get("refund_requested")),
                "sms_order_reconciliation_required": bool(cancellation.get("reconciliation_required")),
                "credential_reservation_release_safe": bool(cancellation.get("cancelled")) and not bool(cancellation.get("reconciliation_required")),
                "retryable": bool(cancellation.get("cancelled")) and not bool(cancellation.get("reconciliation_required")),
            },
        }

    # Always type the full international number returned by SMSPool. The
    # explicit calling code prevents Instagram from guessing the country from
    # the first local digits.
    digits_only = _re_acp.sub(r"\D", "", phone)
    formatted_phone = "+" + digits_only
    await device.send_progress(50, "Entering SMS number...")
    # 2.18.24: clear the mobile-number field BEFORE typing. Otherwise a retry
    # (after smspool failed pool, partially-typed "+" remaining, IG redirect
    # back to phone screen, etc.) leaves leftover characters and the new
    # `+` we type appends → IG sees "++1..." and rejects "Mobile number is
    # invalid." The _brute_clear pattern (KEYCODE_MOVE_END + N×KEYCODE_DEL)
    # works for IG's prism EditTexts where device.clear() / Ctrl+A doesn't.
    # See [[feedback_adb_input_text_spaces]] for the prism EditText
    # selection-state gotcha that motivated brute_clear in the first place.
    # 2.18.26: batch the 20 DEL keycodes into a SINGLE adb call. The previous
    # per-DEL round-trip pattern spent ~100s on the tunnel for a 20-key clear
    # (Anyro hit `error: closed` on Tailscale mid-clear 2026-05-26). One call
    # finishes in ~3s and only crosses the transport once — drastically
    # shrinks the window where a network blip can kill the flow.
    await device.shell("input keyevent KEYCODE_MOVE_END " + " ".join(["KEYCODE_DEL"] * 20))
    await device.wait(300)
    if not await _type_in_focused_edit(formatted_phone):
        return await _fail_before_code(
            "Instagram's mobile-number field was unavailable.",
            "sms_phone_entry_failed",
        )
    if not await _tap_next():
        return await _fail_before_code(
            "Instagram's mobile-number submission button was unavailable.",
            "sms_phone_submit_failed",
        )

    # 2.18.21: split the 180s smspool poll into 12 × 15s chunks with a
    # send_progress between each. The renderer WS client tears down after
    # ~45s of silence (HEARTBEAT_STALE_MS in lib/ws-module-client.js), and
    # a single 180s poll with one progress event was tripping that timeout
    # — Anyro hit "create failed: WebSocket" mid-poll. Progress events are
    # treated as keepalive frames on the renderer side.
    await device.send_progress(60, "Waiting for SMS code (up to 3 min)...")
    code_r = None
    SMS_CHUNK_S = 15
    SMS_TOTAL_S = 180
    for chunk_i in range(SMS_TOTAL_S // SMS_CHUNK_S):
        code_r = (await textverified_client.poll(order_id, timeout_s=SMS_CHUNK_S)
                  if textverified_client else await smspool_poll_sms(order_id, smspool_key, timeout_s=SMS_CHUNK_S))
        if code_r and code_r.get("ok"):
            break
        elapsed = (chunk_i + 1) * SMS_CHUNK_S
        await device.send_progress(
            min(60 + chunk_i, 74),
            f"Waiting for SMS code ({elapsed}s/{SMS_TOTAL_S}s)..."
        )
    if not code_r or not code_r.get("ok"):
        return await _fail_before_code(
            "No SMS code arrived within the verification budget.",
            "sms_code_unavailable",
        )
    code = str(code_r["code"])
    code_received = True
    device._account_creation_sms_state["code_received"] = True
    await device.send_log("phone-signup: SMS code received")

    await device.send_progress(75, "Entering verification code...")
    if not await _type_in_focused_edit(code):
        return {
            "success": False,
            "error": "The SMS code was received but Instagram's code field was unavailable. Check the phone manually; the order will not be cancelled.",
            "code": "sms_code_entry_failed",
            "data": {"retryable": False, "manual_action_required": True},
        }
    if not await submit_account_creation_phone_sms_code(device):
        return {
            "success": False,
            "error": "The SMS code was entered but could not be submitted. Check the phone manually; the order will not be cancelled.",
            "code": "sms_code_submit_failed",
            "data": {"retryable": False, "manual_action_required": True},
        }
    code_submitted = True
    device._account_creation_sms_state["code_submitted"] = True

    await device.wait(3000)
    # 2.18.25: bump iterations from 5 -> 10 so the new "Get started" flow
    # has room for: password, Set date dialog, birthday confirmation, name,
    # username (with pre-filled suggestion). The classic flow only needed 5.
    # Treat is_fresh and is_fresh_v2 the same — both go through these
    # screen-detected steps before terms.
    in_v1_or_v2 = is_fresh or is_fresh_v2
    for _step in range(10):
        await device.get_screen()
        xml = device.current_screen or ""
        if in_v1_or_v2 and "Create a password" in xml:
            await device.send_progress(80, "Setting password...")
            # 2.18.26: batch the brute-clear into a single adb call. See
            # the mobile-number brute-clear above for rationale (Tailscale
            # tunnel exposure window collapse from ~100s -> ~3s).
            await device.shell("input keyevent KEYCODE_MOVE_END " + " ".join(["KEYCODE_DEL"] * 20))
            await device.wait(200)
            await _type_in_focused_edit(desired_password)
            await _tap_next()
            continue
        # 2.18.25: in v2 flow, after the Set date NumberPicker dialog SET
        # closes, IG shows a SECOND birthday confirmation screen titled
        # "What's your birthday?" with the chosen date in a read-only field
        # and a (X years old) annotation. Just tap Next — no editing needed.
        if is_fresh_v2 and "What's your birthday" in xml and "years old" in xml:
            await device.send_progress(82, "Confirming birthday...")
            await _tap_next()
            continue
        if in_v1_or_v2 and ("Set date" in xml or ("birthday" in xml.lower() and "What's your birthday" not in xml)):
            if not await _set_birthday_1996():
                return {"success": False, "error": "Failed to set birthday (SET tap was not confirmed)."}
            await _tap_next()
            continue
        if in_v1_or_v2 and ("What's your name" in xml or "Add your name" in xml):
            await device.send_progress(84, f"Entering name {desired_name}...")
            await _type_in_focused_edit(desired_name)
            await _tap_next()
            continue
        if in_v1_or_v2 and ("Create a username" in xml or "Add a username" in xml or ("username" in xml.lower() and "panther" in xml.lower())):
            await device.send_progress(86, f"Setting username @{desired_username}...")
            # 2.18.25: in v2 flow, the username field comes PRE-FILLED with an
            # IG-generated suggestion (e.g. "walker72806"). If we just call
            # input text our desired_username, it APPENDS to the suggestion
            # which IG rejects as too long / taken. Brute-clear first, then
            # type. The clear is harmless in v1 (the field is empty there).
            # 2.18.26: batched into a single adb call.
            await device.shell("input keyevent KEYCODE_MOVE_END " + " ".join(["KEYCODE_DEL"] * 30))
            await device.wait(200)
            await _type_in_focused_edit(desired_username)
            await _tap_next()
            continue
        break

    await device.send_progress(88, "Accepting terms (may require multiple retries)...")
    await device.get_screen()
    xml = device.current_screen or ""
    if "Agree to Instagram" in xml or "Terms" in xml:
        # 2.18.18: the "Loading → I agree revert" pattern is IG rate-limiting,
        # NOT a permanent reject. Anyro confirmed live 2026-05-26: "sometimes
        # tapping agree after can be a waiting game, so u just need to try
        # again every minute until it goes through". Retry up to N times spaced
        # ~60s apart until: (a) screen advances past terms, (b) "There was a
        # problem setting up your account" hard-reject appears, or (c) budget
        # exhausted. See [[feedback_ig_terms_retry]].
        #
        # 2.18.19 update: helper to pick the ACTUAL "I agree" button, not the
        # inline "I agree" text inside the body paragraph "By tapping I agree,
        # you agree to create an account and to Instagram's Terms, Privacy
        # Policy and Cookies Policy." The inline span has matching content-desc
        # and text but its bounds are TINY (~80px wide inline mention) versus
        # the actual button (full-width ~900px, ~120px tall, near the bottom).
        # Picking the inline mention tapped Privacy Policy / Terms instead of
        # agreeing. Pick the largest "I agree" bounds in the bottom half.
        TERMS_MAX_ATTEMPTS = 10            # up to 10 taps
        TERMS_RETRY_INTERVAL_MS = 60_000   # 60s between taps
        agreed = False
        for attempt in range(1, TERMS_MAX_ATTEMPTS + 1):
            await device.get_screen()
            xml = device.current_screen or ""
            if "There was a problem setting up your account" in xml or (
                "Retry" in xml and "Start over" in xml
            ):
                return {
                    "success": False,
                    "error": "IG showed the Retry/Start over rejection screen at terms.",
                    "code": "ig_finalize_rejected",
                    "data": {
                        "attempted_username": desired_username,
                        "terms_retry_attempts": attempt - 1,
                        "account_exists": False,
                        "credentials_should_persist": False,
                        "manual_action_required": False,
                        "retryable": False,
                        "credential_reservation_release_safe": True,
                    },
                }
            # Recovery: if a previous tap accidentally opened Privacy Policy /
            # Terms / Cookies Policy in an in-app webview, bounce back with the
            # system back key so the next iteration sees the terms screen.
            if "Privacy Policy" in xml and "What is the Privacy Policy" in xml:
                await device.send_log("phone-signup: accidentally opened Privacy Policy, going back")
                await device.shell("input keyevent KEYCODE_BACK")
                await device.wait(2500)
                await device.get_screen()
                xml = device.current_screen or ""
            still_on_terms = ("Agree to Instagram" in xml or
                              'content-desc="I agree"' in xml)
            if not still_on_terms:
                agreed = True
                break  # advanced past terms
            # Tap the actual I agree button (large, bottom-half) — NOT the
            # inline "I agree" text inside the body paragraph.
            await device.send_progress(88, f"Accepting terms (try {attempt}/{TERMS_MAX_ATTEMPTS})...")
            agree_target = find_account_creation_phone_terms_i_agree_button(xml)
            if agree_target:
                await device.send_log(f"phone-signup: tapping I agree button at {agree_target}")
                await device.tap(agree_target[0], agree_target[1], wait_after=8000)
            else:
                # Fallback: hardcoded coords for Pixel 6 button row.
                await device.send_log("phone-signup: no I agree node found, using fallback coords")
                await device.tap(540, 2174, wait_after=8000)
            await device.get_screen()
            xml = device.current_screen or ""
            if not ("Agree to Instagram" in xml or 'content-desc="I agree"' in xml):
                agreed = True
                break
            if attempt < TERMS_MAX_ATTEMPTS:
                # 2.18.21: chunk the 60s between-attempt wait into 4×15s with
                # a send_progress heartbeat each. Without this, the renderer
                # WS client tears down on the 45s stale timer mid-wait.
                CHUNK_MS = 15_000
                chunks = TERMS_RETRY_INTERVAL_MS // CHUNK_MS
                for cwait in range(chunks):
                    await device.wait(CHUNK_MS)
                    secs_left = (chunks - cwait - 1) * (CHUNK_MS // 1000)
                    await device.send_progress(
                        88,
                        f"Waiting before next terms retry ({secs_left}s)..."
                    )
        if not agreed:
            return {
                "success": False,
                "error": f"IG terms screen still showing 'I agree' after {TERMS_MAX_ATTEMPTS} retries spaced 60s apart. IG may have shadow-flagged this signup attempt — try a different smspool pool or wait before retrying on this profile.",
                "code": "ig_terms_retry_exhausted",
                "data": {
                    "attempted_username": desired_username,
                    "terms_retry_attempts": TERMS_MAX_ATTEMPTS,
                },
            }

    await device.send_progress(92, "Skipping post-signup prompts...")
    # 2.18.22 — rewritten post-signup loop. Old version had:
    # (a) `if "sync your contacts" in xml: tap Don't allow` — wrong order;
    #     the IG sync screen comes FIRST and needs Next tapped, only AFTER
    #     does the OS permission dialog appear with Don't allow. Old code
    #     spun on the IG sync screen never tapping Next.
    # (b) Hardcoded fallback coord (990, 201) for Follow / Add bio Skip.
    # (c) Iteration cap 10 — easy to exhaust on multi-screen flow.
    # (d) On break/cap-hit, returned success=True regardless — scaffolded
    #     folder for runs that never reached the home feed.
    # Fix: explicit branches for each known screen using resource-id when
    # available (skip_button, button_text, connect_contacts_sync_button,
    # permission_deny_button); detect home-feed (tab_avatar/Home/Reels)
    # and break on that with `landed_home=True`; require landed_home to
    # declare success below.
    landed_home = False
    # 2.21.9: budget bump 20 → 30 iterations. Slow phones + transitional
    # screens were burning the previous budget before reaching home,
    # leaving accounts stuck on profile-pic / follow-5 screens (AJ report).
    for iter_n in range(30):
        await device.get_screen()
        xml = device.current_screen or ""

        # 2.21.9: detect IG's "There was a problem setting up your account"
        # finalize-reject screen (Retry/Start over). Per memory: taps don't
        # register on this Compose screen; the account is dead. Bail out
        # immediately rather than burning the remaining budget.
        if 'There was a problem setting up your account' in xml:
            await device.send_log("phone-signup: finalize-reject screen — account dead")
            return {
                "success": False,
                "code": "ig_finalize_rejected",
                "error": "IG rejected the account at finalize with 'There was a problem setting up your account'. The account does not exist server-side.",
                "data": {
                    "account_username": desired_username,
                    "method": "phone_smspool",
                    "profile_was_fresh": profile_was_fresh,
                    "account_exists": False,
                    "credentials_should_persist": False,
                    "manual_action_required": False,
                    "retryable": False,
                    "credential_reservation_release_safe": True,
                },
            }

        # 2.21.9: v2 flow opens with a "Lets get started, <name>..." flash
        # interstitial that auto-advances in ~3s with no buttons to tap.
        # If we caught it, wait briefly and continue (don't burn the 2s
        # unrecognized-screen wait below).
        if (
            "Lets get started" in xml or
            "Let's get started" in xml or
            "let's get started" in xml.lower()
        ):
            await device.send_log("phone-signup: lets-get-started interstitial, waiting 3s")
            await device.wait(3000)
            continue
        # Home-feed detection: presence of any of these resource-ids = main
        # tab bar / feed visible = we're done with onboarding.
        # 2.18.25: add reels_tray_container + swipeable_nav_view_pager signals
        # for the new "Get started" flow whose first-render home feed doesn't
        # always paint tab_avatar (story tray renders first).
        if ('com.instagram.android:id/tab_avatar' in xml or
            'com.instagram.android:id/reels_tray_container' in xml or
            'com.instagram.android:id/swipeable_nav_view_pager_inner_recycle' in xml or
            ('content-desc="Home"' in xml and 'content-desc="Reels"' in xml) or
            ('Your story' in xml and 'Suggested for you' in xml)):
            landed_home = True
            await device.send_log(f"phone-signup: landed on home feed after {iter_n} post-signup screens")
            break

        # 2.18.23: detect IG's "Confirm you're human to use your account"
        # CAPTCHA wall. IG creates the account server-side but immediately
        # flags it pending a human-verification (image-CAPTCHA or selfie
        # photo). Auto flow CANNOT solve the captcha. Per Anyro 2026-05-26:
        # the clean exit is to tap the Menu (hamburger) → "Log out <user>"
        # → confirm "Log out" — that pops us back to the pre-existing IG
        # account on this profile (preserving the previous session) so the
        # next attempt isn't polluted by the flagged unfinished account.
        # Then return failure with credentials so the user has them for
        # manual recovery if desired. Don't scaffold the local folder.
        if "Confirm you're human" in xml or "confirm you're human" in xml.lower():
            await device.send_log("phone-signup: IG flagged the account with a 'Confirm you're human' wall — logging out to clean up")
            logout_cleanup_verified = False
            # 1. Tap Menu (hamburger top-right) to open bottom sheet
            menu = device.find_element_by_content_description("Menu")
            if menu:
                await device.tap(menu[0], menu[1], wait_after=2500)
                await device.get_screen()
                xml = device.current_screen or ""
                # 2. Select only this newly flagged account. Never match the
                #    adjacent "Log out all accounts" destructive action.
                logout_target = find_account_creation_phone_logout_target(xml, desired_username)
                if logout_target:
                    await device.tap(logout_target[0], logout_target[1], wait_after=2500)
                    await device.get_screen()
                    xml = device.current_screen or ""
                    # 3. Confirm dialog: tap the "Log out" primary button
                    confirm = device.find_element_by_resource_id(
                        "com.instagram.android:id/igds_alert_dialog_primary_button"
                    )
                    if confirm:
                        await device.tap(confirm[0], confirm[1], wait_after=3500)
                        logout_cleanup_verified = await verify_account_creation_phone_logout_cleanup(
                            device,
                            expected_fresh=profile_was_fresh,
                            expected_username=previous_username,
                        )
                        if logout_cleanup_verified:
                            await device.send_log("phone-signup: flagged-account logout verified after clean relaunch")
                        else:
                            await device.send_log("phone-signup: flagged-account logout could not be verified", "WARN")
                    else:
                        await device.send_log("phone-signup: log-out confirm button not found")
                else:
                    await device.send_log("phone-signup: 'Log out <user>' row not found in menu")
            else:
                await device.send_log("phone-signup: Menu button not found, can't log out")
            return {
                "success": False,
                "error": (
                    "IG flagged the new account at finalize with a 'Confirm you're human' CAPTCHA wall. "
                    + (
                        "The flagged session was logged out and the Instagram landing/session was restored. "
                        if logout_cleanup_verified
                        else "Automatic logout cleanup could not be verified. "
                    )
                    + "The account exists server-side but is unusable without a manual selfie/image verification."
                ),
                "code": "ig_human_check_flagged",
                "data": {
                    "method": "phone_smspool",
                    "profile_was_fresh": profile_was_fresh,
                    "account_exists": True,
                    "account_identity_verified": False,
                    "credentials_should_persist": False,
                    "manual_action_required": True,
                    "retryable": False,
                    "logout_cleanup_verified": logout_cleanup_verified,
                },
            }

        # Generic Skip resolver — IG uses multiple resource-ids depending on
        # screen: `skip_button` (older Bloks screens), `action_bar_action_text`
        # (newer "Try following 5+ people" / "See more of what you love"
        # preference screens that show Skip in the top-right action bar). Try
        # them in order, then fall back to a text/content-desc "Skip" search.
        # Live-walked 2026-05-26: action_bar_action_text was the only Skip
        # selector that worked on the follow-5 and preferences screens.
        #
        # 2.21.9 fix (AJ report): when text="Skip" matches, the leaf TextView
        # is usually clickable=false with its clickable parent wrapping it.
        # find_element_by_text returns the leaf center which can miss the
        # parent's hit region on some screens. Walk all Skip-bearing nodes,
        # filter to clickable=true ones, prefer the largest (button > tiny
        # inline label). Mirrors the I-agree-button fix from 2.18.20.
        def _find_skip():
            # Priority 1: explicit Bloks skip_button resource-id
            sb = device.find_element_by_resource_id('com.instagram.android:id/skip_button')
            if sb:
                return sb
            # Priority 2: action_bar_action_text (top-right Skip in newer
            # screens — follow-5, preferences). Resource-id is reliable
            # AND the node is always clickable.
            ab = device.find_element_by_resource_id('com.instagram.android:id/action_bar_action_text')
            if ab:
                return ab
            # Priority 3: locate every node bearing text="Skip" or
            # content-desc="Skip", then for each, find a clickable
            # ancestor — the smallest enclosing node with clickable="true".
            # Pick the largest such ancestor by area. This handles two
            # real cases:
            #   a) Skip leaf is itself clickable → it's its own ancestor
            #   b) Skip leaf is non-clickable but wrapped by a clickable
            #      ViewGroup parent (common in IG's Compose screens —
            #      the bug AJ hit on the profile-pic screen).
            xml_local = device.current_screen or ""
            try:
                node_pat = re.compile(r'<node\s[^>]*?(?:/>|>)')

                # Step 1: collect all nodes with bounds
                nodes = []
                for m in node_pat.finditer(xml_local):
                    node = m.group(0)
                    bm = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
                    if not bm:
                        continue
                    x1, y1, x2, y2 = map(int, bm.groups())
                    nodes.append({
                        'text': node,
                        'span': m.span(),
                        'bounds': (x1, y1, x2, y2),
                        'clickable': 'clickable="true"' in node,
                        'has_skip': (re.search(r'text="Skip"', node) is not None
                                      or re.search(r'content-desc="Skip"', node) is not None),
                    })

                # Step 2: build parent index — for each node, find ancestor
                # by checking which other node's bounds fully contain it
                # (within tolerance) and was opened earlier in the XML
                # (smaller start span). Pick the smallest such ancestor
                # that's clickable.
                candidates = []
                for n in nodes:
                    if not n['has_skip']:
                        continue
                    if n['clickable']:
                        # Self is clickable — use it
                        x1, y1, x2, y2 = n['bounds']
                        area = max(1, (x2 - x1) * (y2 - y1))
                        candidates.append((area, ((x1 + x2) // 2, (y1 + y2) // 2)))
                        continue
                    # Walk up: find smallest clickable ancestor
                    sx1, sy1, sx2, sy2 = n['bounds']
                    best_anc = None
                    best_area = None
                    for a in nodes:
                        if a is n or not a['clickable']:
                            continue
                        ax1, ay1, ax2, ay2 = a['bounds']
                        # Must fully contain the Skip node bounds
                        if not (ax1 <= sx1 and ay1 <= sy1 and ax2 >= sx2 and ay2 >= sy2):
                            continue
                        # And must have opened before us (in XML order)
                        if a['span'][0] >= n['span'][0]:
                            continue
                        area = max(1, (ax2 - ax1) * (ay2 - ay1))
                        if best_area is None or area < best_area:
                            best_area = area
                            best_anc = a
                    if best_anc:
                        ax1, ay1, ax2, ay2 = best_anc['bounds']
                        candidates.append((best_area, ((ax1 + ax2) // 2, (ay1 + ay2) // 2)))

                if candidates:
                    # Among multiple candidate buttons, prefer the largest
                    # (full-width button beats tiny inline-link button).
                    candidates.sort(reverse=True)
                    return candidates[0][1]
            except Exception:
                pass
            # Priority 4: fallback to the leaf-text finders (which return
            # the leaf center — may miss but tries the original behavior).
            return (
                device.find_element_by_text("Skip", exact=True)
                or device.find_element_by_content_description("Skip")
            )

        # 0. Combined "Allow Instagram to access your device?" consent screen —
        #    Notifications + Contacts described together on ONE screen with a
        #    single blue Next button (fine print: "Next, allow access or skip
        #    these steps"). This was NOT matched by the notifications-only (#1)
        #    or contacts-sync (#4) branches, so the loop fell through to the
        #    generic wait and stalled here (VA report — account left on this
        #    screen after creation). Tap Next; the OS permission dialogs that
        #    follow are denied by branches #2 / #5 below.
        if (
            'Allow Instagram to access your device' in xml or
            'allow instagram to access your device' in xml.lower()
        ):
            if await tap_account_creation_phone_next(device):
                await device.send_log("phone-signup: 'Allow IG to access your device' screen, tap Next")
                continue
        # 1. Notifications may open either an Android permission dialog or
        #    GrapheneOS notification Settings. The helper handles the live
        #    Settings → Back → Instagram Skip roundtrip as well as the intro.
        if await handle_account_creation_phone_notification_prompt(device):
            continue
        # 2. OS notification permission dialog → Don't allow.
        #    Note: this dialog uses `permission_deny_and_dont_ask_again_button`,
        #    different from the contacts perm dialog's `permission_deny_button`.
        if (
            'Allow Instagram to send you notifications' in xml or
            'permission_deny_and_dont_ask_again_button' in xml
        ):
            deny = (
                device.find_element_by_resource_id('com.android.permissioncontroller:id/permission_deny_and_dont_ask_again_button')
                or device.find_element_by_resource_id('com.android.permissioncontroller:id/permission_deny_button')
                or device.find_element_by_text("Don't allow")
                or device.find_element_by_text("Don’t allow")
            )
            if deny:
                await device.send_log("phone-signup: deny notifications permission")
                await device.tap(deny[0], deny[1], wait_after=2500)
                continue
        # 3. Add profile picture/photo → Skip. 2.18.25: new flow uses
        #    "Add a profile photo that shows your vibe" wording on a
        #    `photo_redesign_root_view` screen with skip_button at top-right.
        if (
            "Add a profile picture" in xml or "Add picture" in xml or
            "Add a profile photo" in xml or 'photo_redesign_root_view' in xml
        ):
            sk = _find_skip()
            if sk:
                await device.send_log("phone-signup: skip profile picture/photo")
                await device.tap(sk[0], sk[1], wait_after=2500)
                continue
        # 4. IG contacts sync intro: prefer the top Skip. If Next already
        #    opened the contacts Settings prompt, back out and skip it.
        if await handle_account_creation_phone_contacts_prompt(device):
            continue
        # 5. OS permission dialog for contacts → Don't allow
        if 'com.android.permissioncontroller:id/permission_deny_button' in xml or (
            'Allow Instagram to access contacts' in xml
        ):
            deny = device.find_element_by_resource_id(
                'com.android.permissioncontroller:id/permission_deny_button'
            )
            if not deny:
                deny = (device.find_element_by_text("Don't allow")
                        or device.find_element_by_text("Don’t allow"))
            if deny:
                await device.send_log("phone-signup: deny contacts permission")
                await device.tap(deny[0], deny[1], wait_after=2500)
                continue
        # 6. "Try following 5+ people" / "Follow people" / etc. → Skip
        #    (action_bar_action_text in top-right action bar).
        if (
            "5+ people" in xml or "5 or more people" in xml or
            "Follow 5" in xml or "Follow people" in xml or
            "following 5+" in xml or "Try following" in xml
        ):
            sk = _find_skip()
            if sk:
                await device.send_log("phone-signup: skip follow-5")
                await device.tap(sk[0], sk[1], wait_after=2500)
                continue
        # 7. Preference-tuning / reels-tuning screen → Skip
        #    (action_bar_action_text). Shows multiple variants:
        #    - "See more of what you love" (old)
        #    - "More like this" / "Less like this" video preview (old)
        #    - "Pick what you want to see more of" with `reels_tuning_container`
        #      and Done button (new flow, 2.18.25 live-walk).
        if (
            "See more of what you love" in xml or
            "Your preferences help shape" in xml or
            "Pick what you want to see more of" in xml or
            'reels_tuning_container' in xml or
            ("More like this" in xml and "Less like this" in xml)
        ):
            sk = _find_skip()
            if sk:
                await device.send_log("phone-signup: skip preferences/reels tuner")
                await device.tap(sk[0], sk[1], wait_after=2500)
                continue
        # 8. Dismissable tips ("Swipe to easily access Reels and messages")
        #    → tap "Got it".
        if (
            "Swipe to easily access" in xml or
            "content-desc=\"Got it\"" in xml or "text=\"Got it\"" in xml
        ):
            got = (
                device.find_element_by_resource_id("com.instagram.android:id/igds_headline_primary_action_button")
                or device.find_element_by_content_description("Got it")
                or device.find_element_by_text("Got it")
            )
            if got:
                await device.send_log("phone-signup: dismiss 'Got it' tip")
                await device.tap(got[0], got[1], wait_after=2500)
                continue
        # 9. Add bio / Create a profile / Add an email → Skip
        if "Add bio" in xml or "Create a profile" in xml or "Add an email address" in xml:
            sk = _find_skip()
            if sk:
                await device.send_log("phone-signup: skip bio/email")
                await device.tap(sk[0], sk[1], wait_after=2500)
                continue
        # No recognized post-signup screen this iteration — give it 1.2s
        # and re-dump (was 2s). IG sometimes shows a transient loading
        # screen between prompts. 1.2s + 30-iter budget gives ~36s of
        # unrecognized-screen tolerance, vs. ~12s catch latency for real
        # screens which is faster than the previous 2s wait.
        #
        # NUX-DROPOFF HARDENING (NEEDS-DEVICE-VALIDATION + BRAIN REBUILD —
        # server.py is the frozen server.exe; edits here are inert until it is
        # rebuilt). The primary "stuck on allow contacts/photos, Next not
        # picking up" report is the companion/Tailscale owner-swap re-throwing
        # IG to the signup screen mid-loop, fixed electron-side (grace-aware
        # busy gate) — validate that first before touching this loop. If, after
        # that fix, the walk still parks on an OS permission screen here, add a
        # generic fallback branch ABOVE this wait: when 'com.android.permission
        # controller' is present in `xml` but none of branches 2/5 matched
        # (e.g. a photos/media prompt surfaced earlier than the post-home media
        # step), reuse the ALREADY-ESTABLISHED selectors from this file
        # (permission_deny_button here / permission_allow_all_button in the
        # post-home media step) — deny contacts, allow-all media — then
        # `continue`. Do NOT invent new resource-ids without a live dump; the
        # loop already tolerates ~36s of unrecognized screens, so do not raise
        # waits blindly.
        await device.wait(1200)
    # End post-signup loop. landed_home tells us whether we actually made
    # it to the main tab bar or burned out the iteration budget.
    if not landed_home:
        await device.send_log("phone-signup: post-signup loop ran out without landing on home feed")

    # 2.18.24: final validation step — open Profile → Create New → Create
    # new reel → Allow all on the OS media permission dialog. This proves
    # the account is genuinely usable (post/reel flows won't trip on the
    # media perm later) and is the only state from which we should declare
    # success. Anyro 2026-05-26: "click the post/create button and activate
    # the media gallery urself allow all as the final step of acc creation
    # and validation then create the folder at that stage bc its actually
    # done". Live-validated on armadillo.1709230 (profile 29) — perm
    # dialog has resource-ids permission_allow_all_button /
    # permission_allow_selected_button / permission_deny_button.
    media_granted = False
    profile_verified = False
    returned_home = False
    if landed_home:
        await device.send_progress(95, "Validating account — granting media permission...")
        try:
            # 1. Tap Profile tab via resource-id
            ptab = device.find_element_by_resource_id("com.instagram.android:id/profile_tab")
            if ptab:
                await device.tap(ptab[0], ptab[1], wait_after=2000)
            profile_verified = await verify_account_creation_phone_profile(
                device,
                desired_username,
            )
            if not profile_verified:
                await device.send_log(
                    f"phone-signup: profile title did not match @{desired_username}"
                )
            # 2. Tap "Create New" (top-left action bar)
            create_btn = (
                device.find_element_by_content_description("Create New")
                if profile_verified else None
            )
            if create_btn:
                await device.tap(create_btn[0], create_btn[1], wait_after=1500)
                await device.get_screen()
                # 3. Bottom sheet — prefer Create new reel, then post, then story
                for label in ("Create new reel", "Create new post", "Create new story"):
                    target = device.find_element_by_content_description(label)
                    if target:
                        await device.tap(target[0], target[1], wait_after=2500)
                        break
                # 4. Wait up to 8s for OS media perm dialog and tap Allow all
                for _ in range(8):
                    await device.wait(800)
                    await device.get_screen()
                    xml = device.current_screen or ""
                    if "permission_allow_all_button" in xml:
                        allow = device.find_element_by_resource_id(
                            "com.android.permissioncontroller:id/permission_allow_all_button"
                        )
                        if allow:
                            await device.tap(allow[0], allow[1], wait_after=1500)
                            await device.send_log("phone-signup: ✅ media permission Allow all granted")
                            media_granted = True
                            break
                    elif "permissioncontroller" not in xml.lower():
                        # No perm dialog shown — IG bypassed it (already
                        # granted at OS level, e.g. from a prior account on
                        # this profile). Treat as granted.
                        await device.send_log("phone-signup: media permission already granted (no dialog)")
                        media_granted = True
                        break
                # 5. Back out once, then explicitly return via the Home tab.
                await device.shell("input keyevent KEYCODE_BACK")
                await device.wait(800)
                await device.get_screen()
                home_tab = device.find_element_by_resource_id(
                    "com.instagram.android:id/feed_tab"
                )
                if home_tab:
                    await device.tap(home_tab[0], home_tab[1], wait_after=1800)
                else:
                    await device.shell("input keyevent KEYCODE_BACK")
                    await device.wait(1200)
                await device.get_screen()
                returned_home = account_creation_phone_is_home_feed(
                    device.current_screen
                )
            else:
                await device.send_log("phone-signup: 'Create New' button not found on profile — skipping media pre-grant")
        except Exception as e:
            await device.send_log(f"phone-signup: media pre-grant errored: {e}")

    # 2.18.16: detect IG's terminal-rejection screen before claiming success.
    # After all post-signup skips, if IG shows "There was a problem setting up
    # your account" with Retry / Start over, the account is dead at the server
    # level even though we walked the UI cleanly. Returning success=True here
    # would scaffold the local content folder for an account that doesn't exist.
    # See [[reference_ig_signup_screens_2026_05]] for the live-walk evidence.
    await device.get_screen()
    final_xml = device.current_screen or ""
    if "There was a problem setting up your account" in final_xml or (
        "Start over" in final_xml and "Retry" in final_xml
    ):
        return {
            "success": False,
            "error": "IG rejected the account at finalize ('There was a problem setting up your account'). The smspool number pool or device fingerprint may be flagged. Try a different smspool pool or wait before retrying on this profile.",
            "code": "ig_finalize_rejected",
            "data": {
                "attempted_username": desired_username,
                "account_exists": False,
                "credentials_should_persist": False,
                "manual_action_required": False,
                "retryable": False,
                "credential_reservation_release_safe": True,
            },
        }

    # 2.18.22: only declare success if we actually landed on the home feed.
    # 2.18.24: AND if the media permission was granted via the Create New
    # → Create new reel → Allow all flow. The folder scaffold should only
    # happen for accounts that are fully usable for posting — landing on
    # home alone isn't enough proof; the media perm pre-grant is the real
    # "is this account good?" gate.
    if not landed_home:
        return {
            "success": False,
            "error": "Post-signup loop did not reach the IG home feed. Account may have been created but onboarding screens stalled. Check the phone manually.",
            "code": "ig_onboarding_stalled",
            "data": {
                "smspool_cost_usd": 0.42,
                "method": "phone_smspool",
                "profile_was_fresh": profile_was_fresh,
                "uncertain_outcome": True,
                "account_identity_verified": False,
                "credentials_should_persist": False,
                "manual_action_required": True,
                "retryable": False,
            },
        }
    if not profile_verified:
        return {
            "success": False,
            "error": f"Instagram opened a profile that did not match @{desired_username}. Credentials were preserved for reconciliation.",
            "code": "ig_profile_identity_mismatch",
            "data": {
                "account_exists": True,
                "account_identity_verified": False,
                "credentials_should_persist": False,
                "manual_action_required": True,
                "retryable": False,
            },
        }
    if not media_granted:
        return {
            "success": False,
            "error": "Landed on home feed but could not validate media permission. The account exists and is logged in but post/reel flows will trip on the OS media perm dialog. Open IG manually and tap Allow All on the media access prompt.",
            "code": "ig_media_pregrant_failed",
            "data": {
                "account_username": desired_username,
                "smspool_cost_usd": 0.42,
                "method": "phone_smspool",
                "profile_was_fresh": profile_was_fresh,
                "landed_home": True,
                "account_exists": True,
                "account_identity_verified": True,
                "credentials_should_persist": True,
                "manual_action_required": True,
                "retryable": False,
            },
        }
    if not returned_home:
        return {
            "success": False,
            "error": "Account and media access were validated, but Instagram did not return to Home.",
            "code": "ig_home_return_failed",
            "data": {
                "account_username": desired_username,
                "account_exists": True,
                "account_identity_verified": True,
                "credentials_should_persist": True,
                "manual_action_required": True,
                "retryable": False,
            },
        }

    await device.send_progress(100, f"Created @{desired_username} — media permission granted, ready to post")
    return {
        "success": True,
        "data": {
            "account_username": desired_username,
            "username": desired_username,
            "smspool_cost_usd": 0.42,
            "method": "phone_smspool",
            "profile_was_fresh": profile_was_fresh,
            "account_identity_verified": True,
            "media_permission_granted": True,
        },
    }


async def _ig_get_code_from_gmail(device: RemoteDevice, target_email: str):
    """Helper: Switch to Gmail, find Instagram verification code, return it."""
    import re

    await device.send_log(f"📧 Getting IG code from Gmail ({target_email})...")

    async def _foreground_package() -> str:
        out = await device.shell("dumpsys activity activities")
        matches = re.findall(r"([a-zA-Z0-9_.]+)/[a-zA-Z0-9_.$]+", out or "")
        return matches[-1] if matches else ""

    def _is_recents_screen() -> bool:
        xml = (device.current_screen or "").lower()
        return (
            "com.android.launcher3" in xml
            or "quickstep" in xml
            or "clear all" in xml
            or "recent apps" in xml
        )

    async def _switch_to_app_from_recents(app_name: str, package: str = "") -> bool:
        candidates = [
            app_name,
            app_name.upper(),
            app_name.lower(),
            package,
        ]

        for attempt in range(3):
            await device.send_log(
                f"Switching via recents to {app_name} (attempt {attempt + 1}/3)..."
            )
            await device.keyevent(187)
            await device.wait(500)
            await device.get_screen()

            if not _is_recents_screen():
                await device.swipe(540, 2350, 540, 1150, 420, wait_after=650)
                await device.get_screen()

            if _is_recents_screen():
                for cand in candidates:
                    if not cand:
                        continue
                    app_card = device.find_element_by_text(
                        cand
                    ) or device.find_element_by_content_description(cand)
                    if app_card:
                        await device.tap(app_card[0], app_card[1], wait_after=1200)
                        if package:
                            current = await _foreground_package()
                            if current and package in current:
                                return True
                            await device.wait(450)
                            current = await _foreground_package()
                            if current and package in current:
                                return True
                            continue
                        return True

            await device.swipe(900, 1200, 220, 1200, 280, wait_after=450)
            await device.get_screen()
            await device.swipe(220, 1200, 900, 1200, 280, wait_after=450)
            await device.keyevent(187)
            await device.wait(400)
            if package:
                current = await _foreground_package()
                if current and package in current:
                    return True

        return False

    async def _tap_take_me_to_gmail(force_fallback_tap: bool = False) -> bool:
        await device.get_screen()

        action_done = device.find_element_by_resource_id("com.google.android.gm:id/action_done")
        if action_done:
            await device.send_log("Gmail setup screen detected - tapping TAKE ME TO GMAIL")
            await device.tap(action_done[0], action_done[1], wait_after=1000)
            await device.get_screen()
            return True

        take_me = (
            device.find_element_by_text("TAKE ME TO GMAIL")
            or device.find_element_by_text("Take me to Gmail")
            or device.find_element_by_content_description("TAKE ME TO GMAIL")
        )
        if take_me:
            await device.send_log("Gmail setup screen detected - tapping TAKE ME TO GMAIL")
            await device.tap(take_me[0], take_me[1], wait_after=1000)
            await device.get_screen()
            return True

        if force_fallback_tap:
            width, height = await device.get_screen_size()
            await device.tap(width // 2, int(height * 0.95), wait_after=900)
            await device.get_screen()
            if not device.text_on_screen("TAKE ME TO GMAIL"):
                return True

        return False

    async def _handle_gmail_permission_popup() -> bool:
        """
        If Android notification permission popup appears for Gmail, tap Allow.
        Triggered after "TAKE ME TO GMAIL" on some devices/profiles.
        """
        await device.get_screen()
        xml = device.current_screen or ""
        is_permission_popup = (
            "com.android.permissioncontroller" in xml
            or "permission_allow_button" in xml
            or device.text_on_screen("Allow Gmail to send you notifications")
        )
        if not is_permission_popup:
            return False

        allow_rids = [
            "com.android.permissioncontroller:id/permission_allow_button",
            "com.android.permissioncontroller:id/permission_allow_foreground_only_button",
            "com.android.permissioncontroller:id/permission_allow_one_time_button",
            "com.android.permissioncontroller:id/permission_allow_always_button",
            "com.android.packageinstaller:id/permission_allow_button",
        ]
        for rid in allow_rids:
            btn = device.find_element_by_resource_id(rid)
            if btn:
                await device.send_log("ℹ️ Gmail permission popup detected — tapping Allow")
                await device.tap(btn[0], btn[1], wait_after=900)
                await device.get_screen()
                return True

        allow_btn = device.find_element_by_text("Allow") or device.find_element_by_text(
            "ALLOW"
        )
        if allow_btn:
            await device.send_log("ℹ️ Gmail permission popup detected — tapping Allow")
            await device.tap(allow_btn[0], allow_btn[1], wait_after=900)
            await device.get_screen()
            return True

        return False

    async def _handle_gmail_onboarding_popup() -> bool:
        """
        Handle Gmail in-app onboarding dialogs that can appear after permissions.
        Example seen in live dumps: "Google Meet, now in Gmail" with Got it button.
        """
        await device.get_screen()
        xml = device.current_screen or ""
        is_onboarding_popup = (
            "com.google.android.gm:id/next_button" in xml
            or "com.google.android.gm:id/dismiss_button" in xml
            or "Google Meet, now in Gmail" in xml
            or device.text_on_screen("Got it")
        )
        if not is_onboarding_popup:
            return False

        # Prefer advancing with Got it; fallback to dismiss/close if needed.
        button_candidates = [
            "com.google.android.gm:id/next_button",
            "com.google.android.gm:id/dismiss_button",
            "com.google.android.gm:id/primary_button",
            "com.google.android.gm:id/positive_button",
        ]
        for rid in button_candidates:
            btn = device.find_element_by_resource_id(rid)
            if btn:
                await device.send_log(
                    "ℹ️ Gmail onboarding popup detected — dismissing it"
                )
                await device.tap(btn[0], btn[1], wait_after=900)
                await device.get_screen()
                return True

        got_it_btn = (
            device.find_element_by_text("Got it")
            or device.find_element_by_text("GOT IT")
            or device.find_element_by_content_description("Got it")
        )
        if got_it_btn:
            await device.send_log("ℹ️ Gmail onboarding popup detected — tapping Got it")
            await device.tap(got_it_btn[0], got_it_btn[1], wait_after=900)
            await device.get_screen()
            return True

        return False

    async def _handle_google_recovery_checkup() -> bool:
        """Handle leftover Google recovery-info checkup before polling Gmail."""
        await device.get_screen()
        lower = (device.current_screen or "").lower()
        on_checkup = (
            "make sure you can always sign in" in lower
            or "your recovery info is used" in lower
            or ("add a recovery phone" in lower and "your recovery email" in lower)
        )
        if not on_checkup:
            return False

        # Prefer Skip over Save — the second recovery screen should be skipped
        skip_btn = (
            device.find_element_by_text("Skip", exact=True)
            or device.find_element_by_text("SKIP", exact=True)
            or device.find_element_by_content_description("Skip")
        )
        if skip_btn:
            await device.send_log("Google recovery checkup detected — tapping Skip")
            await device.tap(skip_btn[0], skip_btn[1], wait_after=1200)
            await device.get_screen()
            return True

        save_btn = (
            device.find_element_by_text("Save", exact=True)
            or device.find_element_by_text("SAVE", exact=True)
            or device.find_element_by_content_description("Save")
        )
        if save_btn:
            await device.send_log("Google recovery checkup detected — tapping Save")
            await device.tap(save_btn[0], save_btn[1], wait_after=1200)
        else:
            width, height = await device.get_screen_size()
            await device.send_log("Save/Skip not found — tapping known Save area")
            await device.tap(int(width * 0.90), int(height * 0.63), wait_after=1200)
        await device.get_screen()
        return True

    async def _handle_google_home_address() -> bool:
        """Skip Google's optional home-address checkpoint before polling Gmail."""
        await device.get_screen()
        on_home_address = (
            device.text_on_screen("Set a home address")
            or device.text_on_screen("Home address")
            or device.text_on_screen("Add home address")
        )
        if not on_home_address:
            return False

        skip_btn = (
            device.find_element_by_text("Skip", exact=True)
            or device.find_element_by_text("SKIP", exact=True)
            or device.find_element_by_content_description("Skip")
        )
        await device.send_log("Home-address checkpoint detected - tapping Skip")
        if skip_btn:
            await device.tap(skip_btn[0], skip_btn[1], wait_after=1000)
        else:
            width, height = await device.get_screen_size()
            await device.tap(int(width * 0.10), int(height * 0.93), wait_after=1000)
        await device.get_screen()
        return True

    async def _tap_target_email_row(email: str) -> bool:
        """Tap the row that contains the target Gmail address on setup/account screens."""
        if not device.current_screen:
            return False

        patterns = [
            rf'text="{re.escape(email)}"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
            rf'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*text="{re.escape(email)}"',
        ]
        for pat in patterns:
            m = re.search(pat, device.current_screen, re.IGNORECASE | re.DOTALL)
            if not m:
                continue
            x1, y1, x2, y2 = map(int, m.groups())
            await device.tap((x1 + x2) // 2, (y1 + y2) // 2, wait_after=700)
            return True
        return False

    async def _normalize_gmail_entry_screen(email: str) -> None:
        """
        Handle Gmail onboarding/setup checkpoints before inbox polling:
        - 'Set up email' fresh screen (tap Google, then enter email/password)
        - 'Got it' screens
        - Setup addresses page with 'TAKE ME TO GMAIL'
        - Permission popups and recovery checkups
        """
        for _ in range(8):
            await device.get_screen()

            # "Set up email" fresh screen — Gmail has no account, sign-in didn't stick
            if device.text_on_screen("Set up email"):
                await device.send_log("⚠️ Gmail shows 'Set up email' — account not logged in, skipping normalize")
                break

            # Handle Android permission popup first, then continue normal Gmail entry.
            handled_permission = await _handle_gmail_permission_popup()
            if handled_permission:
                await _handle_gmail_onboarding_popup()
                continue

            handled_onboarding = await _handle_gmail_onboarding_popup()
            if handled_onboarding:
                continue

            if await _handle_google_recovery_checkup():
                continue

            if await _handle_google_home_address():
                continue

            xml = device.current_screen or ""

            got_it_btn = device.find_element_by_text("Got it") or device.find_element_by_text(
                "GOT IT"
            )
            if got_it_btn:
                await device.send_log("ℹ️ Gmail onboarding prompt detected — tapping Got it")
                await device.tap(got_it_btn[0], got_it_btn[1], wait_after=800)
                continue

            on_setup_addresses = (
                "setup_addresses_fragment" in xml
                or "com.google.android.gm:id/action_done" in xml
                or device.text_on_screen("You can now add all your email addresses")
                or device.text_on_screen("TAKE ME TO GMAIL")
            )
            if on_setup_addresses:
                await device.send_log(
                    "ℹ️ Gmail setup-addresses screen detected — entering inbox"
                )
                if await _tap_take_me_to_gmail():
                    continue

                if await _tap_target_email_row(email):
                    await device.send_log(f"Selected Gmail row: {email}")
                if await _tap_take_me_to_gmail(force_fallback_tap=True):
                    continue
            break

    # Switch to Gmail (prefer recents so we keep task state)
    if not await _switch_to_app_from_recents("Gmail", "com.google.android.gm"):
        await device.send_log("Recents switch to Gmail failed; using launch_app fallback.")
        await device.launch_app("com.google.android.gm", wait_after=800)
    else:
        await device.wait(200)
    await device.get_screen()
    await _normalize_gmail_entry_screen(target_email)
    await device.get_screen()

    # Check if on correct account (look for "Signed in as <email>" in content-desc)
    if device.current_screen:
        signed_in = re.search(
            r"Signed in as[^\"]*?([a-zA-Z0-9._%+-]+@gmail\.com)",
            device.current_screen,
        )
        if signed_in and signed_in.group(1) != target_email:
            await device.send_log(
                f"⚠️ Wrong Gmail: {signed_in.group(1)}, switching to {target_email}"
            )
            # Tap profile icon and switch
            await device.tap(1000, 200, wait_after=900)
            await device.get_screen()
            target_btn = device.find_element_by_text(target_email)
            if target_btn:
                await device.tap(target_btn[0], target_btn[1], wait_after=900)
            else:
                await device.swipe(540, 1200, 540, 600, 300, wait_after=500)
                await device.get_screen()
                target_btn = device.find_element_by_text(target_email)
                if target_btn:
                    await device.tap(target_btn[0], target_btn[1], wait_after=900)
            await _normalize_gmail_entry_screen(target_email)
            await device.get_screen()

    async def _extract_code_from_current_screen() -> str:
        if not device.current_screen:
            return ""
        match = re.search(r"(\d{6}) is your Instagram code", device.current_screen)
        if match:
            return match.group(1)
        match = re.search(r"\b(\d{6})\b", device.current_screen)
        if match and ("Instagram" in device.current_screen or "instagram" in device.current_screen):
            return match.group(1)
        return ""

    async def _poll_for_code(window_seconds: int, phase_label: str) -> str:
        elapsed = 0
        attempt = 0
        while elapsed < window_seconds:
            attempt += 1
            if attempt == 1 or attempt % 3 == 0:
                await device.send_log(
                    f"⏳ Waiting for verification email ({phase_label}, {elapsed}s/{window_seconds}s)..."
                )

            await _handle_gmail_permission_popup()
            await _handle_gmail_onboarding_popup()
            if attempt <= 2 or attempt % 4 == 0:
                await _normalize_gmail_entry_screen(target_email)
                await device.get_screen()

            # Pull-to-refresh every pass (quick cycle) to avoid long dead time.
            await device.swipe(540, 500, 540, 1200, 420, wait_after=700)
            await device.get_screen()

            code = await _extract_code_from_current_screen()
            if code:
                await device.send_log(f"✅ Found Instagram code: {code}")
                return code

            if device.current_screen and "Social" in device.current_screen:
                social_btn = device.find_element_by_text("Social")
                if social_btn:
                    await device.tap(social_btn[0], social_btn[1], wait_after=900)
                    await device.get_screen()
                    code = await _extract_code_from_current_screen()
                    if code:
                        await device.send_log(
                            f"✅ Found Instagram code in Social: {code}"
                        )
                        return code

            await device.wait(2500)
            elapsed += 3

        return ""

    # Fast poll loop: ~45s max before resend (previously ~100s)
    code = await _poll_for_code(45, "initial")
    if code:
        return code

    # Code not found after 5 attempts — request resend
    await device.send_log("📧 Code not found, requesting new code...")

    # Switch back to Instagram (prefer recents so signup state is preserved)
    if not await _switch_to_app_from_recents("Instagram", "com.instagram.android"):
        await device.send_log(
            "Recents switch back to Instagram failed; using launch_app fallback."
        )
        await device.launch_app("com.instagram.android", wait_after=1000)
    else:
        await device.wait(200)
    await device.get_screen()
    # Click "get the code" (avoids apostrophe issues with "I didn't get the code")
    resend_btn = device.find_element_by_text("get the code")
    if resend_btn:
        await device.tap(resend_btn[0], resend_btn[1], wait_after=900)
        await device.get_screen()
        resend_confirm = device.find_element_by_text("Resend confirmation code")
        if resend_confirm:
            await device.tap(resend_confirm[0], resend_confirm[1], wait_after=1200)

    # Switch back to Gmail (prefer recents first)
    if not await _switch_to_app_from_recents("Gmail", "com.google.android.gm"):
        await device.send_log(
            "Recents switch back to Gmail failed; using launch_app fallback."
        )
        await device.launch_app("com.google.android.gm", wait_after=1200)
    else:
        await device.wait(200)
    await device.get_screen()
    await _normalize_gmail_entry_screen(target_email)
    await device.get_screen()

    # Fast poll loop after resend: ~45s max (previously another ~100s)
    code = await _poll_for_code(45, "resend")
    if code:
        return code

    await device.send_log(
        "❌ Failed to get Instagram verification code after initial + resend polling windows"
    )
    return None


async def _ig_set_random_birthday(
    device: RemoteDevice, birthday_override: dict | None = None
) -> bool:
    """Set birthday (random or custom) and only succeed after SET is confirmed."""
    import random
    import re

    mode = "custom" if birthday_override else "random"
    await device.send_log(f"📅 Setting {mode} birthday...")
    await device.get_screen()
    pre_picker_screen = device.current_screen or ""

    def _extract_picker_year(screen: str):
        if not screen:
            return None
        # Selected wheel value uses android:id/numberpicker_input.
        match = re.search(
            r'text="((?:19|20)\d{2})"[^>]*resource-id="android:id/numberpicker_input"',
            screen,
        ) or re.search(
            r'resource-id="android:id/numberpicker_input"[^>]*text="((?:19|20)\d{2})"',
            screen,
        )
        if not match:
            return None
        try:
            return int(match.group(1))
        except Exception:
            return None

    def _extract_picker_values(screen: str):
        if not screen:
            return []
        matches = list(
            re.finditer(
                r'text="([^"]+)"[^>]*resource-id="android:id/numberpicker_input"',
                screen,
            )
        )
        if not matches:
            matches = list(
                re.finditer(
                    r'resource-id="android:id/numberpicker_input"[^>]*text="([^"]+)"',
                    screen,
                )
            )
        return [m.group(1) for m in matches]

    def _extract_picker_columns(screen: str):
        if not screen:
            return []
        matches = list(
            re.finditer(
                r'class="android\.widget\.NumberPicker"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                screen,
            )
        )
        if not matches:
            matches = list(
                re.finditer(
                    r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*class="android\.widget\.NumberPicker"',
                    screen,
                )
            )
        cols = []
        for m in matches[:3]:
            x1, y1, x2, y2 = map(int, m.groups())
            cx = (x1 + x2) // 2
            cols.append((cx, y1, y2))
        return cols

    def _picker_open() -> bool:
        return bool(
            device.text_on_screen("Set date")
            or device.find_element_by_resource_id("android:id/datePicker")
            or device.find_element_by_resource_id("android:id/button1")
            or device.find_element_by_text("SET", exact=True)
        )

    # Open birthday picker if not already open.
    if not _picker_open():
        match = re.search(
            r'text="[A-Za-z]+\s+\d{1,2},\s*(\d{4})"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
            pre_picker_screen,
        )
        if match:
            x1, y1, x2, y2 = map(int, match.groups()[1:])
            await device.tap((x1 + x2) // 2, (y1 + y2) // 2, wait_after=700)
        else:
            # Fallback tap around the date field area used in this screen.
            await device.tap(540, 980, wait_after=700)
        await device.get_screen()

    if not _picker_open():
        await device.send_log("❌ Birthday picker did not open.")
        return False

    # Estimate current year from picker first, then pre-picker text fallback.
    current_year = _extract_picker_year(device.current_screen or "")
    if current_year is None:
        current_year = 2026
        y = re.search(r"\b(19|20)\d{2}\b", pre_picker_screen)
        if y:
            current_year = int(y.group(0))

    if birthday_override:
        target_year = int(birthday_override.get("year"))
    else:
        year_choices = [2003, 2004, 2005, 2006, 2007]
        if current_year in year_choices and len(year_choices) > 1:
            # Avoid repeatedly selecting the same in-range year.
            year_choices = [y for y in year_choices if y != current_year]
        target_year = random.choice(year_choices)
    await device.send_log(f"📅 Target birthday year: {target_year}")

    await device.get_screen()
    selected_year = _extract_picker_year(device.current_screen or "")
    picker_cols = _extract_picker_columns(device.current_screen or "")
    month_col = picker_cols[0] if len(picker_cols) > 0 else (336, 971, 1444)
    day_col = picker_cols[1] if len(picker_cols) > 1 else (536, 971, 1444)
    year_col = picker_cols[2] if len(picker_cols) > 2 else (736, 971, 1444)

    def _top_tap(col):
        return col[0], int(col[1] + (col[2] - col[1]) * 0.2)

    def _bottom_tap(col):
        return col[0], int(col[1] + (col[2] - col[1]) * 0.86)

    async def _picker_tap_fast(x: int, y: int, wait_after: int = 8) -> None:
        # Fast picker stepping: no XML dump per tap. We refresh screen after batches.
        await device.send_command(
            "tap", {"x": int(x), "y": int(y)}, wait_after=wait_after, get_screen=False
        )

    # One-step year movement via picker button taps.
    year_steps = 0
    if selected_year is not None and selected_year > target_year:
        year_steps = min(40, selected_year - target_year)
        tx, ty = _top_tap(year_col)
        for _ in range(year_steps):
            await _picker_tap_fast(tx, ty)  # older (one step)
    elif selected_year is not None and selected_year < target_year:
        year_steps = min(40, target_year - selected_year)
        tx, ty = _bottom_tap(year_col)
        for _ in range(year_steps):
            await _picker_tap_fast(tx, ty)  # newer (one step)

    await device.get_screen()
    selected_year = _extract_picker_year(device.current_screen or "")

    if selected_year is None:
        await device.send_log("❌ Could not read selected year from birthday picker.")
        return False
    if birthday_override:
        if selected_year != target_year:
            await device.send_log(
                f"❌ Birthday year did not match custom target ({selected_year} != {target_year})."
            )
            return False
    elif not (2003 <= selected_year <= 2007):
        await device.send_log(
            f"❌ Birthday year not in required random range (got: {selected_year})"
        )
        return False

    month_names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    month_map = {m.lower(): i + 1 for i, m in enumerate(month_names)}

    def _parse_month_num(label: str):
        if not label:
            return None
        key = label.strip().lower()[:3]
        return month_map.get(key)

    def _parse_day_num(label: str):
        if not label:
            return None
        m = re.search(r"\d{1,2}", label)
        return int(m.group(0)) if m else None

    async def _step_column_linear(col, current_val: int, target_val: int):
        if current_val == target_val:
            return 0
        steps = abs(target_val - current_val)
        if target_val < current_val:
            tx, ty = _top_tap(col)
        else:
            tx, ty = _bottom_tap(col)
        for _ in range(min(40, steps)):
            await _picker_tap_fast(tx, ty)
        return steps

    # Always move month + day. In custom mode, move them to exact target.
    await device.get_screen()
    vals_before = _extract_picker_values(device.current_screen or "")
    month_before = vals_before[0] if len(vals_before) > 0 else ""
    day_before = vals_before[1] if len(vals_before) > 1 else ""
    month_steps = 1
    day_steps = 1

    if birthday_override:
        target_month = int(birthday_override.get("month"))
        target_day = int(birthday_override.get("day"))
        curr_month = _parse_month_num(month_before)
        curr_day = _parse_day_num(day_before)
        if curr_month is not None:
            month_steps = await _step_column_linear(month_col, curr_month, target_month)
        else:
            mx, my = _top_tap(month_col)
            await _picker_tap_fast(mx, my)
        if curr_day is not None:
            day_steps = await _step_column_linear(day_col, curr_day, target_day)
        else:
            dx, dy = _top_tap(day_col)
            await _picker_tap_fast(dx, dy)
    else:
        mx, my = _top_tap(month_col)
        dx, dy = _top_tap(day_col)
        await _picker_tap_fast(mx, my)  # month one step
        await _picker_tap_fast(dx, dy)  # day one step

    await device.get_screen()
    vals_after = _extract_picker_values(device.current_screen or "")
    month_after = vals_after[0] if len(vals_after) > 0 else "?"
    day_after = vals_after[1] if len(vals_after) > 1 else "?"

    if birthday_override:
        month_after_num = _parse_month_num(month_after)
        day_after_num = _parse_day_num(day_after)
        if (
            month_after_num != int(birthday_override.get("month"))
            or day_after_num != int(birthday_override.get("day"))
            or selected_year != int(birthday_override.get("year"))
        ):
            await device.send_log(
                f"❌ Custom birthday mismatch after set prep (got {month_after}/{day_after}/{selected_year})."
            )
            return False

    await device.send_log(
        f"📅 Birthday picker set: year {selected_year} (target {target_year}, steps {year_steps}); month {month_before}->{month_after} ({month_steps} steps); day {day_before}->{day_after} ({day_steps} steps)"
    )

    async def _tap_set_once() -> None:
        await device.get_screen()
        set_btn = (
            device.find_element_by_resource_id("android:id/button1")
            or device.find_element_by_text("SET", exact=True)
            or device.find_element_by_content_description("SET")
        )
        if set_btn:
            await device.tap(set_btn[0], set_btn[1], wait_after=280)
            return

        # Fallback: target right side of dialog action panel (SET button side).
        screen = device.current_screen or ""
        panel_match = re.search(
            r'resource-id="android:id/buttonPanel"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
            screen,
        ) or re.search(
            r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*resource-id="android:id/buttonPanel"',
            screen,
        )
        if panel_match:
            x1, y1, x2, y2 = map(int, panel_match.groups())
            await device.tap(
                int(x2 - max(30, (x2 - x1) * 0.2)),
                (y1 + y2) // 2,
                wait_after=280,
            )
            return

        width, height = await device.get_screen_size()
        await device.tap(int(width * 0.78), int(height * 0.66), wait_after=280)

    # Confirm picker closes after tapping SET.
    for attempt in range(1, 5):
        await _tap_set_once()
        await device.get_screen()
        if not _picker_open():
            await device.send_log(f"✅ Birthday set ({target_year})")
            return True
        await device.send_log(
            f"ℹ️ Birthday picker still open after SET tap (attempt {attempt}/4), retrying..."
        )

    await device.send_log("❌ Could not confirm birthday SET action.")
    return False


async def execute_validate_all_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based validate all profiles module.
    Uses RemoteDevice to check Instagram account validity.
    """
    check_banned = config.get("check_banned", True)

    await device.send_progress(0, "Starting account validation...")

    try:
        # Launch Instagram
        await device.send_progress(10, "Opening Instagram...")
        await device.launch_app("com.instagram.android", wait_after=2200)
        await device.dismiss_common_popups()

        await device.get_screen()

        # Check if logged in by looking for profile tab
        profile_tab = device.find_element_by_content_description(
            "Profile"
        ) or device.find_element_by_resource_id("com.instagram.android:id/profile_tab")

        if not profile_tab:
            # Check for login screen
            if device.text_on_screen("Log In") or device.text_on_screen("Create"):
                return {
                    "success": True,
                    "data": {
                        "logged_in": False,
                        "status": "not_logged_in",
                        "message": "No Instagram account logged in",
                    },
                }

        await device.send_progress(30, "Account detected, checking profile...")

        # Navigate to profile tab
        if profile_tab:
            await device.tap(profile_tab[0], profile_tab[1], wait_after=1200)
        else:
            # Fallback: tap bottom right corner (profile is usually there)
            await device.tap(1000, 2200, wait_after=1200)

        await device.get_screen()

        # Extract username
        username = None
        username_el = device.find_element_by_resource_id(
            "com.instagram.android:id/action_bar_title"
        )
        if username_el:
            # Try to extract from screen XML
            import re

            match = re.search(
                r'text="(@?[\w\.]+)"[^>]*resource-id="com.instagram.android:id/action_bar_title"',
                device.current_screen or "",
            )
            if match:
                username = match.group(1).lstrip("@")

        await device.send_progress(50, f"Checking @{username or 'unknown'}...")

        # Check for warning signs of banned/limited account
        status = "valid"
        warnings = []

        if check_banned:
            await device.get_screen()

            # Check for common ban indicators
            if device.text_on_screen("suspended") or device.text_on_screen("Suspended"):
                status = "suspended"
                warnings.append("Account suspended")
            elif device.text_on_screen("disabled") or device.text_on_screen("Disabled"):
                status = "disabled"
                warnings.append("Account disabled")
            elif device.text_on_screen("action blocked") or device.text_on_screen(
                "Action Blocked"
            ):
                status = "limited"
                warnings.append("Actions temporarily blocked")
            elif device.text_on_screen("Try Again Later"):
                status = "rate_limited"
                warnings.append("Rate limited")

        await device.send_progress(80, "Collecting profile stats...")

        # Try to get follower counts from profile
        followers = None
        following = None
        posts = None

        await device.get_screen()

        # Look for stats in profile header
        import re

        if device.current_screen:
            stats_match = re.search(r"(\d+)\s*(?:posts?|Posts?)", device.current_screen)
            if stats_match:
                posts = int(stats_match.group(1))

            followers_match = re.search(
                r"(\d+[KMkm]?)\s*(?:followers?|Followers?)", device.current_screen
            )
            if followers_match:
                followers = followers_match.group(1)

        await device.send_progress(100, "Validation complete!")

        return {
            "success": True,
            "data": {
                "logged_in": True,
                "username": username,
                "status": status,
                "warnings": warnings,
                "stats": {
                    "followers": followers,
                    "following": following,
                    "posts": posts,
                },
            },
        }

    except Exception as e:
        return {"success": False, "error": str(e)}


async def execute_gmail_logout_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based Gmail logout/remove module.
    Uses RemoteDevice to remove Google account via Settings app.
    """
    email = config.get("email", "")

    if not email:
        return {"success": False, "error": "Email is required"}

    await device.send_progress(0, f"Opening Settings...")

    try:
        # Open Settings > Accounts
        await device.shell("am start -a android.settings.SYNC_SETTINGS")
        await device.wait(2000)
        await device.dismiss_common_popups()

        await device.send_progress(20, f"Looking for {email}...")

        # Scroll and look for the email
        found = False
        for scroll_attempt in range(5):
            await device.get_screen()

            email_el = device.find_element_by_text(
                email
            ) or device.find_element_by_text(email.split("@")[0])

            if email_el:
                await device.tap(email_el[0], email_el[1], wait_after=2000)
                found = True
                break

            await device.scroll_down()

        if not found:
            return {"success": False, "error": f"Could not find account: {email}"}

        await device.send_progress(50, "Opening account options...")
        await device.get_screen()

        # Look for Remove account button
        remove_btn = device.find_element_by_text(
            "Remove account"
        ) or device.find_element_by_text("Remove")

        if remove_btn:
            await device.tap(remove_btn[0], remove_btn[1], wait_after=2000)

            # Confirm removal
            await device.get_screen()
            confirm_btn = (
                device.find_element_by_text("Remove account")
                or device.find_element_by_text("Remove")
                or device.find_element_by_text("OK")
            )
            if confirm_btn:
                await device.tap(confirm_btn[0], confirm_btn[1], wait_after=3000)

            await device.send_progress(100, f"Gmail {email} removed!")
            return {"success": True, "data": {"email": email, "removed": True}}
        else:
            return {"success": False, "error": "Could not find Remove account option"}

    except Exception as e:
        return {"success": False, "error": str(e)}


async def execute_drive_sync_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based Google Drive sync module.
    Uses RemoteDevice to interact with Google Drive Android app.
    """
    folder_name = config.get("folder_name", "")
    action = config.get("action", "download")  # download, upload, browse

    await device.send_progress(0, "Opening Google Drive...")

    try:
        # Launch Google Drive app
        await device.launch_app("com.google.android.apps.docs", wait_after=4000)
        await device.dismiss_common_popups()

        await device.send_progress(15, "Navigating Drive...")
        await device.get_screen()

        # Navigate to folder if specified
        if folder_name:
            await device.send_progress(25, f"Opening folder: {folder_name}...")

            # Tap search
            search_btn = device.find_element_by_resource_id(
                "com.google.android.apps.docs:id/search_button"
            ) or device.find_element_by_content_description("Search")
            if search_btn:
                await device.tap(search_btn[0], search_btn[1], wait_after=800)
                await device.input_text(folder_name)
                await device.enter()
                await device.wait(2000)

                # Tap first result (should be folder)
                await device.get_screen()
                await device.tap(540, 400, wait_after=2000)
            else:
                # Try scrolling to find folder
                for _ in range(3):
                    await device.get_screen()
                    folder_el = device.find_element_by_text(folder_name)
                    if folder_el:
                        await device.tap(folder_el[0], folder_el[1], wait_after=2000)
                        break
                    await device.scroll_down()

        await device.send_progress(50, "Found target location...")
        await device.get_screen()

        if action == "download":
            # Tap first file to download
            await device.send_progress(60, "Selecting file...")

            # Long-tap first item to select
            await device.long_tap(540, 500, duration_ms=1000)
            await device.wait(1000)

            # Tap menu (three dots)
            await device.get_screen()
            menu_btn = device.find_element_by_content_description(
                "More options"
            ) or device.find_element_by_resource_id(
                "com.google.android.apps.docs:id/action_mode_close_button"
            )
            if menu_btn:
                # Look for download option
                await device.get_screen()
                download_btn = device.find_element_by_text(
                    "Download"
                ) or device.find_element_by_text("Make available offline")
                if download_btn:
                    await device.tap(download_btn[0], download_btn[1], wait_after=3000)
                    await device.send_progress(90, "Download started!")

            await device.wait(2000)

        elif action == "upload":
            await device.send_progress(60, "Opening upload menu...")

            # Tap FAB (+ button)
            fab = device.find_element_by_resource_id(
                "com.google.android.apps.docs:id/fab"
            ) or device.find_element_by_content_description("New")
            if not fab:
                return {
                    "success": False,
                    "code": "DRIVE_UPLOAD_UNAVAILABLE",
                    "error": "Google Drive's New control was not found. Open Drive and verify the upload screen before retrying.",
                }
            await device.tap(fab[0], fab[1], wait_after=800)

            await device.get_screen()
            upload_btn = device.find_element_by_text("Upload")
            if not upload_btn:
                return {
                    "success": False,
                    "code": "DRIVE_UPLOAD_UNAVAILABLE",
                    "error": "Google Drive's Upload action was not found. No file was selected or uploaded.",
                }
            await device.tap(upload_btn[0], upload_btn[1], wait_after=2000)

            # This legacy module has no verified file binding or upload completion check.
            return {
                "success": False,
                "code": "DRIVE_FILE_SELECTION_REQUIRED",
                "error": "Select the intended file manually in Google Drive. This module cannot verify the upload file or transfer completion.",
                "data": {
                    "action": action,
                    "folder": folder_name or "root",
                    "transfer_started": False,
                    "manual_action_required": True,
                },
            }

        await device.send_progress(100, "Drive sync complete!")

        return {
            "success": True,
            "data": {"action": action, "folder": folder_name or "root"},
        }

    except Exception as e:
        return {"success": False, "error": str(e)}


async def execute_content_manager_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based content manager module.
    NOTE: This module reads local content files and cannot run on Railway.
    It returns metadata about what would be available locally.
    """
    await device.send_progress(0, "Content manager check...")

    try:
        # Check if we're on Railway (no local files)
        import os

        is_railway = os.getenv("RAILWAY_ENVIRONMENT") is not None

        if is_railway:
            await device.send_progress(100, "Content manager is local-only")
            return {
                "success": True,
                "data": {
                    "profile_id": profile_id,
                    "mode": "railway",
                    "message": "Content manager runs locally on Electron - files are managed on client side",
                    "files": [],
                    "sample_usernames": [],
                },
            }

        # Local mode - try to load actual content
        await device.send_progress(20, f"Loading content for profile {profile_id}...")

        try:
            from modules.content_manager import ContentManager, get_usernames_for_follow

            cm = ContentManager()
            files = (
                cm.list_profile_files(profile_id)
                if hasattr(cm, "list_profile_files")
                else []
            )
            usernames = (
                get_usernames_for_follow(profile_id, 5)
                if callable(get_usernames_for_follow)
                else []
            )
        except ImportError:
            files = []
            usernames = []

        await device.send_progress(100, "Content manager ready!")

        return {
            "success": True,
            "data": {
                "profile_id": profile_id,
                "mode": "local",
                "files": files,
                "sample_usernames": usernames,
            },
        }

    except Exception as e:
        return {"success": False, "error": str(e)}


async def execute_push_content_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    Push content from local account folder TO the phone.

    For primary profile (user 0): direct ADB push to /sdcard/
    For secondary profiles (user 15+): HTTP server + Vanadium browser download
    to bypass Android cross-profile storage restrictions.

    Config options:
    - source_folder: path on computer (relative to accounts folder)
    - dest_folder: path on phone (default: /sdcard/ShadowPhone/content)
    - content_type: 'image', 'video', 'reel', 'story', 'all' (default: 'all')
    - max_files: maximum files to transfer (default: 10)
    - clear_existing: whether to clear dest folder first (default: True)
    - target_user: Android user ID — auto-detected via `am get-current-user`. Any non-zero user uses Vanadium flow.
    """
    source_folder = config.get("source_folder", "")
    dest_folder = config.get("dest_folder", "/sdcard/ShadowPhone/content")
    content_type = config.get("content_type", "all")
    max_files = config.get("max_files", 10)
    clear_existing = config.get("clear_existing", True)
    target_user = config.get("target_user", None)
    account_username = config.get("account_username", profile_id or "unknown")
    source_file = config.get("source_file")
    transfer_id = config.get("transfer_id")
    manual_transfer_only = config.get("manual_transfer_only") is True

    await device.send_log(f"📤 Pushing content for @{account_username}")
    await device.send_progress(0, "Preparing content transfer...")

    try:
        # Always detect the ACTUAL current Android user on the phone
        user_result = await device.shell("am get-current-user")
        actual_user = user_result.strip() if user_result else "0"
        # Internal — don't expose Android user ID to UI

        # If quick-run passed target_user (from account→profile mapping), verify it matches
        if (
            target_user is not None
            and str(target_user) != ""
            and str(target_user) != str(actual_user)
        ):
            await device.send_log(
                f"⚠️ Profile mismatch for @{account_username} — auto-correcting",
                "WARN",
            )

        # Always use the actual user — that's the profile we're on right now
        target_user = actual_user
        is_secondary = str(target_user) != "0"

        await device.send_log(f"📱 Pushing content for @{account_username}")

        file_extensions = {
            "image": [".jpg", ".jpeg", ".png", ".webp"],
            "video": [".mp4", ".mov", ".avi"],
            "reel": [".mp4", ".mov"],
            "story": [".jpg", ".jpeg", ".png", ".mp4", ".mov"],
            "all": [".jpg", ".jpeg", ".png", ".webp", ".mp4", ".mov", ".avi"],
        }.get(content_type, [".jpg", ".jpeg", ".png", ".mp4"])

        pushed_count = 0

        if is_secondary:
            # ===== NON-OWNER PROFILE: HTTP server + Vanadium download =====
            # Any user != 0 (user 10, 11, 12, 15, etc.) uses this path
            # Internal — don't expose transfer method
            await device.send_progress(20, "Transferring content...")

            push_result = await device._send_command(
                "push_to_profile",
                {
                    "source_folder": source_folder or f"Instagram/{profile_id}",
                    "target_user": str(target_user),
                    "account_username": account_username,
                    "content_type": content_type,
                    "max_files": max_files,
                    "source_file": source_file,
                    "transfer_id": transfer_id,
                    "manual_transfer_only": manual_transfer_only,
                    # Always send ALL extensions — don't filter here, push whatever exists
                    "extensions": [
                        ".jpg",
                        ".jpeg",
                        ".png",
                        ".webp",
                        ".mp4",
                        ".mov",
                        ".avi",
                    ],
                    "port": 18765,
                },
                get_screen=False,
            )

            await device.send_log(f"📤 Push result: {push_result}")
            if isinstance(push_result, dict):
                pushed_count = push_result.get("pushed", 0)

        else:
            # ===== PRIMARY PROFILE: Direct ADB push =====
            # Shell-quote dest_folder so paths containing spaces (e.g. account
            # names with spaces) don't split into extra shell tokens.
            import shlex as _shlex
            _dest_q = _shlex.quote(dest_folder)

            if clear_existing:
                await device.send_progress(10, "Clearing existing content...")
                await device.shell(f"rm -rf {_dest_q}/*")
                await device.send_log(f"Cleared {dest_folder}")

            await device.send_progress(15, "Creating destination folder...")
            await device.shell(f"mkdir -p {_dest_q}")

            await device.send_progress(20, "Pushing files to device...")
            await device.send_log("Transferring files...")

            push_result = await device._send_command(
                "push_files",
                {
                    "source_folder": source_folder or f"Instagram/{profile_id}",
                    "dest_folder": dest_folder,
                    "max_files": max_files,
                    "extensions": file_extensions,
                },
                get_screen=False,
            )

            # Internal — don't expose push details to user
            await device.send_progress(50, "Files transferred - verifying...")

            result = await device.shell(f"ls -la {_dest_q}/")
            try:
                # Count non-empty lines, subtract 1 for the "total" header from ls -la
                pushed_count = max(
                    0, len([l for l in result.strip().splitlines() if l.strip()]) - 1
                )
            except:
                pass

            if pushed_count == 0:
                await device.send_log("No files found on device after transfer", "WARN")

            await device.send_progress(70, "Refreshing gallery...")
            # URL-encode the dest_folder for the file:// URI so spaces in the
            # path don't produce a malformed broadcast URI.
            import urllib.parse as _urlparse
            _dest_uri = _urlparse.quote(dest_folder, safe="/:")
            await device.shell(
                f"am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://{_dest_uri}/"
            )
            await device.wait(2000)

        # Move source files to "used" folder — swap last segment: reels -> used_reels, images -> used_images
        import os as _os

        _src = source_folder or f"Instagram/{profile_id}"
        _src_parent = _os.path.dirname(_src.rstrip("/"))
        _src_base = _os.path.basename(_src.rstrip("/"))
        _used_base = _src_base if _src_base.startswith("used_") else f"used_{_src_base}"
        move_instructions = {
            "action": "move_to_used",
            "source_folder": _src,
            "used_folder": f"{_src_parent}/{_used_base}" if _src_parent else _used_base,
            "max_files": max_files,
        }

        method = "browser_download" if is_secondary else "adb_push"
        await device.send_progress(100, f"Content ready! {pushed_count} file(s) pushed")
        await device.send_log(f"✅ {pushed_count} files pushed successfully")

        if pushed_count == 0:
            # Surface the real reason from the push handler instead of the
            # generic "confirm unused media" message that misleads the user
            # when the content folder clearly has files.
            error_msg = None
            if isinstance(push_result, dict):
                error_msg = push_result.get("error")
                # pushed=0 with no error string means every download was
                # attempted but none verified in MediaStore (e.g. Vanadium
                # download dialog missed, ADB reverse stale, or MediaStore
                # not indexed yet).  Report how many were attempted so the
                # caller can show a useful message.
                if not error_msg:
                    attempted = push_result.get("total", max_files)
                    error_msg = (
                        f"Media transfer attempted {attempted} file(s) from "
                        f"'{source_folder}' but none were confirmed on the device. "
                        f"The content folder has files — this is likely a Vanadium "
                        f"download or MediaStore sync issue on profile {target_user}."
                    )
            if not error_msg:
                error_msg = f"No files were transferred from '{source_folder}'"
            await device.send_log(f"Push failed: {error_msg}", "ERROR")
            return {
                "success": False,
                "error": error_msg,
                "data": {
                    "profile_id": profile_id,
                    "target_user": str(target_user),
                    "method": method,
                    "files_transferred": 0,
                    "source_folder": source_folder,
                },
            }

        result_data = {
            "profile_id": profile_id,
            "target_user": str(target_user),
            "method": method,
            "content_type": content_type,
            "files_transferred": pushed_count,
            "move_instructions": move_instructions,
        }
        push_result_state = type("PushContentResult", (), {
            "ok": True,
            "screen_type": "content_push_completed",
            "confidence": "high",
            "context_label": f"Content transfer runtime check ({pushed_count} file(s) pushed)",
        })()
        result_data = _append_verified_postcondition(
            result_data,
            "content.push_completed",
            "Push content completed",
            push_result_state,
        )

        return {
            "success": True,
            "data": result_data,
        }

    except Exception as e:
        await device.send_log(f"❌ Push content failed: {str(e)}", "ERROR")
        return {"success": False, "error": str(e)}


async def execute_airtable_sync_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based Airtable sync module.
    NOTE: This module reads local registry files and cannot run on Railway.
    """
    await device.send_progress(0, "Airtable sync check...")

    try:
        import os

        is_railway = os.getenv("RAILWAY_ENVIRONMENT") is not None

        if is_railway:
            await device.send_progress(100, "Airtable sync is local-only")
            return {
                "success": True,
                "data": {
                    "mode": "railway",
                    "message": "Airtable sync runs locally on Electron - registry files are managed on client side",
                    "updated": 0,
                    "created": 0,
                    "device_id": device.device_id,
                },
            }

        # Local mode - try to do actual sync
        await device.send_progress(20, "Connecting to Airtable...")

        try:
            from modules.airtable_sync import AirtableSync

            sync = AirtableSync(config)
            registry = sync.load_registry()

            await device.send_progress(50, "Syncing accounts...")
            result = sync.sync_from_registry(device_id=device.device_id)

            await device.send_progress(
                100, f"Synced: {result.get('updated', 0)} updated"
            )

            return {
                "success": True,
                "data": {
                    "mode": "local",
                    "updated": result.get("updated", 0),
                    "created": result.get("created", 0),
                    "device_id": device.device_id,
                },
            }
        except ImportError:
            return {"success": False, "error": "Airtable sync module not available"}

    except Exception as e:
        return {"success": False, "error": str(e)}


# ==================== WS HANDLERS: DELAY MODULES ====================


async def execute_delay_ws(device: RemoteDevice, config: dict, profile_id: str) -> dict:
    """WebSocket-based delay module. Simply waits for a specified time."""
    import asyncio

    seconds = config.get("seconds", 5)

    await device.send_progress(0, f"Waiting {seconds} seconds...")
    await device.send_log(f"Starting delay of {seconds} seconds")

    # Wait in smaller chunks to allow progress updates
    total_ms = seconds * 1000
    chunk_ms = min(1000, total_ms // 10)  # Update every second or 10 times
    elapsed = 0

    while elapsed < total_ms:
        await asyncio.sleep(chunk_ms / 1000)
        elapsed += chunk_ms
        percent = min(99, int((elapsed / total_ms) * 100))
        await device.send_progress(percent, f"Waited {elapsed // 1000}/{seconds}s...")

    await device.send_progress(100, f"Delay complete!")
    await device.send_log(f"Finished waiting {seconds} seconds")

    return {"success": True, "data": {"waited_seconds": seconds}}


async def execute_random_delay_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """WebSocket-based random delay module. Waits for a random time within range."""
    import asyncio
    import random

    min_seconds = config.get("min_seconds", 3)
    max_seconds = config.get("max_seconds", 10)
    actual_seconds = random.uniform(min_seconds, max_seconds)

    await device.send_progress(
        0, f"Random delay: {actual_seconds:.1f}s (range {min_seconds}-{max_seconds}s)"
    )
    await device.send_log(f"Starting random delay of {actual_seconds:.1f} seconds")

    # Wait in smaller chunks
    total_ms = int(actual_seconds * 1000)
    chunk_ms = min(1000, total_ms // 10)
    elapsed = 0

    while elapsed < total_ms:
        await asyncio.sleep(chunk_ms / 1000)
        elapsed += chunk_ms
        percent = min(99, int((elapsed / total_ms) * 100))
        await device.send_progress(
            percent, f"Waited {elapsed // 1000}/{int(actual_seconds)}s..."
        )

    await device.send_progress(100, f"Random delay complete!")
    await device.send_log(f"Finished waiting {actual_seconds:.1f} seconds")

    return {"success": True, "data": {"waited_seconds": round(actual_seconds, 2)}}


async def execute_conditional_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based conditional module.
    Checks a condition and returns whether to proceed or skip.

    Condition types:
    - time_range: Check if current time is within range
    - day_of_week: Check if today matches specified days
    - battery_above: Check if battery is above threshold
    - random_chance: Random percentage chance to proceed
    """
    import random
    from datetime import datetime

    condition_type = config.get("condition_type", "time_range")

    await device.send_progress(0, f"Checking condition: {condition_type}...")

    should_proceed = True
    reason = ""

    try:
        if condition_type == "time_range":
            # Check if current time is within specified range
            time_start = config.get("time_start", "09:00")
            time_end = config.get("time_end", "21:00")

            now = datetime.now()
            current_time = now.strftime("%H:%M")

            # Parse times
            start_hour, start_min = map(int, time_start.split(":"))
            end_hour, end_min = map(int, time_end.split(":"))

            start_minutes = start_hour * 60 + start_min
            end_minutes = end_hour * 60 + end_min
            current_minutes = now.hour * 60 + now.minute

            # Handle overnight ranges (e.g., 22:00 to 06:00)
            if start_minutes <= end_minutes:
                should_proceed = start_minutes <= current_minutes <= end_minutes
            else:
                should_proceed = (
                    current_minutes >= start_minutes or current_minutes <= end_minutes
                )

            reason = f"Current time {current_time} {'is' if should_proceed else 'is NOT'} in range {time_start}-{time_end}"

        elif condition_type == "day_of_week":
            # Check if today is one of the allowed days
            allowed_days = config.get(
                "days", [0, 1, 2, 3, 4, 5, 6]
            )  # 0=Monday, 6=Sunday
            if isinstance(allowed_days, str):
                allowed_days = [int(d.strip()) for d in allowed_days.split(",")]

            today = datetime.now().weekday()
            day_names = [
                "Monday",
                "Tuesday",
                "Wednesday",
                "Thursday",
                "Friday",
                "Saturday",
                "Sunday",
            ]
            should_proceed = today in allowed_days
            reason = f"Today is {day_names[today]} - {'allowed' if should_proceed else 'not allowed'}"

        elif condition_type == "battery_above":
            # Check device battery level
            threshold = config.get("battery_threshold", 20)

            await device.send_progress(50, "Checking battery level...")
            battery_result = await device.shell("dumpsys battery | grep level")

            battery_level = 100  # Default assumption
            if battery_result:
                try:
                    battery_level = int(battery_result.split(":")[1].strip())
                except:
                    pass

            should_proceed = battery_level >= threshold
            reason = f"Battery at {battery_level}% - {'above' if should_proceed else 'below'} {threshold}% threshold"

        elif condition_type == "random_chance":
            # Random percentage chance
            chance = config.get("random_chance", 50)
            roll = random.randint(1, 100)
            should_proceed = roll <= chance
            reason = f"Random roll {roll} vs {chance}% chance - {'proceed' if should_proceed else 'skip'}"

        else:
            reason = f"Unknown condition type: {condition_type}"
            should_proceed = True  # Default to proceed on unknown

        await device.send_log(f"Condition check: {reason}")
        await device.send_progress(100, reason)

        return {
            "success": True,
            "data": {
                "condition_type": condition_type,
                "should_proceed": should_proceed,
                "reason": reason,
            },
        }

    except Exception as e:
        return {"success": False, "error": f"Condition check failed: {str(e)}"}


async def execute_notification_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based notification module.
    Sends notifications via Discord webhook or other channels.
    """
    import httpx

    message = config.get("message", "Workflow step reached")
    discord_webhook = config.get("discord_webhook", "")

    await device.send_progress(0, "Sending notification...")
    await device.send_log(f"Notification: {message}")

    sent_to = []

    try:
        # Send to Discord if webhook provided
        if discord_webhook and discord_webhook.startswith(
            "https://discord.com/api/webhooks/"
        ):
            await device.send_progress(30, "Sending to Discord...")

            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    payload = {
                        "content": f"**ShadowPhone Notification**\n{message}",
                        "username": "ShadowPhone",
                    }
                    response = await client.post(discord_webhook, json=payload)

                    if response.status_code in [200, 204]:
                        sent_to.append("discord")
                        await device.send_log("Discord notification sent!")
                    else:
                        await device.send_log(
                            f"Discord webhook returned {response.status_code}"
                        )
            except Exception as e:
                await device.send_log(f"Discord webhook failed: {str(e)}")

        # Always log locally
        await device.send_progress(80, "Notification logged")
        sent_to.append("local_log")

        await device.send_progress(
            100, f"Notification sent to {len(sent_to)} channel(s)"
        )

        return {"success": True, "data": {"message": message, "sent_to": sent_to}}

    except Exception as e:
        return {"success": False, "error": f"Notification failed: {str(e)}"}


# ==================== PROFILE MANAGEMENT UTILITIES ====================


async def execute_list_profiles_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    List all Android user profiles on the device.
    Returns: [{id: int, name: str, running: bool}]
    """
    try:
        await device.send_progress(10, "Listing user profiles...")
        result = await device.shell("pm list users")

        profiles = []
        if result:
            import re as _re

            for line in result.split("\n"):
                # Format: UserInfo{<id>:<name>:<flags>} running
                match = _re.search(r"UserInfo\{(\d+):([^:]+):(\w+)\}", line)
                if match:
                    uid = int(match.group(1))
                    name = match.group(2)
                    running = "running" in line.lower()
                    profiles.append({"id": uid, "name": name, "running": running})

        await device.send_progress(100, f"Found {len(profiles)} profiles")
        await device.send_log(f"📋 Profiles: {profiles}")

        return {"success": True, "data": {"profiles": profiles}}

    except Exception as e:
        return {"success": False, "error": f"List profiles failed: {str(e)}"}


async def _complete_graphene_setup_wizard(
    device: RemoteDevice, user_id: int, max_steps: int = 10
) -> dict:
    """Complete first-run setup for a brand-new GrapheneOS user."""

    def _is_complete(xml: str) -> bool:
        lower = (xml or "").lower()
        return (
            "com.android.launcher3" in lower
            or "app store" in lower
            or "gallery" in lower
        )

    def _location_enabled(xml: str) -> bool:
        return any(
            "app.grapheneos.setupwizard:id/sud_items_switch" in node
            and 'checked="true"' in node.lower()
            for node in re.findall(r"<node[^>]+>", xml or "", re.IGNORECASE)
        )

    async def _tap_label(
        label: str, fallback: Optional[Tuple[int, int]] = None
    ) -> bool:
        target = device.find_element_by_text(label, exact=True) or device.find_element_by_text(label)
        if target:
            await device.tap(target[0], target[1], wait_after=1200)
            return True
        if fallback:
            await device.tap(fallback[0], fallback[1], wait_after=1200)
            return True
        return False

    await device.send_log(f"Initializing GrapheneOS setup wizard for profile {user_id}...")
    await device.shell(f"am switch-user {user_id}")
    await device.wait(5000)

    steps_clicked = []
    for _ in range(max_steps):
        await device.get_screen()
        xml = device.current_screen or ""
        lower = xml.lower()

        if _is_complete(xml):
            await device.send_log("GrapheneOS setup wizard complete.")
            return {"completed": True, "steps": steps_clicked}

        if "location services" in lower:
            if _location_enabled(xml):
                switch = device.find_element_by_resource_id(
                    "app.grapheneos.setupwizard:id/sud_items_switch"
                )
                if switch:
                    await device.tap(switch[0], switch[1], wait_after=800)
                    steps_clicked.append("Disable location")
                    await device.get_screen()
            candidates = [("Next", (911, 2179))]
        elif "set a pin" in lower:
            candidates = [("Skip", (98, 1509))]
        elif "skip setup for pin" in lower or "fingerprint unlock" in lower:
            candidates = [("Skip", (894, 1393))]
        elif "restore apps" in lower:
            candidates = [("Skip", (98, 2179))]
        elif "you're all set" in lower or "you&apos;re all set" in lower:
            candidates = [("Start", (911, 2179))]
        elif "welcome to grapheneos" in lower:
            candidates = [("Next", (911, 2179))]
        else:
            candidates = [
                ("Next", (911, 2179)),
                ("Skip", None),
                ("Start", (911, 2179)),
                ("Done", None),
                ("Get started", None),
            ]

        clicked = False
        for label, fallback in candidates:
            if await _tap_label(label, fallback):
                steps_clicked.append(label)
                clicked = True
                break

        if not clicked:
            await device.send_log(
                "No known GrapheneOS setup wizard button found.", "WARN"
            )
            return {
                "completed": False,
                "steps": steps_clicked,
                "reason": "button_not_found",
            }

    await device.get_screen()
    completed = _is_complete(device.current_screen or "")
    return {
        "completed": completed,
        "steps": steps_clicked,
        "reason": None if completed else "max_steps_reached",
    }


async def execute_profile_create_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    Create a new Android user profile and install essential apps.
    Mirrors logic from modules/new_user.py:create_single_user_profile().

    Config: profile_name (str) — name for the new profile.
    """
    profile_name = config.get("profile_name", "").strip()
    if not profile_name:
        return {"success": False, "error": "profile_name is required"}

    # Apps to install on every new profile (from modules/new_user.py)
    APPS_TO_INSTALL = [
        "com.instagram.android",
        "com.instagram.barcelona",  # Threads
        "com.google.android.gm",  # Gmail
        "com.google.android.gms",  # Google Services
        "com.google.android.apps.docs",  # Google Drive
        "com.android.vending",  # Play Store
        "com.zhiliaoapp.musically",  # TikTok
        "ch.protonvpn.android",  # ProtonVPN
        "com.twitter.android",  # X/Twitter
    ]

    try:
        await device.send_progress(5, f"Creating profile '{profile_name}'...")
        result = await device.shell(f'pm create-user "{profile_name}"')

        if not result or "Success" not in result:
            error_msg = result.strip() if result else "Unknown error"
            await device.send_log(f"❌ Create failed: {error_msg}")
            return {"success": False, "error": f"Create profile failed: {error_msg}"}

        # Parse: "Success: created user id <N>"
        import re as _re

        uid_match = _re.search(r"id\s+(\d+)", result)
        new_uid = int(uid_match.group(1)) if uid_match else -1

        await device.send_progress(
            20, f"Profile created (ID: {new_uid}). Installing apps..."
        )
        await device.send_log(f"✅ Created profile '{profile_name}' with ID {new_uid}")

        # Install essential apps — mirrors new_user.install_apps_for_user_with_device()
        installed = []
        failed = []
        total = len(APPS_TO_INSTALL)

        for i, package in enumerate(APPS_TO_INSTALL):
            pct = 20 + int((i / total) * 70)  # 20% → 90%
            await device.send_progress(pct, f"Installing {package.split('.')[-1]}...")

            install_result = await device.shell(
                f"pm install-existing --user {new_uid} {package}"
            )
            if install_result and "installed" in install_result.lower():
                installed.append(package)
                await device.send_log(f"  ✅ {package}")
            else:
                failed.append(package)
                await device.send_log(f"  ❌ {package}: {install_result}")

        await device.send_progress(
            90, f"Done — {len(installed)}/{total} apps installed"
        )
        await device.send_log(
            f"📦 Installed {len(installed)}/{total} apps for profile '{profile_name}'"
        )

        await device.send_progress(92, "Initializing GrapheneOS setup wizard...")
        wizard_result = await _complete_graphene_setup_wizard(device, new_uid)
        if wizard_result.get("completed"):
            await device.send_progress(100, "Profile created and initialized")
        else:
            await device.send_log(
                f"GrapheneOS setup wizard may need manual attention: {wizard_result}",
                "WARN",
            )

        return {
            "success": True,
            "data": {
                "user_id": new_uid,
                "profile_name": profile_name,
                "apps_installed": len(installed),
                "apps_failed": failed,
                "setup_wizard": wizard_result,
            },
        }

    except Exception as e:
        return {"success": False, "error": f"Create profile failed: {str(e)}"}


async def execute_profile_delete_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    Delete an Android user profile from the device.
    Config: target_user_id (int) — the user ID to remove.
    """
    target_id = config.get("target_user_id")
    if target_id is None:
        return {"success": False, "error": "target_user_id is required"}

    target_id = int(target_id)

    # Safety: never delete user 0 (Owner)
    if target_id == 0:
        return {"success": False, "error": "Cannot delete the Owner profile (user 0)"}

    try:
        await device.send_progress(10, f"Deleting profile ID {target_id}...")
        result = await device.shell(f"pm remove-user {target_id}")

        if result and "Success" in result:
            await device.send_progress(100, f"Profile {target_id} deleted")
            await device.send_log(f"🗑️ Deleted profile ID {target_id}")
            return {
                "success": True,
                "data": {"removed_id": target_id},
            }
        else:
            error_msg = result.strip() if result else "Unknown error"
            await device.send_log(f"❌ Delete failed: {error_msg}")
            return {"success": False, "error": f"Delete profile failed: {error_msg}"}

    except Exception as e:
        return {"success": False, "error": f"Delete profile failed: {str(e)}"}


async def execute_profile_rename_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    Rename an Android user profile via Settings UI navigation.
    Config: target_user_id (int), new_name (str).

    Navigates: Settings → System → Multiple users → tap profile → tap name → type new name → OK
    """
    target_id = config.get("target_user_id")
    new_name = config.get("new_name", "").strip()

    if target_id is None:
        return {"success": False, "error": "target_user_id is required"}
    if not new_name:
        return {"success": False, "error": "new_name is required"}

    target_id = int(target_id)

    try:
        import re as _re
        import shlex as _shlex

        def _profile_name_from_users(users_raw: str | None) -> str | None:
            if not users_raw:
                return None
            for line in users_raw.split("\n"):
                match = _re.search(r"UserInfo\{(\d+):([^:]+):(\w+)\}", line)
                if match and int(match.group(1)) == target_id:
                    return match.group(2)
            return None

        users_before = await device.shell("pm list users")
        current_name = _profile_name_from_users(users_before)
        if not current_name:
            return {"success": False, "error": f"Could not find profile ID {target_id}"}

        await device.send_progress(5, "Renaming profile through Android user service...")
        try:
            await device.shell(
                f"cmd user set-user-name {target_id} {_shlex.quote(new_name)}"
            )
            await device.wait(800)
            users_after_service = await device.shell("pm list users")
            if _profile_name_from_users(users_after_service) == new_name:
                await device.send_progress(100, f"Renamed to '{new_name}'")
                await device.send_log(
                    f"Renamed profile {target_id} from '{current_name}' to '{new_name}'"
                )
                return {
                    "success": True,
                    "data": {
                        "user_id": target_id,
                        "old_name": current_name,
                        "new_name": new_name,
                    },
                }
            await device.send_log(
                "Android user service did not confirm rename; falling back to Settings UI."
            )
        except Exception as direct_error:
            await device.send_log(
                f"Android user service rename unavailable; falling back to Settings UI: {direct_error}"
            )

        current_user_result = await device.shell("am get-current-user")
        current_user_id = str(current_user_result or "").strip()

        # Must be switched INTO the target profile to rename it (users can only rename themselves).
        if current_user_id != str(target_id):
            await device.send_progress(2, f"Switching to profile {target_id} to rename it...")
            await device.send_log(f"Switching to profile {target_id} before rename (users can only rename themselves).")
            await device.shell("cmd connectivity airplane-mode enable")
            await device.wait(800)
            await device.shell(f"am switch-user {target_id}")
            await device.wait(3000)
            await device.shell("cmd connectivity airplane-mode disable")
            await device.wait(800)

        await device.send_progress(12, "Opening Settings...")
        await device.shell("am start -a android.settings.USER_SETTINGS")
        await device.wait(2000)

        await device.send_progress(20, "Looking for user profiles...")
        await device.get_screen()

        await device.send_progress(30, f"Found profile '{current_name}', tapping...")

        # Tap the profile entry in Settings
        profile_el = (
            device.find_element_by_text(current_name)
            or device.find_element_by_text(f"You ({current_name})")
            or device.find_element_by_text("You", exact=True)
            or device.find_element_by_text("You")
        )
        if profile_el:
            await device.tap(profile_el[0], profile_el[1], wait_after=800)
        else:
            await device.send_log(f"⚠️ Could not find '{current_name}' in Settings UI")
            return {
                "success": False,
                "error": f"Could not find '{current_name}' in Settings UI",
            }

        await device.send_progress(50, "Opening profile edit...")
        await device.get_screen()

        # Look for the name input field or the profile name text to tap for rename
        name_field = (
            device.find_element_by_text(current_name)
            or device.find_element_by_resource_id("android:id/edit")
            or device.find_element_by_resource_id("com.android.settings:id/user_name")
        )

        if name_field:
            await device.tap(name_field[0], name_field[1], wait_after=1000)

        await device.send_progress(60, f"Typing new name: {new_name}")

        # Clear existing text and type new name
        await device.shell("input keyevent KEYCODE_MOVE_END")
        await device.wait(200)
        # Select all and delete
        await device.shell("input keyevent --longpress KEYCODE_DEL")
        await device.wait(500)
        safe_input = new_name.replace(" ", "%s").replace('"', "").replace("'", "").replace("&", "and")
        await device.shell(f"input text {_shlex.quote(safe_input)}")
        await device.wait(500)

        await device.send_progress(80, "Confirming rename...")

        # Try to find and tap OK/Done button
        ok_btn = (
            device.find_element_by_text("OK")
            or device.find_element_by_text("Done")
            or device.find_element_by_resource_id("android:id/button1")
        )
        if ok_btn:
            await device.tap(ok_btn[0], ok_btn[1], wait_after=1000)
        else:
            await device.shell("input keyevent KEYCODE_ENTER")
            await device.wait(800)

        users_after_ui = await device.shell("pm list users")
        if _profile_name_from_users(users_after_ui) != new_name:
            return {
                "success": False,
                "error": f"Rename may have failed for profile {target_id}",
            }

        # Go back to home
        await device.shell("input keyevent KEYCODE_HOME")

        await device.send_progress(100, f"Renamed to '{new_name}'")
        await device.send_log(f"✏️ Renamed profile {target_id} → '{new_name}'")

        return {
            "success": True,
            "data": {
                "user_id": target_id,
                "old_name": current_name,
                "new_name": new_name,
            },
        }

    except Exception as e:
        # Clean up: go home
        try:
            await device.shell("input keyevent KEYCODE_HOME")
        except Exception:
            pass
        return {"success": False, "error": f"Rename profile failed: {str(e)}"}


# ==================== IG LOGIN / LOGOUT WS HANDLERS ====================


async def _logout_cooked_ig_account(device: RemoteDevice, email: str):
    """Logout a cooked account that needs verification via hamburger menu.
    Ported from account_creation_module._logout_cooked_account."""
    try:
        await device.send_log(f"🚪 Logging out cooked account: {email}")
        # Click hamburger menu (top right)
        await device.tap(1000, 200, wait_after=2000)
        await device.get_screen()
        # Look for "Log out <username>"
        email_prefix = email.split("@")[0]
        logout_specific = device.find_element_by_text(f"Log out {email_prefix}")
        if logout_specific:
            await device.tap(logout_specific[0], logout_specific[1], wait_after=2000)
        else:
            logout_btn = device.find_element_by_text("Log out")
            if logout_btn:
                await device.tap(logout_btn[0], logout_btn[1], wait_after=2000)
        # Confirm logout
        await device.get_screen()
        confirm = device.find_element_by_text("Log out") or device.find_element_by_text(
            "Log Out"
        )
        if confirm:
            await device.tap(confirm[0], confirm[1], wait_after=3000)
        await device.send_log(f"✅ Logged out cooked account: {email}")
    except Exception as e:
        await device.send_log(f"⚠️ Failed to logout cooked account: {str(e)}")


async def execute_ig_login_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based Instagram login module.
    Logs into an existing Instagram account via Add account flow.
    Ported from account_creation_module.instagram_login_existing.
    """
    email = (config.get("email") or config.get("username") or "").strip()
    password = config.get("password", "")

    if not email or not password:
        return {"success": False, "error": "Email and password are required"}

    async def _refresh_lower_screen() -> str:
        await device.get_screen()
        return (device.current_screen or "").lower()

    def _is_logged_in_shell(lower_xml: str) -> bool:
        return (
            "your story" in lower_xml
            or "com.instagram.android:id/tab_bar" in lower_xml
            or "com.instagram.android:id/feed_tab" in lower_xml
            or "com.instagram.android:id/profile_tab" in lower_xml
            or "suggested for you" in lower_xml
        )

    async def _tap_any_label(labels: list[str], wait_after_ms: int = 700) -> bool:
        for label in labels:
            # Prefer exact text first to avoid tapping headers/body copy.
            target = (
                device.find_element_by_text(label, exact=True)
                or device.find_element_by_text(label)
                or device.find_element_by_content_description(label)
            )
            if target:
                await device.tap(target[0], target[1], wait_after=wait_after_ms)
                return True
        return False

    async def _tap_any_rid(resource_ids: list[str], wait_after_ms: int = 700) -> bool:
        for rid in resource_ids:
            target = device.find_element_by_resource_id(rid)
            if target:
                await device.tap(target[0], target[1], wait_after=wait_after_ms)
                return True
        return False

    async def _dismiss_android_permission(wait_after_ms: int = 700) -> bool:
        if await _tap_any_rid(
            [
                "com.android.permissioncontroller:id/permission_deny_button",
                "com.android.permissioncontroller:id/permission_deny_and_dont_ask_again_button",
                "android:id/button2",
            ],
            wait_after_ms=wait_after_ms,
        ):
            return True
        return await _tap_any_label(
            ["Don't allow", "Deny", "No thanks", "Cancel"],
            wait_after_ms=wait_after_ms,
        )

    login_identifier_labels = [
        "Username, email or mobile number",
        "Phone number, username or email",
        "Username, email address, or mobile number",
    ]

    def _find_login_identifier_edittext() -> tuple[Optional[Tuple[int, int]], str]:
        """Find login identifier EditText center + current value from current XML."""
        xml = device.current_screen or ""
        for m in re.finditer(
            r'<node[^>]*class="android\.widget\.EditText"[^>]*>',
            xml,
            re.IGNORECASE,
        ):
            node = m.group(0)
            node_lower = node.lower()
            if not any(label.lower() in node_lower for label in login_identifier_labels):
                continue

            b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
            t = re.search(r'text="([^"]*)"', node)
            text_val = (t.group(1) if t else "").strip()
            if b:
                x1, y1, x2, y2 = map(int, b.groups())
                return ((x1 + x2) // 2, (y1 + y2) // 2), text_val
            return None, text_val
        return None, ""

    async def _clear_login_identifier_field() -> None:
        """
        Ensure the IG login identifier field is empty before typing.
        Uses XML EditText targeting + repeated delete/forward-delete passes.
        """
        await _refresh_lower_screen()
        coords, _ = _find_login_identifier_edittext()
        if coords:
            await device.tap(coords[0], coords[1], wait_after=180)
        else:
            fallback = (
                device.find_element_by_text("Username, email or mobile number")
                or device.find_element_by_text("Phone number, username or email")
                or device.find_element_by_text("Username, email address, or mobile number")
            )
            if fallback:
                await device.tap(fallback[0], fallback[1], wait_after=180)

        for attempt in range(3):
            # 2.19.0: batch the cursor+clear into ONE adb call.
            # Previously this was up to 312 sequential shell calls per
            # login attempt (3 attempts × (1 MOVE_END + 80 DEL + 24 FORWARD_DEL))
            # — every one a separate WS round-trip and adb spawn. On Tailscale
            # that's a several-minute window for a transport drop to kill
            # the flow. input keyevent accepts N keycodes per call.
            await device.shell(
                "input keyevent 123 "
                + " ".join(["67"] * 80) + " "
                + " ".join(["112"] * 24)
            )
            await device.wait(200)

            await _refresh_lower_screen()
            coords, current_value = _find_login_identifier_edittext()
            if not current_value:
                return

            # Fallback: long-press -> Select all -> delete
            if attempt == 0 and coords:
                await device.long_tap(coords[0], coords[1], duration_ms=650)
                await device.wait(180)
                await _tap_any_label(["Select all", "SELECT ALL"], wait_after_ms=120)
                await device.shell("input keyevent 67")
                await device.wait(150)

    await device.send_progress(0, f"Logging into IG: {email}")

    try:
        # Go home first
        await device.shell("input keyevent 3")
        await device.wait(400)

        # Open Instagram
        await device.send_progress(5, "Opening Instagram...")
        await device.launch_app("com.instagram.android", wait_after=1800)
        await device.dismiss_common_popups()

        await device.send_progress(15, "Opening account switcher...")

        # Long-press profile tab to show account switcher
        await device.swipe(972, 2274, 972, 2274, 1000)
        await device.wait(950)

        lower = await _refresh_lower_screen()
        if _is_logged_in_shell(lower) and "add instagram account" not in lower:
            username = email.split("@")[0]
            await device.send_progress(100, "Already logged in on this profile")
            return {
                "success": True,
                "data": {"username": username, "email": email, "already_logged_in": True},
            }

        # Tap "Add Instagram account"
        add_acct = device.find_element_by_text("Add Instagram account")
        if add_acct:
            await device.tap(add_acct[0], add_acct[1], wait_after=900)
        else:
            # Fallback: try "Add account"
            add_btn = device.find_element_by_text("Add account")
            if add_btn:
                await device.tap(add_btn[0], add_btn[1], wait_after=900)
            else:
                await device.send_log("Could not find Add account button")
                return {
                    "success": False,
                    "error": "Could not find Add Instagram account option",
                }

        await device.send_progress(25, "Selecting login option...")
        lower = await _refresh_lower_screen()

        # Tap "Log into existing account"
        login_existing = device.find_element_by_text(
            "Log into existing account"
        ) or device.find_element_by_text("Log in to existing account")
        if login_existing:
            await device.tap(login_existing[0], login_existing[1], wait_after=900)

        await device.send_progress(35, "Checking login form...")
        lower = await _refresh_lower_screen()

        # Handle "Use another profile" screen
        if "use another profile" in lower:
            use_another = device.find_element_by_text("Use another profile")
            if use_another:
                await device.tap(use_another[0], use_another[1], wait_after=900)
                await _refresh_lower_screen()

        await device.send_progress(45, "Entering credentials...")

        # Always clear any prefilled username before typing a new account.
        await _clear_login_identifier_field()

        # Type email/username
        await device.input_text(email)
        await device.wait(420)

        await device.send_progress(55, "Entering password...")

        # Find and tap password field
        await _refresh_lower_screen()
        password_field = device.find_element_by_text("Password")
        if password_field:
            await device.tap(password_field[0], password_field[1], wait_after=220)
        await device.input_text(password)
        await device.wait(420)

        await device.send_progress(65, "Submitting login...")

        # Tap Log in button
        await _refresh_lower_screen()
        login_btn = device.find_element_by_text(
            "Log in"
        ) or device.find_element_by_text("Log In")
        if login_btn:
            await device.tap(login_btn[0], login_btn[1], wait_after=700)
        else:
            # Fallback: press Enter
            await device.shell("input keyevent 66")
            await device.wait(700)

        await device.send_progress(80, "Finalizing login...")

        # Handle post-login onboarding/checkpoint stack.
        for _ in range(28):
            await device.wait(450)
            lower = await _refresh_lower_screen()

            if _is_logged_in_shell(lower):
                username = email.split("@")[0]
                await device.send_progress(100, f"Logged in as {username}")
                return {
                    "success": True,
                    "data": {"username": username, "email": email},
                }

            # Hard failure states
            if "password you entered is incorrect" in lower or "password is incorrect" in lower:
                await device.send_progress(100, "Incorrect password")
                return {
                    "success": False,
                    "error": "Incorrect password",
                    "data": {"email": email},
                }

            if "check your email" in lower or "enter the code" in lower:
                await device.send_progress(100, "Verification code required")
                return {
                    "success": False,
                    "error": "Wrong password or verification required (Instagram requested an email code)",
                    "data": {"email": email, "needs_email_code": True},
                }

            if (
                "try another way" in lower
                or "choose a way to confirm it's you" in lower
                or "choose a way to confirm it" in lower
                or "we noticed unusual activity" in lower
            ):
                await device.send_progress(100, "Verification challenge required")
                return {
                    "success": False,
                    "error": "Login verification challenge required (2FA/checkpoint)",
                    "data": {"email": email, "needs_verification": True},
                }

            if (
                "confirm you're human to use your account" in lower
                or ("confirm you're human" in lower and "to use your account" in lower)
                or "enter the code from the image" in lower
            ):
                await _logout_cooked_ig_account(device, email)
                return {
                    "success": False,
                    "error": "Captcha / human verification required",
                    "data": {"verification_needed": True, "email": email},
                }

            if "video selfie" in lower or "confirm you're a real person" in lower:
                await _logout_cooked_ig_account(device, email)
                return {
                    "success": False,
                    "error": "Video selfie verification required",
                    "data": {"verification_needed": True, "email": email},
                }

            if "is this your account" in lower or "couldn't find an account" in lower:
                await device.shell("input keyevent 4")
                await device.wait(700)
                await device.shell("input keyevent 4")
                return {
                    "success": False,
                    "error": f"No Instagram account found for {email}",
                    "data": {"account_not_found": True, "email": email},
                }

            acted = False

            if not acted and "save your login info" in lower:
                acted = await _tap_any_label(["Not now", "Not Now", "Save"], wait_after_ms=750)

            if not acted and "finish setting up your account" in lower:
                acted = await _tap_any_label(["Not now", "Not Now", "Continue"], wait_after_ms=750)

            if not acted and "swipe to easily access reels and messages" in lower:
                acted = await _tap_any_label(["Got it", "GOT IT"], wait_after_ms=700)

            if not acted and "set up on new device" in lower:
                acted = await _tap_any_label(["Skip", "SKIP"], wait_after_ms=750)

            if not acted and (
                "to use location services" in lower
                or "how you can use location services" in lower
            ):
                acted = await _tap_any_label(["Continue"], wait_after_ms=700)

            if not acted and "open settings" in lower and "cancel" in lower:
                acted = await _tap_any_label(["Cancel"], wait_after_ms=700)

            if not acted and (
                "turn on notifications" in lower
                or "allow instagram to send you notifications" in lower
            ):
                acted = await _dismiss_android_permission(wait_after_ms=700)
                if not acted:
                    acted = await _tap_any_label(
                        ["Not now", "Not Now", "Skip", "Don't allow"],
                        wait_after_ms=700,
                    )

            if not acted and (
                "allow access to your contacts" in lower
                or "find your friends on instagram" in lower
                or "sync your contacts" in lower
            ):
                acted = await _tap_any_label(
                    ["Next", "Continue", "Allow access"], wait_after_ms=700
                )
                if acted:
                    # The Android contacts permission dialog usually appears immediately after.
                    await device.wait(320)
                    lower_after_contacts = await _refresh_lower_screen()
                    if (
                        "com.android.permissioncontroller" in lower_after_contacts
                        or "permissioncontroller:id/" in lower_after_contacts
                        or "allow instagram to access your contacts" in lower_after_contacts
                    ):
                        await _dismiss_android_permission(wait_after_ms=700)

            if not acted and (
                "com.android.permissioncontroller" in lower
                or "permissioncontroller:id/" in lower
            ):
                acted = await _dismiss_android_permission(wait_after_ms=700)

            if not acted:
                acted = await _tap_any_label(
                    ["Skip", "Not now", "Not Now", "Got it", "GOT IT", "Done"],
                    wait_after_ms=650,
                )

            if acted:
                continue

        await device.send_progress(100, "Login status unclear")
        return {
            "success": False,
            "error": "Login result unclear - check device screen",
            "data": {"email": email},
        }

    except Exception as e:
        return {"success": False, "error": f"IG login failed: {str(e)}"}


async def execute_ig_logout_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based Instagram logout module.
    Logs out the current Instagram account.
    """
    await device.send_progress(0, "Opening Instagram...")

    try:
        async def _tap_logout_confirm(wait_after_ms: int = 950) -> bool:
            """
            Tap the actual logout confirmation CTA, not the dialog title.
            """
            await device.get_screen()

            # Try positive button resource-ids first.
            for rid in [
                "android:id/button1",
                "com.instagram.android:id/button_positive",
                "com.instagram.android:id/confirm_button",
            ]:
                btn = device.find_element_by_resource_id(rid)
                if btn:
                    await device.tap(btn[0], btn[1], wait_after=wait_after_ms)
                    return True

            # Then exact text variants.
            for label in ["Log out", "Log Out", "LOG OUT"]:
                btn = device.find_element_by_text(label, exact=True)
                if btn:
                    await device.tap(btn[0], btn[1], wait_after=wait_after_ms)
                    return True

            # Last resort: partial matches; pick lowest on screen to avoid title text.
            candidates = (
                device.find_all_elements_by_text("Log out")
                + device.find_all_elements_by_text("Log Out")
                + device.find_all_elements_by_text("LOG OUT")
            )
            if candidates:
                candidates.sort(key=lambda p: p[1], reverse=True)
                x, y = candidates[0]
                await device.tap(x, y, wait_after=wait_after_ms)
                return True

            return False

        await device.launch_app("com.instagram.android", wait_after=1800)
        await device.dismiss_common_popups()

        await device.send_progress(15, "Opening profile...")

        # Navigate to profile tab
        await device.get_screen()
        profile_tab = device.find_element_by_content_description(
            "Profile"
        ) or device.find_element_by_resource_id("com.instagram.android:id/profile_tab")
        if profile_tab:
            await device.tap(profile_tab[0], profile_tab[1], wait_after=900)
        else:
            await device.tap(1000, 2200, wait_after=900)

        await device.send_progress(30, "Opening settings...")

        # Tap hamburger menu (top right)
        await device.get_screen()
        menu_btn = device.find_element_by_content_description(
            "Options"
        ) or device.find_element_by_resource_id(
            "com.instagram.android:id/action_bar_overflow_icon"
        )
        if menu_btn:
            await device.tap(menu_btn[0], menu_btn[1], wait_after=700)
        else:
            # Fallback: top-right corner
            await device.tap(1020, 160, wait_after=700)

        await device.get_screen()

        # Tap Settings
        settings_btn = device.find_element_by_text(
            "Settings and privacy"
        ) or device.find_element_by_text(
            "Settings and activity"
        ) or device.find_element_by_text("Settings")
        if settings_btn:
            await device.tap(settings_btn[0], settings_btn[1], wait_after=900)

        await device.send_progress(50, "Scrolling to logout...")

        # Scroll down to find Log out (handles both multi-account and single-account)
        logout_btn = None
        for _ in range(8):
            await device.get_screen()
            # Check multi-account variant first, then single
            logout_btn = device.find_element_by_text(
                "Log out all accounts"
            ) or device.find_element_by_text("Log out")
            if logout_btn:
                break
            await device.scroll_down()
            await device.wait(420)

        await device.send_progress(70, "Logging out...")

        if not logout_btn:
            # One final screen refresh attempt
            await device.get_screen()
            logout_btn = device.find_element_by_text(
                "Log out all accounts"
            ) or device.find_element_by_text("Log out")

        if logout_btn:
            await device.tap(logout_btn[0], logout_btn[1], wait_after=900)
            await device.send_progress(82, "Confirming logout...")

            def _is_logged_out_screen(lower_xml: str) -> bool:
                return (
                    "use another profile" in lower_xml
                    or "create new account" in lower_xml
                    or "username, email or mobile number" in lower_xml
                    or "phone number, username or email" in lower_xml
                )

            # Instagram often shows:
            # 1) Save your login info? -> Not now / Save
            # 2) Log out of your account? -> Log out / Cancel
            for _ in range(10):
                await device.get_screen()
                lower = (device.current_screen or "").lower()

                if _is_logged_out_screen(lower):
                    await device.send_progress(100, "Logged out!")
                    await device.send_log("Logged out of Instagram")
                    return {
                        "success": True,
                        "data": {"message": "Logged out successfully"},
                    }

                acted = False

                if "save your login info" in lower:
                    not_now_btn = device.find_element_by_text(
                        "Not now"
                    ) or device.find_element_by_text("Not Now")
                    save_btn = device.find_element_by_text("Save")
                    if not_now_btn:
                        await device.tap(not_now_btn[0], not_now_btn[1], wait_after=900)
                        acted = True
                    elif save_btn:
                        await device.tap(save_btn[0], save_btn[1], wait_after=900)
                        acted = True

                if not acted and (
                    "log out of your account" in lower or "log out?" in lower
                ):
                    if await _tap_logout_confirm(wait_after_ms=1100):
                        acted = True

                if not acted and "logging out" in lower:
                    await device.wait(900)
                    acted = True

                if not acted:
                    if await _tap_logout_confirm(wait_after_ms=900):
                        acted = True

                if not acted:
                    await device.wait(450)

            return {
                "success": False,
                "error": "Logout flow timed out before reaching logged-out screen",
            }
        else:
            return {
                "success": False,
                "error": "Could not find Log out button",
            }

    except Exception as e:
        return {"success": False, "error": f"IG logout failed: {str(e)}"}


# ==================== GMAIL LOGIN WS HANDLER ====================


async def execute_gmail_login_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based Gmail login module.
    Logs into a Gmail account or adds another Gmail account.
    Ported from account_creation_module.gmail_login / gmail_add_account.
    """
    email = config.get("email", "")
    password = config.get("password", "")
    recovery_email = config.get("recovery_email", "")

    if not email or not password:
        return {"success": False, "error": "Email and password are required"}

    await device.send_progress(0, f"Gmail login: {email}")

    try:
        async def _tap_next_fast(settle_ms: int = 2800) -> None:
            """Advance through Next without tapping the Gboard punctuation row."""
            await device.get_screen()
            before_screen = device.current_screen or ""
            before_lower = before_screen.lower()

            async def _wait_for_transition(poll_ms: int = 350) -> bool:
                elapsed = 0
                while elapsed < settle_ms:
                    await device.wait(poll_ms)
                    await device.get_screen()
                    if device.current_screen and device.current_screen != before_screen:
                        return True
                    elapsed += poll_ms
                return False

            def _same_google_step(screen_xml: str) -> bool:
                lower = (screen_xml or "").lower()
                if "email or phone" in before_lower or "forgot email" in before_lower:
                    return "email or phone" in lower or "forgot email" in lower
                if "enter your password" in before_lower or "show password" in before_lower:
                    return "enter your password" in lower or "show password" in lower
                return False

            keyboard_visible = (
                "com.google.android.inputmethod" in before_lower
                or "gboard" in before_lower
            )
            google_signin_screen = (
                "email or phone" in before_lower
                or "forgot email" in before_lower
                or "enter your password" in before_lower
                or "show password" in before_lower
                or ("sign in" in before_lower and "google" in before_lower)
            )
            if keyboard_visible and google_signin_screen:
                await device.send_log("Google sign-in keyboard detected; pressing Enter for Next")
                await device.enter()
                await device.wait(500)
                await device.get_screen()
                if not _same_google_step(device.current_screen or ""):
                    return

                width, height = await device.get_screen_size()
                await device.send_log("Google sign-in still on same step; tapping keyboard action")
                await device.tap(int(width * 0.93), int(height * 0.92), wait_after=500)
                await _wait_for_transition()
                return

            next_btn = device.find_element_by_text("Next")
            if next_btn:
                await device.tap(next_btn[0], next_btn[1], wait_after=500)
            else:
                await device.enter()
                await device.wait(500)
            await _wait_for_transition()

        async def _handle_add_phone_number_screen_if_present() -> bool:
            """
            Handle Google's optional "Add phone number?" checkpoint:
            scroll down the webview, tap Skip, and return True if handled.
            """
            await device.get_screen()
            screen_xml = (device.current_screen or "").lower()

            on_phone_screen = (
                "add phone number" in screen_xml
                or ("yes, i" in screen_xml and "skip" in screen_xml and "google accounts" in screen_xml)
            )
            if not on_phone_screen:
                return False

            await device.send_log("ℹ️ Add phone number checkpoint detected — scrolling to Skip")
            width, height = await device.get_screen_size()

            for _ in range(5):
                skip_btn = device.find_element_by_text(
                    "Skip"
                ) or device.find_element_by_content_description("Skip")
                if skip_btn:
                    await device.tap(skip_btn[0], skip_btn[1], wait_after=950)
                    await device.get_screen()
                    if "add phone number" not in (device.current_screen or "").lower():
                        await device.send_log("✅ Skipped optional phone-number step")
                        return True

                await device.swipe(
                    int(width * 0.50),
                    int(height * 0.84),
                    int(width * 0.50),
                    int(height * 0.28),
                    450,
                    wait_after=650,
                )
                await device.get_screen()

            await device.send_log("⚠️ Skip not found after scroll — trying footer-left fallback tap")
            await device.tap(int(width * 0.10), int(height * 0.93), wait_after=950)
            await device.get_screen()
            return "add phone number" not in (device.current_screen or "").lower()

        async def _tap_terms_agree() -> bool:
            """Best-effort tap for Google terms acceptance with robust fallbacks."""
            text_candidates = ["I agree", "I Agree", "I AGREE", "AGREE", "Accept"]
            rid_candidates = [
                "signinconsentNext",
                "com.google.android.gms:id/signinconsentNext",
                "com.google.android.gms:id/sud_navbar_next",
                "com.google.android.gms:id/suc_navbar_next",
                "com.google.android.gms:id/next_button",
            ]
            keyword_candidates = [
                "i agree",
                "agree",
                "accept",
                "review and accept",
            ]

            async def _tap_known_i_agree_location(wait_after_ms: int = 900) -> None:
                """
                Tap the known Google consent CTA location (existing path).
                Base point is (~895, 2226) on a 1080x2400 screen, which matches
                the I-agree button center in recent dumps.
                """
                width, height = await device.get_screen_size()
                tap_x = int(width * (895 / 1080))
                tap_y = int(height * (2226 / 2400))
                await device.send_log(
                    f"ℹ️ Terms known-location tap at ({tap_x}, {tap_y})"
                )
                await device.tap(tap_x, tap_y, wait_after=wait_after_ms)

            def _find_terms_cta_from_xml_exact() -> tuple[int, int] | None:
                """
                Prefer exact selectors from XML:
                1) Known consent resource-ids (e.g. signinconsentNext)
                2) Exact I agree button text/content-desc
                """
                screen_xml = device.current_screen or ""
                if not screen_xml:
                    return None

                rid_exact = {
                    "signinconsentnext",
                    "com.google.android.gms:id/signinconsentnext",
                    "com.google.android.gms:id/sud_navbar_next",
                    "com.google.android.gms:id/suc_navbar_next",
                    "com.google.android.gms:id/next_button",
                }

                # Pass 1: exact resource-id node (from dump this is the most reliable).
                for node_match in re.finditer(r"<node\b[^>]*>", screen_xml, re.IGNORECASE):
                    node = node_match.group(0)
                    rid_match = re.search(r'resource-id="([^"]*)"', node, re.IGNORECASE)
                    bounds_match = re.search(
                        r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node
                    )
                    if not rid_match or not bounds_match:
                        continue
                    rid_val = (rid_match.group(1) or "").strip().lower()
                    if rid_val in rid_exact:
                        x1, y1, x2, y2 = map(int, bounds_match.groups())
                        return ((x1 + x2) // 2, (y1 + y2) // 2)

                # Pass 2: exact I agree button node.
                for node_match in re.finditer(r"<node\b[^>]*>", screen_xml, re.IGNORECASE):
                    node = node_match.group(0)
                    text_match = re.search(r'text="([^"]*)"', node, re.IGNORECASE)
                    desc_match = re.search(
                        r'content-desc="([^"]*)"', node, re.IGNORECASE
                    )
                    bounds_match = re.search(
                        r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node
                    )
                    if not bounds_match:
                        continue
                    text_val = ((text_match.group(1) if text_match else "") or "").strip().lower()
                    desc_val = ((desc_match.group(1) if desc_match else "") or "").strip().lower()
                    if text_val == "i agree" or desc_val == "i agree":
                        x1, y1, x2, y2 = map(int, bounds_match.groups())
                        return ((x1 + x2) // 2, (y1 + y2) // 2)

                return None

            for attempt in range(5):
                await device.get_screen()

                # Exact XML selectors first (resource-id/text from current dump).
                xml_cta = _find_terms_cta_from_xml_exact()
                if xml_cta:
                    before_screen = device.current_screen or ""
                    await device.send_log(
                        f"ℹ️ Terms exact-XML tap at ({xml_cta[0]}, {xml_cta[1]})"
                    )
                    await device.tap(xml_cta[0], xml_cta[1], wait_after=1200)
                    for _ in range(5):
                        await device.wait(350)
                        await device.get_screen()
                        if not _is_on_google_terms_screen():
                            return True
                        if device.current_screen and device.current_screen != before_screen:
                            break

                # Text/content-desc selectors first.
                agree_btn = None
                for t in text_candidates:
                    agree_btn = device.find_element_by_text(t)
                    if agree_btn:
                        break
                    agree_btn = device.find_element_by_content_description(t)
                    if agree_btn:
                        break

                # Resource-id fallback used by some Google service screens.
                if not agree_btn:
                    for rid in rid_candidates:
                        agree_btn = device.find_element_by_resource_id(rid)
                        if agree_btn:
                            break

                if agree_btn:
                    before_screen = device.current_screen or ""
                    await device.tap(agree_btn[0], agree_btn[1], wait_after=1200)
                    # Verify terms screen is actually gone before claiming success.
                    for _ in range(5):
                        await device.wait(350)
                        await device.get_screen()
                        if not _is_on_google_terms_screen():
                            return True
                        # If UI changed but still on terms, keep trying.
                        if device.current_screen and device.current_screen != before_screen:
                            break

                # If direct selectors missed, use the known I-agree location.
                if _is_on_google_terms_screen():
                    before_screen = device.current_screen or ""
                    await _tap_known_i_agree_location(900)
                    for _ in range(4):
                        await device.wait(350)
                        await device.get_screen()
                        if not _is_on_google_terms_screen():
                            return True
                        if device.current_screen and device.current_screen != before_screen:
                            break

                # Try to reveal the button if terms text is scroll-locked.
                await device.swipe(540, 1950, 540, 850, 420, wait_after=500)

                # Late fallback: common bottom-right CTA area.
                if attempt >= 3 and _is_on_google_terms_screen():
                    before_screen = device.current_screen or ""
                    await _tap_known_i_agree_location(900)
                    for _ in range(4):
                        await device.wait(350)
                        await device.get_screen()
                        if not _is_on_google_terms_screen():
                            return True
                        if device.current_screen and device.current_screen != before_screen:
                            break

            await device.send_log(
                "ℹ️ Terms screen is still open; agree button not found yet."
            )
            return False

        def _is_on_google_terms_screen() -> bool:
            """Detect common Google terms/consent screens shown after password step."""
            indicators = [
                "I agree",
                "Google Terms",
                "Google Services",
                "Review and accept",
                "signinconsentNext",
                "sud_navbar_next",
                "suc_navbar_next",
            ]
            return any(device.text_on_screen(indicator) for indicator in indicators)

        def _is_recovery_checkup_screen() -> bool:
            """Detect Google's final recovery-info review screen with the Save CTA."""
            lower = (device.current_screen or "").lower()
            return (
                "make sure you can always sign in" in lower
                or "your recovery info is used" in lower
                or ("add a recovery phone" in lower and "your recovery email" in lower)
            )

        async def _tap_save_checkpoint_if_present(wait_after_ms: int = 1200) -> bool:
            """Tap Skip or Save on Google's recovery/contact checkup screen."""
            await device.get_screen()
            if not (_is_recovery_checkup_screen() or device.text_on_screen("Save")):
                return False

            # Prefer Skip over Save on the second recovery screen
            skip_btn = (
                device.find_element_by_text("Skip", exact=True)
                or device.find_element_by_text("SKIP", exact=True)
                or device.find_element_by_content_description("Skip")
            )
            if skip_btn:
                await device.send_log("Google recovery checkup detected — tapping Skip")
                await device.tap(skip_btn[0], skip_btn[1], wait_after=wait_after_ms)
                await device.get_screen()
                return True

            save_btn = (
                device.find_element_by_text("Save", exact=True)
                or device.find_element_by_text("SAVE", exact=True)
                or device.find_element_by_content_description("Save")
            )
            if save_btn:
                await device.send_log("Google recovery checkup detected — tapping Save")
                await device.tap(save_btn[0], save_btn[1], wait_after=wait_after_ms)
                await device.get_screen()
                return True

            if _is_recovery_checkup_screen():
                width, height = await device.get_screen_size()
                await device.send_log("Save button not found by XML - tapping known Save area")
                await device.tap(int(width * 0.90), int(height * 0.63), wait_after=wait_after_ms)
                await device.get_screen()
                return True

            return False

        async def _handle_home_address_screen_if_present(wait_after_ms: int = 1000) -> bool:
            """Skip Google's optional home-address checkpoint."""
            await device.get_screen()
            on_home_address_screen = (
                device.text_on_screen("Set a home address")
                or device.text_on_screen("Home address")
                or device.text_on_screen("Add home address")
            )
            if not on_home_address_screen or device.text_on_screen("I agree"):
                return False

            await device.send_log("Home-address checkpoint detected - tapping Skip")
            skip_home_btn = (
                device.find_element_by_text("Skip", exact=True)
                or device.find_element_by_text("SKIP", exact=True)
                or device.find_element_by_content_description("Skip")
            )
            if skip_home_btn:
                await device.tap(skip_home_btn[0], skip_home_btn[1], wait_after=wait_after_ms)
            else:
                width, height = await device.get_screen_size()
                await device.tap(int(width * 0.10), int(height * 0.93), wait_after=wait_after_ms)
            await device.get_screen()
            return True

        async def _tap_take_me_to_gmail_if_present(wait_after_ms: int = 1000) -> bool:
            """Enter Gmail inbox from setup-addresses screens."""
            await device.get_screen()
            action_done = device.find_element_by_resource_id("com.google.android.gm:id/action_done")
            take_me = (
                action_done
                or device.find_element_by_text("TAKE ME TO GMAIL")
                or device.find_element_by_text("Take me to Gmail")
                or device.find_element_by_content_description("TAKE ME TO GMAIL")
            )
            if not take_me:
                return False

            await device.send_log("Gmail setup screen detected - tapping TAKE ME TO GMAIL")
            await device.tap(take_me[0], take_me[1], wait_after=wait_after_ms)
            await device.get_screen()
            return True

        async def _handle_gmail_permission_popup_if_present(wait_after_ms: int = 900) -> bool:
            """Allow Gmail notification permission popups after entering the inbox."""
            await device.get_screen()
            xml = device.current_screen or ""
            lower = xml.lower()
            is_permission_popup = (
                "com.android.permissioncontroller" in xml
                or "permission_allow_button" in lower
                or device.text_on_screen("Allow Gmail to send you notifications")
                or ("gmail" in lower and "send you notifications" in lower)
            )
            if not is_permission_popup:
                return False

            allow_rids = [
                "com.android.permissioncontroller:id/permission_allow_button",
                "com.android.permissioncontroller:id/permission_allow_foreground_only_button",
                "com.android.permissioncontroller:id/permission_allow_one_time_button",
                "com.android.permissioncontroller:id/permission_allow_always_button",
                "com.android.packageinstaller:id/permission_allow_button",
                "android:id/button1",
            ]
            for rid in allow_rids:
                btn = device.find_element_by_resource_id(rid)
                if btn:
                    await device.send_log("Gmail permission popup detected - tapping Allow")
                    await device.tap(btn[0], btn[1], wait_after=wait_after_ms)
                    await device.get_screen()
                    return True

            allow_btn = (
                device.find_element_by_text("Allow", exact=True)
                or device.find_element_by_text("ALLOW", exact=True)
            )
            if allow_btn:
                await device.send_log("Gmail permission popup detected - tapping Allow")
                await device.tap(allow_btn[0], allow_btn[1], wait_after=wait_after_ms)
                await device.get_screen()
                return True

            return False

        async def _handle_gmail_onboarding_popup_if_present(wait_after_ms: int = 900) -> bool:
            """Dismiss Gmail onboarding cards such as Google Meet/Got it."""
            await device.get_screen()
            xml = device.current_screen or ""
            is_onboarding_popup = (
                "com.google.android.gm:id/next_button" in xml
                or "com.google.android.gm:id/dismiss_button" in xml
                or "Google Meet, now in Gmail" in xml
                or device.text_on_screen("Got it")
                or device.text_on_screen("GOT IT")
            )
            if not is_onboarding_popup:
                return False

            for rid in [
                "com.google.android.gm:id/next_button",
                "com.google.android.gm:id/dismiss_button",
                "com.google.android.gm:id/primary_button",
                "com.google.android.gm:id/positive_button",
            ]:
                btn = device.find_element_by_resource_id(rid)
                if btn:
                    await device.send_log("Gmail onboarding popup detected - dismissing it")
                    await device.tap(btn[0], btn[1], wait_after=wait_after_ms)
                    await device.get_screen()
                    return True

            got_it = (
                device.find_element_by_text("Got it", exact=True)
                or device.find_element_by_text("GOT IT", exact=True)
                or device.find_element_by_content_description("Got it")
            )
            if got_it:
                await device.send_log("Gmail onboarding popup detected - tapping Got it")
                await device.tap(got_it[0], got_it[1], wait_after=wait_after_ms)
                await device.get_screen()
                return True

            return False

        async def _handle_google_setup_checkpoint_once() -> bool:
            """Handle one post-login Google/Gmail setup checkpoint."""
            if await _tap_save_checkpoint_if_present():
                return True
            if await _handle_home_address_screen_if_present():
                return True
            if await _handle_add_phone_number_screen_if_present():
                return True
            if await _tap_take_me_to_gmail_if_present():
                return True
            if await _handle_gmail_permission_popup_if_present():
                return True
            if await _handle_gmail_onboarding_popup_if_present():
                return True
            return False

        async def _finish_gmail_setup() -> bool:
            """Drain setup checkpoints before declaring Gmail login complete."""
            blocking_markers = [
                "make sure you can always sign in",
                "your recovery info is used",
                "set a home address",
                "take me to gmail",
                "allow gmail to send you notifications",
                "send you notifications",
                "com.android.permissioncontroller",
                "google meet, now in gmail",
            ]

            for _ in range(14):
                await device.get_screen()
                if _is_on_google_terms_screen():
                    await _tap_terms_agree()
                    continue
                if await _handle_google_setup_checkpoint_once():
                    continue

                lower = (device.current_screen or "").lower()
                if not any(marker in lower for marker in blocking_markers):
                    return True
                await device.wait(700)

            await device.get_screen()
            lower = (device.current_screen or "").lower()
            return not any(marker in lower for marker in blocking_markers)

        # Open Gmail (force-stop first for clean state)
        await device.send_progress(5, "Opening Gmail...")
        await device.shell("am force-stop com.google.android.gm")
        await device.wait(500)
        await device.launch_app("com.google.android.gm", wait_after=800)

        await device.get_screen()

        # Check if already logged into target email
        if device.current_screen and email.lower() in device.current_screen.lower():
            import re as _re_gmail

            signed_in = _re_gmail.search(
                r"Signed in as[^\"]*?" + _re_gmail.escape(email),
                device.current_screen,
                _re_gmail.IGNORECASE,
            )
            if signed_in:
                await device.send_log(f"✅ Already logged in as {email}")
                await device.send_progress(100, f"Already logged in: {email}")
                return {
                    "success": True,
                    "data": {"email": email, "message": f"Already logged into {email}"},
                }

        # Detect profile state: new (no accounts) vs existing (has accounts)
        # "Set up email" is the fresh Gmail first-launch screen showing Google/Outlook/Yahoo
        is_new_profile = (
            device.text_on_screen("Got it")
            or device.text_on_screen("Add an email address")
            or device.text_on_screen("Set up email")
        )

        if is_new_profile:
            await device.send_log("📧 New profile detected — fresh Gmail login")

            # "Set up email" screen: tap Google directly (it's already on the provider list)
            if device.text_on_screen("Set up email"):
                await device.send_log("📧 On 'Set up email' screen — tapping Google")
                google_btn = device.find_element_by_text("Google")
                if google_btn:
                    await device.tap(google_btn[0], google_btn[1], wait_after=1200)
                    await device.get_screen()
                else:
                    await device.send_log("⚠️ Could not find Google on Set up email screen")
            else:
                # Click Got it if present (non-blocking)
                await device.tap_element("Got it", wait_after=700)
                await device.get_screen()

                # Click Add an email address
                if not await device.tap_element("Add an email address", wait_after=900):
                    await device.tap_element("Add another email address", wait_after=900)
                await device.get_screen()
        else:
            await device.send_log("📧 Existing profile detected — adding account")

            # Tap profile icon (top right) to open account picker
            await device.tap(1000, 200, wait_after=900)
            await device.get_screen()

            # Click Add another account
            if not await device.tap_element("Add another account", wait_after=900):
                await device.send_log("⚠️ Could not find 'Add another account'")
            await device.get_screen()

        await device.send_progress(20, "Selecting Google...")

        # Select Google — retry up to 3 times since page may still be loading
        # Skip if we already tapped Google from the "Set up email" screen
        google_already_tapped = is_new_profile and device.text_on_screen("Sign in") or (
            device.current_screen and "accounts.google.com" in (device.current_screen or "").lower()
        )
        google_found = google_already_tapped
        if not google_already_tapped:
            for attempt in range(3):
                await device.get_screen()
                google_btn = device.find_element_by_text("Google")
                if google_btn:
                    await device.tap(google_btn[0], google_btn[1], wait_after=1200)
                    google_found = True
                    break
                await device.send_log(
                    f"⏳ Google button not found, retrying ({attempt + 1}/3)..."
                )
                await device.wait(800)

        if not google_found:
            await device.send_log("⚠️ Could not find Google button, proceeding anyway")

        await device.get_screen()

        await device.send_progress(30, "Entering email...")

        # Tap input field (try EditText first, fallback to coords)
        input_field = device.find_element_by_class("android.widget.EditText")
        if input_field:
            await device.tap(input_field[0], input_field[1], wait_after=500)
        else:
            await device.tap(539, 978, wait_after=500)

        # Type email
        await device.input_text(email)
        await device.wait(250)

        # Click Next
        await _tap_next_fast(2400)

        await device.send_progress(45, "Entering password...")

        # Tap input field for password (try EditText first, fallback to coords)
        input_field = device.find_element_by_class("android.widget.EditText")
        if input_field:
            await device.tap(input_field[0], input_field[1], wait_after=500)
        else:
            await device.tap(539, 978, wait_after=500)

        # Type password
        await device.input_text(password)
        await device.wait(250)

        # Click Next
        await _tap_next_fast(3000)

        await device.send_progress(60, "Handling verification...")
        await device.get_screen()

        # Fast path: some accounts jump directly to Google terms (no recovery / no 2FA).
        # Give slow devices a short window so we don't misclassify as non-terms path.
        direct_terms_path = _is_on_google_terms_screen()
        if not direct_terms_path:
            for _ in range(5):
                # Break early if another checkpoint clearly appeared.
                if (
                    device.text_on_screen("Confirm your recovery email")
                    or device.text_on_screen("Add recovery email")
                    or _is_recovery_checkup_screen()
                    or device.text_on_screen("2-Step Verification")
                    or device.text_on_screen("2-step verification")
                    or device.text_on_screen("Verify it's you")
                    or device.text_on_screen("Verify it’s you")
                ):
                    break
                await device.wait(600)
                await device.get_screen()
                if _is_on_google_terms_screen():
                    direct_terms_path = True
                    break

        if direct_terms_path:
            await device.send_log(
                "ℹ️ Direct terms path detected — no recovery/2FA step required"
            )
            # Immediate accept attempt for direct-terms path (don't wait for later loop).
            if await _tap_terms_agree():
                await device.send_log("✅ Direct terms path accepted immediately")
                await device.wait(600)

        if not direct_terms_path:
            await _handle_google_setup_checkpoint_once()

            # Handle recovery-email prompts BEFORE 2FA detection.
            # Some Google screens contain "verification code" wording while only requiring recovery email.
            recovery_screen_indicators = [
                "Confirm your recovery email",
                "Add recovery email",
                "Add a recovery email",
                "Confirm your recovery phone",
            ]
            on_recovery_screen = any(
                device.text_on_screen(indicator) for indicator in recovery_screen_indicators
            ) and not _is_recovery_checkup_screen()
            if on_recovery_screen:
                await device.send_log("ℹ️ Recovery prompt detected (not 2FA challenge)")

                # Open the recovery step if Google is showing a CTA first.
                for cta in [
                    "Confirm your recovery email",
                    "Add recovery email",
                    "Add a recovery email",
                ]:
                    btn = device.find_element_by_text(cta)
                    if btn:
                        await device.tap(btn[0], btn[1], wait_after=900)
                        await device.get_screen()
                        break

                if recovery_email:
                    input_field = device.find_element_by_class("android.widget.EditText")
                    if input_field:
                        await device.tap(input_field[0], input_field[1], wait_after=300)
                    await device.input_text(recovery_email)
                    await device.wait(250)
                    await device.get_screen()

                    next_btn = (
                        device.find_element_by_text("Next")
                        or device.find_element_by_text("Confirm")
                        or device.find_element_by_text("Done")
                        or device.find_element_by_text("Save")
                    )
                    if next_btn:
                        await device.tap(next_btn[0], next_btn[1], wait_after=1200)
                        await device.get_screen()
                    await device.send_log("✅ Recovery email step completed")
                else:
                    await device.send_log(
                        "⚠️ Recovery email prompt shown but no recovery_email provided in config"
                    )

            # Recovery step can lead directly to "Add phone number?" before terms.
            await _handle_add_phone_number_screen_if_present()

            # ── 2FA Detection: pause and let user handle it manually ──
            # Use stronger detection to avoid false positives on recovery/account-checkup screens.
            _2fa_strong_indicators = [
                "2-Step Verification",
                "2-step verification",
                "Use your authenticator app",
                "Security key",
                "Try another way",
            ]
            _2fa_weak_indicators = [
                "Verify it's you",
                "Verify it\u2019s you",
                "Get a verification code",
                "Enter the code",
                "Confirm your identity",
            ]

            strong_hits = [
                indicator
                for indicator in _2fa_strong_indicators
                if device.text_on_screen(indicator)
            ]
            weak_hits = [
                indicator
                for indicator in _2fa_weak_indicators
                if device.text_on_screen(indicator)
            ]
            detected_2fa = bool(strong_hits) or len(weak_hits) >= 2

            if detected_2fa:
                detected_text = strong_hits[0] if strong_hits else weak_hits[0]
                await device.send_log(
                    f"⚠️ 2FA detected: '{detected_text}' — waiting for you to handle it"
                )
                # Prompt user to handle 2FA manually on the phone
                action = await device.prompt_user(
                    f"2-Factor Authentication detected on {email}.\n\n"
                    "Please complete the 2FA verification on the phone screen, "
                    "then tap Continue once you're logged into Gmail.\n\n"
                    "Tap Cancel to abort.",
                    options=["continue", "cancel"],
                    timeout=300,  # 5 minutes to handle 2FA
                )

                if action != "continue":
                    await device.send_log("❌ User cancelled — aborting Gmail login")
                    await device.shell("am force-stop com.google.android.gm")
                    return {
                        "success": False,
                        "error": "Gmail login cancelled by user after 2FA prompt.",
                    }

                # User said continue — re-check screen to verify login succeeded
                await device.send_log("🔄 Continuing after 2FA — verifying login...")
                await device.get_screen()

                # Check if still on a 2FA screen (user didn't complete it)
                still_strong_hits = any(
                    device.text_on_screen(check) for check in _2fa_strong_indicators
                )
                still_weak_hits = sum(
                    1 for check in _2fa_weak_indicators if device.text_on_screen(check)
                )
                still_on_2fa = still_strong_hits or still_weak_hits >= 2

                if still_on_2fa:
                    await device.send_log("❌ Still on 2FA screen — login not completed")
                    await device.shell("am force-stop com.google.android.gm")
                    return {
                        "success": False,
                        "error": "2FA was not completed. Gmail login failed.",
                    }

                await device.send_log("✅ 2FA handled — Gmail login appears successful")

        await _handle_google_setup_checkpoint_once()

        # Handle occasional Google account-checkup screen that requires pressing "Save"
        # before terms ("I agree") appear.
        await device.get_screen()
        save_btn = device.find_element_by_text("Save") or device.find_element_by_text(
            "SAVE"
        )
        if save_btn and not device.text_on_screen("I agree"):
            await device.send_log("ℹ️ Checkup screen detected — tapping Save")
            await device.tap(save_btn[0], save_btn[1], wait_after=1200)
            await device.get_screen()

        # Handle optional "Set a home address" checkpoint.
        await device.get_screen()
        on_home_address_screen = device.text_on_screen(
            "Set a home address"
        ) or device.text_on_screen("Home address")
        if on_home_address_screen and not device.text_on_screen("I agree"):
            await device.send_log("ℹ️ Home-address screen detected — tapping Skip")
            skip_home_btn = device.find_element_by_text(
                "Skip"
            ) or device.find_element_by_content_description("Skip")
            if skip_home_btn:
                await device.tap(skip_home_btn[0], skip_home_btn[1], wait_after=900)
            else:
                await device.tap_element(text="Skip", wait_after=900)
            await device.get_screen()

        await device.send_progress(70, "Accepting terms...")

        # Robust checkpoint loop:
        # screens can arrive in different orders (phone skip, checkup save, then terms),
        # and terms can appear late on slower devices.
        agreed = False
        for _ in range(10):
            await device.get_screen()

            if _is_on_google_terms_screen():
                agreed = await _tap_terms_agree()
                if agreed:
                    await device.send_log("✅ Google terms accepted")
                    await device.wait(800)
                    break

            if await _handle_google_setup_checkpoint_once():
                continue

            # Handle optional "Save" checkpoint that may appear before terms.
            save_btn = device.find_element_by_text("Save") or device.find_element_by_text(
                "SAVE"
            )
            if save_btn and not _is_on_google_terms_screen():
                await device.send_log("ℹ️ Save checkpoint during terms flow — tapping")
                await device.tap(save_btn[0], save_btn[1], wait_after=900)
                continue

            # Handle optional Add-phone-number step (requires scrolling on many devices).
            if await _handle_add_phone_number_screen_if_present():
                continue

            await device.wait(600)

        if not agreed:
            await device.get_screen()
            # One final explicit attempt in case terms appeared at the tail end.
            if _is_on_google_terms_screen():
                agreed = await _tap_terms_agree()

        if not agreed:
            await device.get_screen()
            still_on_terms = _is_on_google_terms_screen()
            if still_on_terms:
                return {
                    "success": False,
                    "error": "Could not click Google terms acceptance (I agree).",
                }
        else:
            # Safety gate: never proceed if terms are still visible.
            await device.get_screen()
            if _is_on_google_terms_screen():
                return {
                    "success": False,
                    "error": "Terms screen still visible after agree tap. Retrying required.",
                }

        await device.send_progress(85, "Finishing setup...")

        if not await _finish_gmail_setup():
            return {
                "success": False,
                "error": "Gmail setup did not finish. Still on a Google/Gmail checkpoint screen after login.",
            }

        # If we landed back on "Set up email", login didn't stick
        await device.get_screen()
        if device.text_on_screen("Set up email"):
            return {
                "success": False,
                "error": "Gmail login appeared to succeed but the account was not saved. Gmail still shows 'Set up email'. Try again.",
            }

        # Take me to Gmail
        take_me = device.find_element_by_text("TAKE ME TO GMAIL")
        if take_me:
            await device.tap(take_me[0], take_me[1], wait_after=900)
            await device.get_screen()

        # Handle notifications popup
        await _handle_gmail_permission_popup_if_present()

        # Handle other popups
        got_it = device.find_element_by_text("Got it")
        if got_it:
            await device.tap(got_it[0], got_it[1], wait_after=1000)
        dismiss = device.find_element_by_text("Dismiss")
        if dismiss:
            await device.tap(dismiss[0], dismiss[1], wait_after=1000)

        await device.send_progress(100, f"Gmail login complete: {email}")
        await device.send_log(f"✅ Gmail login complete: {email}")
        return {
            "success": True,
            "data": {"email": email, "message": f"Logged into {email}"},
        }

    except Exception as e:
        return {"success": False, "error": f"Gmail login failed: {str(e)}"}


# ==================== EDIT PROFILE WS HANDLER ====================


async def _edit_profile_field(device: RemoteDevice, field_type: str, value: str):
    """Helper: Navigate into a profile field screen, clear, type, and save."""
    OPEN_FIELD_WAIT_MS = 360
    INLINE_REFOCUS_WAIT_MS = 120
    INPUT_FOCUS_WAIT_MS = 120
    CLEAR_SETTLE_MS = 70
    TYPE_SETTLE_MS = 120
    RETRY_FOCUS_WAIT_MS = 90
    USERNAME_SETTLE_MS = 220
    SAVE_WAIT_MS = 360
    BACK_WAIT_MS = 320
    CONFIRM_POLL_INTERVAL_MS = 120
    CONFIRM_TAP_WAIT_MS = 320

    await device.get_screen()

    def _is_on_edit_profile_form(xml: str) -> bool:
        lower = (xml or "").lower()
        return (
            "com.instagram.android:id/edit_profile_fields" in lower
            and (
                "com.instagram.android:id/full_name" in lower
                or "com.instagram.android:id/username" in lower
                or "com.instagram.android:id/bio" in lower
            )
        )

    field_meta = {
        "name": {
            "label": "Name",
            "resource_id": "com.instagram.android:id/full_name",
            "clear_chars": 60,
        },
        "username": {
            "label": "Username",
            "resource_id": "com.instagram.android:id/username",
            "clear_chars": 80,
        },
        "bio": {
            "label": "Bio",
            "resource_id": "com.instagram.android:id/bio",
            "clear_chars": 180,
        },
    }

    meta = field_meta.get(field_type)
    if not meta:
        return False

    btn_text = str(meta["label"])
    resource_id = str(meta["resource_id"])
    clear_chars = int(meta["clear_chars"])

    # IMPORTANT: prefer exact resource-id targeting so username does not
    # accidentally route to the Name row on certain IG layouts.
    target = device.find_element_by_resource_id(resource_id)
    if not target:
        target = (
            device.find_element_by_text(btn_text, exact=True)
            or device.find_element_by_text(btn_text)
        )
    if not target:
        await device.send_log(f"⚠️ Could not find {btn_text} button")
        return False

    await device.tap(target[0], target[1], wait_after=OPEN_FIELD_WAIT_MS)
    await device.get_screen()

    # New IG edit-profile layouts often require tapping lower inside the row
    # (center tap often does nothing and leaves focus unchanged).
    if field_type in ("name", "username", "bio") and _is_on_edit_profile_form(
        device.current_screen or ""
    ):
        focus_y = min(target[1] + 45, 2320)
        await device.tap(target[0], focus_y, wait_after=INLINE_REFOCUS_WAIT_MS)
        await device.get_screen()

    # Find the actual input field inside that editor.
    if field_type in ("name", "username", "bio") and _is_on_edit_profile_form(
        device.current_screen or ""
    ):
        input_field = (target[0], min(target[1] + 45, 2320))
    else:
        input_field = device.find_element_by_resource_id(
            resource_id
        ) or device.find_element_by_class("android.widget.EditText")
    if input_field:
        await device.tap(input_field[0], input_field[1], wait_after=INPUT_FOCUS_WAIT_MS)

    normalized_value = str(value or "").replace("\r\n", "\n").replace("\r", "\n")

    async def _type_field_value(v: str):
        # Android `input text` cannot type literal newlines; emulate with ENTER.
        if field_type == "bio" and "\n" in v:
            parts = v.split("\n")
            for idx, part in enumerate(parts):
                if part:
                    await device.input_text(part)
                if idx < len(parts) - 1:
                    await device.keyevent(66)
                    await device.wait(120)
        else:
            await device.input_text(v)

    # Clear/type with verification to avoid leftovers.
    typed_ok = False
    for attempt in range(1, 4):
        await device.select_all_and_delete()
        await device.wait(CLEAR_SETTLE_MS)

        # Extra backspaces for stubborn fields.
        backspace_count = max(clear_chars, len(str(value or "")) + 40)
        await device.shell(
            f"i=0; while [ $i -lt {backspace_count} ]; do input keyevent 67; i=$((i+1)); done"
        )
        await device.wait(CLEAR_SETTLE_MS)

        await _type_field_value(normalized_value)
        await device.wait(TYPE_SETTLE_MS)
        await device.get_screen()

        if field_type == "bio" and "\n" in normalized_value:
            parts = [p.strip() for p in normalized_value.split("\n") if p.strip()]
            # Keep verification practical for long bios: require first up to 3 lines.
            value_present = all(device.text_on_screen(p) for p in parts[:3]) if parts else True
        else:
            value_present = device.text_on_screen(normalized_value)

        if value_present:
            typed_ok = True
            break

        await device.send_log(
            f"ℹ️ {btn_text} clear/type verification retry ({attempt}/3)..."
        )
        if input_field:
            await device.tap(input_field[0], input_field[1], wait_after=RETRY_FOCUS_WAIT_MS)

    if not typed_ok:
        await device.send_log(f"⚠️ {btn_text} may still contain leftover text")

    # Extra wait for username validation (IG checks availability)
    if field_type == "username":
        await device.wait(USERNAME_SETTLE_MS)

    # Save — look for checkmark/Done/Save button
    await device.get_screen()
    save_btn = (
        device.find_element_by_resource_id(
            "com.instagram.android:id/action_bar_button_action"
        )
        or device.find_element_by_content_description("Done")
        or device.find_element_by_text("Done")
        or device.find_element_by_content_description("Save")
    )
    if save_btn:
        await device.tap(save_btn[0], save_btn[1], wait_after=SAVE_WAIT_MS)
    else:
        # Only back out if we're NOT on the inline edit-profile form.
        if not _is_on_edit_profile_form(device.current_screen or ""):
            await device.back()
            await device.wait(BACK_WAIT_MS)

    # Handle post-save confirmation dialogs (e.g. name/username change prompts).
    for attempt in range(1, 5):
        await device.get_screen()
        lower = (device.current_screen or "").lower()
        confirm = (
            device.find_element_by_resource_id(
                "com.instagram.android:id/igds_alert_dialog_primary_button"
            )
            or device.find_element_by_text("Change name")
            or device.find_element_by_text("Change Name")
            or device.find_element_by_text("Change username")
            or device.find_element_by_text("Change Username")
            or device.find_element_by_text("Keep username")
            or device.find_element_by_text("Keep Username")
            or device.find_element_by_text("Keep current username")
            or device.find_element_by_text("Keep both")
            or device.find_element_by_text("Change")
            or device.find_element_by_text("Confirm")
            or device.find_element_by_content_description("Change name")
            or device.find_element_by_content_description("Change username")
            or device.find_element_by_content_description("Keep username")
            or device.find_element_by_content_description("Confirm")
        )
        if confirm:
            await device.tap(confirm[0], confirm[1], wait_after=CONFIRM_TAP_WAIT_MS)
            break

        if (
            "change your name" in lower
            or "change name" in lower
            or "change your username" in lower
            or "change username" in lower
            or "keep username" in lower
            or "igds_alert_dialog" in lower
            or "confirm" in lower
        ):
            # Dialog is visible but selector failed; use a safe primary-button fallback.
            await device.tap(540, 1370, wait_after=CONFIRM_TAP_WAIT_MS)
            break

        if attempt < 4:
            await device.wait(CONFIRM_POLL_INTERVAL_MS)

    await device.send_log(f"✅ Updated {field_type}: {value[:30]}...")
    return True


async def execute_edit_profile_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """
    WebSocket-based IG profile editor.
    Updates name, username, bio, and/or link.
    Ported from edit_profile_module.py.
    """
    def _clean_text(value):
        if value is None:
            return None
        if not isinstance(value, str):
            value = str(value)
        value = value.strip()
        return value or None

    name = _clean_text(config.get("name"))
    username = _clean_text(config.get("username"))
    bio = _clean_text(config.get("bio"))
    # Keep backward compatibility with older UI payload key.
    link = _clean_text(config.get("link") or config.get("website"))

    switch_to_professional_raw = config.get("switch_to_professional", False)
    if isinstance(switch_to_professional_raw, bool):
        switch_to_professional = switch_to_professional_raw
    elif isinstance(switch_to_professional_raw, str):
        switch_to_professional = (
            switch_to_professional_raw.strip().lower() in ("1", "true", "yes", "y", "on")
        )
    else:
        switch_to_professional = bool(switch_to_professional_raw)

    professional_category = _clean_text(config.get("professional_category")) or "Digital creator"
    account_type = (_clean_text(config.get("account_type")) or "Business").lower()
    if account_type not in ("creator", "business"):
        account_type = "business"

    if not any([name, username, bio, link, switch_to_professional]):
        return {
            "success": False,
            "error": "At least one field required: name, username, bio, link, or professional switch",
        }

    await device.send_progress(0, "Opening Instagram...")

    try:
        # Launch Instagram
        await device.launch_app("com.instagram.android", wait_after=3000)
        await device.dismiss_common_popups()

        await device.send_progress(10, "Navigating to profile...")

        async def _on_profile_surface() -> bool:
            await device.get_screen()
            lower = (device.current_screen or "").lower()
            return (
                "edit profile" in lower
                or "share profile" in lower
                or "professional dashboard" in lower
                or "com.instagram.android:id/row_profile_header_edit_profile_button" in lower
                or "com.instagram.android:id/action_bar_username_container" in lower
                or (
                    "followers" in lower and "following" in lower and "posts" in lower
                )
            )

        async def _on_edit_profile_form_surface() -> bool:
            await device.get_screen()
            lower = (device.current_screen or "").lower()
            return (
                "com.instagram.android:id/edit_profile_fields" in lower
                and (
                    "com.instagram.android:id/full_name" in lower
                    or "com.instagram.android:id/username" in lower
                    or "com.instagram.android:id/bio" in lower
                )
            )

        def _find_bottom_profile_tab_from_xml(
            xml: str, width: int, height: int
        ) -> Optional[Tuple[int, int]]:
            if not xml:
                return None

            candidates = []
            patterns = [
                r'content-desc="([^"]*profile[^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*?content-desc="([^"]*profile[^"]*)"',
            ]

            for idx, pat in enumerate(patterns):
                for match in re.finditer(pat, xml, re.IGNORECASE | re.DOTALL):
                    if idx == 0:
                        desc = (match.group(1) or "").strip().lower()
                        x1, y1, x2, y2 = map(
                            int,
                            [
                                match.group(2),
                                match.group(3),
                                match.group(4),
                                match.group(5),
                            ],
                        )
                    else:
                        x1, y1, x2, y2 = map(
                            int,
                            [
                                match.group(1),
                                match.group(2),
                                match.group(3),
                                match.group(4),
                            ],
                        )
                        desc = (match.group(5) or "").strip().lower()

                    if "edit profile" in desc:
                        continue

                    cx = (x1 + x2) // 2
                    cy = (y1 + y2) // 2

                    # Profile tab should be in bottom-nav right area.
                    if cy >= int(height * 0.78) and cx >= int(width * 0.55):
                        candidates.append((cx, cy))

            if not candidates:
                return None

            # Prefer lowest/right-most candidate.
            candidates.sort(key=lambda p: (p[1], p[0]), reverse=True)
            return candidates[0]

        async def _tap_profile_tab_once(width: int, height: int) -> None:
            await device.get_screen()

            # 1) Resource IDs are the safest selectors.
            profile_tab = device.find_element_by_resource_id(
                "com.instagram.android:id/profile_tab"
            ) or device.find_element_by_resource_id("com.instagram.android:id/tab_avatar")
            if profile_tab:
                await device.tap(profile_tab[0], profile_tab[1], wait_after=320)
                return

            # 2) Content-desc match restricted to bottom-nav bounds.
            filtered_profile = _find_bottom_profile_tab_from_xml(
                device.current_screen or "", width, height
            )
            if filtered_profile:
                await device.tap(filtered_profile[0], filtered_profile[1], wait_after=320)
                return

            # 3) Relative bottom-right fallback.
            await device.tap(int(width * 0.90), int(height * 0.948), wait_after=320)

        async def _ensure_edit_profile_form_surface() -> bool:
            if await _on_edit_profile_form_surface():
                return True

            await device.get_screen()
            edit_btn = (
                device.find_element_by_resource_id(
                    "com.instagram.android:id/row_profile_header_edit_profile_button"
                )
                or device.find_element_by_text("Edit profile")
                or device.find_element_by_text("Edit Profile")
                or device.find_element_by_content_description("Edit profile")
                or device.find_element_by_content_description("Edit Profile")
            )
            if edit_btn:
                await device.tap(edit_btn[0], edit_btn[1], wait_after=420)
                return await _on_edit_profile_form_surface()
            return False

        async def _tap_any(
            labels: List[str],
            fallback: Optional[Tuple[int, int]] = None,
            wait_after: int = 420,
        ) -> bool:
            await device.get_screen()
            for label in labels:
                target = (
                    device.find_element_by_text(label, exact=True)
                    or device.find_element_by_text(label)
                    or device.find_element_by_content_description(label)
                )
                if target:
                    await device.tap(target[0], target[1], wait_after=wait_after)
                    return True
            if fallback:
                await device.tap(fallback[0], fallback[1], wait_after=wait_after)
                return True
            return False

        width, height = await device.get_screen_size()
        profile_confirmed = False
        for attempt in range(1, 4):
            await _tap_profile_tab_once(width, height)
            if await _on_profile_surface():
                profile_confirmed = True
                break
            await device.send_log(
                f"[INFO] Profile screen not confirmed yet (attempt {attempt}/3), retrying..."
            )
            await device.wait(120)

        if not profile_confirmed:
            await device.send_log(
                "[WARN] Could not confirm profile screen; attempting Edit profile lookup anyway."
            )

        await device.send_progress(20, "Entering edit profile...")

        # Tap "Edit profile" button (resource-id first, then text variants).
        edit_btn = None
        for attempt in range(1, 4):
            await device.get_screen()
            edit_btn = (
                device.find_element_by_resource_id(
                    "com.instagram.android:id/row_profile_header_edit_profile_button"
                )
                or device.find_element_by_text("Edit profile")
                or device.find_element_by_text("Edit Profile")
                or device.find_element_by_content_description("Edit profile")
                or device.find_element_by_content_description("Edit Profile")
            )
            if edit_btn:
                break

            if attempt < 3:
                await device.send_log(
                    f"[INFO] Edit profile button not found (attempt {attempt}/3), re-opening profile tab..."
                )
                await _tap_profile_tab_once(width, height)
                await device.wait(140)

        if not edit_btn:
            return {"success": False, "error": "Could not find Edit profile button"}

        await device.tap(edit_btn[0], edit_btn[1], wait_after=460)

        results = {
            "name": None,
            "username": None,
            "bio": None,
            "link": None,
            "switch_to_professional": None,
        }
        step = 30
        total_fields = sum(1 for x in [name, username, bio, link] if x is not None)
        if switch_to_professional:
            total_fields += 1
        step_increment = 60 // max(total_fields, 1)

        # Update name
        if name is not None:
            await device.send_progress(step, f"Updating name: {name[:20]}...")
            if await _ensure_edit_profile_form_surface():
                results["name"] = await _edit_profile_field(device, "name", name)
            else:
                results["name"] = False
                await device.send_log("⚠️ Could not return to Edit Profile form for Name")
            step += step_increment

        # Update username
        if username is not None:
            await device.send_progress(step, f"Updating username: {username[:20]}...")
            if await _ensure_edit_profile_form_surface():
                results["username"] = await _edit_profile_field(
                    device, "username", username
                )
            else:
                results["username"] = False
                await device.send_log(
                    "⚠️ Could not return to Edit Profile form for Username"
                )
            step += step_increment

        # Update bio
        if bio is not None:
            await device.send_progress(step, f"Updating bio...")
            if await _ensure_edit_profile_form_surface():
                results["bio"] = await _edit_profile_field(device, "bio", bio)
            else:
                results["bio"] = False
                await device.send_log("⚠️ Could not return to Edit Profile form for Bio")
            step += step_increment

        # Update link
        if link is not None:
            await device.send_progress(step, f"Adding link: {link[:30]}...")
            if await _ensure_edit_profile_form_surface():
                await device.get_screen()

                links_btn = (
                    device.find_element_by_resource_id(
                        "com.instagram.android:id/links_text_cell"
                    )
                    or device.find_element_by_text("Add link")
                    or device.find_element_by_text("Links")
                    or device.find_element_by_content_description("Add link")
                    or device.find_element_by_content_description("Links")
                )
                if links_btn:
                    await device.tap(links_btn[0], links_btn[1], wait_after=360)
                    await device.get_screen()

                    add_ext = (
                        device.find_element_by_text("Add external link")
                        or device.find_element_by_text("Add link")
                        or device.find_element_by_content_description("Add external link")
                    )
                    if add_ext:
                        await device.tap(add_ext[0], add_ext[1], wait_after=360)
                        await device.get_screen()

                        input_field = (
                            device.find_element_by_resource_id(
                                "com.instagram.android:id/edit_url_form_field"
                            )
                            or device.find_element_by_class("android.widget.EditText")
                        )
                        if input_field:
                            await device.tap(input_field[0], input_field[1], wait_after=90)
                        await device.select_all_and_delete()
                        await device.input_text(link)
                        await device.wait(90)

                        await device.get_screen()
                        done_btn = (
                            device.find_element_by_resource_id(
                                "com.instagram.android:id/action_bar_button_action"
                            )
                            or device.find_element_by_content_description("Done")
                            or device.find_element_by_text("Done")
                        )
                        if done_btn:
                            await device.tap(done_btn[0], done_btn[1], wait_after=380)
                        else:
                            await device.back()
                            await device.wait(220)

                        await device.back()
                        await device.wait(220)

                        results["link"] = True
                        await device.send_log(f"[OK] Link added: {link}")
                    else:
                        results["link"] = False
                        await device.send_log("[WARN] Could not find Add external link button")
                else:
                    results["link"] = False
                    await device.send_log("[WARN] Could not find Links button")
            else:
                results["link"] = False
                await device.send_log("[WARN] Could not return to Edit Profile form for Link")
            step += step_increment

        # Optional: switch to professional account wizard
        if switch_to_professional:
            await device.send_progress(step, "Switching to professional account...")
            professional_ok = False

            if await _ensure_edit_profile_form_surface():
                await device.get_screen()
                switch_btn = (
                    device.find_element_by_resource_id(
                        "com.instagram.android:id/business_conversion_entry"
                    )
                    or device.find_element_by_text("Switch to professional account")
                    or device.find_element_by_text("Switch to professional")
                )
                if not switch_btn:
                    await device.swipe(540, 1950, 540, 980, duration_ms=220, wait_after=220)
                    await device.get_screen()
                    switch_btn = (
                        device.find_element_by_resource_id(
                            "com.instagram.android:id/business_conversion_entry"
                        )
                        or device.find_element_by_text("Switch to professional account")
                        or device.find_element_by_text("Switch to professional")
                    )

                if switch_btn:
                    await device.tap(switch_btn[0], switch_btn[1], wait_after=1040)
                else:
                    await device.tap(540, 1980, wait_after=1040)

                await _tap_any(
                    ["Next", "Continue", "Get started"],
                    fallback=(540, 2247),
                    wait_after=880,
                )

                await device.get_screen()
                lower = (device.current_screen or "").lower()
                if (
                    "category" in lower
                    or "describes you" in lower
                    or "search_edit_text" in lower
                ):
                    search = (
                        device.find_element_by_resource_id(
                            "com.instagram.android:id/search_edit_text"
                        )
                        or device.find_element_by_class("android.widget.EditText")
                    )
                    if search:
                        await device.tap(search[0], search[1], wait_after=140)
                        await device.select_all_and_delete()
                        await device.input_text(professional_category)
                        await device.wait(400)

                    category_row = device.find_element_by_text(professional_category)
                    if category_row:
                        await device.tap(category_row[0], category_row[1], wait_after=280)
                    else:
                        await device.tap(540, 983, wait_after=280)

                    await _tap_any(
                        ["Switch to professional account", "Switch", "Next", "Continue"],
                        fallback=(540, 2149),
                        wait_after=1200,
                    )

                await device.get_screen()
                lower = (device.current_screen or "").lower()
                if "creator" in lower or "business" in lower:
                    if account_type == "creator":
                        await _tap_any(["Creator"], fallback=(954, 695), wait_after=280)
                    else:
                        await _tap_any(["Business"], fallback=(954, 1013), wait_after=280)
                    await _tap_any(
                        ["Next", "Continue"], fallback=(540, 2247), wait_after=880
                    )

                await _tap_any(["Next", "Continue"], fallback=(540, 2247), wait_after=720)
                await _tap_any(
                    [
                        "Don't use my contact info",
                        "Don’t use my contact info",
                        "Skip",
                        "Not now",
                        "Not Now",
                    ],
                    fallback=(540, 2292),
                    wait_after=880,
                )
                await _tap_any(
                    ["Skip", "Not now", "Not Now"],
                    fallback=(540, 2253),
                    wait_after=1040,
                )
                await _tap_any(
                    ["Close", "Done", "Got it"],
                    fallback=(73, 201),
                    wait_after=480,
                )

                await device.get_screen()
                lower = (device.current_screen or "").lower()
                professional_ok = (
                    "professional dashboard" in lower
                    or "professional tools" in lower
                    or "insights" in lower
                    or "creator tools" in lower
                )
            else:
                await device.send_log(
                    "[WARN] Could not return to Edit Profile form for professional switch"
                )

            results["switch_to_professional"] = professional_ok
            if professional_ok:
                await device.send_log("[OK] Switched to professional account")
            else:
                await device.send_log(
                    "[WARN] Professional switch flow completed with uncertain result"
                )
            step += step_increment

        # Final save on Edit Profile screen (only for form-field edits).
        if any(results.get(k) is not None for k in ("name", "username", "bio", "link")):
            await device.send_progress(90, "Saving profile changes...")
            await device.get_screen()
            save_btn = (
                device.find_element_by_resource_id(
                    "com.instagram.android:id/action_bar_button_action"
                )
                or device.find_element_by_content_description("Done")
                or device.find_element_by_text("Done")
                or device.find_element_by_content_description("Save")
            )
            if save_btn:
                await device.tap(save_btn[0], save_btn[1], wait_after=360)
            elif await _on_edit_profile_form_surface():
                await device.send_log(
                    "[INFO] No explicit Done button found; exiting Edit Profile to apply changes..."
                )
                await device.back()
                await device.wait(280)
        successes = sum(1 for v in results.values() if v is True)
        await device.send_progress(
            100, f"Profile updated! {successes} field(s) changed"
        )
        await device.send_log(
            f"✅ Edit profile complete: {successes}/{total_fields} fields updated"
        )

        return {
            "success": successes > 0,
            "data": {
                "message": f"Edit profile complete: {successes}/{total_fields} fields updated",
                "results": results,
                "fields_updated": successes,
                "fields_attempted": total_fields,
            },
        }

    except Exception as e:
        return {"success": False, "error": f"Edit profile failed: {str(e)}"}


# ==================== DROIDRUN PORTAL BRIDGE WS HANDLERS ====================


def _droidrun_content_uri(endpoint: str) -> str:
    """Build a Droidrun Portal content provider URI from a short endpoint."""
    value = str(endpoint or "").strip()
    if value.startswith("content://"):
        return value
    return f"content://com.droidrun.portal/{value.lstrip('/')}"


def _adb_escape(value: str) -> str:
    """Escape a string for safe double-quoted ADB shell argument usage."""
    return str(value or "").replace("\\", "\\\\").replace('"', '\\"')


def _extract_content_field(raw: str, field: str) -> str:
    """Extract a field value from Android `content query` output."""
    marker = f"{field}="
    idx = raw.find(marker)
    if idx < 0:
        return ""

    tail = raw[idx + len(marker) :].strip()
    if not tail:
        return ""

    if tail.startswith("{"):
        # Preserve JSON blobs as-is.
        return tail

    # Typical format uses whitespace separators between key=value tokens.
    return tail.split()[0].strip()


def _extract_portal_token(raw: str) -> str:
    """Extract auth token from Droidrun Portal content output."""
    for key in ("auth_token", "token", "result"):
        value = _extract_content_field(raw, key)
        if value:
            return value
    return ""


def _mask_token(token: str) -> str:
    """Mask a token so logs/UI can show that one exists without leaking it."""
    if not token:
        return ""
    if len(token) <= 10:
        return "***"
    return f"{token[:6]}...{token[-4:]}"


def _coerce_bool(value, default: bool) -> bool:
    """Best-effort boolean parser for module config values."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in ("true", "1", "yes", "y", "on"):
            return True
        if normalized in ("false", "0", "no", "n", "off"):
            return False
    return default


async def _droidrun_content_query(device: RemoteDevice, endpoint: str) -> str:
    """Run a Droidrun Portal content query through the current device shell."""
    uri = _droidrun_content_uri(endpoint)
    return await device.shell(f'content query --uri "{uri}" 2>/dev/null || true')


async def execute_droidrun_portal_ping_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """Checks whether Droidrun Portal content provider is reachable on this phone."""
    await device.send_progress(10, "Pinging Droidrun Portal...")
    raw = await _droidrun_content_query(device, "ping")
    lowered = (raw or "").lower()
    ok = any(marker in lowered for marker in ("success", "pong", "ok"))

    await device.send_progress(100, "Portal ping complete")
    if ok:
        await device.send_log("✅ Droidrun Portal is reachable")
        return {"success": True, "data": {"reachable": True, "raw": raw}}

    await device.send_log("❌ Droidrun Portal did not respond as expected", "ERROR")
    return {
        "success": False,
        "error": "Droidrun Portal is not reachable. Install/open portal app and enable accessibility.",
        "data": {"reachable": False, "raw": raw},
    }


async def execute_droidrun_portal_auth_token_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """Reads the local Droidrun Portal auth token for HTTP/WS local API usage."""
    return_full = bool(config.get("return_full_token", False))

    await device.send_progress(20, "Reading Droidrun local auth token...")
    raw = await _droidrun_content_query(device, "auth_token")
    token = _extract_portal_token(raw)
    if not token:
        await device.send_log("❌ Could not read Droidrun auth token", "ERROR")
        return {
            "success": False,
            "error": "No Droidrun auth token returned from device.",
            "data": {"raw": raw},
        }

    masked = _mask_token(token)
    await device.send_log(f"✅ Droidrun auth token detected ({masked})")
    await device.send_progress(100, "Token read complete")

    data = {"token_masked": masked, "raw": raw}
    if return_full:
        data["token"] = token
    return {"success": True, "data": data}


async def execute_droidrun_shadowphone_bootstrap_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """ShadowPhone-tailored Droidrun bootstrap: ping, reverse config, local API, token+state verification."""
    enabled = _coerce_bool(config.get("enabled", True), True)
    local_api_enabled = _coerce_bool(config.get("local_api_enabled", True), True)
    url = str(
        config.get("reverse_url")
        or os.getenv("SHADOWPHONE_DROIDRUN_REVERSE_URL")
        or "wss://api.mobilerun.ai/v1/providers/personal/join"
    ).strip()
    token = str(config.get("token") or "").strip()
    service_key = str(config.get("service_key") or "").strip()
    verify_endpoint = str(config.get("verify_endpoint") or "state_full").strip() or "state_full"
    ws_port = int(config.get("ws_port", 8081) or 8081)
    http_port = int(config.get("http_port", 8080) or 8080)

    await device.send_progress(8, "ShadowPhone bootstrap: pinging Droidrun portal...")
    ping_raw = await _droidrun_content_query(device, "ping")

    binds = [
        f'--bind url:s:"{_adb_escape(url)}"',
        f'--bind enabled:b:{"true" if enabled else "false"}',
    ]
    if token:
        binds.append(f'--bind token:s:"{_adb_escape(token)}"')
    if service_key:
        binds.append(f'--bind service_key:s:"{_adb_escape(service_key)}"')

    await device.send_progress(30, "Configuring Droidrun reverse connection...")
    reverse_raw = await device.shell(
        "content insert --uri content://com.droidrun.portal/configure_reverse_connection "
        + " ".join(binds)
        + " 2>/dev/null || true"
    )

    await device.send_progress(52, "Configuring local Droidrun API...")
    socket_raw = await device.shell(
        f"content insert --uri content://com.droidrun.portal/socket_port --bind port:i:{http_port} 2>/dev/null || true"
    )
    ws_raw = await device.shell(
        "content insert --uri content://com.droidrun.portal/toggle_websocket_server "
        f'--bind enabled:b:{"true" if local_api_enabled else "false"} --bind port:i:{ws_port} 2>/dev/null || true'
    )

    await device.send_progress(74, "Reading auth token and portal state...")
    auth_raw = await _droidrun_content_query(device, "auth_token")
    auth_token = _extract_portal_token(auth_raw)
    state_raw = await _droidrun_content_query(device, verify_endpoint)
    state_result = _extract_content_field(state_raw, "result")
    state_json = None
    if state_result.startswith("{") and state_result.endswith("}"):
        try:
            state_json = json.loads(state_result)
        except Exception:
            state_json = None

    await device.send_progress(100, "ShadowPhone Droidrun bootstrap complete")
    await device.send_log("✅ Droidrun bridge configured for ShadowPhone")

    result_data = {
        "ping_raw": ping_raw,
        "reverse_raw": reverse_raw,
        "socket_raw": socket_raw,
        "ws_raw": ws_raw,
        "auth_token_masked": _mask_token(auth_token),
        "verify_endpoint": verify_endpoint,
        "state_raw": state_raw,
        "state_result": state_json if state_json is not None else state_result,
        "enabled": enabled,
        "local_api_enabled": local_api_enabled,
        "url": url,
        "http_port": http_port,
        "ws_port": ws_port,
    }
    bootstrap_ready = bool(auth_token) and bool(state_result or state_json)
    if bootstrap_ready:
        bootstrap_result = type("DroidrunBootstrapResult", (), {
            "ok": True,
            "screen_type": "droidrun_bootstrap_ready",
            "confidence": "high",
            "context_label": f"Droidrun bootstrap runtime check via auth_token + {verify_endpoint} content query",
        })()
        result_data = _append_verified_postcondition(
            result_data,
            "bootstrap.droidrun_ready",
            "Droidrun bootstrap ready",
            bootstrap_result,
        )

    return {
        "success": True,
        "data": result_data,
    }


async def execute_droidrun_portal_state_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """Reads full/partial Portal state payload from content provider."""
    endpoint = str(config.get("endpoint") or "state_full").strip()
    if not endpoint:
        endpoint = "state_full"

    await device.send_progress(20, f"Reading Droidrun endpoint: {endpoint}...")
    raw = await _droidrun_content_query(device, endpoint)
    result_value = _extract_content_field(raw, "result")
    parsed = None
    if result_value.startswith("{") and result_value.endswith("}"):
        try:
            parsed = json.loads(result_value)
        except Exception:
            parsed = None

    await device.send_progress(100, "Portal state fetched")
    await device.send_log("✅ Droidrun portal state query complete")
    return {
        "success": bool(raw and raw.strip()),
        "data": {
            "endpoint": endpoint,
            "raw": raw,
            "result": parsed if parsed is not None else result_value,
        },
    }


async def execute_droidrun_portal_configure_reverse_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """Configures Droidrun Portal reverse WebSocket connection on device."""
    url = str(
        config.get("url") or "wss://api.mobilerun.ai/v1/providers/personal/join"
    ).strip()
    token = str(config.get("token") or "").strip()
    service_key = str(config.get("service_key") or "").strip()
    enabled = bool(config.get("enabled", True))

    if not url:
        return {"success": False, "error": "config.url is required"}

    binds = [
        f'--bind url:s:"{_adb_escape(url)}"',
        f'--bind enabled:b:{"true" if enabled else "false"}',
    ]
    if token:
        binds.append(f'--bind token:s:"{_adb_escape(token)}"')
    if service_key:
        binds.append(f'--bind service_key:s:"{_adb_escape(service_key)}"')

    cmd = (
        "content insert --uri content://com.droidrun.portal/configure_reverse_connection "
        + " ".join(binds)
        + " 2>/dev/null || true"
    )

    await device.send_progress(30, "Configuring Droidrun reverse connection...")
    raw = await device.shell(cmd)
    await device.send_progress(75, "Verifying connection state...")
    state_raw = await _droidrun_content_query(device, "state")

    await device.send_progress(100, "Droidrun reverse connection configured")
    await device.send_log("✅ Droidrun reverse connection command sent")
    return {
        "success": True,
        "data": {
            "url": url,
            "enabled": enabled,
            "has_token": bool(token),
            "has_service_key": bool(service_key),
            "configure_raw": raw,
            "state_raw": state_raw,
        },
    }


async def execute_droidrun_portal_enable_local_api_ws(
    device: RemoteDevice, config: dict, profile_id: str
) -> dict:
    """Enables local Droidrun HTTP+WebSocket servers on configurable ports."""
    ws_port = int(config.get("ws_port", 8081) or 8081)
    http_port = int(config.get("http_port", 8080) or 8080)
    enabled = bool(config.get("enabled", True))

    await device.send_progress(25, "Configuring Droidrun local socket port...")
    socket_raw = await device.shell(
        f"content insert --uri content://com.droidrun.portal/socket_port --bind port:i:{http_port} 2>/dev/null || true"
    )
    await device.send_progress(60, "Toggling Droidrun local WebSocket server...")
    ws_raw = await device.shell(
        "content insert --uri content://com.droidrun.portal/toggle_websocket_server "
        f'--bind enabled:b:{"true" if enabled else "false"} --bind port:i:{ws_port} 2>/dev/null || true'
    )
    await device.send_progress(100, "Local API configuration complete")
    await device.send_log(
        f"✅ Droidrun local API {'enabled' if enabled else 'disabled'} (http:{http_port}, ws:{ws_port})"
    )

    return {
        "success": True,
        "data": {
            "enabled": enabled,
            "http_port": http_port,
            "ws_port": ws_port,
            "socket_raw": socket_raw,
            "ws_raw": ws_raw,
        },
    }


# ==================== REGISTER ALL REMAINING WS HANDLERS ====================
# This ensures all WebSocket handler functions are available for dispatch.
#
# IMPORTANT: keys present in lib/ws_module_adapter.WS_ADAPTED_MODULES MUST NOT
# appear here — they are stripped at the bottom of this file anyway by the
# defensive pop loop, but we don't add them here in the first place so
# git-blame stays honest about which path owns each module.
_safe_register_ws_handlers("final_master_block", lambda: {
        # Adapter-owned modules are omitted here: engagement, post_feed,
        # post_story, follow, story_viewer, repost, ig_login, threads_post,
        # tiktok_post, and twitter_post. Desktop-local modules are also omitted
        # and rejected by validate_ws_module_request before device dispatch.
        "unfollow": execute_unfollow_ws,
        "comment": execute_comment_ws,
        "comments": execute_comment_ws,
        "dm_automation": execute_dm_automation_ws,
        "send_dm": execute_dm_automation_ws,
        "ig_dm": execute_dm_automation_ws,
        "ig_message": execute_dm_automation_ws,
        # Engagement variants (not in adapter)
        "reels_engagement": execute_reels_engagement_ws,
        "feed_engagement": execute_feed_engagement_ws,
        "hashtag_engagement": execute_hashtag_engagement_ws,
        "explore_engagement": execute_explore_engagement_ws,
        # Account management (not in adapter)
        "account_validator": execute_account_validator_ws,
        "validate_current": execute_account_validator_ws,
        "validate_all": execute_validate_all_ws,
        # Profile management utilities
        "profile_rename": execute_profile_rename_ws,
        # Gmail
        "gmail_login": execute_gmail_login_ws,
        # Threads — only `_engage` alias is native; threads_post and
        # threads_engagement go through the adapter
        "threads_engage": execute_threads_engage_ws,
        # TikTok — only `_engage` alias is native
        "tiktok_engage": execute_tiktok_engage_ws,
        # Twitter/X — only `_engage` alias is native
        "twitter_engage": execute_twitter_engage_ws,
        # Content & Sync
        "drive_sync": execute_drive_sync_ws,
        # Droidrun Portal bridge
        "droidrun_shadowphone_bootstrap": execute_droidrun_shadowphone_bootstrap_ws,
        "droidrun_portal_ping": execute_droidrun_portal_ping_ws,
        "droidrun_portal_auth_token": execute_droidrun_portal_auth_token_ws,
        "droidrun_portal_state": execute_droidrun_portal_state_ws,
        "droidrun_portal_configure_reverse": execute_droidrun_portal_configure_reverse_ws,
        "droidrun_portal_enable_local_api": execute_droidrun_portal_enable_local_api_ws,
        # Phone-only IG signup via smspool (2.18.13). Auto-detects fresh-vs-
        # logged-in profile and picks the matching nav path. Default flow for
        # sidebar "+ Create IG Account" button.
        "account_creation_phone": execute_account_creation_phone_ws,
    }
)


# Adapter precedence guard: any key present in WS_ADAPTED_MODULES must NOT
# survive in WS_MODULE_HANDLERS. The native dispatch at server.py:5952 looks
# up the native table first, so leaving an entry here would shadow the
# adapter and silently bypass the lean lib/ws_modules/* path.
#
# Doing this in one place (rather than relying on every .update() block
# above being correct) means a future PR that re-adds a native registration
# by accident still cannot break adapter-first routing. The handler
# functions themselves stay defined as cold fallbacks for legacy callers.
for _adapter_key in WS_ADAPTED_MODULES.keys():
    WS_MODULE_HANDLERS.pop(_adapter_key, None)


# ==================== RUN SERVER ====================


if __name__ == "__main__":
    import uvicorn

    # Bind host: 0.0.0.0 for Railway (cloud), 127.0.0.1 for local Electron
    # spawn (renderer + brain on same machine — no external exposure).
    # Token still required (SHADOWPHONE_API_SECRET) so a malicious local
    # process can't drive the phone even on 127.0.0.1.
    host = os.getenv("BIND_HOST", "0.0.0.0")
    try:
        port = int(os.getenv("PORT", 8000))
    except ValueError:
        print("[Server] invalid PORT, defaulting to 8000", flush=True)
        port = 8000
    print(f"[Server] Starting on {host}:{port} (build {BUILD_VERSION})")
    # WebSocket keepalive tuning. uvicorn defaults: ws_ping_interval=20s,
    # ws_ping_timeout=20s. Engagement / story_viewer modules have natural
    # silence windows much longer than 20s — humanized scroll delays, IG
    # feed loads under throttling, ad-recovery paths, screen-dump retries.
    # Result on Mac (where App Nap / network throttling adds extra stalls):
    # uvicorn closes the WS with code 1011 "keepalive ping timeout" mid-run,
    # the schedule reports "Automation WebSocket disconnected", and the run
    # fails even though the brain was still healthy.
    # 60s/120s gives ~3 minutes of stall tolerance — wider than any real
    # operation should take, but tight enough that a truly dead brain still
    # gets surfaced. App-level heartbeat in ws-module-client.js (12s ping,
    # 45s stale threshold) is the faster watchdog for that case.
    uvicorn.run(
        app,
        host=host,
        port=port,
        ws_ping_interval=60.0,
        ws_ping_timeout=120.0,
    )
