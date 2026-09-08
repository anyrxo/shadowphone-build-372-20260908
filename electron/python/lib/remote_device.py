"""
RemoteDevice - Abstraction layer for remote device control via WebSocket.

Replaces direct ADB subprocess calls with WebSocket commands.
Modules use this class exactly like they would use direct ADB,
but commands are executed by the Electron client.

This keeps all module logic on the server while the client
just executes ADB commands and returns screen state.
"""

import html
import re
import asyncio
import sys
from typing import Optional, Tuple, List, Dict, Any
from datetime import datetime

from lib.screen_state import ParsedScreenState, ScreenObservation, utc_now_iso

# Default timeout for individual WS commands (seconds).
# Prevents a single stuck client from blocking the server forever.
COMMAND_TIMEOUT = 60

# Extended timeout for commands that drive multi-file transfers on the phone.
# push_to_profile serves up to 10 files through Vanadium with up to 30s per
# file + polling, so the total can reach ~5 minutes (10 × 30s overhead).
# We use 360s (6 min) to cover the worst case without blocking indefinitely.
PUSH_COMMAND_TIMEOUT = 360

# Commands that need the extended timeout
_LONG_RUNNING_ACTIONS = frozenset({"push_to_profile", "push_files"})


class ModuleAbortedError(asyncio.CancelledError):
    """Raised when user cancels a running module via the abort button."""

    pass


class RemoteDevice:
    """
    Remote device control via WebSocket.

    Usage:
        device = RemoteDevice(websocket, "1A121FDF60082H")
        await device.launch_app("com.instagram.android")
        screen = await device.get_screen()
        if "Your story" in screen:
            await device.tap(540, 100)
    """

    def __init__(self, websocket, device_id: str):
        self.ws = websocket
        self.device_id = device_id
        self.current_screen: Optional[str] = None
        self.current_package: Optional[str] = None
        self.current_activity: Optional[str] = None
        self.last_screen_size: Optional[Tuple[int, int]] = None
        self.last_screenshot_path: Optional[str] = None
        self.last_observed_at: Optional[str] = None
        self.cmd_counter = 0
        self.log_history: List[str] = []
        self.aborted = False

    def log(self, level: str, message: str):
        """Log message. DEBUG logs are only printed to console, not sent to client."""
        timestamp = datetime.now().strftime("%H:%M:%S")
        log_entry = f"[{timestamp}] [{level}] {message}"
        # Only add non-DEBUG logs to history (shown to users)
        if level != "DEBUG":
            self.log_history.append(log_entry)
        encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
        print(log_entry.encode(encoding, errors="replace").decode(encoding, errors="replace"))

    async def send_command(
        self,
        action: str,
        params: dict = None,
        wait_after: int = 0,
        get_screen: bool = True,
    ) -> dict:
        """Public API for WSDeviceAdapter. Wraps _send_command and returns a
        structured dict so the adapter can read screen XML reliably.

        Returns:
            dict with keys: success (bool), screen (dict with xml key), data (optional)
        """
        try:
            raw = await self._send_command(action, params, wait_after, get_screen)
            result = {"success": True}
            # Always include the latest screen XML if we have one
            if self.current_screen:
                result["screen"] = {"xml": self.current_screen}
            # Include any data/output that came back
            if isinstance(raw, dict):
                result["data"] = raw
            elif isinstance(raw, str) and raw != self.current_screen:
                result["data"] = {"output": raw}
            return result
        except ModuleAbortedError:
            raise
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def _send_command(
        self,
        action: str,
        params: dict = None,
        wait_after: int = 0,
        get_screen: bool = True,
    ) -> Optional[str]:
        """Send command and wait for result."""
        self.cmd_counter += 1
        cmd_id = f"cmd_{self.cmd_counter:04d}"

        await self.ws.send_json(
            {
                "type": "command",
                "cmd_id": cmd_id,
                "action": action,
                "params": params or {},
                "wait_after": wait_after,
                "expect_screen_dump": get_screen,
            }
        )

        # push_to_profile / push_files drive multi-file downloads through Vanadium
        # with up to 30 s per file.  The default 60 s ceiling is too tight and would
        # abort a legitimate 10-file transfer mid-way.  Use the extended ceiling for
        # these actions so the client has time to finish the full loop.
        cmd_timeout = (
            PUSH_COMMAND_TIMEOUT if action in _LONG_RUNNING_ACTIONS else COMMAND_TIMEOUT
        )

        # Wait for result - skip any non-command_result messages
        # Timeout prevents stuck clients from blocking the server
        #
        # cmd_id correlation: a command_result MUST match the cmd_id we just
        # sent. Without this, a stale result left in the socket buffer by an
        # EARLIER command (e.g. one whose caller hit a short asyncio.wait_for
        # timeout and got cancelled while the slow client kept working) gets
        # consumed by the NEXT command — returning the wrong command's payload.
        # That's the `echo sp_ok` -> '24' bug: a prior `am get-current-user`
        # result arrives late and is picked up here. We discard mismatched
        # command_results instead of returning them.
        max_tries = 20  # Allow more tries since some commands trigger many intermediate messages
        result = None
        for _ in range(max_tries):
            try:
                result = await asyncio.wait_for(
                    self.ws.receive_json(), timeout=cmd_timeout
                )
            except asyncio.TimeoutError:
                raise Exception(
                    f"Command '{action}' timed out after {cmd_timeout}s - client may be disconnected"
                )

            # Skip progress and other message types
            if result.get("type") == "command_result":
                result_cmd_id = result.get("cmd_id")
                # No cmd_id on the result (older client) -> accept it; we
                # can't correlate so fall back to the legacy first-match
                # behaviour for backward compatibility.
                if result_cmd_id is None or result_cmd_id == cmd_id:
                    break
                # Stale result from an earlier, abandoned command. Drop it
                # and keep waiting for OUR result.
                print(
                    f"[RemoteDevice] Discarding stale command_result "
                    f"{result_cmd_id!r} while waiting for {cmd_id!r} "
                    f"(action='{action}')"
                )
                continue
            elif result.get("type") in ("progress", "log", "ping"):
                continue  # Skip and wait for next message
            elif result.get("type") == "abort":
                self.aborted = True
                print(f"[RemoteDevice] Abort received during '{action}'")
                raise ModuleAbortedError("Task cancelled by user")
            else:
                # Unknown type - log and continue
                print(
                    f"[RemoteDevice] Skipping unexpected message: {result.get('type')}"
                )
                continue
        else:
            raise Exception(
                f"No matching command_result (cmd_id={cmd_id}) received "
                f"after {max_tries} messages"
            )

        if not result.get("success"):
            raise Exception(f"Command failed: {result.get('error')}")

        # Update current screen
        screen_data = result.get("screen")
        if screen_data:
            self.current_screen = screen_data.get("xml")
            self.last_observed_at = utc_now_iso()

        # Also capture shell output if present
        data = result.get("data", {})
        if data and data.get("output"):
            return data.get("output")

        # For commands that don't expect screen dumps (push_to_profile, etc.),
        # return the full data dict so modules can read structured results
        if not get_screen and data and not data.get("output"):
            return data

        return self.current_screen

    async def send_progress(self, percent: int, message: str):
        """Send progress update to client."""
        await self.ws.send_json(
            {"type": "progress", "percent": percent, "message": message}
        )

    async def send_log(self, message: str, level: str = "INFO"):
        """Send log message to client for real-time display in Live Output."""
        # Also log locally
        self.log(level, message)
        # Send to client
        await self.ws.send_json({"type": "log", "message": message, "level": level})

    async def prompt_user(
        self,
        message: str,
        options: list = None,
        timeout: int = 300,
    ) -> str:
        """Send a prompt to the user and wait for their response.

        Used when the module needs user intervention (e.g. 2FA handling).
        Sends a 'user_prompt' message and blocks until the client sends
        back a 'user_response' message with the chosen action.

        Args:
            message: The prompt message to display to the user.
            options: List of action strings (default: ["continue", "cancel"]).
            timeout: Max seconds to wait for response (default: 300 = 5 min).

        Returns:
            The action string chosen by the user (e.g. "continue" or "cancel").
        """
        if options is None:
            options = ["continue", "cancel"]

        prompt_id = f"prompt_{self.cmd_counter:04d}"
        self.cmd_counter += 1

        await self.ws.send_json(
            {
                "type": "user_prompt",
                "prompt_id": prompt_id,
                "message": message,
                "options": options,
            }
        )

        self.log("INFO", f"⏸️ Waiting for user response: {message}")

        # Wait for user_response — skip any other message types
        max_tries = 100  # Allow many intermediate messages during the wait
        for _ in range(max_tries):
            try:
                result = await asyncio.wait_for(self.ws.receive_json(), timeout=timeout)
            except asyncio.TimeoutError:
                self.log("WARN", "⏱️ User prompt timed out")
                return "cancel"

            if result.get("type") == "user_response":
                action = result.get("action", "cancel")
                self.log("INFO", f"✅ User responded: {action}")
                return action
            elif result.get("type") == "abort":
                self.aborted = True
                raise ModuleAbortedError("Task cancelled by user")
            # Skip progress, log, ping, command_result etc.
            continue

        # Exhausted retries without getting a response
        self.log("WARN", "⚠️ No user response received after max retries")
        return "cancel"

    # ==================== BASIC COMMANDS ====================

    async def tap(self, x: int, y: int, wait_after: int = 500) -> str:
        """Tap at coordinates."""
        self.log("DEBUG", f"Tap ({x}, {y})")
        return await self._send_command("tap", {"x": x, "y": y}, wait_after)

    async def long_tap(self, x: int, y: int, duration_ms: int = 1000) -> str:
        """Long press at coordinates."""
        self.log("DEBUG", f"Long tap ({x}, {y}) for {duration_ms}ms")
        return await self._send_command(
            "long_tap", {"x": x, "y": y, "duration_ms": duration_ms}
        )

    async def swipe(
        self,
        x1: int,
        y1: int,
        x2: int,
        y2: int,
        duration_ms: int = 300,
        wait_after: int = 500,
    ) -> str:
        """Swipe gesture."""
        self.log("DEBUG", f"Swipe ({x1},{y1}) -> ({x2},{y2})")
        return await self._send_command(
            "swipe",
            {"x1": x1, "y1": y1, "x2": x2, "y2": y2, "duration_ms": duration_ms},
            wait_after,
        )

    async def input_text(
        self, text: str, clear_first: bool = False, typing_mode: str = "instant"
    ) -> str:
        """Type text without exposing its contents to logs."""
        if typing_mode not in {"instant", "human"}:
            raise ValueError(f"Unsupported typing mode: {typing_mode}")
        self.log("DEBUG", f"Input text: [REDACTED length={len(text)}] mode={typing_mode}")
        return await self._send_command(
            "input_text",
            {
                "text": text,
                "clear_first": clear_first,
                "typing_mode": typing_mode,
            },
        )

    async def input_emoji(self, text: str, typing_mode: str = "instant") -> str:
        """Type text including emojis. Uses same method as input_text."""
        # Just use input_text - the client handles special chars with escaping
        return await self.input_text(text, typing_mode=typing_mode)

    async def keyevent(self, keycode: int) -> str:
        """Send keyevent."""
        self.log("DEBUG", f"Keyevent: {keycode}")
        return await self._send_command("keyevent", {"keycode": keycode})

    async def back(self) -> str:
        """Press back button."""
        return await self.keyevent(4)

    async def home(self) -> str:
        """Press home button."""
        return await self.keyevent(3)

    async def enter(self) -> str:
        """Press enter."""
        return await self.keyevent(66)

    async def select_all_and_delete(self) -> str:
        """Select all text and delete. Useful for clearing input fields."""
        # Ctrl+A to select all (keycode 29 with meta CTRL)
        await self.shell("input keyevent --longpress 67")  # Multiple backspaces
        await self.shell("input keyevent 123")  # Move to end
        await self.shell("input keyevent --longpress 67")  # Delete remaining
        return await self._send_command(
            "shell", {"command": "input text ''"}, get_screen=False
        )

    def find_element_by_content_description(
        self, desc: str
    ) -> Optional[Tuple[int, int]]:
        """Find element by content-description attribute.
        Handles both attribute orderings (content-desc before/after bounds)."""
        if not self.current_screen:
            return None

        # Try content-desc BEFORE bounds
        pattern = rf'content-desc="[^"]*{re.escape(desc)}[^"]*"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
        match = re.search(pattern, self.current_screen, re.IGNORECASE | re.DOTALL)

        if not match:
            # Try bounds BEFORE content-desc (reverse attribute order)
            pattern = rf'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*?content-desc="[^"]*{re.escape(desc)}[^"]*"'
            match = re.search(pattern, self.current_screen, re.IGNORECASE | re.DOTALL)

        if match:
            x1, y1, x2, y2 = map(int, match.groups())
            return ((x1 + x2) // 2, (y1 + y2) // 2)

        return None

    def find_element_by_content_description_exact(
        self, desc: str
    ) -> Optional[Tuple[int, int]]:
        """Find element center by exact content-description attribute."""
        if not self.current_screen:
            return None

        desc_pat = rf'content-desc="{re.escape(desc)}"'
        bounds_pat = r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'

        match = re.search(
            rf"{desc_pat}[^>]*?{bounds_pat}",
            self.current_screen,
            re.DOTALL,
        )
        if not match:
            match = re.search(
                rf"{bounds_pat}[^>]*?{desc_pat}",
                self.current_screen,
                re.DOTALL,
            )

        if match:
            x1, y1, x2, y2 = map(int, match.groups())
            return ((x1 + x2) // 2, (y1 + y2) // 2)

        return None

    async def launch_app(self, package: str, wait_after: int = 3000) -> str:
        """Launch app by package name."""
        self.log("INFO", f"Launching {package}")
        return await self._send_command("launch_app", {"package": package}, wait_after)

    async def shell(self, command: str) -> str:
        """Run shell command.

        2.18.26: retry on transient ADB transport errors. When the phone is
        attached over Tailscale (e.g. `100.116.5.79:5555`), the tunnel can
        drop mid-command — adb returns `error: closed` / `error: device
        offline` / `error: protocol fault`. The phone is fine and the next
        adb call usually reconnects automatically. Without retry we'd kill
        a multi-minute IG-signup mid-flow on a 50ms network blip.

        Live hit 2026-05-26: Anyro's account_creation_phone died on
        `input text "+17622904000"` with `error: closed` after 20× DEL
        keyevents all succeeded — pure Tailscale transport flake. Retry
        the same shell command up to TRANSIENT_RETRIES with a short
        backoff; the renderer side re-spawns adb fresh per call so a
        retry naturally re-establishes the device connection.
        """
        self.log("DEBUG", f"Shell: {command}")
        TRANSIENT_PATTERNS = (
            "error: closed",
            "error: device offline",
            "error: device not found",
            "error: no devices/emulators found",
            "error: protocol fault",
            "error: connection reset",
            "cannot connect to daemon",
        )
        TRANSIENT_RETRIES = 3
        last_exc = None
        for attempt in range(TRANSIENT_RETRIES + 1):
            try:
                return await self._send_command("shell", {"command": command})
            except Exception as e:
                msg = str(e).lower()
                is_transient = any(p in msg for p in TRANSIENT_PATTERNS)
                if not is_transient or attempt >= TRANSIENT_RETRIES:
                    raise
                last_exc = e
                self.log(
                    "WARN",
                    f"Shell transient error (attempt {attempt + 1}/{TRANSIENT_RETRIES}): "
                    f"{str(e)[:120]} — retrying",
                )
                # Backoff: 0.5s, 1.5s, 3s. Gives the adb daemon/transport
                # time to reconnect before we hammer it again.
                await asyncio.sleep(0.5 + attempt * 1.0)
        # Should be unreachable — the loop either returns or raises above.
        if last_exc:
            raise last_exc
        raise Exception("shell retry loop exhausted with no exception")

    async def wait(self, ms: int):
        """Wait for specified milliseconds."""
        await self._send_command("wait", {"ms": ms}, get_screen=False)

    async def get_screen(self) -> str:
        """Get current screen XML."""
        return await self._send_command("dump_screen")

    def get_parsed_screen_state(self) -> ParsedScreenState:
        """Return a parsed/indexed view of the current XML screen source."""
        return ParsedScreenState(self.current_screen)

    async def refresh_screen_observation(self) -> ScreenObservation:
        """Build a reusable screen observation snapshot from current device context.

        Phase 1 foundation only: this gathers lightweight context without changing
        any automation decisions.
        """
        await self.get_screen()

        package = None
        activity = None
        try:
            package = await self.get_current_app()
        except Exception:
            package = self.current_package

        try:
            activity = await self.get_current_activity()
        except Exception:
            activity = self.current_activity

        try:
            screen_size = await self.get_screen_size()
        except Exception:
            screen_size = self.last_screen_size

        self.current_package = package or self.current_package
        self.current_activity = activity or self.current_activity
        self.last_screen_size = screen_size or self.last_screen_size
        self.last_observed_at = utc_now_iso()

        parsed = self.get_parsed_screen_state()
        return ScreenObservation(
            observed_at=self.last_observed_at,
            device_id=self.device_id,
            package=self.current_package,
            activity=self.current_activity,
            xml_source=self.current_screen,
            screenshot_path=self.last_screenshot_path,
            screen_size=self.last_screen_size,
            text_summary=parsed.text_snippets(limit=12),
            element_summary=parsed.summary(),
        )

    # ==================== SCREEN ANALYSIS ====================

    def find_element_by_text(
        self, text: str, exact: bool = False
    ) -> Optional[Tuple[int, int]]:
        """Find element center coordinates by text content.
        Handles both attribute orderings (text before/after bounds)."""
        if not self.current_screen:
            return None

        flags = re.DOTALL | (re.IGNORECASE if not exact else 0)

        # Build text pattern
        if exact:
            text_pat = rf'text="{re.escape(text)}"'
        else:
            text_pat = rf'text="[^"]*{re.escape(text)}[^"]*"'

        bounds_pat = r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'

        # Try text BEFORE bounds
        match = re.search(rf"{text_pat}[^>]*?{bounds_pat}", self.current_screen, flags)

        if not match:
            # Try bounds BEFORE text (reverse attribute order)
            match = re.search(
                rf"{bounds_pat}[^>]*?{text_pat}", self.current_screen, flags
            )

        if match:
            x1, y1, x2, y2 = map(int, match.groups())
            return ((x1 + x2) // 2, (y1 + y2) // 2)

        return None

    def find_element_by_resource_id(
        self, resource_id: str
    ) -> Optional[Tuple[int, int]]:
        """Find element center by resource-id.
        Handles both attribute orderings (resource-id before/after bounds)."""
        if not self.current_screen:
            return None

        rid_pat = rf'resource-id="[^"]*{re.escape(resource_id)}[^"]*"'
        bounds_pat = r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'

        # Try resource-id BEFORE bounds
        match = re.search(
            rf"{rid_pat}[^>]*?{bounds_pat}", self.current_screen, re.DOTALL
        )

        if not match:
            # Try bounds BEFORE resource-id (reverse attribute order)
            match = re.search(
                rf"{bounds_pat}[^>]*?{rid_pat}", self.current_screen, re.DOTALL
            )

        if match:
            x1, y1, x2, y2 = map(int, match.groups())
            return ((x1 + x2) // 2, (y1 + y2) // 2)

        return None

    def find_element_by_resource_id_in_bounds(
        self,
        resource_id: str,
        *,
        min_y: int = 0,
        max_y: int = 10_000,
        min_x: int = 0,
        max_x: int = 10_000,
    ) -> Optional[Tuple[int, int]]:
        """Find an element center by resource-id within a screen region."""
        if not self.current_screen:
            return None

        candidates: List[Tuple[int, int]] = []
        for node in re.findall(r"<node\b[^>]*>", self.current_screen, re.DOTALL):
            if resource_id not in node:
                continue
            bounds = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
            if not bounds:
                continue
            x1, y1, x2, y2 = map(int, bounds.groups())
            cx = (x1 + x2) // 2
            cy = (y1 + y2) // 2
            if min_x <= cx <= max_x and min_y <= cy <= max_y:
                candidates.append((cx, cy))

        return candidates[0] if candidates else None

    def find_element_by_content_description_exact_in_bounds(
        self,
        desc: str,
        *,
        min_y: int = 0,
        max_y: int = 10_000,
        min_x: int = 0,
        max_x: int = 10_000,
    ) -> Optional[Tuple[int, int]]:
        """Find an exact content-desc element center within a screen region."""
        if not self.current_screen:
            return None

        desc_pat = re.compile(r'content-desc="([^"]*)"', re.DOTALL)
        candidates: List[Tuple[int, int]] = []
        for node in re.findall(r"<node\b[^>]*>", self.current_screen, re.DOTALL):
            desc_match = desc_pat.search(node)
            if not desc_match or html.unescape(desc_match.group(1)).strip() != desc:
                continue
            bounds = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
            if not bounds:
                continue
            x1, y1, x2, y2 = map(int, bounds.groups())
            cx = (x1 + x2) // 2
            cy = (y1 + y2) // 2
            if min_x <= cx <= max_x and min_y <= cy <= max_y:
                candidates.append((cx, cy))

        return candidates[0] if candidates else None

    def find_element_by_class(self, class_name: str) -> Optional[Tuple[int, int]]:
        """Find first element by class name."""
        if not self.current_screen:
            return None

        cls_pat = rf'class="{re.escape(class_name)}"'
        bounds_pat = r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'

        match = re.search(
            rf"{cls_pat}[^>]*?{bounds_pat}", self.current_screen, re.DOTALL
        )
        if not match:
            match = re.search(
                rf"{bounds_pat}[^>]*?{cls_pat}", self.current_screen, re.DOTALL
            )

        if match:
            x1, y1, x2, y2 = map(int, match.groups())
            return ((x1 + x2) // 2, (y1 + y2) // 2)

        return None

    def find_all_elements_by_text(self, text: str) -> List[Tuple[int, int]]:
        """Find all elements matching text."""
        if not self.current_screen:
            return []

        text_pat = rf'text="[^"]*{re.escape(text)}[^"]*"'
        bounds_pat = r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'

        # Both orderings
        results = []
        for pat in [rf"{text_pat}[^>]*?{bounds_pat}", rf"{bounds_pat}[^>]*?{text_pat}"]:
            for m in re.finditer(pat, self.current_screen, re.IGNORECASE | re.DOTALL):
                coord = (
                    (int(m.group(1)) + int(m.group(3))) // 2,
                    (int(m.group(2)) + int(m.group(4))) // 2,
                )
                if coord not in results:
                    results.append(coord)

        return results

    def text_on_screen(self, text: str) -> bool:
        """Check if text is visible on screen."""
        if not self.current_screen:
            return False
        return text.lower() in self.current_screen.lower()

    def element_exists(self, text: str = None, resource_id: str = None) -> bool:
        """Check if element exists."""
        if text:
            return self.find_element_by_text(text) is not None
        if resource_id:
            return self.find_element_by_resource_id(resource_id) is not None
        return False

    def get_text_content(self, resource_id: str) -> Optional[str]:
        """Get text content of an element by resource-id."""
        if not self.current_screen:
            return None

        # Try resource-id before text
        pattern = (
            rf'resource-id="[^"]*{re.escape(resource_id)}[^"]*"[^>]*?text="([^"]*)"'
        )
        match = re.search(pattern, self.current_screen, re.DOTALL)
        if match:
            return match.group(1)

        # Try text before resource-id
        pattern = (
            rf'text="([^"]*)"[^>]*?resource-id="[^"]*{re.escape(resource_id)}[^"]*"'
        )
        match = re.search(pattern, self.current_screen, re.DOTALL)
        return match.group(1) if match else None

    def get_content_desc(self, resource_id: str) -> Optional[str]:
        """Get content-desc of an element by resource-id.
        Useful for checking like button state: 'Like' vs 'Liked'."""
        if not self.current_screen:
            return None

        # Try resource-id before content-desc
        pattern = rf'resource-id="[^"]*{re.escape(resource_id)}[^"]*"[^>]*?content-desc="([^"]*)"'
        match = re.search(pattern, self.current_screen, re.DOTALL)
        if match:
            return match.group(1)

        # Try content-desc before resource-id (XML attribute order varies)
        pattern = rf'content-desc="([^"]*)"[^>]*?resource-id="[^"]*{re.escape(resource_id)}[^"]*"'
        match = re.search(pattern, self.current_screen, re.DOTALL)
        return match.group(1) if match else None

    def find_all_elements_by_resource_id(
        self, resource_id: str
    ) -> List[Tuple[int, int]]:
        """Find all elements matching a resource-id."""
        if not self.current_screen:
            return []

        rid_pat = rf'resource-id="[^"]*{re.escape(resource_id)}[^"]*"'
        bounds_pat = r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'

        results = []
        for pat in [rf"{rid_pat}[^>]*?{bounds_pat}", rf"{bounds_pat}[^>]*?{rid_pat}"]:
            for m in re.finditer(pat, self.current_screen, re.DOTALL):
                coord = (
                    (int(m.group(1)) + int(m.group(3))) // 2,
                    (int(m.group(2)) + int(m.group(4))) // 2,
                )
                if coord not in results:
                    results.append(coord)

        return results

    # ==================== HIGH-LEVEL ACTIONS ====================

    async def tap_element(
        self,
        text: str = None,
        resource_id: str = None,
        wait_after: int = 500,
        retry: int = 3,
    ) -> bool:
        """Tap element by text or resource-id with retry."""
        for attempt in range(retry):
            # Get fresh screen if not first attempt
            if attempt > 0:
                await self.get_screen()

            # Find element
            coords = None
            if text:
                coords = self.find_element_by_text(text)
            elif resource_id:
                coords = self.find_element_by_resource_id(resource_id)

            if coords:
                self.log("INFO", f"Tapping element: {text or resource_id}")
                await self.tap(coords[0], coords[1], wait_after)
                return True

            # Retry after short wait
            if attempt < retry - 1:
                self.log(
                    "DEBUG", f"Element not found, retrying ({attempt + 1}/{retry})"
                )
                await self.wait(1000)

        self.log(
            "WARN", f"Element not found after {retry} attempts: {text or resource_id}"
        )
        return False

    async def wait_for_element(
        self,
        text: str = None,
        resource_id: str = None,
        timeout_ms: int = 10000,
        poll_ms: int = 500,
    ) -> bool:
        """Wait for element to appear."""
        elapsed = 0
        while elapsed < timeout_ms:
            await self.get_screen()

            if text and self.text_on_screen(text):
                return True
            if resource_id and self.element_exists(resource_id=resource_id):
                return True

            await self.wait(poll_ms)
            elapsed += poll_ms

        return False

    async def scroll_down(self, amount: int = 800) -> str:
        """Scroll down."""
        return await self.swipe(540, 1500, 540, 1500 - amount, 300)

    async def scroll_up(self, amount: int = 800) -> str:
        """Scroll up."""
        return await self.swipe(540, 700, 540, 700 + amount, 300)

    async def scroll_feed(self) -> str:
        """Scroll to next feed item (optimized for Instagram reels) — humanized."""
        import random

        style = random.choices(
            ["normal", "long_flick", "slow_drag", "burst"],
            weights=[0.45, 0.25, 0.20, 0.10],
        )[0]
        x = random.randint(440, 640)
        if style == "long_flick":
            start_y = random.randint(1850, 2200)
            end_y = random.randint(180, 520)
            duration = random.randint(160, 320)
        elif style == "slow_drag":
            start_y = random.randint(1650, 2050)
            end_y = random.randint(350, 760)
            duration = random.randint(560, 900)
        elif style == "burst":
            for _ in range(random.randint(2, 3)):
                burst_y = random.randint(1450, 1850)
                await self.swipe(
                    x + random.randint(-45, 45),
                    burst_y,
                    x + random.randint(-45, 45),
                    burst_y - random.randint(650, 1050),
                    random.randint(120, 260),
                    wait_after=random.randint(80, 220),
                )
            return ""
        else:
            start_y = random.randint(1750, 2150)
            end_y = random.randint(260, 680)
            duration = random.randint(260, 560)
        return await self.swipe(
            x,
            start_y,
            x + random.randint(-35, 35),
            end_y,
            duration,
            wait_after=random.randint(650, 1700),
        )

    # ==================== POPUP HANDLING ====================

    async def dismiss_common_popups(self) -> int:
        """Dismiss common Instagram popups. Returns count dismissed."""
        dismissed = 0

        await self.get_screen()

        # Notification popup
        if self.text_on_screen("Turn on Notifications"):
            if await self.tap_element("Not Now"):
                dismissed += 1
                await self.wait(500)
                await self.get_screen()

        # "Allow" permission
        if self.text_on_screen("Allow") and (
            self.text_on_screen("notification") or self.text_on_screen("access")
        ):
            if await self.tap_element("Allow"):
                dismissed += 1
                await self.wait(500)
                await self.get_screen()

        # "Got it" onboarding
        if self.text_on_screen("Got it"):
            if await self.tap_element("Got it"):
                dismissed += 1
                await self.wait(500)
                await self.get_screen()

        # Save login info
        if self.text_on_screen("Save your login info"):
            if await self.tap_element("Not now") or await self.tap_element("Not Now"):
                dismissed += 1
                await self.wait(500)
                await self.get_screen()

        # "Dismiss" button
        if self.text_on_screen("Dismiss"):
            if await self.tap_element("Dismiss"):
                dismissed += 1
                await self.wait(500)
                await self.get_screen()

        for label in ["Not now", "Not Now", "Maybe later", "Continue", "Allow all"]:
            if self.text_on_screen(label):
                if await self.tap_element(label):
                    dismissed += 1
                    await self.wait(500)
                    await self.get_screen()
                    break

        # "Skip" button
        if self.text_on_screen("Skip"):
            if await self.tap_element("Skip"):
                dismissed += 1
                await self.wait(500)
                await self.get_screen()

        # "Rate Instagram" popup
        if self.text_on_screen("Rate Instagram"):
            if await self.tap_element("No, thanks") or await self.tap_element("Not Now") or await self.tap_element("Remind me later"):
                dismissed += 1
                await self.wait(500)
                await self.get_screen()

        if dismissed > 0:
            self.log("INFO", f"Dismissed {dismissed} popup(s)")

        return dismissed

    async def handle_action_blocked(self) -> bool:
        """Check for and handle action blocked screen."""
        await self.get_screen()

        if self.text_on_screen("Action Blocked") or self.text_on_screen(
            "Try Again Later"
        ):
            self.log("WARN", "⚠️ Action blocked detected!")

            # Try to dismiss
            if await self.tap_element("OK") or await self.tap_element("Tell us"):
                await self.wait(1000)

            return True

        return False

    # ==================== SCREEN DIMENSIONS ====================

    async def get_current_app(self) -> Optional[str]:
        """Get current foreground package name when available."""
        result = await self.shell(
            "dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -3; "
            "dumpsys activity activities 2>/dev/null | grep -E 'topResumedActivity|mResumedActivity' | head -3; true"
        )
        if result:
            match = re.search(r"u\d+\s+([a-zA-Z0-9_.]+)/", result)
            if match:
                self.current_package = match.group(1)
                return self.current_package
        return self.current_package

    async def get_current_activity(self) -> Optional[str]:
        """Get current foreground activity name when available."""
        result = await self.shell(
            "dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -3; "
            "dumpsys activity activities 2>/dev/null | grep -E 'topResumedActivity|mResumedActivity' | head -3; true"
        )
        if result:
            match = re.search(r"u\d+\s+[a-zA-Z0-9_.]+/([a-zA-Z0-9_.$]+)", result)
            if match:
                self.current_activity = match.group(1)
                return self.current_activity
        return self.current_activity

    async def get_screen_size(self) -> Tuple[int, int]:
        """Get device screen size. Returns (width, height)."""
        result = await self.shell("wm size")
        # Output: "Physical size: 1080x1920"
        if result:
            match = re.search(r"(\d+)x(\d+)", result)
            if match:
                size = (int(match.group(1)), int(match.group(2)))
                self.last_screen_size = size
                return size
        fallback = self.last_screen_size or (1080, 2400)
        self.last_screen_size = fallback
        return fallback  # Default modern phone size

    def get_screen_center(
        self, width: int = 1080, height: int = 2400
    ) -> Tuple[int, int]:
        """Get center coordinates of screen."""
        return (width // 2, height // 2)

    # ==================== INSTAGRAM-SPECIFIC ====================

    async def is_on_home_screen(self) -> bool:
        """Check if we're on Instagram home screen."""
        await self.get_screen()
        return (
            self.text_on_screen("Your story")
            or self.element_exists(resource_id="com.instagram.android:id/tab_bar")
            or self.element_exists(resource_id="com.instagram.android:id/feed_tab")
        )

    async def navigate_to_reels(self) -> bool:
        """Navigate to Instagram Reels tab."""
        await self.get_screen()

        for _ in range(2):
            if not await self.is_in_story_view():
                break
            self.log("WARN", "Story viewer open before Reels navigation; backing out first")
            await self.back()
            await self.wait(900)
            await self.get_screen()

        if not (
            self.element_exists(resource_id="com.instagram.android:id/tab_bar")
            or self.element_exists(resource_id="com.instagram.android:id/clips_tab")
        ):
            if await self.is_in_story_view():
                await self.back()
                await self.wait(900)
                await self.get_screen()
            await self.navigate_to_home()
            await self.wait(900)
            await self.get_screen()

        # Look for Reels tab in bottom nav only. A fuzzy content-desc lookup can
        # match story tray/viewer text and accidentally open a story.
        reels_coords = self.find_element_by_resource_id_in_bounds(
            "com.instagram.android:id/clips_tab",
            min_y=1950,
        )
        if reels_coords:
            await self.tap(reels_coords[0], reels_coords[1], wait_after=1500)
            await self.wait(1500)
            return await self.verify_on_reels_tab()

        reels_coords = self.find_element_by_content_description_exact_in_bounds(
            "Reels",
            min_y=1950,
        )
        if reels_coords:
            await self.tap(reels_coords[0], reels_coords[1], wait_after=1500)
            await self.wait(1500)
            return await self.verify_on_reels_tab()

        # Only use the coordinate fallback when the bottom nav is visible. On a
        # story viewer the same coordinate can hit story content/reactions.
        if self.element_exists(resource_id="com.instagram.android:id/tab_bar"):
            await self.tap(324, 2274, wait_after=1500)
            await self.wait(1500)
            return await self.verify_on_reels_tab()

        self.log("WARN", "Reels tab not found in bottom nav")
        return False


    async def navigate_to_profile(self) -> bool:
        """Navigate to Instagram Profile tab.
        ig_ui_map: content-desc="Profile" bounds [864,2227][1080,2400] center (972,2313)
        NOTE: resource-id="tab_avatar" may not exist on all IG versions.
        Content-desc="Profile" is the reliable identifier."""
        await self.get_screen()
        profile_coords = self.find_element_by_content_description(
            "Profile"
        ) or self.find_element_by_resource_id("com.instagram.android:id/tab_avatar")
        if profile_coords:
            await self.tap(profile_coords[0], profile_coords[1])
            await self.wait(1500)
            return True
        # ADB-VERIFIED fallback: Profile tab center (972, 2274)
        await self.tap(972, 2274, wait_after=1500)
        return True

    async def navigate_to_home(self) -> bool:
        """Navigate to Instagram Home feed tab.
        ig_ui_map: Home tab [0,2211][216,2337] center (108,2274)
        DO NOT use find_element_by_content_description("Home") — it matches
        the Instagram logo at (540, 201) which opens Following/Favorites dropdown!
        Use hardcoded bottom-nav coordinates instead."""
        # ADB-VERIFIED: Home tab center (108, 2274) from ig_ui_map
        await self.tap(108, 2274, wait_after=1500)
        return True

    async def double_tap_to_like(self, x: int = None, y: int = None) -> bool:
        """Double tap to like content using ADB double_tap command."""
        if x is None or y is None:
            x = x or 540
            y = y or 1200
        # Use the dedicated double_tap ADB command for instant execution
        await self._send_command("double_tap", {"x": x, "y": y})
        await self.wait(400)
        self.log("INFO", "Double-tapped to like")
        return True

    def is_sponsored(self, surface: str = "generic") -> bool:
        """Check if current feed/reel/story unit is sponsored/ad.

        Must call get_screen() first. Story viewers always expose a "Send
        message" composer, so the CTA-only heuristic is intentionally stricter
        for stories to avoid treating every normal story as an ad.
        """
        if not self.current_screen:
            return False

        xml_str = self.current_screen if self.current_screen else ""
        xml_lower = xml_str.lower()
        surface = (surface or "generic").lower()

        sponsor_phrases = [
            "sponsored",
            "sponsored by",
            "promoted",
            "paid partnership",
            "paid for by",
            "advertisement",
            "advertiser",
            "why you're seeing this ad",
            "about this ad",
        ]
        for attr, value in re.findall(
            r'(text|content-desc)="([^"]*)"',
            xml_str,
            re.IGNORECASE | re.DOTALL,
        ):
            normalized = html.unescape(value).strip().lower()
            normalized = re.sub(r"\s+", " ", normalized)
            if not normalized:
                continue
            if normalized == "ad":
                self.log("INFO", f"Detected ad marker: {attr}=Ad")
                return True
            if surface == "story" and re.search(r"(^|[^a-z])ad([^a-z]|$)", normalized):
                self.log("INFO", f"Detected story ad marker: {attr}={normalized[:40]}")
                return True
            for phrase in sponsor_phrases:
                if normalized == phrase or normalized.startswith(f"{phrase} ") or f" {phrase} " in f" {normalized} ":
                    self.log("INFO", f"Detected ad marker: {attr}={phrase}")
                    return True

        if re.search(r'text="ad"', xml_str, re.IGNORECASE):
            self.log("INFO", "Detected ad marker: text=Ad")
            return True

        ad_resource_markers = [
            "sponsored_label",
            "reel_item_sponsored_label_footer_pill",
            "ad_label",
            "ad_header",
            "ad_cta",
            "ad_cta_button",
            "branded_content",
            "paid_partnership",
            "story_item_cta_container",
            "story_ad",
            "story_ads",
            "story_ad_cta",
            "reel_ad",
            "reel_viewer_ad",
            "reel_viewer_ad_cta",
            "reel_item_sponsored",
            "reel_viewer_sponsored",
            "sponsored_label_stub",
            "ads_manager",
            "ad_disclosure",
            "ads_cta",
            "instagram_ad",
            "cta_sticker",
        ]
        for marker in ad_resource_markers:
            if marker in xml_lower:
                self.log("INFO", f"Detected ad resource: {marker}")
                return True

        ad_ctas = [
            "shop now",
            "learn more",
            "install now",
            "sign up",
            "book now",
            "download",
            "get offer",
            "order now",
            "apply now",
            "contact us",
            "get quote",
            "subscribe",
            "watch more",
            "listen now",
            "visit profile",
            "view shop",
            "view products",
            "get tickets",
            "open link",
            "see more",
            "send whatsapp message",
        ]
        for cta in ad_ctas:
            escaped = re.escape(cta)
            if re.search(rf'(text|content-desc)="[^"]*{escaped}[^"]*"', xml_str, re.IGNORECASE):
                self.log("INFO", f"Detected ad CTA: {cta}")
                return True

        if surface in {"feed", "reel", "reels"}:
            escaped = re.escape("send message")
            if re.search(rf'(text|content-desc)="[^"]*{escaped}[^"]*"', xml_str, re.IGNORECASE):
                self.log("INFO", "Detected ad CTA: send message")
                return True

        return False

    def is_liked(self) -> bool:
        """Check if current reel/post is already liked. Must call get_screen() first.
        Uses resource-id + content-desc pattern matching on raw XML."""
        if not self.current_screen:
            return False

        # Check like_button (reels) and row_feed_button_like (feed) by content-desc
        # content-desc="Like" = not liked, content-desc="Liked" = already liked
        like_ids = ["like_button", "row_feed_button_like"]

        for lid in like_ids:
            # Check for Liked state via content-desc on the like button (both orderings)
            pattern = (
                rf'resource-id="[^"]*{re.escape(lid)}[^"]*"[^>]*?content-desc="Liked"'
            )
            if re.search(pattern, self.current_screen, re.DOTALL):
                self.log("DEBUG", f"Post already liked ({lid} content-desc=Liked)")
                return True
            pattern_rev = (
                rf'content-desc="Liked"[^>]*?resource-id="[^"]*{re.escape(lid)}[^"]*"'
            )
            if re.search(pattern_rev, self.current_screen, re.DOTALL):
                self.log(
                    "DEBUG", f"Post already liked ({lid} content-desc=Liked, reversed)"
                )
                return True

        return False

    async def find_and_tap_like_button(self) -> bool:
        """Find and tap the like button on a post/reel using resource ID."""
        like_btn = await self.find_like_button()

        if like_btn:
            await self.tap(like_btn[0], like_btn[1], wait_after=500)
            self.log("INFO", "Tapped like button")
            return True
        return False

    async def find_and_tap_comment_button(self) -> bool:
        """Find and tap the comment button on a post/reel."""
        comment_btn = await self.find_comment_button()

        if comment_btn:
            await self.tap(comment_btn[0], comment_btn[1], wait_after=1500)
            self.log("INFO", "Opened comment section")
            return True
        return False

    async def post_comment(self, comment_text: str) -> bool:
        """Type and post a comment. Assumes comment sheet is open."""
        # Ensure input field is focused before typing
        await self.get_screen()
        input_field = self.find_element_by_resource_id(
            "com.instagram.android:id/layout_comment_thread_edittext"
        )
        if input_field:
            await self.tap(input_field[0], input_field[1], wait_after=500)

        # Type the comment (input_text handles escaping)
        await self.input_text(comment_text, typing_mode="human")
        await self.wait(500)

        # Press enter to submit the comment
        await self.enter()
        await self.wait(1000)

        self.log("INFO", f"Posted comment: [REDACTED length={len(comment_text)}]")

        # Only 1 back to close comment sheet (2 would exit reels view)
        await self.back()
        await self.wait(500)

        return True

    async def tap_story_ring(self, index: int = 0) -> bool:
        """Tap on a story ring at the top of the feed."""
        await self.get_screen()

        # Story rings are usually in a horizontal scroll at top
        # Each story is about 80px wide, starting around x=50
        x_offset = 80 + (index * 90)  # Approximate spacing

        # Try to find "Your story" specifically for first story
        if index == 0:
            your_story = self.find_element_by_text(
                "Your story"
            ) or self.find_element_by_content_description("Your story")
            if your_story:
                await self.tap(your_story[0], your_story[1], wait_after=2500)
                return True

        # Look for story tray
        story_tray = self.find_element_by_resource_id(
            "com.instagram.android:id/reel_viewer_avatar"
        )
        if story_tray:
            await self.tap(story_tray[0] + (index * 90), story_tray[1], wait_after=2500)
            return True

        # Fallback: tap at calculated position (stories are at top)
        await self.tap(x_offset, 200, wait_after=2500)
        return True

    async def open_create_menu(self) -> bool:
        """Open Instagram create/post menu.
        ig_ui_map: Create (+) bounds [0,128][127,275] center (63,201)
        The container resource-id 'action_bar_buttons_container_left' is unreliable --
        it's a layout wrapper, not the clickable icon. Use content-desc instead."""
        await self.get_screen()

        create_btn = self.find_element_by_content_description(
            "Create"
        ) or self.find_element_by_content_description("New post")

        if create_btn and create_btn[0] < 400:
            await self.tap(create_btn[0], create_btn[1], wait_after=2000)
            return True

        # ADB-VERIFIED: Create (+) center (63, 201) from ig_ui_map
        await self.tap(63, 201, wait_after=2000)
        return True

    async def select_gallery_item(self, index: int = 0) -> bool:
        """Select an item from the gallery grid."""
        await self.get_screen()

        # Gallery items are in a grid, typically 3 columns
        # First row starts around y=400, each item is about 350px tall
        col = index % 3
        row = index // 3

        x = 180 + (col * 360)
        y = 500 + (row * 360)

        await self.tap(x, y, wait_after=2000)
        self.log("INFO", f"Selected gallery item at position {index}")
        return True

    # ==================== VERIFICATION HELPERS ====================

    async def verify_on_reels_tab(self) -> bool:
        """Verify we're on the Reels tab."""
        await self.get_screen()
        if not self.current_screen:
            return False

        # Reels has specific surface IDs. The bottom-nav clips_tab exists on
        # every Instagram screen, so only accept it when selected.
        if (
            self.element_exists(resource_id="com.instagram.android:id/root_clips_layout")
            or self.element_exists(
                resource_id="com.instagram.android:id/clips_viewer_view_pager"
            )
            or self.element_exists(
                resource_id="com.instagram.android:id/clips_viewer_container"
            )
        ):
            return True

        return bool(
            re.search(
                r'resource-id="com\.instagram\.android:id/clips_tab"[^>]*selected="true"',
                self.current_screen,
                re.DOTALL,
            )
            or re.search(
                r'selected="true"[^>]*resource-id="com\.instagram\.android:id/clips_tab"',
                self.current_screen,
                re.DOTALL,
            )
        )

    async def verify_post_success(self) -> bool:
        """Verify a post was shared successfully."""
        await self.get_screen()
        return (
            self.text_on_screen("Sharing")
            or self.text_on_screen("Posted")
            or self.text_on_screen("Shared")
            or (
                self.element_exists(resource_id="com.instagram.android:id/tab_bar")
                and not self.text_on_screen("Share")
            )
        )

    async def verify_comment_posted(self) -> bool:
        """Verify a comment was posted."""
        await self.wait(1000)
        await self.get_screen()
        # After posting, the "Post" button should be gone or we're back in feed
        return not self.element_exists(
            resource_id="com.instagram.android:id/layout_comment_thread_post_button"
        ) or self.text_on_screen("Reply")

    async def is_in_story_view(self) -> bool:
        """Check if we're viewing a story."""
        await self.get_screen()
        return (
            self.text_on_screen("Reply")
            or self.text_on_screen("Send message")
            or self.find_element_by_content_description_exact("Send message or reaction")
            or self.find_element_by_content_description_exact("Like Story")
            or self.element_exists(
                resource_id="com.instagram.android:id/reel_viewer_root"
            )
            or self.element_exists(
                resource_id="com.instagram.android:id/reel_viewer_content_layout"
            )
            or self.element_exists(
                resource_id="com.instagram.android:id/reel_viewer_media_layout"
            )
            or self.element_exists(
                resource_id="com.instagram.android:id/reel_viewer_media_container"
            )
            or self.element_exists(
                resource_id="com.instagram.android:id/message_composer_container"
            )
            or self.element_exists(
                resource_id="com.instagram.android:id/toolbar_like_button"
            )
            or self.element_exists(
                resource_id="com.instagram.android:id/reel_viewer_reply_bar"
            )
            or self.element_exists(
                resource_id="com.instagram.android:id/reel_viewer_message_composer"
            )
            or self.element_exists(
                resource_id="com.instagram.android:id/reel_viewer_view_root"
            )
            or self.element_exists(resource_id="com.instagram.android:id/story_ring")
        )

    async def is_in_dm_inbox(self) -> bool:
        """Check if we're in the DM inbox."""
        await self.get_screen()
        return (
            self.text_on_screen("Messages")
            or self.text_on_screen("Primary")
            or self.text_on_screen("General")
            or self.text_on_screen("Requests")
            or self.element_exists(
                resource_id="com.instagram.android:id/action_bar_inbox_button"
            )
            or self.element_exists(
                resource_id="com.instagram.android:id/direct_inbox_action_bar"
            )
            or self.element_exists(
                resource_id="com.instagram.android:id/igds_action_bar_title"
            )
            or self.element_exists(
                resource_id="com.instagram.android:id/inbox_refreshable_thread_list_recyclerview"
            )
            or self.element_exists(
                resource_id="com.instagram.android:id/row_inbox_container"
            )
        )

    async def find_follow_button(self) -> Optional[Tuple[int, int]]:
        """Find a Follow button on screen (not Following)."""
        await self.get_screen()

        follow_coords = (
            self.find_element_by_resource_id("com.instagram.android:id/inline_follow_button")
            or self.find_element_by_text("Follow", exact=True)
        )

        if follow_coords:
            return follow_coords

        if self.current_screen and any(
            "profile_header_follow_button" in node
            and re.search(r'(?:text|content-desc)="[^"]*Follow[^"]*"', node, re.IGNORECASE)
            and "following" not in node.lower()
            for node in re.findall(r"<node[^>]+>", self.current_screen, re.IGNORECASE)
        ):
            return self.find_element_by_resource_id(
                "com.instagram.android:id/profile_header_follow_button"
            )

        return None

    async def find_following_button(self) -> Optional[Tuple[int, int]]:
        """Find a Following button on screen."""
        await self.get_screen()
        following_coords = self.find_element_by_text(
            "Following", exact=True
        ) or self.find_element_by_content_description("Following")
        if following_coords:
            return following_coords

        if self.current_screen and any(
            "profile_header_follow_button" in node
            and re.search(
                r'(?:text|content-desc)="[^"]*Following[^"]*"',
                node,
                re.IGNORECASE,
            )
            for node in re.findall(r"<node[^>]+>", self.current_screen, re.IGNORECASE)
        ):
            return self.find_element_by_resource_id(
                "com.instagram.android:id/profile_header_follow_button"
            )
        return None

    def find_first_resource_id(
        self, resource_ids: List[str]
    ) -> Optional[Tuple[int, int]]:
        """Find the first available element from a list of resource IDs."""
        for resource_id in resource_ids:
            coords = self.find_element_by_resource_id(resource_id)
            if coords:
                return coords
        return None

    async def find_like_button(self) -> Optional[Tuple[int, int]]:
        """Find a visible feed, reels, or story Like button."""
        await self.get_screen()
        return (
            self.find_first_resource_id(
                [
                    "com.instagram.android:id/row_feed_button_like",
                    "com.instagram.android:id/like_button",
                    "com.instagram.android:id/reel_viewer_like_button",
                    "com.instagram.android:id/toolbar_like_button",
                ]
            )
            or self.find_element_by_content_description_exact("Like")
            or self.find_element_by_content_description_exact("Like Story")
            or self.find_element_by_text("Like", exact=True)
        )

    async def find_comment_button(self) -> Optional[Tuple[int, int]]:
        """Find a visible feed or reels Comment button."""
        await self.get_screen()
        return (
            self.find_first_resource_id(
                [
                    "com.instagram.android:id/row_feed_button_comment",
                    "com.instagram.android:id/comment_button",
                ]
            )
            or self.find_element_by_content_description_exact("Comment")
            or self.find_element_by_text("Comment", exact=True)
        )

    async def find_share_button(self) -> Optional[Tuple[int, int]]:
        """Find a visible feed or reels share/send button."""
        await self.get_screen()
        return (
            self.find_first_resource_id(
                [
                    "com.instagram.android:id/row_feed_button_share",
                    "com.instagram.android:id/direct_share_button",
                    "com.instagram.android:id/share_button",
                ]
            )
            or self.find_element_by_content_description_exact("Share")
            or self.find_element_by_content_description_exact("Send")
        )

    # ==================== PROFILE MANAGEMENT ====================

    async def get_profile_list(self) -> List[Dict[str, str]]:
        """Get list of GrapheneOS profiles via pm list users."""
        result = await self.shell("pm list users")

        profiles = []
        # Parse output: UserInfo{0:Owner:c13} running
        pattern = r"UserInfo\{(\d+):([^:]+):"

        if self.current_screen:  # Shell result comes back in screen
            matches = re.findall(pattern, self.current_screen)
            for user_id, name in matches:
                profiles.append({"id": user_id, "name": name})

        return profiles

    async def switch_profile(self, profile_id: str) -> bool:
        """Switch to a GrapheneOS profile."""
        self.log("INFO", f"Switching to profile {profile_id}")
        await self.shell(f"am switch-user {profile_id}")
        await self.wait(3000)  # Wait for profile switch
        return True

    # ==================== FILE OPERATIONS ====================

    async def push_file(self, local_path: str, remote_path: str) -> bool:
        """Push file to device."""
        self.log("INFO", f"Pushing file to {remote_path}")
        return await self._send_command(
            "push_file",
            {"local_path": local_path, "remote_path": remote_path},
            get_screen=False,
        )

    async def pull_file(self, remote_path: str, local_path: str) -> bool:
        """Pull file from device."""
        self.log("INFO", f"Pulling file from {remote_path}")
        return await self._send_command(
            "pull_file",
            {"remote_path": remote_path, "local_path": local_path},
            get_screen=False,
        )

    async def take_screenshot(self, save_to: str = None) -> str:
        """Take screenshot and optionally save to path."""
        return await self._send_command(
            "screenshot", {"save_to": save_to}, get_screen=False
        )
