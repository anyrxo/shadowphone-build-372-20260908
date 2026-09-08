#!/usr/bin/env python3
"""
WebSocket Module Adapter - backwards-compatible facade.

Imports each handler from lib/ws_modules/<name>.py and re-exports them under
their original names. Public API is unchanged — server.py and any other importer
continues to use:

    from lib.ws_module_adapter import WS_ADAPTED_MODULES, execute_adapted_module, WSDeviceAdapter

Handler logic lives in lib/ws_modules/<module_id>.py.
Shared infrastructure (WSDeviceAdapter, helpers, constants) lives in lib/ws_modules_shared.py.

Per-module fault tolerance
--------------------------
Every `lib.ws_modules.<name>` import below is wrapped in a try/except via
`_safe_import`. Before this, a single ImportError (e.g. one module missing a
package in the PyInstaller-frozen brain) would propagate, server.py's
`try: from lib.ws_module_adapter import ...` would set
WS_ADAPTER_AVAILABLE=False, and EVERY adapter-handled module
(engagement, post_feed, …) would fall through to the
"Module '<X>' not yet migrated to WebSocket" error — completely misleading
since the modules ARE migrated; the adapter just failed to load.

Now each import failure is isolated: the broken module gets a stub that
raises a clear error when called, and all the working modules keep working.
Failures are surfaced via WS_ADAPTER_IMPORT_FAILURES so server.py can
include them in error responses + brain.log.
"""

import asyncio
import re as _sanitize_re

from lib.remote_device import ModuleAbortedError


_SENSITIVE_FIELD_FRAGMENTS = (
    "message",
    "caption",
    "bio",
    "name",
    "email",
    "link",
    "url",
    "uri",
    "password",
    "passwd",
    "secret",
    "token",
    "apikey",
    "authorization",
    "cookie",
    "credential",
    "traceback",
    "error",
)

_LOG_EMAIL_RE = _sanitize_re.compile(
    r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b"
)
_LOG_URL_RE = _sanitize_re.compile(r"(?i)\b(?:https?://|www\.)[^\s,\]\[{}<>\"']+")
_LOG_BEARER_RE = _sanitize_re.compile(r"(?i)\bBearer\s+(?P<value>[A-Z0-9._~+/=-]+)")
_LOG_SENSITIVE_KV_RE = _sanitize_re.compile(
    r"(?i)\b(?P<key>[A-Z0-9_]*(?:message|caption|bio|name|email|link|url|uri|"
    r"password|passwd|secret|token|apikey|authorization|cookie|credential)[A-Z0-9_]*)"
    r"\s*(?P<sep>[:=])\s*(?P<value>\"[^\"]*\"|'[^']*'|[^\s,;}\]]+)"
)


def _is_sensitive_field(key) -> bool:
    normalized = "".join(character for character in str(key).casefold() if character.isalnum())
    return any(fragment in normalized for fragment in _SENSITIVE_FIELD_FRAGMENTS)


def _redaction_marker(value) -> str:
    value_type = type(value).__name__
    try:
        length = len(value)
    except TypeError:
        return f"[redacted {value_type}]"
    return f"[redacted {value_type} length={length}]"


def _sanitize_persisted_log_text(value: str) -> str:
    def replace_key_value(match) -> str:
        raw_value = match.group("value")
        unquoted = raw_value[1:-1] if len(raw_value) >= 2 and raw_value[0] == raw_value[-1] and raw_value[0] in "\"'" else raw_value
        normalized_key = match.group("key").casefold()
        value_kind = "email" if "email" in normalized_key else (
            "url" if any(part in normalized_key for part in ("link", "url", "uri")) else "str"
        )
        return (
            f"{match.group('key')}{match.group('sep')}"
            f"[redacted {value_kind} length={len(unquoted)}]"
        )

    text = _LOG_SENSITIVE_KV_RE.sub(replace_key_value, str(value or ""))
    text = _LOG_EMAIL_RE.sub(
        lambda match: f"[redacted email length={len(match.group(0))}]", text
    )
    text = _LOG_URL_RE.sub(
        lambda match: f"[redacted url length={len(match.group(0))}]", text
    )
    return _LOG_BEARER_RE.sub(
        lambda match: f"Bearer [redacted token length={len(match.group('value'))}]",
        text,
    )


def sanitize_module_payload(value, *, field_name=None, persistence_kind=None):
    """Recursively remove private module values before disk or database persistence."""
    if persistence_kind == "log" and isinstance(value, str):
        return _sanitize_persisted_log_text(value)
    if field_name is not None and _is_sensitive_field(field_name):
        return _redaction_marker(value)
    if isinstance(value, dict):
        return {
            key: sanitize_module_payload(
                item,
                field_name=key,
                persistence_kind=persistence_kind,
            )
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple, set)):
        return [
            sanitize_module_payload(item, persistence_kind=persistence_kind)
            for item in value
        ]
    return value


# Failures collected during module import so server.py can surface them in
# error responses + brain.log. Keys are module names ("engagement"), values
# are "<ExceptionType>: <message>".
WS_ADAPTER_IMPORT_FAILURES: dict = {}


# Shared infra. If this fails, every per-module import below will also fail
# (each module imports from ws_modules_shared at its top), so we record one
# clear failure here rather than letting the adapter half-load.
try:
    from lib.ws_modules_shared import (
        WSDeviceAdapter,
        Element,
        _SessionState,
        _jitter,
        _snap_to_feed_post,
        _is_ig_ad_xml,
        _dismiss_ig_popups,
        _handle_ig_media_permission_popup,
        _navigate_to_ig_tab,
        _COMMENT_POOL,
        _post_comment,
        _tap_create_button,
        _tap_next_button,
        _is_story_ad,
        verify_active_profile,
    )
except Exception as _shared_exc:  # pragma: no cover — defensive
    WS_ADAPTER_IMPORT_FAILURES["__shared__"] = f"{type(_shared_exc).__name__}: {_shared_exc}"
    print(f"[ws_module_adapter] CRITICAL: ws_modules_shared failed: {_shared_exc}")
    # Set all names to None so attribute access at least returns a defined
    # value (callers downstream that try to use these will get a clear
    # AttributeError, not a NameError surprise).
    WSDeviceAdapter = None
    Element = None
    _SessionState = None
    _jitter = None
    _snap_to_feed_post = None
    _is_ig_ad_xml = None
    _dismiss_ig_popups = None
    _handle_ig_media_permission_popup = None
    _navigate_to_ig_tab = None
    _COMMENT_POOL = None
    _post_comment = None
    _tap_create_button = None
    _tap_next_button = None
    _is_story_ad = None
    verify_active_profile = None


def _safe_import(module_name: str):
    """Import lib.ws_modules.<module_name>.run with isolated failure handling.

    Returns the real `run` callable on success, or an async stub that raises
    a clear, actionable error when called. The stub ensures one missing
    module doesn't disable the entire WS adapter — only the module that
    actually failed reports its failure.
    """
    try:
        mod = __import__(f"lib.ws_modules.{module_name}", fromlist=["run"])
        run = getattr(mod, "run", None)
        if run is None:
            raise AttributeError(f"lib.ws_modules.{module_name} has no `run`")
        return run
    except Exception as exc:
        err = f"{type(exc).__name__}: {exc}"
        WS_ADAPTER_IMPORT_FAILURES[module_name] = err
        print(f"[ws_module_adapter] FAILED to import lib.ws_modules.{module_name}: {err}")

        async def _missing(*_args, **_kwargs):
            raise RuntimeError(
                f"WS module '{module_name}' failed to load in this brain build: {err}. "
                f"This is a brain packaging bug — please report with brain.log attached."
            )
        return _missing


run_vpn_disconnect = _safe_import("vpn_disconnect")
run_engagement = _safe_import("engagement")
run_post_feed = _safe_import("post_feed")
run_post_story = _safe_import("post_story")
run_follow = _safe_import("follow")
run_ig_login = _safe_import("ig_login")
run_edit_profile = _safe_import("edit_profile")
run_view_stories = _safe_import("view_stories")
run_repost = _safe_import("repost")
run_twitter_launcher = _safe_import("twitter_launcher")
run_twitter_engagement = _safe_import("twitter_engagement")
run_twitter_follow = _safe_import("twitter_follow")
run_twitter_post = _safe_import("twitter_post")
run_tiktok_launcher = _safe_import("tiktok_launcher")
run_tiktok_engagement = _safe_import("tiktok_engagement")
run_tiktok_post = _safe_import("tiktok_post")
run_threads_launcher = _safe_import("threads_launcher")
run_threads_engagement = _safe_import("threads_engagement")
run_threads_post = _safe_import("threads_post")
run_dismiss_popups = _safe_import("dismiss_popups")
run_account_creation = _safe_import("account_creation")
# post_trial_reel was the one that used to crash dict construction via bare
# __import__ calls. Cache it here once so the lambdas below + the explicit
# entries below both reuse the same (safe) reference instead of calling
# __import__ on every invocation.
run_post_trial_reel = _safe_import("post_trial_reel")


async def _run_exact_comment(device, config: dict):
    comments = config.get("comments")
    if (
        not isinstance(comments, list)
        or len(comments) != 1
        or not isinstance(comments[0], str)
        or not comments[0].strip()
    ):
        return {
            "success": False,
            "error": "exactly_one_comment_required",
            "data": {
                "publish_attempted": False,
                "safe_to_retry": True,
            },
        }
    return await run_engagement(
        device,
        {
            **config,
            "count": 1,
            "exact_comment_mode": True,
            "feed_ratio": 1,
            "like_only": False,
            "like_chance": 0,
            "comment_chance": 100,
        },
    )

if WS_ADAPTER_IMPORT_FAILURES:
    print(
        f"[ws_module_adapter] STARTED WITH {len(WS_ADAPTER_IMPORT_FAILURES)} "
        f"import failure(s): {list(WS_ADAPTER_IMPORT_FAILURES.keys())}"
    )


# ==================== MODULE REGISTRY ====================

WS_ADAPTED_MODULES = {
    # VPN
    "vpn_disconnect": run_vpn_disconnect,
    "dismiss_popups": run_dismiss_popups,
    # Instagram Core
    "engagement": run_engagement,
    "ig_engagement": run_engagement,
    "comment": _run_exact_comment,
    # Video/reel posting: canonical flow goes through Profile -> Create New ->
    # Reel (validated live 2026-05-19 against eileenswrld). The old `post_feed`
    # via POST tab still exists for IMAGE posts (POST tab supports images);
    # video content auto-routes through the reel flow because the trial
    # toggle, audio picker, and reel editor only exist on the REEL path.
    "post_feed": lambda device, config: (
        run_post_trial_reel(device, {**config, "trial_mode": False})
        if str(config.get("content_type", "reel")).lower() in ("reel", "video", "")
        else run_post_feed(device, config)
    ),
    "ig_post": lambda device, config: (
        run_post_trial_reel(device, {**config, "trial_mode": False})
        if str(config.get("content_type", "reel")).lower() in ("reel", "video", "")
        else run_post_feed(device, config)
    ),
    "post_reel": lambda device, config: run_post_trial_reel(device, {**config, "trial_mode": False}),
    "ig_reel": lambda device, config: run_post_trial_reel(device, {**config, "trial_mode": False}),
    "post_story": run_post_story,
    "ig_story": run_post_story,
    # Trial reel: Profile -> Create New -> Reel -> Trial toggle -> Got it -> Share.
    #
    # These used to be `__import__("lib.ws_modules.post_trial_reel", fromlist=["run"]).run` —
    # evaluated AT DICT CONSTRUCTION TIME. When the frozen brain failed to
    # bundle the lib.ws_modules package (PyInstaller sometimes skips empty
    # __init__.py files), this raised ModuleNotFoundError → the dict literal
    # blew up → the whole `WS_ADAPTED_MODULES = { ... }` assignment failed
    # → the adapter module never finished loading → server.py caught the
    # outer ImportError → set WS_ADAPTER_AVAILABLE=False → every adapter-
    # handled module (engagement, post_feed, post_story,
    # …) fell through to "Module 'X' is not registered on this brain".
    # _safe_import() makes the lookup defensive: a missing module gets a
    # stub that raises a clear error when called, instead of taking down
    # the adapter at import time.
    "post_trial_reel": run_post_trial_reel,
    "trial_reel": run_post_trial_reel,
    "ig_trial_reel": run_post_trial_reel,
    "follow": run_follow,
    "ig_follow": run_follow,
    "ig_login": run_ig_login,
    "edit_profile": run_edit_profile,
    "ig_edit_profile": run_edit_profile,
    # Lean account-creation flow (replaces server.py's 1700-line
    # execute_account_creation_ws when local brain is up). Uses inbox-
    # snippet code retrieval + content-desc lookups for ~30-50% wall-clock
    # reduction. Falls back to the legacy path on Railway brain.
    "account_creation": run_account_creation,
    # Instagram Extended
    "view_stories": run_view_stories,
    "ig_view_stories": run_view_stories,
    "story_viewer": run_view_stories,
    "repost": run_repost,
    "ig_repost": run_repost,
    # Twitter/X
    "twitter_launcher": run_twitter_launcher,
    "x_launcher": run_twitter_launcher,
    "twitter_engagement": run_twitter_engagement,
    "x_engagement": run_twitter_engagement,
    "twitter_follow": run_twitter_follow,
    "x_follow": run_twitter_follow,
    "twitter_post": run_twitter_post,
    "x_post": run_twitter_post,
    "tweet": run_twitter_post,
    # TikTok
    "tiktok_launcher": run_tiktok_launcher,
    "tiktok_engagement": run_tiktok_engagement,
    "tiktok_post": run_tiktok_post,
    # Threads
    "threads_launcher": run_threads_launcher,
    "threads_engagement": run_threads_engagement,
    "threads_post": run_threads_post,
}


def _extract_actions_count(module_id: str, success: bool, data: dict) -> int:
    """Derive a single actions_count int from a module's structured result.

    Module classes:
      - engagement (engagement, ig_engagement, twitter_engagement, tiktok_engagement,
        threads_engagement, view_stories, repost): likes + comments + ads_skipped
        (covers liked/commented + skipped_ads naming variants).
      - post_* (post_feed, post_story, post_trial_reel, ig_post, ig_reel, ig_story,
        twitter_post, tiktok_post, threads_post): 1 on success, 0 on failure.
      - follow / unfollow (follow, ig_follow, twitter_follow): follows_done.
      - fallback: data.actions_count if present, else 0.

    Defensive — missing fields default to 0, never raises.
    """
    try:
        if not isinstance(data, dict):
            return 0
        mid = (module_id or "").lower()

        if mid == "comment":
            return int(data.get("comments", data.get("commented", 0)) or 0)

        # Post-style modules: success == 1 action
        if mid.startswith("post_") or mid in (
            "ig_post", "ig_reel", "ig_story", "twitter_post", "tweet",
            "tiktok_post", "threads_post", "trial_reel", "ig_trial_reel",
        ):
            return 1 if success else 0

        # Follow modules
        if "follow" in mid:
            return int(data.get("follows_done", data.get("followed", 0)) or 0)

        # Engagement modules + view_stories + repost (aggregate engagement-like fields)
        if (
            "engagement" in mid
            or mid in ("view_stories", "ig_view_stories", "story_viewer", "repost", "ig_repost")
        ):
            likes = int(data.get("likes", data.get("liked", 0)) or 0)
            comments = int(data.get("comments", data.get("commented", 0)) or 0)
            ads = int(data.get("ads_skipped", data.get("skipped_ads", 0)) or 0)
            stories = int(data.get("stories_viewed", data.get("viewed", 0)) or 0)
            reposts = int(data.get("reposts", data.get("reposted", 0)) or 0)
            return likes + comments + ads + stories + reposts

        # DM
        if mid in ("send_dm", "ig_dm", "ig_message"):
            return int(data.get("messages_sent", 1 if success else 0) or 0)

        # Fallback
        return int(data.get("actions_count", 0) or 0)
    except Exception:
        return 0


def _telemetry_start(module_id: str, user_id: str, device_id, profile_id, config: dict):
    """Insert a running module_runs row and return its uuid (or None).

    Never raises — a telemetry failure must not block module execution.
    """
    try:
        # Lazy import to avoid boot-time circular deps.
        from server import get_supabase  # type: ignore
    except Exception:
        return None
    try:
        sb = get_supabase()
        if not sb or not user_id or user_id == "anonymous":
            return None
        safe_cfg = sanitize_module_payload(config or {})
        params = {
            "p_user_id": user_id,
            "p_module_id": module_id,
            "p_status": "running",
            "p_config": safe_cfg,
        }
        if profile_id:
            params["p_profile_id"] = str(profile_id)
        res = sb.rpc("log_module_run", params).execute()
        if res and getattr(res, "data", None):
            # log_module_run returns the new uuid directly
            return str(res.data) if not isinstance(res.data, list) else (
                str(res.data[0]) if res.data else None
            )
    except Exception as _tel_e:
        try:
            print(f"[WS] telemetry_start failed for {module_id}: {_tel_e}")
        except Exception:
            pass
    return None


def _telemetry_end(
    run_id, user_id: str, module_id: str, success: bool,
    data: dict, error: str | None,
):
    """Update the running row with the final outcome. Never raises."""
    if not run_id:
        return
    try:
        from server import get_supabase  # type: ignore
    except Exception:
        return
    try:
        sb = get_supabase()
        if not sb:
            return
        actions_count = _extract_actions_count(module_id, success, data if isinstance(data, dict) else {})
        status = "completed" if success else "failed"
        result_payload = sanitize_module_payload(data if isinstance(data, dict) else {})
        error_payload = sanitize_module_payload({"message": error or ""})["message"]
        sb.rpc(
            "update_module_run_outcome",
            {
                "p_run_id": run_id,
                "p_user_id": user_id,
                "p_status": status,
                "p_result": result_payload,
                "p_error_message": error_payload if not success and error else None,
                "p_actions_count": int(actions_count or 0),
            },
        ).execute()
    except Exception as _tel_e:
        try:
            print(f"[WS] telemetry_end failed for {module_id}: {_tel_e}")
        except Exception:
            pass


# --- log-line parsing ----------------------------------------------------
#
# persistent_log writes:   [YYYY-MM-DD HH:MM:SS.mmm] <body>
# Bodies we care about:
#   ERROR: ...              -> ERROR
#   WARN ... / WARNING ...  -> WARN
#   anything else           -> INFO  (progress, START/END, freeform log)
#
# We only ingest ERROR+WARN by default (INFO is too noisy), plus the last
# few lines of any level for tail context around an error.
import re as _re

# Cap the tail we read off-disk so a giant log doesn't blow memory.
_LOG_TAIL_LINES = 200
# Hard cap on rows we ever insert per run.
_LOG_INSERT_CAP = 60
# Tail-context lines (any level) attached for surrounding context.
_LOG_TAIL_CONTEXT = 5

_LOG_LINE_RE = _re.compile(
    r"^\[(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\]\s*(.*)$"
)

# Optional `[run xxxxxxxx] [+1.234s] ` correlation prefix injected by
# persistent_log.RunContext. We strip it from the body that gets stored in
# module_logs.message so the message stays clean — the run_id is already
# carried separately on the run row, and the duration is reconstructible
# from the ISO timestamp + module_runs.started_at.
_RUN_PREFIX_RE = _re.compile(
    r"^\[run\s+([0-9a-f]{6,12})\]\s+\[\+(\d+(?:\.\d+)?)s\]\s*"
)


def _classify_level(body: str) -> str:
    """Map a log-line body to ERROR/WARN/INFO."""
    if not body:
        return "INFO"
    head = body.lstrip()
    # ws_module_adapter and ModuleLogger.error() both prefix with "ERROR:".
    if head.startswith("ERROR:") or head.startswith("ERROR "):
        return "ERROR"
    if head.startswith("WARN:") or head.startswith("WARN ") or head.startswith("WARNING"):
        return "WARN"
    return "INFO"


def _parse_log_line(line: str):
    """Return (timestamp_iso, level, message) or None for unparseable lines.

    Also strips the optional `[run xxxxxxxx] [+1.234s] ` correlation prefix
    from the body — the run_id is already on module_runs and would only
    duplicate noise into module_logs.message.
    """
    line = line.rstrip("\n").rstrip("\r")
    if not line:
        return None
    m = _LOG_LINE_RE.match(line)
    if not m:
        # Unprefixed continuation (tracebacks span multiple lines). Treat as
        # INFO with no timestamp so the caller can decide to drop or attach.
        # Still strip the run-id prefix if it leaked here.
        return (None, "INFO", _RUN_PREFIX_RE.sub("", line))
    ts_raw, body = m.group(1), m.group(2)
    # Strip the [run xxx] [+1.234s] prefix BEFORE classification so level
    # detection (`ERROR:` etc.) keys off the real body.
    body = _RUN_PREFIX_RE.sub("", body)
    # persistent_log writes "YYYY-MM-DD HH:MM:SS.mmm" (no TZ). Normalize to a
    # timestamptz-compatible ISO string. Assume local time; Postgres will
    # cast a naive ISO as the session timezone, which matches the user's
    # machine clock — good enough for support diagnostics.
    ts_iso = ts_raw.replace(" ", "T")
    if not (ts_iso.endswith("Z") or "+" in ts_iso[10:] or "-" in ts_iso[10:]):
        ts_iso = ts_iso + "Z"
    return (ts_iso, _classify_level(body), body)


def _resolve_module_log_path(module_id: str) -> str | None:
    """Mirror ModuleLogger's path resolution so we read the EXACT same file."""
    try:
        # Re-use the resolver from persistent_log so paths stay in sync.
        from lib.persistent_log import _resolve_log_dir  # type: ignore
        log_dir = _resolve_log_dir()
        safe_id = "".join(c if c.isalnum() or c in "_-" else "_" for c in module_id)
        return os.path.join(log_dir, f"{safe_id}.log")
    except Exception:
        return None


def _read_tail_lines(path: str, max_lines: int) -> list[str]:
    """Read the last `max_lines` lines of a file. Cheap for our log sizes."""
    try:
        if not os.path.exists(path):
            return []
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            # Module log files are typically <1MB per run. A full read is
            # simpler and faster than seek-based tailing at this size.
            lines = f.readlines()
        return lines[-max_lines:] if len(lines) > max_lines else lines
    except Exception:
        return []


def _telemetry_flush_logs(run_id, user_id: str, module_id: str) -> None:
    """Batch-insert ERROR/WARN log lines (+tail context) into module_logs.

    Called from execute_adapted_module at run end on the FAILURE path only —
    successful runs skip ingestion entirely to keep the table from bloating
    with happy-path noise. Every supabase call is try/except wrapped; this
    helper MUST NOT raise back into the caller.
    """
    if not run_id or not user_id or user_id == "anonymous":
        return
    try:
        path = _resolve_module_log_path(module_id)
        if not path:
            return
        tail = _read_tail_lines(path, _LOG_TAIL_LINES)
        if not tail:
            return

        parsed: list[tuple[str | None, str, str]] = []
        for raw in tail:
            p = _parse_log_line(raw)
            if p is not None:
                parsed.append(p)
        if not parsed:
            return

        # Keep ERROR/WARN everywhere + last N lines of any level for context.
        keep_idx: set[int] = set()
        for i, (_ts, lvl, _msg) in enumerate(parsed):
            if lvl in ("ERROR", "WARN"):
                keep_idx.add(i)
        if not keep_idx:
            # No errors/warns in tail -- nothing worth shipping.
            return
        for i in range(max(0, len(parsed) - _LOG_TAIL_CONTEXT), len(parsed)):
            keep_idx.add(i)

        # Preserve chronological order.
        rows: list[dict] = []
        for i in sorted(keep_idx):
            ts_iso, lvl, msg = parsed[i]
            # Cap individual message size to keep batch payload reasonable.
            if msg and len(msg) > 2000:
                msg = msg[:2000] + " ...[truncated]"
            row = {
                "run_id": str(run_id),
                "user_id": user_id,
                "level": lvl,
                "message": sanitize_module_payload(
                    msg or "", persistence_kind="log"
                ),
            }
            if ts_iso:
                row["timestamp"] = ts_iso
            rows.append(row)
            if len(rows) >= _LOG_INSERT_CAP:
                break

        if not rows:
            return

        try:
            from server import get_supabase  # type: ignore
        except Exception:
            return
        try:
            sb = get_supabase()
            if not sb:
                return
            sb.table("module_logs").insert(rows).execute()
        except Exception as _ins_e:
            try:
                print(f"[WS] flush_logs insert failed for {module_id}: {_ins_e}")
            except Exception:
                pass
    except Exception as _flush_e:
        # Belt-and-suspenders: anything we missed must NOT bubble up.
        try:
            print(f"[WS] flush_logs unexpected failure for {module_id}: {_flush_e}")
        except Exception:
            pass


async def execute_adapted_module(
    module_id: str,
    remote_device,
    config: dict,
    user_id: str = "anonymous",
    profile_id: str | None = None,
) -> dict:
    """
    Execute a module that has been adapted for WebSocket.

    Centralized logging: every module invocation gets a START line with
    the module id + sanitized config, an END line with the success/data
    shape, and (on exception) a full traceback. Logs land in
    <userData>/logs/<module_id>.log via the shared persistent_log helper.

    Telemetry: ALSO writes a module_runs row at START (status=running) and
    UPDATES it at END (status=completed|failed) so every run gets duration,
    result, error_message, and actions_count. user_id/profile_id are
    optional positional kwargs so legacy callers (no telemetry) still work.
    """
    if module_id not in WS_ADAPTED_MODULES:
        return {
            "success": False,
            "error": f"Module {module_id} not adapted for WebSocket",
        }

    if module_id == "comment" and (
        profile_id is None
        or isinstance(profile_id, bool)
        or (
            isinstance(profile_id, str)
            and profile_id.strip().lower() in ("", "any", "*", "none")
        )
    ):
        return {
            "success": False,
            "error": "concrete_profile_required",
            "data": {
                "requested_profile": profile_id,
                "publish_attempted": False,
                "safe_to_retry": True,
            },
        }

    if module_id in ("repost", "ig_repost"):
        from lib.ws_modules.repost import normalize_repost_config

        try:
            config = normalize_repost_config(
                config,
                tenant_id=user_id,
                device_id=getattr(remote_device, "device_id", None),
                profile_id=profile_id,
            )
        except ValueError as error:
            return {"success": False, "error": str(error)}

    # Lazy-import to avoid breaking modules that import this file at
    # boot before persistent_log is on the path.
    from lib.persistent_log import ModuleLogger as _ModLog, RunContext as _RunCtx
    _adapter_log = _ModLog(module_id)

    # Create adapter
    adapter = WSDeviceAdapter(remote_device)

    _safe_cfg = sanitize_module_payload(config or {})

    # Telemetry: open the module_runs row BEFORE the handler runs so that
    # crashes/timeouts also leave a trace. _telemetry_start swallows all
    # errors; if it returns None we just skip the END update.
    device_id = getattr(remote_device, "device_id", None)
    run_id = _telemetry_start(module_id, user_id, device_id, profile_id, config or {})

    # All log lines from here on carry `[run xxxxxxxx] [+1.234s]` so support
    # can grep one run's chronology from a long log file.
    with _RunCtx(module_id=module_id) as _rc:
        _adapter_log.sync_log(
            f"=== START {module_id} cfg={_safe_cfg} profile={profile_id!r}"
        )

        # ── Pre-flight: profile verification ────────────────────────────
        # Verify the device's foreground Android user matches the profile
        # this run was dispatched for. Mismatch returns immediately and
        # the actual module handler is NEVER invoked.
        dispatch_t0 = _adapter_log.log_step_start("dispatch")
        verification_failure = None
        try:
            ok, cur_id, cur_name, req_id = await verify_active_profile(
                adapter, profile_id
            )
        except Exception as _ve:
            verification_failure = f"{type(_ve).__name__}: {_ve}"
            safe_verification_failure = sanitize_module_payload(
                {"message": verification_failure}
            )["message"]
            _adapter_log.sync_log(
                f"ERROR: verify_active_profile raised {safe_verification_failure} "
                f"-- refusing module dispatch"
            )
            ok, cur_id, cur_name, req_id = False, -1, "", -1

        if not ok:
            failure_code = (
                "profile_verification_failed"
                if verification_failure or cur_id < 0 or req_id < 0
                else "profile_mismatch"
            )
            mismatch_data = {
                "requested_profile": profile_id,
                "requested_profile_id": req_id if req_id >= 0 else None,
                "current_profile_id": cur_id if cur_id >= 0 else None,
                "current_profile_name": cur_name or None,
                "publish_attempted": False,
                "safe_to_retry": True,
            }
            if verification_failure:
                mismatch_data["verification_error"] = verification_failure
            safe_current_name = sanitize_module_payload(
                {"name": cur_name or "unknown"}
            )["name"]
            _adapter_log.sync_log(
                f"ERROR: {failure_code} -- requested={profile_id!r} "
                f"(id={req_id}) but device foreground user is {cur_id} "
                f"({safe_current_name}) -- aborting dispatch"
            )
            _adapter_log.log_step_end("dispatch", success=False, started_at=dispatch_t0)
            try:
                await remote_device.send_log(
                    f"ABORT {module_id}: {failure_code} "
                    f"(want={profile_id}, have={cur_id}/{cur_name or '?'})"
                )
            except Exception:
                pass
            _telemetry_end(
                run_id, user_id, module_id,
                False,
                mismatch_data,
                failure_code,
            )
            _telemetry_flush_logs(run_id, user_id, module_id)
            return {
                "success": False,
                "error": failure_code,
                "data": mismatch_data,
            }

        # Pre-flight passed (or was skipped). Run the actual module.
        try:
            handler = WS_ADAPTED_MODULES[module_id]
            handler_config = config
            if module_id in ("comment", "engagement", "ig_engagement"):
                handler_config = {
                    **config,
                    "_requested_profile_id": profile_id,
                }
            raw = await handler(adapter, handler_config)
        except ModuleAbortedError:
            raise
        except Exception as e:
            import traceback as _tb
            safe_error = sanitize_module_payload({"message": str(e)})["message"]
            _adapter_log.sync_log(
                f"ERROR: {module_id} raised {type(e).__name__}: {safe_error}"
            )
            _adapter_log.log_step_end("dispatch", success=False, started_at=dispatch_t0)
            # Surface the error via WS so the dashboard shows something
            # actionable instead of a silent hang.
            try:
                await remote_device.send_log(
                    f"ERROR in {module_id}: {type(e).__name__}: {e}"
                )
            except Exception:
                pass
            err_str = f"{type(e).__name__}: {e}"
            err_data = {"traceback_tail": _tb.format_exc().splitlines()[-5:]}
            _telemetry_end(run_id, user_id, module_id, False, err_data, err_str)
            # Failure path: ingest the ERROR/WARN tail so support can diagnose
            # remotely without asking the user to attach the log file.
            _telemetry_flush_logs(run_id, user_id, module_id)
            return {
                "success": False,
                "error": err_str,
                "data": err_data,
            }

        # Normalize flat adapter return into the {success, error, data} shape the
        # WS protocol expects. Without this every metric (viewed, ads_skipped,
        # likes, etc.) is dropped because server.py reads result.get("data").
        if not isinstance(raw, dict):
            _adapter_log.sync_log(f"END {module_id}: non-dict return ({type(raw).__name__})")
            _adapter_log.log_step_end("dispatch", success=False, started_at=dispatch_t0)
            _telemetry_end(run_id, user_id, module_id, False, {}, "module returned non-dict")
            _telemetry_flush_logs(run_id, user_id, module_id)
            return {"success": False, "error": "module returned non-dict", "data": {}}
        if "data" in raw and isinstance(raw["data"], dict):
            # already normalized
            _success_n = bool(raw.get("success", True))
            safe_error = sanitize_module_payload(
                {"message": (raw.get("error") or "")[:120]}
            )["message"]
            _adapter_log.sync_log(
                f"END {module_id} success={raw.get('success')} error={safe_error}"
            )
            _adapter_log.log_step_end("dispatch", success=_success_n, started_at=dispatch_t0)
            _telemetry_end(
                run_id, user_id, module_id,
                _success_n,
                raw.get("data") or {},
                raw.get("error"),
            )
            # Only flush log tail on FAILURE — happy-path runs would bloat
            # module_logs with success noise.
            if not _success_n:
                _telemetry_flush_logs(run_id, user_id, module_id)
            return raw
        success = raw.get("success", True)
        error = raw.get("error")
        data = {k: v for k, v in raw.items() if k not in ("success", "error", "data")}
        safe_error = sanitize_module_payload({"message": (error or "")[:120]})["message"]
        _adapter_log.sync_log(
            f"END {module_id} success={success} error={safe_error} "
            f"data_keys={list(data.keys())}"
        )
        _adapter_log.log_step_end("dispatch", success=bool(success), started_at=dispatch_t0)
        _telemetry_end(run_id, user_id, module_id, bool(success), data, error)
        if not bool(success):
            _telemetry_flush_logs(run_id, user_id, module_id)
        return {"success": success, "error": error, "data": data}
