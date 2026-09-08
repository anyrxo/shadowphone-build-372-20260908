"""
Lightweight runtime telemetry helpers for desktop automation execution.

Phase 1 goals:
- production-safe
- no behavior changes to automation logic
- emit consistent structured execution events
- easy to expand later for sinks/aggregation

Current behavior:
- creates normalized event dictionaries
- logs them to stdout as compact JSON lines prefixed with [RuntimeTelemetry]
- keeps implementation dependency-free and optional
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional


_RUNTIME_TELEMETRY_PREFIX = "[RuntimeTelemetry]"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_json_default(value: Any) -> str:
    return str(value)


def _compact_observation_summary(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    return {
        "package": value.get("package"),
        "activity": value.get("activity"),
        "screen_size": value.get("screen_size"),
        "xml_length": value.get("xml_length"),
        "text_summary": list(value.get("text_summary") or [])[:6],
        "element_summary": value.get("element_summary"),
    }


def emit_runtime_event(event_type: str, **fields: Any) -> Dict[str, Any]:
    """Build and emit a structured runtime event.

    Returns the event dict so callers can reuse or enrich in tests later.
    """
    event_fields = dict(fields)
    if "screen_observation" in event_fields:
        event_fields["screen_observation"] = _compact_observation_summary(event_fields.get("screen_observation"))

    event: Dict[str, Any] = {
        "event_type": str(event_type),
        "timestamp": _utc_now_iso(),
        **event_fields,
    }
    print(f"{_RUNTIME_TELEMETRY_PREFIX} {json.dumps(event, default=_safe_json_default, separators=(',', ':'))}")
    return event


class RuntimeSpan:
    """Very small timing span helper for module/runtime instrumentation."""

    def __init__(self, event_name: str, **base_fields: Any) -> None:
        self.event_name = event_name
        self.base_fields = dict(base_fields)
        self.started_at = time.perf_counter()
        self.started_event = emit_runtime_event(f"{event_name}.start", **self.base_fields)

    def success(self, **fields: Any) -> Dict[str, Any]:
        duration_ms = round((time.perf_counter() - self.started_at) * 1000, 2)
        return emit_runtime_event(
            f"{self.event_name}.success",
            duration_ms=duration_ms,
            **self.base_fields,
            **fields,
        )

    def failure(self, error: Any, **fields: Any) -> Dict[str, Any]:
        duration_ms = round((time.perf_counter() - self.started_at) * 1000, 2)
        return emit_runtime_event(
            f"{self.event_name}.failure",
            duration_ms=duration_ms,
            error=str(error),
            **self.base_fields,
            **fields,
        )

    def aborted(self, **fields: Any) -> Dict[str, Any]:
        duration_ms = round((time.perf_counter() - self.started_at) * 1000, 2)
        return emit_runtime_event(
            f"{self.event_name}.aborted",
            duration_ms=duration_ms,
            **self.base_fields,
            **fields,
        )
