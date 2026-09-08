# Shared persistent-log helper for ws_modules.
#
# Every module that wires this up gets a per-module file at
# <userData>/logs/<module_id>.log with timestamped lines for every
# log/progress event. Files are append-only (never truncated within a
# run) so a user can ship the whole file when something breaks.
#
# Usage:
#     from lib.persistent_log import ModuleLogger
#     LOG = ModuleLogger("post_trial_reel")
#     async def run(device, config):
#         await LOG.log(device, "Starting…")
#         await LOG.progress(device, 20, "Tapping profile tab")
#
# The path resolution prefers the SHADOWPHONE_LOG_DIR env var (set by
# main.js to <userData>/logs/), then falls back to dev/temp paths.

import os
import sys
import time
import uuid
import datetime
import tempfile
import contextvars
from typing import Any, Optional


# Guard: print the first _append() OSError to stderr once per process so the
# user notices a broken logs dir (disk full, permissions change), then go
# silent on every subsequent failure to avoid stderr-spam during a long run.
_APPEND_FAILURE_REPORTED = False


# ── Run correlation context ───────────────────────────────────────────────
#
# All log lines emitted within `with RunContext(run_id, module_id):` get a
# stable `[run xxxxxxxx] [+1.234s]` prefix injected between the ISO timestamp
# and the body. Support engineers can grep a single log file for
# `[run abc12345]` to pull the entire chronology of one dispatch.
#
# Implemented with a contextvars.ContextVar so concurrent module runs in the
# same event loop don't bleed run-ids into each other.
_RUN_CTX: "contextvars.ContextVar[Optional[dict]]" = contextvars.ContextVar(
    "shadowphone_run_ctx", default=None
)


def _current_run_prefix() -> str:
    """Return `[run xxxxxxxx] [+1.234s] ` if a RunContext is active, else ''."""
    ctx = _RUN_CTX.get()
    if not ctx:
        return ""
    try:
        elapsed = max(0.0, time.monotonic() - ctx["start_ts"])
        return f"[run {ctx['run_id']}] [+{elapsed:.3f}s] "
    except Exception:
        return ""


def current_run_id() -> Optional[str]:
    """Public accessor: short run id if a RunContext is active, else None."""
    ctx = _RUN_CTX.get()
    return ctx.get("run_id") if ctx else None


class RunContext:
    """Tag every log line in this block with `[run xxxxxxxx] [+1.234s]`.

    Example:
        with RunContext(module_id="engagement") as rc:
            rc.run_id              # 8-char short id, also grep-able in logs
            await LOG.log(...)     # auto-prefixed

    The short run_id is an 8-char prefix of a fresh UUID4 — collisions are
    astronomically unlikely across a single device's log file lifetime.
    """

    __slots__ = ("run_id", "module_id", "start_ts", "_token")

    def __init__(self, module_id: str, run_id: Optional[str] = None):
        self.run_id = (run_id or uuid.uuid4().hex)[:8]
        self.module_id = module_id
        self.start_ts = time.monotonic()
        self._token = None

    def __enter__(self) -> "RunContext":
        self._token = _RUN_CTX.set(
            {
                "run_id": self.run_id,
                "module_id": self.module_id,
                "start_ts": self.start_ts,
            }
        )
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            if self._token is not None:
                _RUN_CTX.reset(self._token)
        except Exception:
            # Last-ditch cleanup if reset() chokes (e.g., wrong context). Set
            # to None so subsequent log lines don't keep prepending stale ids.
            _RUN_CTX.set(None)

    # Convenience for callers that don't want a `with` block (rare).
    def enter(self) -> "RunContext":
        return self.__enter__()

    def exit(self) -> None:
        self.__exit__(None, None, None)


def log_with_run_context(module_id: str, level: str, message: str) -> None:
    """Best-effort fallback for callers that need to log explicitly without
    going through ModuleLogger (e.g., synchronous helpers). Writes to the
    same per-module log file with the active RunContext prefix applied.
    """
    body = f"{level}: {message}" if level and level.upper() != "INFO" else message
    try:
        ModuleLogger(module_id)._append(body)
    except Exception:
        pass


def _resolve_log_dir() -> str:
    """Pick a writable log directory. Tries env -> repo logs/ -> temp."""
    env_dir = os.environ.get("SHADOWPHONE_LOG_DIR", "").strip()
    if env_dir:
        try:
            os.makedirs(env_dir, exist_ok=True)
            return env_dir
        except Exception:
            pass
    try:
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        log_dir = os.path.join(os.path.dirname(here), "logs")
        os.makedirs(log_dir, exist_ok=True)
        return log_dir
    except Exception:
        pass
    return tempfile.gettempdir()


_LOG_DIR = _resolve_log_dir()


class ModuleLogger:
    """One ModuleLogger per ws_module. Append-only persistent log file."""

    def __init__(self, module_id: str):
        safe_id = "".join(c if c.isalnum() or c in "_-" else "_" for c in module_id)
        self.module_id = safe_id
        self.path = os.path.join(_LOG_DIR, f"{safe_id}.log")
        self._announce_path()

    def _announce_path(self) -> None:
        print(f"[{self.module_id}] log file: {self.path}")

    def _append(self, line: str) -> None:
        global _APPEND_FAILURE_REPORTED
        try:
            ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
            # Inject `[run xxxxxxxx] [+1.234s] ` between timestamp and body when
            # a RunContext is active. Body itself stays untouched so existing
            # callers and regex parsers keep working.
            prefix = _current_run_prefix()
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(f"[{ts}] {prefix}{line}\n")
        except OSError as e:
            # Logging must never break the run, but the FIRST failure per
            # process gets one stderr line so unwritable log dirs (disk full,
            # permissions change mid-run) don't go completely unnoticed.
            if not _APPEND_FAILURE_REPORTED:
                _APPEND_FAILURE_REPORTED = True
                try:
                    print(
                        f"[persistent_log] WARN: append failed at {self.path}: "
                        f"{type(e).__name__}: {e} -- silencing further append "
                        f"errors for this process",
                        file=sys.stderr,
                    )
                except Exception:
                    pass
        except Exception:
            # Non-OSError (encoding etc) — stay silent, not a disk-state signal.
            pass

    async def log(self, device: Any, msg: str) -> None:
        """Print + persist + best-effort WS send_log to the renderer."""
        print(f"[{self.module_id}] {msg}")
        self._append(msg)
        try:
            await device.device.send_log(msg)
        except Exception:
            pass

    async def progress(self, device: Any, pct: int, msg: str) -> None:
        """Print + persist + best-effort WS send_progress to the renderer."""
        print(f"[{self.module_id}] [{pct}%] {msg}")
        self._append(f"[{pct}%] {msg}")
        try:
            await device.device.send_progress(pct, msg)
        except Exception:
            pass

    async def error(self, device: Any, msg: str) -> None:
        """Tag errors with a clear marker so they're easy to grep in the log."""
        line = f"ERROR: {msg}"
        print(f"[{self.module_id}] {line}")
        self._append(line)
        try:
            await device.device.send_log(line)
        except Exception:
            pass

    def sync_log(self, msg: str) -> None:
        """For callers that aren't async (e.g. shell helpers)."""
        print(f"[{self.module_id}] {msg}")
        self._append(msg)

    # ── Step bracketing (great for multi-step debugging) ─────────────────
    #
    # Use as a pair around any meaningful sub-phase of a module:
    #     t0 = LOG.log_step_start("dispatch")
    #     ...
    #     LOG.log_step_end("dispatch", success=True, started_at=t0)
    #
    # Produces (with an active RunContext):
    #     [..] [run abc12345] [+0.012s] STEP: dispatch started
    #     [..] [run abc12345] [+1.246s] STEP: dispatch done in 1.234s (ok)
    def log_step_start(self, step_name: str) -> float:
        """Log a step-start line and return the monotonic timestamp so the
        matching log_step_end() can compute exact duration."""
        started_at = time.monotonic()
        self._append(f"STEP: {step_name} started")
        return started_at

    def log_step_end(
        self, step_name: str, success: bool = True, started_at: Optional[float] = None
    ) -> None:
        dur = (time.monotonic() - started_at) if started_at is not None else 0.0
        status = "ok" if success else "fail"
        self._append(f"STEP: {step_name} done in {dur:.3f}s ({status})")
