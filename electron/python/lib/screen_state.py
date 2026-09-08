"""
Shared screen observation and XML screen-state primitives for desktop automation.

Design goals for this first slice:
- production-safe and dependency-light
- no automation behavior changes
- reusable by RemoteDevice and modules later
- replace ad hoc XML regex with a parsed/indexed model over time
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple
import re
import xml.etree.ElementTree as ET


Bounds = Tuple[int, int, int, int]
Point = Tuple[int, int]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class ScreenNode:
    index: int
    tag: str
    resource_id: str = ""
    text: str = ""
    content_desc: str = ""
    class_name: str = ""
    package: str = ""
    clickable: bool = False
    enabled: bool = False
    bounds: Optional[Bounds] = None
    center: Optional[Point] = None
    raw_attrib: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ScreenObservation:
    observed_at: str
    device_id: str
    package: Optional[str] = None
    activity: Optional[str] = None
    xml_source: Optional[str] = None
    screenshot_path: Optional[str] = None
    screen_size: Optional[Tuple[int, int]] = None
    text_summary: List[str] = field(default_factory=list)
    element_summary: Dict[str, Any] = field(default_factory=dict)

    def to_summary_dict(self) -> Dict[str, Any]:
        return {
            "observed_at": self.observed_at,
            "device_id": self.device_id,
            "package": self.package,
            "activity": self.activity,
            "has_xml": bool(self.xml_source),
            "xml_length": len(self.xml_source or ""),
            "screenshot_path": self.screenshot_path,
            "screen_size": list(self.screen_size) if self.screen_size else None,
            "text_summary": self.text_summary[:12],
            "element_summary": self.element_summary,
        }


class ParsedScreenState:
    """Parsed/indexed Android XML helper.

    Keeps the first implementation intentionally small and read-only.
    """

    def __init__(self, xml_source: Optional[str]):
        self.xml_source = xml_source or ""
        self.nodes: List[ScreenNode] = []
        self.by_resource_id: Dict[str, List[ScreenNode]] = {}
        self.by_text: Dict[str, List[ScreenNode]] = {}
        self.by_content_desc: Dict[str, List[ScreenNode]] = {}
        self.clickable_nodes: List[ScreenNode] = []
        self._parse_error: Optional[str] = None
        if self.xml_source.strip():
            self._parse()

    @property
    def parse_error(self) -> Optional[str]:
        return self._parse_error

    def _parse(self) -> None:
        try:
            root = ET.fromstring(self.xml_source)
        except Exception:
            try:
                sanitized = re.sub(r'&(?!amp;|lt;|gt;|quot;|apos;)', '&amp;', self.xml_source)
                root = ET.fromstring(sanitized)
            except Exception as exc:
                self._parse_error = str(exc)
                return

        idx = 0
        for elem in root.iter():
            attrib = dict(elem.attrib)
            bounds = parse_bounds(attrib.get("bounds"))
            center = bounds_center(bounds) if bounds else None
            node = ScreenNode(
                index=idx,
                tag=elem.tag,
                resource_id=str(attrib.get("resource-id") or ""),
                text=str(attrib.get("text") or ""),
                content_desc=str(attrib.get("content-desc") or ""),
                class_name=str(attrib.get("class") or ""),
                package=str(attrib.get("package") or ""),
                clickable=_as_bool(attrib.get("clickable")),
                enabled=_as_bool(attrib.get("enabled")),
                bounds=bounds,
                center=center,
                raw_attrib=attrib,
            )
            idx += 1
            self.nodes.append(node)
            if node.resource_id:
                self.by_resource_id.setdefault(node.resource_id, []).append(node)
            if node.text:
                self.by_text.setdefault(node.text, []).append(node)
            if node.content_desc:
                self.by_content_desc.setdefault(node.content_desc, []).append(node)
            if node.clickable:
                self.clickable_nodes.append(node)

    def find_by_resource_id(self, resource_id: str, contains: bool = True) -> List[ScreenNode]:
        if not resource_id:
            return []
        if not contains:
            return list(self.by_resource_id.get(resource_id, []))
        needle = resource_id.lower()
        return [node for node in self.nodes if node.resource_id and needle in node.resource_id.lower()]

    def find_by_text(self, text: str, exact: bool = False, case_sensitive: bool = False) -> List[ScreenNode]:
        return self._match_string_field("text", text, exact=exact, case_sensitive=case_sensitive)

    def find_by_content_desc(self, content_desc: str, exact: bool = False, case_sensitive: bool = False) -> List[ScreenNode]:
        return self._match_string_field("content_desc", content_desc, exact=exact, case_sensitive=case_sensitive)

    def find_clickable(self) -> List[ScreenNode]:
        return list(self.clickable_nodes)

    def find_by_bounds_containing_point(self, x: int, y: int) -> List[ScreenNode]:
        matches: List[ScreenNode] = []
        for node in self.nodes:
            if not node.bounds:
                continue
            x1, y1, x2, y2 = node.bounds
            if x1 <= x <= x2 and y1 <= y <= y2:
                matches.append(node)
        return matches

    def text_snippets(self, limit: int = 12) -> List[str]:
        snippets: List[str] = []
        seen = set()
        for node in self.nodes:
            for candidate in (node.text, node.content_desc):
                clean = normalize_whitespace(candidate)
                if clean and clean not in seen:
                    snippets.append(clean)
                    seen.add(clean)
                    if len(snippets) >= limit:
                        return snippets
        return snippets

    def summary(self) -> Dict[str, Any]:
        return {
            "node_count": len(self.nodes),
            "clickable_count": len(self.clickable_nodes),
            "resource_id_count": len(self.by_resource_id),
            "text_count": len(self.by_text),
            "content_desc_count": len(self.by_content_desc),
            "parse_error": self._parse_error,
        }

    def _match_string_field(self, field_name: str, needle: str, exact: bool = False, case_sensitive: bool = False) -> List[ScreenNode]:
        if not needle:
            return []
        matches: List[ScreenNode] = []
        lhs = needle if case_sensitive else needle.lower()
        for node in self.nodes:
            raw = getattr(node, field_name, "") or ""
            rhs = raw if case_sensitive else raw.lower()
            if exact:
                if rhs == lhs:
                    matches.append(node)
            else:
                if lhs in rhs:
                    matches.append(node)
        return matches


def parse_bounds(value: Optional[str]) -> Optional[Bounds]:
    if not value:
        return None
    match = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", value)
    if not match:
        return None
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def bounds_center(bounds: Optional[Bounds]) -> Optional[Point]:
    if not bounds:
        return None
    x1, y1, x2, y2 = bounds
    return ((x1 + x2) // 2, (y1 + y2) // 2)


def normalize_whitespace(value: Optional[str]) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _as_bool(value: Any) -> bool:
    return str(value).lower() == "true"
