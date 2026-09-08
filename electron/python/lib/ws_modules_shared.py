#!/usr/bin/env python3
"""
Shared infrastructure for WebSocket module handlers.

Contains: imports, constants, helper classes (_SessionState, Element, WSDeviceAdapter),
and all helper functions used by 2+ module handlers.
"""

import asyncio
import html
import logging
import re
import time
import random
import math
import unicodedata
from typing import Optional, Dict, Any, List, Tuple
from datetime import datetime
from xml.etree import ElementTree

from lib.remote_device import ModuleAbortedError


_log = logging.getLogger("ws_modules_shared")


def normalize_text_for_exact_match(value) -> str:
    text = html.unescape(str(value or ""))
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return unicodedata.normalize("NFKC", text).strip()


def normalized_text_equal(expected, actual) -> bool:
    return normalize_text_for_exact_match(expected) == normalize_text_for_exact_match(actual)


# ══════════════════════════════════════════════════════════════════════
# HUMAN BEHAVIOR ENGINE (ported from old appium human_behavior.py)
# Makes all engagement smooth, realistic, and undetectable.
# ══════════════════════════════════════════════════════════════════════

# Energy curve by hour of day: (energy, speed_modifier, engagement_modifier)
_ENERGY_CURVE = {
    0: (0.3, 0.7, 0.4),
    1: (0.2, 0.6, 0.3),
    2: (0.2, 0.5, 0.2),
    3: (0.2, 0.5, 0.2),
    4: (0.3, 0.6, 0.3),
    5: (0.4, 0.7, 0.4),
    6: (0.5, 0.8, 0.5),
    7: (0.6, 0.85, 0.6),
    8: (0.75, 0.9, 0.7),
    9: (0.85, 0.95, 0.8),
    10: (0.95, 1.0, 0.9),
    11: (1.0, 1.0, 1.0),
    12: (0.9, 0.95, 0.85),
    13: (0.8, 0.9, 0.75),
    14: (0.85, 0.95, 0.8),
    15: (0.9, 1.0, 0.85),
    16: (0.85, 0.95, 0.8),
    17: (0.8, 0.9, 0.75),
    18: (0.75, 0.85, 0.7),
    19: (0.7, 0.8, 0.65),
    20: (0.6, 0.75, 0.6),
    21: (0.5, 0.7, 0.55),
    22: (0.4, 0.65, 0.5),
    23: (0.35, 0.6, 0.45),
}

# View type distribution weights and time ranges (from old engagement_module).
# 2.18.15: time ranges shortened ~40% per Anyro feedback — pre/post engagement
# was too slow; combined with halved default count (10→5) the workflow finishes
# in ~30% of the old time without giving up the variance that keeps it human-ish.
_VIEW_TYPES = {
    "quick_scroll": {"weight": 0.15, "time": (0.3, 0.5)},
    "brief_view": {"weight": 0.35, "time": (0.5, 1.0)},
    "engaged_view": {"weight": 0.35, "time": (1.0, 1.5)},
    "deep_view": {"weight": 0.15, "time": (1.5, 2.5)},
}

# View type like multipliers (from old engagement_module smart_engage_with_ratios)
_VIEW_LIKE_MULTIPLIER = {
    "quick_scroll": 0.0,  # Never like on quick scroll (just scrolling past)
    "brief_view": 0.5,
    "engaged_view": 1.0,
    "deep_view": 1.2,
}

# Scroll patterns (from old human_behavior.py get_scroll_pattern).
# 2.19.8: tightened durations + pauses by ~45% across the board after Anyro
# flagged engagement scrolls and story advances felt sluggish on a Run Now
# test 2026-05-26. "Slow" is still distinguishable from "flick" but the
# whole distribution shifts toward faster — modern IG feed handles quick
# scrolls fine and the human-mimicry randomness still varies per iter.
_SCROLL_PATTERNS = [
    {"speed": "slow",   "duration_ms": 400, "pause": (0.5, 1.5), "weight": 0.15},
    {"speed": "normal", "duration_ms": 280, "pause": (0.3, 1.0), "weight": 0.50},
    {"speed": "fast",   "duration_ms": 200, "pause": (0.2, 0.6), "weight": 0.30},
    {"speed": "flick",  "duration_ms": 130, "pause": (0.15, 0.35), "weight": 0.05},
]

# Mood system (from old human_behavior.py)
_MOOD_WEIGHTS = {"engaged": 0.40, "passive": 0.35, "active": 0.20, "distracted": 0.05}
_MOOD_MODIFIERS = {
    "engaged": {"like_mult": 1.0, "comment_mult": 1.0, "scroll_speed": 1.0},
    "passive": {"like_mult": 0.4, "comment_mult": 0.1, "scroll_speed": 0.8},
    "active": {"like_mult": 1.5, "comment_mult": 1.8, "scroll_speed": 1.2},
    "distracted": {"like_mult": 0.1, "comment_mult": 0.0, "scroll_speed": 1.5},
}


class _SessionState:
    """Tracks fatigue, mood, and energy for a single engagement session."""

    def __init__(self):
        self.fatigue = 0.0
        self.actions = 0
        self.mood = self._pick_mood()
        hour = datetime.now().hour
        base = _ENERGY_CURVE.get(hour, (0.7, 0.8, 0.7))
        self.energy = max(0.2, min(1.0, base[0] + random.uniform(-0.1, 0.1)))
        self.speed_mod = max(0.5, min(1.0, base[1] + random.uniform(-0.05, 0.05)))
        self.engage_mod = max(0.2, min(1.0, base[2] + random.uniform(-0.1, 0.1)))

    @staticmethod
    def _pick_mood() -> str:
        roll, cumul = random.random(), 0.0
        for mood, w in _MOOD_WEIGHTS.items():
            cumul += w
            if roll <= cumul:
                return mood
        return "engaged"

    def add_fatigue(self, action: str = "general"):
        rates = {
            "scroll": 0.002,
            "like": 0.005,
            "comment": 0.015,
            "post": 0.02,
            "story_view": 0.003,
            "general": 0.003,
        }
        self.fatigue = min(0.50, self.fatigue + rates.get(action, 0.003))
        self.actions += 1

    def effective_like_chance(self, base_chance: float, view_type: str) -> float:
        """Apply mood, energy, fatigue, and view-type to raw like chance."""
        m = _MOOD_MODIFIERS.get(self.mood, _MOOD_MODIFIERS["engaged"])
        view_mult = _VIEW_LIKE_MULTIPLIER.get(view_type, 1.0)
        fatigue_penalty = min(0.3, self.fatigue * 0.5)
        return (
            base_chance
            * m["like_mult"]
            * view_mult
            * max(0.3, self.engage_mod - fatigue_penalty)
        )

    def effective_comment_chance(self, base_chance: float, view_type: str) -> float:
        """Comments only happen on engaged/deep views."""
        if view_type in ("quick_scroll", "brief_view"):
            return 0.0
        m = _MOOD_MODIFIERS.get(self.mood, _MOOD_MODIFIERS["engaged"])
        fatigue_penalty = min(0.3, self.fatigue * 0.5)
        return (
            base_chance
            * m["comment_mult"]
            * max(0.2, self.engage_mod - fatigue_penalty)
        )

    def get_scroll_pattern(self) -> dict:
        """Weighted random scroll pattern."""
        roll, cumul = random.random(), 0.0
        for p in _SCROLL_PATTERNS:
            cumul += p["weight"]
            if roll <= cumul:
                return {
                    "duration_ms": p["duration_ms"] + random.randint(-30, 30),
                    "pause": random.uniform(*p["pause"]),
                }
        return {"duration_ms": 250, "pause": random.uniform(0.5, 2.0)}

    def pick_view_type(self) -> str:
        """Pick a random view type using the standard distribution."""
        roll, cumul = random.random(), 0.0
        for vt, info in _VIEW_TYPES.items():
            cumul += info["weight"]
            if roll <= cumul:
                return vt
        return "brief_view"

    def get_view_duration(self, view_type: str) -> float:
        """Get a humanized viewing duration for the given view type."""
        lo, hi = _VIEW_TYPES.get(view_type, _VIEW_TYPES["brief_view"])["time"]
        # Slower when fatigued
        fatigue_stretch = 1 + self.fatigue * 0.5
        return random.uniform(lo, hi) * fatigue_stretch / self.speed_mod

    def micro_pause(self) -> float:
        """Tiny natural pause between rapid actions (50-400ms)."""
        return random.uniform(0.05, 0.4)

    def maybe_distraction(self) -> float:
        """5% chance of 2-4s distraction, 15% chance of 0.5-2s, else 0."""
        r = random.random()
        if r < 0.05:
            return random.uniform(2, 4)
        elif r < 0.20:
            return random.uniform(0.5, 2)
        return 0.0


def _jitter(value: int, jitter_range: int = 30) -> int:
    """Add random jitter to a coordinate (from old engagement_module)."""
    return value + random.randint(-jitter_range, jitter_range)


async def _snap_to_feed_post(device, xml: str) -> bool:
    """Micro-scroll to align the nearest post header to the viewport top.

    Uses the already-refreshed XML (no extra dump) to find row_feed_profile_header
    bounds, then does a tiny scroll to bring the closest header to ~Y=200.
    Returns True if a post was found and snapped to.
    """
    import re as _re

    # Find all row_feed_profile_header bounds in the XML
    # Pattern: resource-id="com.instagram.android:id/row_feed_profile_header" ... bounds="[x1,y1][x2,y2]"
    header_pattern = _re.compile(
        r'resource-id="com\.instagram\.android:id/row_feed_profile_header"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
    )
    headers = []
    for m in header_pattern.finditer(xml):
        y1 = int(m.group(2))
        y2 = int(m.group(4))
        headers.append((y1, y2))

    if not headers:
        return False

    # Ideal: header top should be at Y ~200-400 (just below top nav bar at y=128)
    ideal_y = 250
    # Find closest header to ideal position
    best = min(headers, key=lambda h: abs(h[0] - ideal_y))
    header_y = best[0]

    # If header is already near ideal (within 150px), don't bother snapping
    if abs(header_y - ideal_y) < 150:
        return True

    # If header is below ideal, scroll up to bring it to top
    # If header is above ideal, scroll down (rare, means we overshot)
    if header_y > ideal_y + 150:
        # Scroll up: drag from header_y to ideal_y (slow, 400ms for precision)
        scroll_dist = header_y - ideal_y
        await device.swipe(
            540, header_y, 540, ideal_y, min(400, max(200, scroll_dist // 3))
        )
        await asyncio.sleep(0.3)
    elif header_y < ideal_y - 150:
        # Scroll down: drag from ideal_y to header_y
        scroll_dist = ideal_y - header_y
        await device.swipe(
            540, ideal_y, 540, header_y + 200, min(400, max(200, scroll_dist // 3))
        )
        await asyncio.sleep(0.3)

    return True


def _is_ig_suggested_card_xml(xml: str) -> bool:
    """Detect "Suggested for you" follow-recommendation carousel.

    IG inserts these between real posts on the home feed — a horizontal
    strip of profile cards each with a "Follow" button. Tapping anywhere
    in this carousel would either land on a Follow button (bad: follows
    random suggested accounts) or land on a profile picture (bad:
    navigates away from the feed). Engagement modules must skip these
    the same way they skip ads — swipe past, count, continue.

    Detection signals (any match):
      - resource-id `row_suggested_users_*` / `recycler_view_container_id`
        directly under a "Suggested for you" header
      - text="Suggested for you" + visible Follow buttons on same screen
      - content-desc="Dismiss" appearing inside a recycler row (the X to
        remove a suggested account)
    """
    xml_raw = xml or ""
    xml_lower = xml_raw.lower()
    # Strong signal: explicit resource-id markers IG uses for this carousel.
    rid_markers = [
        "row_suggested_users",
        "suggested_users_recycler",
        "discover_people_card",
        "fbb_suggested_users",
    ]
    if any(m in xml_lower for m in rid_markers):
        return True
    # Header text + multiple Follow buttons on the same screen
    if "suggested for you" in xml_lower:
        follow_count = xml_lower.count('text="follow"') + xml_lower.count('content-desc="follow ')
        if follow_count >= 2:
            return True
    return False


def _is_ig_ad_xml(xml: str) -> bool:
    """Detect sponsored Instagram units from UI XML."""
    xml_raw = xml or ""
    xml_lower = xml_raw.lower()
    sponsor_phrases = [
        "sponsored",
        "paid partnership",
        "paid for by",
        "advertisement",
    ]
    for attr, value in re.findall(
        r'(text|content-desc)="([^"]*)"',
        xml_raw,
        re.IGNORECASE | re.DOTALL,
    ):
        normalized = re.sub(r"\s+", " ", html.unescape(value).strip().lower())
        if normalized == "ad":
            return True
        for phrase in sponsor_phrases:
            if normalized == phrase or normalized.startswith(f"{phrase} ") or f" {phrase} " in f" {normalized} ":
                return True

    markers = [
        'text="sponsored"',
        'content-desc="sponsored"',
        'text="paid partnership"',
        'content-desc="paid partnership"',
        'text="paid for by"',
        'content-desc="paid for by"',
        "sponsored_label",
        "reel_item_sponsored_label_footer_pill",
        "ad_label",
        "ad_header",
        "ad_cta",
        "ad_cta_button",
        "branded_content",
        "paid_partnership",
        "story_item_cta_container",
        "cta_sticker",
    ]
    if any(marker in xml_lower for marker in markers):
        return True
    if re.search(r'text="ad"', xml_raw, re.IGNORECASE):
        return True
    ad_ctas = [
        "shop now", "learn more", "install now", "sign up",
        "book now", "download", "get offer", "order now",
        "apply now", "contact us", "get quote", "subscribe",
        "watch more", "listen now", "send message",
    ]
    return any(
        re.search(rf'(text|content-desc)="[^"]*{re.escape(cta)}[^"]*"', xml_raw, re.IGNORECASE)
        for cta in ad_ctas
    )


class Element:
    """Represents a UI element found on screen"""

    def __init__(
        self,
        bounds: str = None,
        text: str = None,
        resource_id: str = None,
        content_desc: str = None,
        class_name: str = None,
        index: int = 0,
    ):
        self.bounds = bounds
        self.text = text
        self.resource_id = resource_id
        self.content_desc = content_desc
        self.class_name = class_name
        self.index = index

        # Parse bounds to get center coordinates
        self.x1, self.y1, self.x2, self.y2 = 0, 0, 0, 0
        self.center_x, self.center_y = 0, 0

        if bounds:
            self._parse_bounds(bounds)

    def _parse_bounds(self, bounds: str):
        """Parse bounds string like '[0,0][100,100]' to coordinates"""
        match = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds)
        if match:
            self.x1 = int(match.group(1))
            self.y1 = int(match.group(2))
            self.x2 = int(match.group(3))
            self.y2 = int(match.group(4))
            self.center_x = (self.x1 + self.x2) // 2
            self.center_y = (self.y1 + self.y2) // 2

    @property
    def location(self) -> Dict[str, int]:
        return {"x": self.x1, "y": self.y1}

    @property
    def size(self) -> Dict[str, int]:
        return {"width": self.x2 - self.x1, "height": self.y2 - self.y1}


class WSDeviceAdapter:
    """
    Adapts RemoteDevice to provide Appium-like interface

    This class wraps RemoteDevice and provides methods that match
    the Appium WebDriver API, so existing modules can work with
    minimal changes.
    """

    def __init__(self, remote_device):
        """
        Args:
            remote_device: RemoteDevice instance connected via WebSocket
        """
        self.device = remote_device
        self.device_id = remote_device.device_id
        self._screen_xml = None
        self._last_refresh = 0
        self._cache_ttl = 0.5  # Cache XML for 500ms
        self._capture_action_screens = True

    def _mark_screen_stale(self):
        self._last_refresh = 0

    def set_action_screen_capture(self, enabled: bool):
        previous = self._capture_action_screens
        self._capture_action_screens = bool(enabled)
        return previous

    async def _send_action(self, action: str, params: dict):
        if self._capture_action_screens:
            return await self.device.send_command(action, params)
        result = await self.device.send_command(action, params, get_screen=False)
        self._mark_screen_stale()
        return result

    # ==================== SCREEN STATE ====================

    async def refresh_screen(self, force: bool = False):
        """Refresh the cached screen XML.

        Returns the current XML string on success (which may be empty during an
        Android activity transition). Raises RuntimeError when the executor
        explicitly reports a dump failure.
        """
        now = time.time()
        if force or (now - self._last_refresh) > self._cache_ttl:
            result = await self.device.send_command("dump_screen", {})
            if not result.get("success"):
                # dump_screen failed — clear stale XML so callers don't act on it
                # and log the failure once per call (not per retry inside dump_screen).
                err = ""
                if isinstance(result, dict):
                    err = result.get("error") or result.get("message") or ""
                    data = result.get("data")
                    if not err and isinstance(data, dict):
                        err = data.get("error", "") or ""
                try:
                    await self.device.send_log(
                        f"refresh_screen: dump_screen failed (error={err or 'unknown'}); clearing cached XML"
                    )
                except Exception:
                    pass
                self._screen_xml = ""
                self._last_refresh = now
                raise RuntimeError(
                    f"dump_screen failed: {err or 'unknown error'}"
                )
            self._screen_xml = result.get("screen", {}).get("xml") or ""
            self._last_refresh = now
        return self._screen_xml or ""

    @property
    def page_source(self) -> str:
        """Get current screen XML (Appium compatibility)"""
        return self._screen_xml or ""

    # ==================== ELEMENT FINDING ====================

    def _find_in_xml(
        self, attr_name: str, attr_value: str, partial: bool = False
    ) -> Optional[Element]:
        """Find element in XML by attribute.

        Uses a two-pass approach:
        1. Find all XML nodes that contain the target attribute value
        2. Extract bounds from the matching node

        This is robust against attribute ordering and multi-line XML.
        """
        if not self._screen_xml:
            return None

        # Build attribute pattern
        if partial:
            attr_pat = f'{attr_name}="[^"]*{re.escape(attr_value)}[^"]*"'
        else:
            attr_pat = f'{attr_name}="{re.escape(attr_value)}"'

        # Match any XML node (<...>) that has BOTH the attribute AND bounds
        # Use [\s\S] instead of [^>] to handle multi-line XML nodes
        # Two-pass: first find nodes with our attribute, then extract bounds from them
        # Pattern: match a complete XML node that contains our attribute
        node_pattern = (
            r"<node\b[^/]*?"
            + attr_pat
            + r'[^/]*?bounds="(\[[^\]]+\]\[[^\]]+\])"[^/]*?/?>'
        )
        match = re.search(node_pattern, self._screen_xml, re.IGNORECASE | re.DOTALL)

        if not match:
            # Try reverse order (bounds before attribute)
            node_pattern = (
                r'<node\b[^/]*?bounds="(\[[^\]]+\]\[[^\]]+\])"[^/]*?'
                + attr_pat
                + r"[^/]*?/?>"
            )
            match = re.search(node_pattern, self._screen_xml, re.IGNORECASE | re.DOTALL)

        if not match:
            # Fallback: generic tag name (not just <node>), handles any XML tag
            node_pattern = (
                r"<[a-zA-Z][^>]*?"
                + attr_pat
                + r'[^>]*?bounds="(\[[^\]]+\]\[[^\]]+\])"[^>]*?/?>'
            )
            match = re.search(node_pattern, self._screen_xml, re.IGNORECASE | re.DOTALL)
            if not match:
                node_pattern = (
                    r'<[a-zA-Z][^>]*?bounds="(\[[^\]]+\]\[[^\]]+\])"[^>]*?'
                    + attr_pat
                    + r"[^>]*?/?>"
                )
                match = re.search(
                    node_pattern, self._screen_xml, re.IGNORECASE | re.DOTALL
                )

        if match:
            bounds = match.group(1)
            return Element(bounds=bounds, **{attr_name.replace("-", "_"): attr_value})

        return None

    def _find_all_in_xml(
        self, attr_name: str, attr_value: str, partial: bool = False
    ) -> List[Element]:
        """Find all matching elements in XML"""
        if not self._screen_xml:
            return []

        elements = []
        if partial:
            attr_pat = f'{attr_name}="[^"]*{re.escape(attr_value)}[^"]*"'
        else:
            attr_pat = f'{attr_name}="{re.escape(attr_value)}"'

        # Try <node> first (standard uiautomator dump format)
        node_pattern = (
            r"<node\b[^/]*?"
            + attr_pat
            + r'[^/]*?bounds="(\[[^\]]+\]\[[^\]]+\])"[^/]*?/?>'
        )
        matches = list(
            re.finditer(node_pattern, self._screen_xml, re.IGNORECASE | re.DOTALL)
        )

        if not matches:
            # Try reverse order
            node_pattern = (
                r'<node\b[^/]*?bounds="(\[[^\]]+\]\[[^\]]+\])"[^/]*?'
                + attr_pat
                + r"[^/]*?/?>"
            )
            matches = list(
                re.finditer(node_pattern, self._screen_xml, re.IGNORECASE | re.DOTALL)
            )

        if not matches:
            # Fallback: generic tag
            node_pattern = (
                r"<[a-zA-Z][^>]*?"
                + attr_pat
                + r'[^>]*?bounds="(\[[^\]]+\]\[[^\]]+\])"[^>]*?/?>'
            )
            matches = list(
                re.finditer(node_pattern, self._screen_xml, re.IGNORECASE | re.DOTALL)
            )

        for i, match in enumerate(matches):
            bounds = match.group(1)
            elements.append(
                Element(
                    bounds=bounds, index=i, **{attr_name.replace("-", "_"): attr_value}
                )
            )

        return elements

    async def find_element_by_id(self, resource_id: str) -> Optional[Element]:
        """Find element by resource-id (Appium: By.ID)"""
        await self.refresh_screen()
        return self._find_in_xml("resource-id", resource_id)

    async def find_element_by_text(
        self, text: str, partial: bool = False
    ) -> Optional[Element]:
        """Find element by text content"""
        await self.refresh_screen()
        return self._find_in_xml("text", text, partial=partial)

    async def find_element_by_content_desc(
        self, desc: str, partial: bool = False
    ) -> Optional[Element]:
        """Find element by content-desc (accessibility label)"""
        await self.refresh_screen()
        return self._find_in_xml("content-desc", desc, partial=partial)

    async def find_element_by_class(self, class_name: str) -> Optional[Element]:
        """Find element by class name"""
        await self.refresh_screen()
        return self._find_in_xml("class", class_name)

    async def find_element_by_xpath(self, xpath: str) -> Optional[Element]:
        """
        Find element by XPath-like expression

        Supports simplified XPath patterns:
        - //android.widget.TextView[@text='Hello']
        - //*[@resource-id='com.app:id/button']
        - //*[contains(@text, 'partial')]
        """
        await self.refresh_screen()
        if not self._screen_xml:
            return None

        # Parse common XPath patterns
        # Pattern: [@attr='value']
        attr_match = re.search(r"\[@(\w+(?:-\w+)?)='([^']+)'\]", xpath)
        if attr_match:
            attr_name = attr_match.group(1)
            attr_value = attr_match.group(2)
            return self._find_in_xml(attr_name, attr_value)

        # Pattern: [contains(@attr, 'value')]
        contains_match = re.search(
            r"\[contains\(@(\w+(?:-\w+)?),\s*'([^']+)'\)\]", xpath
        )
        if contains_match:
            attr_name = contains_match.group(1)
            attr_value = contains_match.group(2)
            return self._find_in_xml(attr_name, attr_value, partial=True)

        return None

    async def find_elements_by_id(self, resource_id: str) -> List[Element]:
        """Find all elements by resource-id"""
        await self.refresh_screen()
        return self._find_all_in_xml("resource-id", resource_id)

    async def find_elements_by_text(
        self, text: str, partial: bool = False
    ) -> List[Element]:
        """Find all elements by text"""
        await self.refresh_screen()
        return self._find_all_in_xml("text", text, partial=partial)

    async def find_elements_by_class(self, class_name: str) -> List[Element]:
        """Find all elements by class name"""
        await self.refresh_screen()
        return self._find_all_in_xml("class", class_name)

    # ==================== ELEMENT INTERACTIONS ====================

    async def click(self, element: Element):
        """Click/tap on an element with human micro-pause after"""
        result = await self._send_action(
            "tap", {"x": element.center_x, "y": element.center_y}
        )
        self._require_success(result, "tap")
        await asyncio.sleep(random.uniform(0.2, 0.4))

    async def tap(self, x: int, y: int):
        """Tap at coordinates with human micro-pause after"""
        result = await self._send_action("tap", {"x": x, "y": y})
        self._require_success(result, "tap")
        await asyncio.sleep(random.uniform(0.2, 0.4))

    async def tap_element(self, element: Element):
        """Alias for click"""
        await self.click(element)

    async def long_press(self, element: Element, duration: int = 1000):
        """Long press on an element"""
        result = await self._send_action(
            "long_tap",
            {"x": element.center_x, "y": element.center_y, "duration_ms": duration},
        )
        self._require_success(result, "long_tap")

    async def send_keys(self, text: str, typing_mode: str = "instant"):
        """Type text into the currently focused element."""
        if typing_mode not in {"instant", "human"}:
            raise ValueError(f"Unsupported typing mode: {typing_mode}")
        result = await self._send_action(
            "input_text",
            {"text": text, "typing_mode": typing_mode},
        )
        self._require_success(result, "input_text")

    async def clear(self):
        """Clear current text field — select all then delete.

        BUG FIX: the old impl ran `input keyevent --longpress 113 29`, which
        sends CTRL_LEFT (113) and A (29) as TWO SEPARATE keyevents — they do
        NOT combine into Ctrl+A, so keycode 29 just types a literal "a" into
        the field (observed corrupting captions to "a"). Use `input
        keycombination` (Android 11+) for a real Ctrl+A, with a DEL fallback.
        """
        try:
            select_all = await self._send_action(
                "shell",
                {"command": "input keycombination 113 29"},
            )  # real Ctrl+A (select all)
            self._require_success(select_all, "shell")
        except Exception:
            pass
        await asyncio.sleep(0.1)
        deleted = await self._send_action("delete", {})  # KEYCODE_DEL (67)
        self._require_success(deleted, "delete")

    async def pixel_rgb(self, x: int, y: int):
        """Read one screen pixel's (r,g,b) via raw-screencap. Distinguishes the
        IG EDIT vs SHARE screens (identical uiautomator dumps). Retries transient
        screencap failures (~0.1s,0.2s backoff, well under the 30s WS budget);
        malformed data (missing r/g/b) is NOT retried. Returns tuple or None."""
        for attempt in range(3):
            try:
                res = await self.device.send_command(
                    "pixel_at", {"x": int(x), "y": int(y)}, get_screen=False
                )
                data = (res or {}).get("data") or {}
                if "r" in data and "g" in data and "b" in data:
                    return (int(data["r"]), int(data["g"]), int(data["b"]))
                return None  # malformed, not transient
            except Exception as e:
                if attempt < 2:
                    await asyncio.sleep((100 * (2 ** attempt) + random.randint(-20, 20)) / 1000.0)
                    continue
                await self.device.send_log(f"pixel_rgb({x},{y}) failed after 3 tries: {e}")
        return None

    async def is_on_share_screen(self) -> bool:
        """True when IG's image SHARE screen ('New post' + Share button) is the
        VISIBLE screen — detected by the full-width blue Share button at
        (540,2279). The EDIT screen is dark there (its blue Next is at 940,2280).
        Live-calibrated 2026-05-29: share=RGB(74,93,249), edit=RGB(12,16,20)."""
        rgb = await self.pixel_rgb(540, 2279)
        if not rgb:
            return False
        r, g, b = rgb
        return b > 180 and r < 130 and b > r + 90

    # ==================== GESTURES ====================

    async def swipe(
        self, start_x: int, start_y: int, end_x: int, end_y: int, duration: int = 300
    ):
        """Swipe gesture with slight duration jitter for human feel"""
        # Add small jitter to duration (from old engagement_module scroll)
        jittered_duration = max(80, duration + random.randint(-20, 20))
        result = await self._send_action(
            "swipe",
            {
                "x1": start_x,
                "y1": start_y,
                "x2": end_x,
                "y2": end_y,
                "duration_ms": jittered_duration,
            },
        )
        self._require_success(result, "swipe")

    async def scroll_down(self, distance: int = 700):
        """Scroll down on screen"""
        await self.swipe(540, 1500, 540, 1500 - distance, 300)

    async def scroll_up(self, distance: int = 700):
        """Scroll up on screen"""
        await self.swipe(540, 800, 540, 800 + distance, 300)

    # ==================== NAVIGATION ====================

    async def back(self):
        """Press back button"""
        result = await self._send_action("back", {})
        self._require_success(result, "back")

    async def home(self):
        """Press home button"""
        result = await self._send_action("home", {})
        self._require_success(result, "home")

    async def recent_apps(self):
        """Press recent apps button"""
        result = await self._send_action("recents", {})
        self._require_success(result, "recents")

    # ==================== APP MANAGEMENT ====================

    async def launch_app(self, package: str, activity: str = None):
        """Launch an app by package name"""
        if activity:
            result = await self._send_action(
                "launch_activity",
                {"component": f"{package}/{activity}"},
            )
        else:
            result = await self._send_action("launch_app", {"package": package})
        self._require_success(result, "launch_app")
        await asyncio.sleep(2)

    async def activate_app(self, package: str):
        """Bring app to foreground"""
        await self.launch_app(package)

    async def close_app(self, package: str):
        """Force stop an app"""
        result = await self._send_action("force_stop", {"package": package})
        self._require_success(result, "force_stop")

    @property
    async def current_package(self) -> str:
        """Get current foreground package"""
        result = await self.device.send_command(
            "shell",
            {"command": "dumpsys activity activities | grep mResumedActivity"},
            get_screen=False,
        )
        self._require_success(result, "shell")
        data = result.get("data", {}) if isinstance(result, dict) else {}
        output = data.get("output", "") if isinstance(data, dict) else ""
        match = re.search(r"([a-zA-Z0-9_.]+)/[a-zA-Z0-9_.]+", output)
        return match.group(1) if match else ""

    # ==================== SHELL COMMANDS ====================

    async def shell(self, command: str) -> str:
        """Execute shell command on device"""
        result = await self.device.send_command(
            "shell", {"command": command}, get_screen=False
        )
        self._require_success(result, "shell")
        data = result.get("data", {}) if isinstance(result, dict) else {}
        return data.get("output", "") if isinstance(data, dict) else ""

    @staticmethod
    def _require_success(result: dict, action: str) -> dict:
        if isinstance(result, dict) and result.get("aborted"):
            raise ModuleAbortedError(result.get("error") or "Task cancelled by user")
        if not isinstance(result, dict) or not result.get("success"):
            error = result.get("error") if isinstance(result, dict) else "invalid result"
            raise RuntimeError(f"{action} failed: {error or 'unknown error'}")
        return result

    async def push_file(self, local_path: str, remote_path: str):
        """Push file to device"""
        result = await self.device.send_command(
            "push_file", {"local_path": local_path, "remote_path": remote_path}
        )
        self._require_success(result, "push_file")

    async def pull_file(self, remote_path: str, local_path: str):
        """Pull file from device"""
        result = await self.device.send_command(
            "pull_file", {"remote_path": remote_path, "local_path": local_path}
        )
        self._require_success(result, "pull_file")

    # ==================== WAIT HELPERS ====================

    async def wait_for_element(
        self, finder_func, *args, timeout: int = 10, poll: float = 0.3, **kwargs
    ) -> Optional[Element]:
        """Wait for element to appear"""
        start = time.time()
        while time.time() - start < timeout:
            await self.refresh_screen(force=True)
            element = await finder_func(*args, **kwargs)
            if element:
                return element
            await asyncio.sleep(poll)
        return None

    async def wait_for_text(
        self, text: str, timeout: int = 10, partial: bool = False
    ) -> Optional[Element]:
        """Wait for text to appear on screen"""
        return await self.wait_for_element(
            self.find_element_by_text, text, partial=partial, timeout=timeout
        )

    async def wait_for_id(
        self, resource_id: str, timeout: int = 10
    ) -> Optional[Element]:
        """Wait for element with resource-id to appear"""
        return await self.wait_for_element(
            self.find_element_by_id, resource_id, timeout=timeout
        )


# ==================== SHARED INSTAGRAM HELPERS ====================


def _instagram_verification_kind(xml: str) -> Optional[str]:
    source = re.sub(r"<\?.*?\?>", "", xml or "", flags=re.DOTALL)
    try:
        root = ElementTree.fromstring(f"<verification>{source}</verification>")
    except ElementTree.ParseError:
        return None

    labels = []
    navigation_visible = any(
        node.get("selected") == "true"
        and re.search(r"(?:feed|profile|reels|search)_tab$", node.get("resource-id", ""))
        for node in root.iter("node")
    )

    def visit(node, content=False, prompt=False):
        resource_id = node.get("resource-id", "").lower()
        content = content or bool(re.search(
            r"row_feed_|feed_timeline|feed_recycler|comment|caption|profile_header|direct_text|direct_thread|chat_thread|message_text|story.*text|reel.*text",
            resource_id,
        )) or node.get("class") == "android.widget.EditText" or node.get("visible-to-user") == "false"
        if content:
            return
        prompt = prompt or bool(re.search(r"challenge|checkpoint|bloks_container|dialog_container|bottom_sheet_container", resource_id))
        if not navigation_visible or prompt:
            for attribute in ("text", "content-desc"):
                value = node.get(attribute, "").strip().lower().replace("’", "'").replace("‘", "'")
                if value:
                    labels.append(value)
        for child in node:
            visit(child, content, prompt)

    visit(root)
    if any(re.match(r"^(?:(?:take|record|upload) a (?:video )?selfie\b|video selfie verification\b|face verification\b)", label) for label in labels):
        return "selfie"
    if any(re.match(r"^confirm (?:you're|you are) human\b", label) for label in labels):
        return "human"
    if any(marker in label for label in labels for marker in _IG_POPUP_VERIFICATION_MARKERS if "human" not in marker):
        return "verification"
    return None


class InstagramVerificationRequired(RuntimeError):
    def __init__(self, outcome: dict):
        super().__init__("verification_required")
        self.outcome = outcome


async def detect_instagram_verification(
    device: WSDeviceAdapter,
    stage: str,
    xml: Optional[str] = None,
) -> Optional[dict]:
    focus = ""
    try:
        focus = await device.shell(
            "dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -3; "
            "dumpsys activity activities 2>/dev/null | grep -E 'topResumedActivity|mResumedActivity' | head -3; true"
        )
    except Exception:
        pass

    if xml is None:
        try:
            xml = await device.refresh_screen(force=True)
        except Exception:
            xml = device.page_source or ""

    verification_type = _instagram_verification_kind(xml or "")
    if not verification_type and "com.instagram.android" in focus and "challengeactivity" in focus.lower():
        verification_type = "verification"
    if not verification_type:
        return None

    requirement = "a selfie or face check" if verification_type == "selfie" else "human confirmation" if verification_type == "human" else "account verification"
    return {
        "success": False,
        "error": f"verification_required: Instagram requires {requirement}. Complete it manually on the phone or choose another account.",
        "code": "verification_required",
        "data": {
            "stage": stage,
            "activity": (focus or "").strip()[:300] or None,
            "verification_required": True,
            "verification_type": verification_type,
            "reason": f"{verification_type}_verification_required" if verification_type != "verification" else "identity_verification_required",
            "manual_action_required": True,
            "recovery_required": False,
        },
    }


async def raise_if_instagram_verification(
    device: WSDeviceAdapter,
    stage: str,
    xml: Optional[str] = None,
) -> None:
    outcome = await detect_instagram_verification(device, stage, xml)
    if outcome:
        raise InstagramVerificationRequired(outcome)


_IG_POPUP_VERIFICATION_MARKERS = (
    "confirm you're human",
    "confirm you are human",
    "challenge required",
    "confirm it's you",
    "help us confirm",
    "verify your identity",
)
_IG_POPUP_BLOCKER_MARKERS = (
    "action blocked",
    "we restrict certain activity",
    "try again later",
    "too many requests",
    "please wait a few minutes",
    "rate limit",
    "temporarily blocked",
    "feedback_required",
    "account suspended",
)
_IG_POPUP_MODAL_MARKERS = (
    "com.instagram.android:id/dialog_container",
    "com.instagram.android:id/modal_container",
    "com.instagram.android:id/igds_alert_dialog",
    "com.instagram.android:id/igds_headline",
    "com.instagram.android:id/bottom_sheet_container",
)
_IG_POPUP_FEED_PREVIEW_MARKERS = (
    "com.instagram.android:id/feed_preview_keep_watching_backdrop",
    "com.instagram.android:id/feed_preview_keep_watching_button",
)
_IG_POPUP_RATE_MARKERS = (
    "com.instagram.android:id/appirater_title_area",
    "com.instagram.android:id/appirater_cancel_button",
)
_IG_POPUP_PROTECTED = (
    (
        "stale_draft",
        (
            "discard reel",
            "discard post",
            "discard story",
            "discard changes",
            "discard edits",
            "save this as a draft",
        ),
        ("Discard", "Save draft", "Save Draft", "Keep editing"),
    ),
    (
        "cross_post",
        (
            "share to facebook",
            "also share to",
            "add to your story",
            "share to other apps",
        ),
        ("Not Now", "Not now", "Skip", "Cancel"),
    ),
)
_IG_POPUP_BENIGN_OPT_OUTS = (
    (
        "notification_prompt",
        ("turn on notifications", "enable notifications"),
        ("Not Now", "Not now"),
    ),
    (
        "login_save_prompt",
        ("save your login info", "save login info"),
        ("Not Now", "Not now"),
    ),
    (
        "contacts_prompt",
        ("sync your contacts", "connect contacts", "find people to follow"),
        ("Not Now", "Not now", "Skip"),
    ),
    (
        "home_screen_prompt",
        ("add instagram to your home screen",),
        ("Cancel", "Not Now", "Not now"),
    ),
    (
        "sharing_posts_education",
        (
            "sharing posts",
            "your account is public, so anyone can discover your posts",
        ),
        ("OK",),
    ),
)


def _classify_ig_popup(
    xml: str,
    popup_policy: Optional[Dict[str, str]] = None,
) -> Tuple[str, Optional[str]]:
    """Return the popup type and the one exact action a caller authorized."""
    source = xml or ""
    decoded_source = html.unescape(source)
    normalized = (
        decoded_source.lower()
        .replace("\u2019", "'")
        .replace("\u2018", "'")
        .replace("ã¢â‚¬â„¢", "'")
        .replace("ã¢â‚¬ëœ", "'")
    )

    def exact_action(
        scoped_source: str,
        labels: Tuple[str, ...],
    ) -> Optional[str]:
        for label in labels:
            pattern = rf'\b(?:text|content-desc)="{re.escape(label)}"'
            scoped_matches = re.findall(pattern, scoped_source, re.IGNORECASE)
            global_matches = re.findall(pattern, source, re.IGNORECASE)
            if len(scoped_matches) == 1 and len(global_matches) == 1:
                return label
        return None

    if _instagram_verification_kind(source):
        return "verification_required", None
    if any(marker in normalized for marker in _IG_POPUP_BLOCKER_MARKERS):
        return "blocked", None
    if all(marker in normalized for marker in _IG_POPUP_RATE_MARKERS):
        return "rate_instagram", exact_action(source, ("No, thanks",))
    if any(marker in normalized for marker in _IG_POPUP_FEED_PREVIEW_MARKERS):
        return "feed_preview", "back"

    try:
        root = ElementTree.fromstring(source)
    except ElementTree.ParseError:
        return "unknown", None

    modal_sources = []
    for element in root.iter():
        attributes = " ".join(str(value) for value in element.attrib.values()).lower()
        if any(marker in attributes for marker in _IG_POPUP_MODAL_MARKERS):
            modal_sources.append(ElementTree.tostring(element, encoding="unicode"))
    if not modal_sources:
        return "unknown", None

    policy = popup_policy if isinstance(popup_policy, dict) else {}
    for modal_source in modal_sources:
        modal_normalized = html.unescape(modal_source).lower()
        for category, signatures, allowed_actions in _IG_POPUP_PROTECTED:
            if not any(signature in modal_normalized for signature in signatures):
                continue
            requested = policy.get(category)
            if requested not in allowed_actions:
                return category, None
            return category, exact_action(modal_source, (requested,))

    for modal_source in modal_sources:
        modal_normalized = html.unescape(modal_source).lower()
        for category, signatures, safe_actions in _IG_POPUP_BENIGN_OPT_OUTS:
            if any(signature in modal_normalized for signature in signatures):
                return category, exact_action(modal_source, safe_actions)

    return "unknown", None


async def _dismiss_ig_popups(
    device: WSDeviceAdapter,
    max_attempts: int = 3,
    popup_policy: Optional[Dict[str, str]] = None,
):
    """Dismiss only classified Instagram prompts with one exact safe action."""
    dismissed = 0

    for _ in range(max_attempts):
        await device.refresh_screen(force=True)
        await raise_if_instagram_verification(
            device,
            stage="popup_dismissal",
            xml=device.page_source,
        )
        popup_type, action_text = _classify_ig_popup(device.page_source, popup_policy)
        if not action_text:
            break

        if popup_type == "feed_preview" and action_text == "back":
            await device.back()
            dismissed += 1
            await asyncio.sleep(0.3)
            continue

        btn = device._find_in_xml("text", action_text)
        if not btn:
            btn = device._find_in_xml("content-desc", action_text)
        if not btn:
            break

        await device.click(btn)
        dismissed += 1
        await asyncio.sleep(0.3)

    try:
        await device.device.send_log(
            f"_dismiss_ig_popups: dismissed {dismissed} popups"
        )
    except Exception:
        pass

    return dismissed


async def _handle_ig_media_permission_popup(
    device: WSDeviceAdapter, context: str = ""
) -> bool:
    """Handle Android media permission popup (Allow all/Allow) during IG posting."""
    await device.refresh_screen(force=True)
    xml = device.page_source or ""
    xml_lower = xml.lower()

    is_permission_popup = (
        "com.android.permissioncontroller" in xml
        or "com.android.packageinstaller" in xml
        or "permission_allow" in xml_lower
        or ("allow all" in xml_lower and "don't allow" in xml_lower)
        or ("allow all" in xml_lower and "don't allow" in xml_lower)
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
        btn = await device.find_element_by_id(rid)
        if btn:
            try:
                await device.device.send_log(
                    f"ℹ️ Instagram media permission popup detected{ctx} — tapping Allow"
                )
            except Exception:
                pass
            await device.click(btn)
            await asyncio.sleep(0.7)
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
        btn = await device.find_element_by_text(label)
        if not btn:
            btn = await device.find_element_by_content_desc(label)
        if not btn:
            btn = await device.find_element_by_text(label, partial=True)
        if btn:
            try:
                await device.device.send_log(
                    f"ℹ️ Instagram media permission popup detected{ctx} — tapping '{label}'"
                )
            except Exception:
                pass
            await device.click(btn)
            await asyncio.sleep(0.7)
            return True

    return False


async def _navigate_to_ig_tab(device: WSDeviceAdapter, tab: str):
    """Navigate to an Instagram tab using resource ID first, coordinate fallback.
    tab: 'home', 'reels', 'search', 'messages', 'profile'"""
    tab_map = {
        "home": ("com.instagram.android:id/feed_tab", "Home", (108, 2274)),
        "reels": ("com.instagram.android:id/clips_tab", "Reels", (324, 2274)),
        "search": (
            "com.instagram.android:id/search_tab",
            "Search and explore",
            (756, 2274),
        ),
        "messages": ("com.instagram.android:id/direct_tab", "Message", (540, 2274)),
        "profile": ("com.instagram.android:id/profile_tab", "Profile", (972, 2274)),
    }

    resource_id, content_desc, fallback_coord = tab_map.get(tab, tab_map["home"])

    # Strategy 1: Resource ID
    el = await device.find_element_by_id(resource_id)
    if el:
        await device.click(el)
        return True

    # Strategy 2: Content description
    el = await device.find_element_by_content_desc(content_desc)
    if el:
        await device.click(el)
        return True

    # Strategy 3: Coordinate fallback (blind tap — verify after)
    await device.tap(fallback_coord[0], fallback_coord[1])

    # Post-tap verification: confirm IG still foreground + tab marker present
    try:
        await asyncio.sleep(0.4)
        fg_output = await device.shell(
            "dumpsys window | grep mCurrentFocus"
        )
        if "com.instagram.android" not in (fg_output or ""):
            try:
                await device.device.send_log(
                    f"_navigate_to_ig_tab: coord-fallback for '{tab}' lost IG foreground (mCurrentFocus={fg_output.strip() if fg_output else 'empty'})"
                )
            except Exception:
                pass
        else:
            # Look for tab-identifying marker in UI
            tab_markers = {
                "home": ("Search bar", "feed_tab"),
                "reels": ("Reels", "clips_viewer"),
                "search": ("Search", "search_tab"),
                "messages": ("Search", "direct_tab"),
                "profile": ("Edit profile", "Saved"),
            }
            markers = tab_markers.get(tab, ())
            await device.refresh_screen(force=True)
            xml = device.page_source or ""
            if markers and not any(m in xml for m in markers):
                try:
                    await device.device.send_log(
                        f"_navigate_to_ig_tab: coord-fallback for '{tab}' did not land on expected tab (none of {markers} found in UI)"
                    )
                except Exception:
                    pass
    except Exception as e:
        try:
            await device.device.send_log(
                f"_navigate_to_ig_tab: coord-fallback verification raised for '{tab}': {type(e).__name__}: {e}"
            )
        except Exception:
            pass

    return True


_COMMENT_POOL = [
    "fire",
    "so fire",
    "this is fire",
    "straight fire",
    "love this",
    "so good",
    "love it",
    "amazing",
    "incredible",
    "wow",
    "this is everything",
    "perfect",
    "obsessed",
    "iconic",
    "yesss",
    "goals",
    "vibe",
    "mood",
    "need this",
    "slay",
    "sheesh",
    "this made my day",
    "cant stop watching",
    "so good omg",
    "literally perfect",
    "how is this so good",
    "insane",
    "best thing ever",
    "unreal",
    "too good",
    "living for this",
]


def _comment_xml_nodes(xml: str):
    for tag in re.findall(r"<[a-zA-Z][^>]*>", xml or ""):
        attrs = {
            name: html.unescape(value)
            for name, value in re.findall(r'([\w:-]+)="([^"]*)"', tag)
        }
        if attrs:
            yield attrs


def _compose_comment_sheet(xml: str):
    try:
        root = ElementTree.fromstring(xml or "")
    except ElementTree.ParseError:
        return None
    for node in root.iter():
        if node.get("resource-id") != "com.instagram.android:id/bottom_sheet_container":
            continue
        if any(
            child.get("resource-id") == "com.instagram.android:id/title_text_view"
            and child.get("text") == "Comments"
            for child in node.iter()
        ):
            return node
    return None


def _compose_comment_input_node(xml: str):
    sheet = _compose_comment_sheet(xml)
    if sheet is None:
        return None
    candidates = []
    for node in sheet.iter():
        if node.get("class") != "android.widget.ScrollView":
            continue
        text = node.get("text", "")
        hints = [
            child.get("text", "")
            for child in node.iter()
            if child.get("resource-id") == "ig_text"
        ]
        if text or any(
            hint == "What do you think of this?"
            or hint.startswith("Add a comment")
            for hint in hints
        ):
            candidates.append(node)
    return candidates[0] if len(candidates) == 1 else None


def _compose_comment_element(node) -> Element | None:
    if node is None or not node.get("bounds"):
        return None
    return Element(
        bounds=node.get("bounds"),
        text=node.get("text"),
        resource_id=node.get("resource-id"),
        content_desc=node.get("content-desc"),
        class_name=node.get("class"),
    )


def _compose_comment_post_element(xml: str) -> Element | None:
    sheet = _compose_comment_sheet(xml)
    if sheet is None:
        return None
    candidates = [
        node
        for node in sheet.iter()
        if node.get("content-desc") == "Post" and node.get("bounds")
    ]
    return _compose_comment_element(candidates[0]) if len(candidates) == 1 else None


def _comment_draft_matches(xml: str, comment_text: str) -> bool:
    input_ids = {
        "com.instagram.android:id/layout_comment_thread_edittext",
        "com.instagram.android:id/layout_comment_thread_edittext_multiline",
    }
    if any(
        node.get("resource-id") in input_ids
        and node.get("text", "") == comment_text
        for node in _comment_xml_nodes(xml)
    ):
        return True
    compose_input = _compose_comment_input_node(xml)
    return compose_input is not None and compose_input.get("text", "") == comment_text


def _posted_comment_match_count(xml: str, comment_text: str) -> int:
    matches = 0
    for node in _comment_xml_nodes(xml):
        resource_id = node.get("resource-id", "")
        if (
            "comment" not in resource_id
            or "edittext" in resource_id
            or "comment_composer" in resource_id
        ):
            continue
        if node.get("text") == comment_text or node.get("content-desc") == comment_text:
            matches += 1
    return matches


def _comment_sheet_open(xml: str) -> bool:
    return _compose_comment_input_node(xml) is not None or any(
        marker in (xml or "")
        for marker in (
            "com.instagram.android:id/layout_comment_thread_edittext",
            "com.instagram.android:id/layout_comment_thread_edittext_multiline",
            "com.instagram.android:id/comment_composer_parent_updated",
        )
    )


async def _close_comment_sheet(device: WSDeviceAdapter) -> bool:
    for _ in range(2):
        try:
            await device.refresh_screen(force=True)
        except Exception:
            return False
        if not _comment_sheet_open(device.page_source or ""):
            return True
        try:
            await device.back()
        except Exception:
            return False
        await asyncio.sleep(random.uniform(0.2, 0.4))
    try:
        await device.refresh_screen(force=True)
    except Exception:
        return False
    return not _comment_sheet_open(device.page_source or "")


def _comment_post_outcome(state: str, reason: str, *, sheet_closed: bool = False) -> dict:
    post_tap_attempted = state != "pre_tap_failure"
    return {
        "state": state,
        "reason": reason,
        "confirmed": state == "post_tap_confirmed",
        "post_tap_attempted": post_tap_attempted,
        "safe_to_retry": not post_tap_attempted,
        "sheet_closed": sheet_closed,
    }


async def _post_comment(
    device: WSDeviceAdapter,
    mode: str = "feed",
    comment_text: str | None = None,
    requested_profile_id: Any = None,
) -> dict:
    """Post a comment on current post/reel and close the comment sheet.

    Args:
        mode: 'feed' or 'reels' - determines how to close comment sheet afterward.
              In reels: press back ONCE (returns to reel, continue scrolling).
              In feed: press back ONCE (returns to feed post).
    Returns a structured outcome that distinguishes safe pre-tap failures from
    confirmed or uncertain post-tap delivery.
    """
    comment_opened = False
    open_strategy = "none"

    async def _slog(msg: str):
        try:
            await device.device.send_log(msg)
        except Exception:
            pass

    if comment_text is None:
        comment_text = random.choice(_COMMENT_POOL)
    if not isinstance(comment_text, str) or not comment_text:
        await _slog("_post_comment: refusing an empty or invalid comment")
        return _comment_post_outcome("pre_tap_failure", "invalid_comment")

    if mode == "reels":
        # Resource ID first
        comment_btn = await device.find_element_by_id(
            "com.instagram.android:id/comment_button"
        )
        if comment_btn:
            await device.click(comment_btn)
            comment_opened = True
            open_strategy = "reels:resource-id"
    else:
        # Feed comment button
        comment_btn = await device.find_element_by_id(
            "com.instagram.android:id/row_feed_button_comment"
        )
        if comment_btn:
            await device.click(comment_btn)
            comment_opened = True
            open_strategy = "feed:resource-id"

    if not comment_opened:
        await _slog(f"_post_comment: failed to open comment sheet (mode={mode})")
        return _comment_post_outcome(
            "pre_tap_failure", "comment_open_selector_missing"
        )

    await _slog(f"_post_comment: opened comment sheet via {open_strategy}")

    await asyncio.sleep(random.uniform(1.2, 2.0))  # Wait for comment sheet (humanized)

    # --- Locate and focus the comment input field ---
    # Reels comment sheet renders later than feed; retry with a fresh XML dump
    # each attempt before falling back to coordinates.
    # Priority: full resource-id → click-area container → partial content-desc → coords
    input_field = None
    input_strategy = None
    for _attempt in range(3):
        if _attempt > 0:
            await asyncio.sleep(0.8)
            await device.refresh_screen(force=True)
        for input_id in (
            "com.instagram.android:id/layout_comment_thread_edittext",
            "com.instagram.android:id/layout_comment_thread_edittext_multiline",
        ):
            input_field = await device.find_element_by_id(input_id)
            if input_field:
                input_strategy = f"resource-id:{input_id.rsplit(':id/', 1)[-1]}"
                break
        if not input_field:
            input_field = _compose_comment_element(
                _compose_comment_input_node(device.page_source or "")
            )
            if input_field:
                input_strategy = "compose:android.widget.ScrollView"
        if input_field:
            break

    if input_field:
        await device.click(input_field)
    else:
        await _slog(f"_post_comment: exact input selector missing (mode={mode})")
        sheet_closed = await _close_comment_sheet(device)
        return _comment_post_outcome(
            "pre_tap_failure",
            "comment_input_selector_missing",
            sheet_closed=sheet_closed,
        )

    await asyncio.sleep(random.uniform(0.3, 0.6))

    # Verify the comment field is actually focused before typing.
    # Look for: edittext with focused="true", OR the IME (keyboard) being up,
    # OR the post button being visible (only shows when input has content/focus).
    input_focused = False
    try:
        await device.refresh_screen(force=True)
        xml = device.page_source or ""
        if 'layout_comment_thread_edittext' in xml and 'focused="true"' in xml:
            input_focused = True
        elif (
            (compose_input := _compose_comment_input_node(xml)) is not None
            and compose_input.get("focused") == "true"
        ):
            input_focused = True
        elif 'layout_comment_thread_post_button_icon' in xml:
            input_focused = True
        else:
            # Check IME visibility via dumpsys
            ime_out = await device.shell(
                "dumpsys input_method | grep mInputShown"
            )
            if "mInputShown=true" in (ime_out or ""):
                input_focused = True
    except Exception as e:
        await _slog(
            f"_post_comment: input-focus verification raised: {type(e).__name__}: {e}"
        )

    if not input_focused:
        await _slog(
            f"_post_comment: comment input not focused after {input_strategy} (mode={mode}, open={open_strategy}) — aborting"
        )
        sheet_closed = await _close_comment_sheet(device)
        return _comment_post_outcome(
            "pre_tap_failure",
            "comment_input_not_focused",
            sheet_closed=sheet_closed,
        )

    await _slog(f"_post_comment: input focused via {input_strategy}")

    await device.clear()
    await asyncio.sleep(random.uniform(0.2, 0.5))
    try:
        await device.refresh_screen(force=True)
    except Exception:
        sheet_closed = await _close_comment_sheet(device)
        return _comment_post_outcome(
            "pre_tap_failure",
            "comment_baseline_unavailable",
            sheet_closed=sheet_closed,
        )
    baseline_count = _posted_comment_match_count(
        device.page_source or "", comment_text
    )

    # Type comment with a micro-pause before (like thinking of what to write)
    await asyncio.sleep(random.uniform(0.1, 0.4))
    await device.send_keys(comment_text, typing_mode="human")
    await asyncio.sleep(random.uniform(0.35, 0.9))

    try:
        await device.refresh_screen(force=True)
    except Exception:
        sheet_closed = await _close_comment_sheet(device)
        return _comment_post_outcome(
            "pre_tap_failure",
            "comment_draft_unavailable",
            sheet_closed=sheet_closed,
        )
    if not _comment_draft_matches(device.page_source or "", comment_text):
        await _slog("_post_comment: exact draft verification failed; refusing send")
        sheet_closed = await _close_comment_sheet(device)
        return _comment_post_outcome(
            "pre_tap_failure",
            "comment_draft_not_proven",
            sheet_closed=sheet_closed,
        )

    # --- Locate and tap the send/post button ---
    # After text entry the send button appears. Reels and feed share the same
    # resource-id, but Instagram sometimes promotes the clickable click_area
    # wrapper above the icon in the accessibility tree.
    # Priority: icon resource-id → click-area wrapper → content-desc → WARN+coords
    await device.refresh_screen(force=True)
    post_btn = await device.find_element_by_id(
        "com.instagram.android:id/layout_comment_thread_post_button_icon"
    )
    if post_btn:
        post_strategy = "resource-id:layout_comment_thread_post_button_icon"
    else:
        post_btn = await device.find_element_by_id(
            "com.instagram.android:id/layout_comment_thread_post_button_click_area"
        )
        if post_btn:
            post_strategy = "resource-id:layout_comment_thread_post_button_click_area"

    if not post_btn:
        post_btn = _compose_comment_post_element(device.page_source or "")
        if post_btn:
            post_strategy = "compose:content-desc:Post"

    if not post_btn:
        await _slog(f"_post_comment: exact post-button selector missing (mode={mode})")
        sheet_closed = await _close_comment_sheet(device)
        return _comment_post_outcome(
            "pre_tap_failure",
            "comment_post_selector_missing",
            sheet_closed=sheet_closed,
        )

    if requested_profile_id is None or isinstance(requested_profile_id, bool) or (
        isinstance(requested_profile_id, str)
        and requested_profile_id.strip().lower() in ("", "any", "*", "none")
    ):
        sheet_closed = await _close_comment_sheet(device)
        return _comment_post_outcome(
            "pre_tap_failure",
            "concrete_profile_required_before_post",
            sheet_closed=sheet_closed,
        )
    try:
        profile_ok, _current_id, _current_name, _requested_id = (
            await verify_active_profile(device, requested_profile_id)
        )
    except Exception:
        profile_ok = False
    if not profile_ok:
        await _slog("_post_comment: active Android profile changed before Post")
        sheet_closed = await _close_comment_sheet(device)
        return _comment_post_outcome(
            "pre_tap_failure",
            "profile_mismatch_before_post",
            sheet_closed=sheet_closed,
        )

    try:
        await device.click(post_btn)
    except Exception:
        sheet_closed = await _close_comment_sheet(device)
        return _comment_post_outcome(
            "post_tap_uncertain",
            "post_tap_transport_error",
            sheet_closed=sheet_closed,
        )
    await _slog(f"_post_comment: post button tapped via {post_strategy}")
    comment_posted = False
    for _ in range(3):
        await asyncio.sleep(random.uniform(0.5, 0.9))
        try:
            await device.refresh_screen(force=True)
        except Exception:
            continue
        post_xml = device.page_source or ""
        if (
            not _comment_draft_matches(post_xml, comment_text)
            and _posted_comment_match_count(post_xml, comment_text) > baseline_count
        ):
            comment_posted = True
            break

    sheet_closed = await _close_comment_sheet(device)
    if not comment_posted:
        await _slog("_post_comment: no new exact posted-comment node after send")
    if not sheet_closed:
        await _slog("_post_comment: comment sheet did not close")
    if comment_posted:
        return _comment_post_outcome(
            "post_tap_confirmed",
            "posted_comment_proven",
            sheet_closed=sheet_closed,
        )
    return _comment_post_outcome(
        "post_tap_uncertain",
        "posted_comment_not_proven",
        sheet_closed=sheet_closed,
    )


async def _tap_create_button(device: WSDeviceAdapter):
    """Reliably tap the create/new post button (top-left, NOT notifications top-right).

    From ig_ui_map:
      Create (+) button: bounds [0,128][127,275] center=(63, 201)
      Notifications:     resource-id=notification [953,128][1080,275] center=(1016, 201)

    The container resource-id 'action_bar_buttons_container_left' is a layout
    wrapper, NOT the clickable icon itself. Using it returns the container's
    center which can miss the actual + button. Use content-desc instead.
    ALL strategies verify X < 400 to avoid hitting notifications on the right.
    """
    # Strategy 1: content-desc "Create" or "New post" (most reliable)
    for desc in ["Create", "New post"]:
        btn = await device.find_element_by_content_desc(desc)
        if btn and btn.center_x < 400:
            await device.click(btn)
            return True

    # Strategy 2: ADB-VERIFIED coordinate (63, 201) from ig_ui_map
    # Bounds [0,128][127,275] on 1080x2400 screen
    await device.tap(63, 201)
    return True


async def _tap_next_button(device: WSDeviceAdapter, fallback: tuple = (1000, 201)):
    """Tap the Next button - checks which screen we're on to pick correct position.
    FIRST Next (media->edit): TOP-RIGHT (1000, 201)
    SECOND Next (edit->share): could be same position or bottom area
    """
    next_btn = await device.find_element_by_id(
        "com.instagram.android:id/next_button_textview"
    )
    if next_btn:
        await device.click(next_btn)
        return True
    next_btn = await device.find_element_by_text("Next")
    if next_btn:
        await device.click(next_btn)
        return True
    # Fallback: top-right where Next typically is
    await device.tap(*fallback)
    return True


async def _is_story_ad(device: WSDeviceAdapter, force: bool = True) -> bool:
    """Detect if current story is a sponsored ad.

    Reliable markers (verified on Pixel 6 against live IG May 2026):
      - resource-id `reel_item_sponsored_label_footer_pill` (the small "Ad" pill at bottom-left)
      - resource-id `reel_bottom_ad_banner_text` (the full-width ad disclaimer banner)
      - content-desc containing "sponsored story" (accessibility label on the ad header)

    Any one of these is sufficient. Regular stories never expose any of them.

    IG rotates the story-ad markup often, so a single resource-id is not
    enough — when IG ships a build that drops the footer pill, a too-narrow
    detector returns False and the ad gets treated as a normal story. The
    most common real-world failure: tapping the ad's CTA deep-links into the
    advertised app (e.g. TikTok signup). To stay robust we ALSO defer to the
    broader `_is_ig_ad_xml` signal set (the plain "Sponsored" text label, CTA
    button resource-ids, CTA verbs) and match the story-specific CTA sticker
    resource-ids directly.

    Why this matters: on ads, the entire media area is clickable to open the
    sponsor's link, so tapping (900, 1148) to advance opens the ad instead. We
    must detect ads and use a non-tap escape (system back) to skip them safely.
    """
    await device.refresh_screen(force=force)
    xml = device._screen_xml or ""
    if "com.instagram.android:id/reel_item_sponsored_label_footer_pill" in xml:
        return True
    if "com.instagram.android:id/reel_bottom_ad_banner_text" in xml:
        return True
    xml_lower = xml.lower()
    if "sponsored story" in xml_lower:
        return True
    # Story-ad CTA sticker / chin button resource-ids — present on the
    # tappable "Learn More" / "Shop Now" pill that overlays the media.
    story_ad_ids = (
        "story_item_cta_container",
        "cta_sticker",
        "reel_cta",
        "reel_ad_cta",
        "netego_cta",
        "ad_link_text",
    )
    if any(rid in xml_lower for rid in story_ad_ids):
        return True
    # The normal story reply composer always exposes "Send message" and
    # "Send message or reaction". Feed/reel ad detection intentionally treats
    # a standalone Send message CTA as an ad signal, so clear those labels only
    # on the known composer nodes before applying the broader detector.
    def _clear_composer_labels(match):
        tag = match.group(0)
        tag_lower = tag.lower()
        if not any(
            resource_id in tag_lower
            for resource_id in (
                'resource-id="com.instagram.android:id/composer_text"',
                'resource-id="com.instagram.android:id/message_composer_container"',
            )
        ):
            return tag
        return re.sub(
            r'(text|content-desc)="[^"]*"',
            lambda attribute: f'{attribute.group(1)}=""',
            tag,
            flags=re.IGNORECASE,
        )

    story_scoped_xml = re.sub(
        r'<node\b[^<>]*>',
        _clear_composer_labels,
        xml,
        flags=re.IGNORECASE | re.DOTALL,
    )
    # Broader fallback: plain "Sponsored" label, CTA verbs, paid-partnership
    # markers. Shared with feed/reels ad detection so a single IG markup
    # change can't silently disable story-ad skipping.
    if _is_ig_ad_xml(story_scoped_xml):
        return True
    return False


# ══════════════════════════════════════════════════════════════════════
# PROFILE PRE-FLIGHT VERIFICATION
# ══════════════════════════════════════════════════════════════════════
#
# The dispatch layer pins each module run to a specific Android user profile
# (1A121FDF60082H has 25 user profiles, one per IG account). If the wrong
# profile is foreground when a module runs we corrupt data — wrong IG account
# posts, comments on the wrong feed, etc. This helper checks that the
# requested profile matches the device's foreground user BEFORE the module
# handler runs.

# Cached `pm list users` output so a name->id resolution doesn't shell out on
# every dispatch. 30s TTL is long enough for a sequenced run, short enough
# that a fresh profile created on the device shows up quickly.
_PROFILE_LIST_CACHE: dict[str, tuple[float, dict[str, int]]] = {}
_PROFILE_LIST_TTL_S = 30.0
_PROFILE_SHELL_TIMEOUT_S = 1.5
_PROFILE_SHELL_ATTEMPTS = 2
_PROFILE_SHELL_RETRY_DELAY_S = 0.15

_PM_USERS_LINE_RE = re.compile(
    r"UserInfo\{(\d+):([^:}]+):", re.IGNORECASE
)


async def _shell_with_timeout(device: "WSDeviceAdapter", cmd: str, timeout: float) -> str:
    """Run a device shell command with a hard timeout. Returns '' on
    timeout/error so each caller can apply its own safety policy."""
    try:
        return await asyncio.wait_for(device.shell(cmd), timeout=timeout)
    except asyncio.TimeoutError:
        _log.warning("device shell timed out (%.1fs): %s", timeout, cmd)
        return ""
    except Exception as e:
        _log.warning("device shell raised: %s: %s (cmd=%s)", type(e).__name__, e, cmd)
        return ""


async def _read_active_user(device: "WSDeviceAdapter") -> str:
    for attempt in range(_PROFILE_SHELL_ATTEMPTS):
        current = await _shell_with_timeout(
            device, "am get-current-user", _PROFILE_SHELL_TIMEOUT_S
        )
        if (current or "").strip().isdigit():
            return current
        if attempt + 1 < _PROFILE_SHELL_ATTEMPTS:
            await asyncio.sleep(_PROFILE_SHELL_RETRY_DELAY_S)
    return ""


async def _list_device_profiles(device: "WSDeviceAdapter") -> dict[str, int]:
    """Return {profile_name: user_id} parsed from `pm list users`.

    Cached for 30s per device. Empty dict on any failure (caller falls back
    to int parsing of the requested id)."""
    dev_id = getattr(device, "device_id", "") or ""
    cached = _PROFILE_LIST_CACHE.get(dev_id)
    now = time.time()
    if cached and (now - cached[0]) < _PROFILE_LIST_TTL_S:
        return cached[1]

    out = await _shell_with_timeout(
        device, "pm list users", _PROFILE_SHELL_TIMEOUT_S
    )
    mapping: dict[str, int] = {}
    if out:
        for m in _PM_USERS_LINE_RE.finditer(out):
            try:
                uid = int(m.group(1))
                name = (m.group(2) or "").strip()
                if name:
                    mapping[name] = uid
                    # Also key by lowercased name for case-insensitive lookup.
                    mapping[name.lower()] = uid
            except Exception:
                continue
    _PROFILE_LIST_CACHE[dev_id] = (now, mapping)
    return mapping


def _coerce_profile_id(raw: Any) -> Optional[int]:
    """Try to parse `raw` as a numeric Android user id. Returns None if it
    isn't already numeric (caller will resolve via `pm list users`)."""
    if raw is None:
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw
    s = str(raw).strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


async def verify_active_profile(
    device: "WSDeviceAdapter",
    requested_profile_id: Any,
) -> tuple[bool, int, str, int]:
    """Pre-flight check: is the requested Android user profile foreground?

    Args:
        device:               WSDeviceAdapter for the target phone.
        requested_profile_id: Either an int user id (e.g. 35) or a profile
                              name (e.g. "test6"). None/""/"any" skip the
                              check (used by global utility modules).

    Returns:
        (ok, current_id, current_name, requested_id)
          - ok            -- True if requested matches current, or if no
                              concrete check was requested. Concrete profile
                              runs fail closed when the active user is unknown.
          - current_id    -- The Android user id from `am get-current-user`,
                              or -1 if unknown.
          - current_name  -- Profile display name from `pm list users`, or
                              "" if it couldn't be resolved.
          - requested_id  -- The numeric id we resolved the request to, or
                              -1 if the name didn't resolve.

    Never raises — telemetry and dispatch upstream depend on this being safe
    to call from any context.
    """
    # Skip-the-check sentinels: dispatch layer signals "any profile is fine"
    # by passing None, "", "any", "*".
    if requested_profile_id is None or (
        isinstance(requested_profile_id, str)
        and requested_profile_id.strip().lower() in ("", "any", "*", "none")
    ):
        cur_raw = await _read_active_user(device)
        cur_id = -1
        try:
            cur_id = int((cur_raw or "").strip())
        except ValueError:
            pass
        return True, cur_id, "", -1

    # Step 1: read current foreground user id.
    requested_id = _coerce_profile_id(requested_profile_id)
    cur_raw = await _read_active_user(device)
    cur_stripped = (cur_raw or "").strip()
    try:
        current_id = int(cur_stripped)
    except ValueError:
        # A concrete-profile mutation must not run against an unknown user.
        _log.warning(
            "verify_active_profile: am get-current-user returned non-numeric "
            "(%r) on device=%s -- refusing concrete-profile module run",
            cur_raw,
            getattr(device, "device_id", "?"),
        )
        return False, -1, "", requested_id if requested_id is not None else -1

    # Step 2: resolve requested into numeric id (int already, or name lookup).
    profile_map: dict[str, int] = {}
    if requested_id is None:
        # Name lookup via cached `pm list users`.
        profile_map = await _list_device_profiles(device)
        name_key = str(requested_profile_id).strip()
        requested_id = (
            profile_map.get(name_key)
            or profile_map.get(name_key.lower())
        )
        if requested_id is None:
            _log.warning(
                "verify_active_profile: requested profile name %r not found "
                "in pm list users (device=%s, available=%s)",
                requested_profile_id,
                getattr(device, "device_id", "?"),
                sorted({v: k for k, v in profile_map.items() if isinstance(v, int)}),
            )
            # Treat unresolvable name as a mismatch so we don't run on the
            # wrong account silently.
            return False, current_id, "", -1

    # Step 3: resolve the CURRENT id back into a display name (for log/UI).
    if not profile_map:
        profile_map = await _list_device_profiles(device)
    current_name = ""
    for k, v in profile_map.items():
        # profile_map has both case-preserving and lower-cased keys; pick
        # the first case-preserving match for display.
        if v == current_id and k == k.strip() and not k.islower():
            current_name = k
            break
    if not current_name:
        # Fall back to any key that maps to current_id (lower-case version).
        for k, v in profile_map.items():
            if v == current_id:
                current_name = k
                break

    ok = current_id == requested_id
    return ok, current_id, current_name, int(requested_id)


async def _toggle_trial_reel(device: WSDeviceAdapter, max_scroll_attempts: int = 6) -> bool:
    """
    Toggle the "Trial reel" switch on the share screen.

    Mirrors the proven legacy flow (post_module.py::toggle_trial_reel_current):
      - Up to 6 attempts
      - Force-refresh XML each iteration
      - At attempt 2, expand "More options" if the trial row hasn't appeared
      - Otherwise swipe the share sheet up (steep scroll) to reveal more rows
      - When the row is found, tap (970, row_y) — toggle sits on the right
      - Then dismiss the "Keep as trial / Continue / Got it" confirm popup
    """
    import re as _re

    async def _dismiss_trial_popup() -> None:
        await device.refresh_screen(force=True)
        xml = device.page_source or ""
        for keep_text in ("Keep as trial", "Keep trial", "Continue", "Got it", "OK", "Confirm", "Yes"):
            if keep_text in xml:
                btn = await device.find_element_by_text(keep_text)
                if btn:
                    await device.click(btn)
                    await asyncio.sleep(1)
                    return

    for attempt in range(max_scroll_attempts):
        await device.refresh_screen(force=True)
        xml = device.page_source or ""
        lower = xml.lower()

        if "trial" in lower:
            row_y = None
            for node_match in _re.finditer(
                r'<node[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*?(?:text="([^"]*)"|content-desc="([^"]*)")[^>]*?/?>',
                xml,
            ):
                y1, y2 = int(node_match.group(2)), int(node_match.group(4))
                label = (node_match.group(5) or node_match.group(6) or "").lower()
                if "trial" in label:
                    row_y = (y1 + y2) // 2
                    break
            if row_y is not None:
                try:
                    await device.tap(970, row_y)
                    await asyncio.sleep(2)
                    await _dismiss_trial_popup()
                    return True
                except Exception as _e:
                    _log.error('_toggle_trial_reel: tap/dismiss raised %s: %r (row_y=%s)', type(_e).__name__, _e, row_y)
                    return False

        # At attempt index 2, the trial row may be hidden under "More options"
        if attempt == 2 and "More options" in xml:
            try:
                more_btn = await device.find_element_by_text("More options")
                if more_btn:
                    await device.click(more_btn)
                    await asyncio.sleep(2)
                    continue
            except Exception:
                pass

        # Scroll the share sheet up to reveal more rows (steep scroll: 1900 -> 700)
        try:
            await device.swipe(540, 1900, 540, 700, 650)
            await asyncio.sleep(1)
        except Exception as _e:
            _log.error('_toggle_trial_reel: scroll swipe raised %s: %r at attempt %d', type(_e).__name__, _e, attempt)
            break

    return False
