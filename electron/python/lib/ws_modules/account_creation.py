# Module: account_creation
# Lean Instagram account-creation flow built from a live walkthrough on a
# fresh GrapheneOS profile (2026-05-20). Replaces the legacy ~1700-line
# execute_account_creation_ws path with content-desc / resource-id first
# lookups, polled validations, and an inbox-snippet code retrieval that
# skips the email-open step entirely.
#
# Pipeline:
#   1. Enumerate Gmail accounts on the active profile (open Gmail, scrape).
#   2. If target email not on profile, log in via the existing Gmail flow.
#   3. Launch IG, log out if a session is active.
#   4. Tap "Create new account" -> "Sign up with email".
#   5. Type email, advance.
#   6. Fetch 6-digit code from Gmail INBOX SNIPPET (not the opened email).
#   7. Back to IG, type code, advance.
#   8. Adaptive loop handling password / birthday / name / username
#      whichever order IG presents them.
#   9. Accept terms, sweep post-signup onboarding (Skip notif/contacts/PFP).
#
# At every major transition we check for IG's "Confirm you're human"
# challenge screen and bail with `manual_action_required: True` if seen.

import asyncio
import re
import random
from typing import Optional

from lib.ws_modules_shared import WSDeviceAdapter


# ── IG signup landmarks (verified live 2026-05-20 on Pixel 6, IG 412.x) ──
# content-desc strings IG uses; checked in order. Falling through to text
# matches keeps us alive if a build rotates the accessibility labels.
SIGNUP_BUTTON_DESCS = ("Create new account",)
EMAIL_PATH_DESCS = ("Sign up with email",)
NEXT_DESCS = ("Next",)
IAGREE_DESCS = ("I agree",)

# Skip labels used across the post-signup onboarding stack.
SKIP_LABELS = ("Skip", "SKIP", "Not now", "Don't allow", "Don’t allow")
ALLOW_LABELS = ("Allow", "Allow all", "Allow only while using the app")

# Checkpoint detector — apostrophes are normalised before checking.
CHECKPOINT_PHRASES = (
    "confirm you're human to use your account",
    "confirm you are human to use your account",
)


# ── Small helpers ─────────────────────────────────────────────────────


def _coerce_bool(value, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        n = value.strip().lower()
        if n in ("true", "1", "yes", "y", "on"):
            return True
        if n in ("false", "0", "no", "n", "off"):
            return False
    return default


def _normalize(text: str) -> str:
    return (text or "").lower().replace("’", "'").replace("‘", "'")


# Persistent log file — shared helper now lives in lib/persistent_log.py
# so every module gets the same logging behavior. Output:
#   <userData>/logs/account_creation.log
from lib.persistent_log import ModuleLogger

_LOG = ModuleLogger("account_creation")


async def _log(device: WSDeviceAdapter, msg: str) -> None:
    """Best-effort progress log; persists to <userData>/logs/account_creation.log
    so users can ship the file when a flow breaks."""
    await _LOG.log(device, msg)


async def _progress(device: WSDeviceAdapter, pct: int, msg: str) -> None:
    await _LOG.progress(device, pct, msg)


async def _refresh(device: WSDeviceAdapter) -> str:
    await device.refresh_screen(force=True)
    return device.page_source or ""


async def _is_checkpoint(device: WSDeviceAdapter, xml: Optional[str] = None) -> bool:
    """Detect IG's 'Confirm you're human' challenge."""
    if xml is None:
        xml = await _refresh(device)
    norm = _normalize(xml)
    if not any(phrase in norm for phrase in CHECKPOINT_PHRASES):
        return False
    # Only fire on the actual challenge screen — the phrase must coexist
    # with a Continue CTA and live inside the IG package.
    return (
        ("content-desc=\"continue\"" in norm or "text=\"continue\"" in norm)
        and "package=\"com.instagram.android\"" in norm
    )


def _checkpoint_error(stage: str) -> dict:
    return {
        "success": False,
        "error": (
            "Instagram checkpoint detected: 'Confirm you're human to use your "
            "account'. Manual verification/2FA is required."
        ),
        "data": {
            "checkpoint": "ig_confirm_human",
            "stage": stage,
            "manual_action_required": True,
        },
    }


async def _wait_for(
    device: WSDeviceAdapter,
    predicate,
    label: str,
    *,
    steps=(300, 200, 200, 200, 300, 500),
) -> bool:
    """Poll the screen until predicate(xml) returns truthy, or steps exhaust."""
    for delay in steps:
        await asyncio.sleep(delay / 1000.0)
        xml = await _refresh(device)
        if predicate(xml):
            return True
    print(f"[account_creation] WAIT FAILED: {label}")
    return False


async def _tap_by_desc(
    device: WSDeviceAdapter, descs, *, wait_after: float = 0.3
) -> bool:
    for desc in descs:
        el = await device.find_element_by_content_desc(desc)
        if el:
            await device.click(el)
            await asyncio.sleep(wait_after)
            return True
    return False


async def _tap_by_text(
    device: WSDeviceAdapter, texts, *, wait_after: float = 0.3
) -> bool:
    for text in texts:
        el = await device.find_element_by_text(text)
        if el:
            await device.click(el)
            await asyncio.sleep(wait_after)
            return True
    return False


async def _tap_label(
    device: WSDeviceAdapter, labels, *, wait_after: float = 0.3
) -> bool:
    """Try content-desc then text for the same label set."""
    if await _tap_by_desc(device, labels, wait_after=wait_after):
        return True
    return await _tap_by_text(device, labels, wait_after=wait_after)


async def _tap_first_edittext(device: WSDeviceAdapter) -> bool:
    """Tap the first EditText on screen to focus it."""
    el = await device.find_element_by_class("android.widget.EditText")
    if not el:
        return False
    await device.click(el)
    await asyncio.sleep(0.15)
    return True


async def _type(
    device: WSDeviceAdapter, text: str, typing_mode: str = "instant"
) -> None:
    await device.send_keys(text, typing_mode=typing_mode)
    if typing_mode == "human":
        await asyncio.sleep(random.uniform(0.35, 0.9))
    else:
        await asyncio.sleep(0.15)


async def _brute_clear(device: WSDeviceAdapter, max_chars: int = 80) -> None:
    """Clear focused EditText by jumping to end + spamming KEYCODE_DEL.

    device.clear() uses Ctrl+A via input keyevent --meta-state which we
    proved live (2026-05-20 on hahn_berg) does NOT reliably select text
    on IG's prism EditText / Android's NumberPicker EditText. The field
    shows selected="true" but DEL only consumes one char. Subsequent
    send_keys then APPENDS to the existing value — so the birthday year
    becomes '20262002' instead of '2002', date gets nonsense, etc.

    Brute backspace is slow but deterministic. We MOVE_END first so the
    cursor sits at the end of any text, then send `max_chars` DELs in a
    single shell loop (one ADB round trip total, not N).
    """
    await device.shell("input keyevent 123")  # KEYCODE_MOVE_END
    await asyncio.sleep(0.05)
    await device.shell(
        f"i=0; while [ $i -lt {max_chars} ]; do input keyevent 67; i=$((i+1)); done"
    )
    await asyncio.sleep(0.15)


async def _clear_field(device: WSDeviceAdapter) -> None:
    # Backwards-compat shim — callers should prefer _brute_clear with an
    # explicit char budget when they know the field's max length.
    await _brute_clear(device, max_chars=80)


# ── Gmail account enumeration ─────────────────────────────────────────


GMAIL_PKG = "com.google.android.gm"
IG_PKG = "com.instagram.android"


async def _gmail_accounts_on_profile(device: WSDeviceAdapter) -> list[str]:
    """Enumerate Gmail accounts present on the currently active profile.

    Uses `dumpsys account` filtered by the foreground Android user —
    we don't need to open Gmail at all. Validated live 2026-05-20 on
    user 34: dumpsys correctly shows the per-profile accounts even
    when adb is running as user 0, as long as we grep the right
    `User UserInfo{N:...}` block.

    Previously this opened Gmail, tapped the profile picker, and
    scraped XML — added 3-5s of unnecessary UI flicker. Anyro
    explicitly asked to skip the Gmail step since the sign-in goes
    through Settings anyway.
    """
    accounts: list[str] = []
    try:
        current_user = (await device.shell("am get-current-user") or "0").strip() or "0"
        # Match the `User UserInfo{N:...}` block for the foreground user
        # and capture every `Account {name=...@..., type=com.google}`
        # entry inside it. The dumpsys output is grouped per-user so
        # we just need the right starting block.
        dump = await device.shell("dumpsys account") or ""
        block_pat = re.compile(
            r"User UserInfo\{" + re.escape(current_user) + r":[^}]+\}:(.*?)(?:User UserInfo\{|\Z)",
            re.DOTALL,
        )
        m_block = block_pat.search(dump)
        if m_block:
            block = m_block.group(1)
            for m in re.finditer(
                r"Account\s*\{\s*name=([^,\s]+@[A-Za-z0-9_.+\-]+),\s*type=com\.google\}",
                block,
            ):
                addr = m.group(1).strip().lower()
                if addr not in accounts:
                    accounts.append(addr)
    except Exception as e:
        await _log(device, f"Gmail enum failed: {e}")
    return accounts


# ── Inbox-snippet code retrieval (fast path) ──────────────────────────


# The IG verification email lands as a row whose preview text starts with
# the 6-digit code immediately followed by " is your Instagram code". The
# subject TextView (com.google.android.gm:id/subject) gives us bounds we
# can sort by y-coord to pick the most-recent email if multiple exist.
_INBOX_CODE_NODE_RE = re.compile(
    r'<node[^>]*text="(\d{6})\s+is your Instagram code"'
    r'[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
    re.IGNORECASE,
)
# Fallback when the node-with-bounds match misses (e.g. attribute reorder).
_INBOX_CODE_RE = re.compile(
    r"(\d{6})\s+is your Instagram code", re.IGNORECASE
)


def _pick_topmost_ig_code(xml: str) -> Optional[str]:
    """Find every IG code row in the inbox XML, return the one with the
    smallest top-y bound (= most recent, top of the list)."""
    matches: list[tuple[int, str]] = []
    for m in _INBOX_CODE_NODE_RE.finditer(xml or ""):
        code = m.group(1)
        top_y = int(m.group(3))
        matches.append((top_y, code))
    if matches:
        matches.sort(key=lambda x: x[0])
        return matches[0][1]
    # Fallback: take the FIRST occurrence in the XML (uiautomator dumps
    # are top-to-bottom in DOM order, so first ≈ topmost).
    m = _INBOX_CODE_RE.search(xml or "")
    return m.group(1) if m else None


async def _fetch_ig_code_via_inbox_snippet(
    device: WSDeviceAdapter, signup_email: str, *, max_wait_s: float = 45.0
) -> Optional[str]:
    """Open Gmail, poll the inbox listing for the IG code, return it.

    Reads the listing text directly — no need to open the email. Verified
    live: IG includes the code in the email subject + first sentence.
    Picks the topmost (most-recent) row when the inbox already contains
    historical codes for the same Gmail address.
    """
    # Use direct `am start` instead of WSDeviceAdapter.launch_app which
    # bakes in a 2-second sleep after the command. We do our own settle
    # via the loop's first refresh_screen.
    await device.shell(
        f"am start -n com.google.android.gm/.ConversationListActivityGmail"
    )
    await asyncio.sleep(0.7)

    # Dismiss the Gmail first-launch stack. Verified live order on a
    # fresh profile after Google sign-in:
    #   GOT IT (welcome tour) -> Save your recovery email -> (sometimes)
    #   Add your home address -> TAKE ME TO GMAIL -> Allow notifications
    #   prompt -> Meet "Got it" card -> inbox.
    # Each branch taps and IMMEDIATELY continues — the next iteration's
    # _refresh (500-800ms uiautomator dump) is the settle for the
    # previous tap. The legacy 0.4-0.6s post-tap sleeps stacked on top
    # of that ~700ms refresh + the click's internal 0.2-0.4s pause, so
    # each screen burned 1.3-1.8s when 0.7-1.2s is enough.
    for _ in range(8):
        xml = await _refresh(device)
        norm_lower = _normalize(xml)

        # If we see the inbox already, bail the dismiss loop fast.
        if (
            "search in mail" in norm_lower
            or "com.google.android.gm:id/conversation_list_view" in (xml or "")
            or ("primary" in norm_lower and "social" in norm_lower)
        ):
            break

        # GOT IT (welcome tour)
        el = await device.find_element_by_id(
            "com.google.android.gm:id/welcome_tour_got_it"
        )
        if el:
            await device.click(el)
            continue

        # "Save your recovery email" prompt — appears right after I agree.
        if "save your recovery email" in norm_lower or "save recovery email" in norm_lower:
            if not await _tap_label(
                device, ("Skip", "Not now", "Not Now", "Later"), wait_after=0.0
            ):
                await device.back()
            continue

        # "Set/Add home address" — Google's address capture screen.
        if (
            "home address" in norm_lower
            and ("skip" in norm_lower or "set address" in norm_lower or "add address" in norm_lower)
        ):
            if not await _tap_label(
                device, ("Skip", "Not now", "Not Now", "Later"), wait_after=0.0
            ):
                await device.back()
            continue

        # TAKE ME TO GMAIL.
        if "take me to gmail" in norm_lower:
            el = await device.find_element_by_id(
                "com.google.android.gm:id/action_done"
            )
            if not el:
                el = await device.find_element_by_text("TAKE ME TO GMAIL")
            if el:
                await device.click(el)
                continue

        # Android notification-permission system prompt — always Deny.
        if (
            "send you notifications" in norm_lower
            or 'permission_deny_button' in (xml or "")
        ):
            deny = await device.find_element_by_id(
                "com.android.permissioncontroller:id/permission_deny_button"
            )
            if deny:
                await device.click(deny)
                continue
            if await _tap_label(
                device,
                ("Don't allow", "Don’t allow", "Deny", "No thanks"),
                wait_after=0.0,
            ):
                continue

        # Meet "Got it" card.
        if "google meet" in norm_lower or "got it" in norm_lower:
            el = await device.find_element_by_id(
                "com.google.android.gm:id/next_button"
            )
            if not el:
                el = await device.find_element_by_text("Got it")
            if el:
                await device.click(el)
                continue

        # Nothing actionable AND not on inbox — Gmail may still be
        # rendering. Brief wait before the next round.
        await asyncio.sleep(0.25)

    # Now we're on the inbox. Poll the XML for the code text node.
    elapsed = 0.0
    interval = 1.5
    while elapsed < max_wait_s:
        xml = await _refresh(device)
        code = _pick_topmost_ig_code(xml)
        if code:
            await _log(device, f"📧 IG code captured from inbox snippet: {code}")
            return code

        # Pull-to-refresh by swiping down on the inbox list.
        await device.swipe(540, 600, 540, 1400, 300)
        await asyncio.sleep(interval)
        elapsed += interval
        # Back off the swipe interval a touch each round.
        interval = min(3.0, interval + 0.4)

    return None


# ── IG signup walk-through ────────────────────────────────────────────


async def _ensure_ig_logged_out(device: WSDeviceAdapter) -> None:
    """If IG home screen is showing, log out so we can hit signup."""
    xml = await _refresh(device)
    norm = _normalize(xml)
    if "your story" not in norm and "tab_bar" not in norm:
        return
    await _log(device, "Existing IG session detected; logging out…")
    # Profile tab
    await device.tap(972, 2274)
    await asyncio.sleep(0.4)
    # Hamburger menu
    await device.tap(996, 202)
    await asyncio.sleep(0.4)
    # Scroll until "Log out" or "Log out all accounts" appears.
    logout_el = None
    for _ in range(6):
        await device.swipe(540, 1800, 540, 600, 350)
        await asyncio.sleep(0.2)
        xml = await _refresh(device)
        logout_el = await device.find_element_by_text("Log out all accounts")
        if logout_el:
            break
        logout_el = await device.find_element_by_text("Log out")
        if logout_el:
            break
    if not logout_el:
        await _log(device, "Could not find Log out button — aborting logout sweep")
        return
    await device.click(logout_el)
    await asyncio.sleep(0.5)
    # Confirm dialog
    confirm = await device.find_element_by_text("Log out")
    if confirm:
        await device.click(confirm)
        await asyncio.sleep(0.8)


async def _dismiss_system_permission_dialog(device: WSDeviceAdapter) -> None:
    """Clear Android 13+ runtime-permission dialogs (POST_NOTIFICATIONS etc.)
    that pop over IG's first launch on a fresh profile. Until dismissed they
    cover the launch screen — the root cause of the "Could not find
    'Create new account' button" failure. Verified live 2026-05-21: a fresh
    profile shows "Allow Instagram to send you notifications?" on top of the
    IG signup screen. Any choice clears it; we tap the allow/deny button by
    its stable resource-id."""
    for _ in range(4):
        xml = await _refresh(device) or ""
        if "com.android.permissioncontroller" not in xml:
            return
        m = re.search(
            r'resource-id="com\.android\.permissioncontroller:id/permission_(?:allow|deny)_button"'
            r'[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
            xml,
        )
        if m:
            x1, y1, x2, y2 = (int(v) for v in m.groups())
            await device.tap((x1 + x2) // 2, (y1 + y2) // 2)
            await asyncio.sleep(0.7)
        else:
            await device.back()
            await asyncio.sleep(0.4)


async def _tap_create_new_account(device: WSDeviceAdapter) -> bool:
    """Tap 'Create new account' on the IG launch / login screen."""
    if await _tap_by_desc(device, SIGNUP_BUTTON_DESCS, wait_after=0.6):
        return True
    return await _tap_by_text(
        device, ("Create new account", "Sign up"), wait_after=0.6
    )


async def _tap_sign_up_with_email(device: WSDeviceAdapter) -> bool:
    if await _tap_by_desc(device, EMAIL_PATH_DESCS, wait_after=0.5):
        return True
    return await _tap_by_text(device, ("Sign up with email",), wait_after=0.5)


async def _tap_next(device: WSDeviceAdapter, *, wait_after: float = 0.6) -> bool:
    if await _tap_by_desc(device, NEXT_DESCS, wait_after=wait_after):
        return True
    return await _tap_by_text(device, ("Next", "NEXT"), wait_after=wait_after)


async def _set_birthday(
    device: WSDeviceAdapter, year: int, month: int, day: int
) -> bool:
    """Type values directly into the NumberPicker EditTexts (fast path).

    The IG date picker uses three NumberPickers (month, day, year). Each
    has an embedded EditText that accepts direct text input — this is far
    faster than tapping +/- buttons or swiping the wheels.
    """
    xml = await _refresh(device)
    # Each NumberPicker exposes an EditText at android:id/numberpicker_input.
    edits = re.findall(
        r'class="android.widget.EditText"[^>]*resource-id="android:id/numberpicker_input"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
        xml or "",
    )
    if len(edits) < 3:
        # Fall back to alternate attribute order
        edits = re.findall(
            r'resource-id="android:id/numberpicker_input"[^>]*class="android.widget.EditText"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
            xml or "",
        )
    if len(edits) < 3:
        await _log(device, "Birthday picker EditTexts not found")
        return False

    # Order on screen is left-to-right; the IG picker shows month, day, year.
    fields = [
        ((int(b[0]) + int(b[2])) // 2, (int(b[1]) + int(b[3])) // 2) for b in edits[:3]
    ]
    # Map calendar month index -> short name as the picker displays "May" etc.
    month_short = (
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    )[max(1, min(12, int(month))) - 1]

    # Month — brute-clear is mandatory; device.clear() does not actually
    # select+delete on NumberPicker EditTexts and send_keys would append
    # to the existing value (e.g. 'May' + 'Jun' -> 'MayJun', which the
    # picker silently rejects and reverts).
    await device.tap(fields[0][0], fields[0][1])
    await asyncio.sleep(0.2)
    await _brute_clear(device, max_chars=6)
    await device.send_keys(month_short)
    await asyncio.sleep(0.15)
    # Day (1-2 digit value; clear up to 4 chars to cover the worst case
    # of typing into a 2-digit field that already had 2 digits).
    await device.tap(fields[1][0], fields[1][1])
    await asyncio.sleep(0.15)
    await _brute_clear(device, max_chars=4)
    await device.send_keys(str(max(1, min(31, int(day)))))
    await asyncio.sleep(0.15)
    # Year (4 digits — clear 6 chars for safety).
    await device.tap(fields[2][0], fields[2][1])
    await asyncio.sleep(0.15)
    await _brute_clear(device, max_chars=6)
    await device.send_keys(str(int(year)))
    await asyncio.sleep(0.15)

    # SET button — resource-id is android:id/button1.
    set_btn = await device.find_element_by_id("android:id/button1")
    if not set_btn:
        # Last-ditch text fallback
        set_btn = await device.find_element_by_text("SET")
    if not set_btn:
        await _log(device, "Birthday SET button not found")
        return False

    await device.click(set_btn)
    await asyncio.sleep(0.6)
    return True


async def _adaptive_signup_loop(
    device: WSDeviceAdapter,
    *,
    password: str,
    ig_name: str,
    ig_username_hint: Optional[str],
    birthday: tuple[int, int, int],
) -> tuple[bool, Optional[str], Optional[dict]]:
    """Walk the post-code IG screens in whatever order they're presented.

    Returns (terms_reached, final_username, checkpoint_error_payload).
    """
    final_username: Optional[str] = None
    password_done = False
    name_done = False
    username_done = False
    birthday_done = False

    for round_idx in range(10):
        xml = await _refresh(device)
        norm = _normalize(xml)

        if await _is_checkpoint(device, xml):
            return False, final_username, _checkpoint_error(
                f"adaptive_loop_round_{round_idx}"
            )

        # Terms screen -> end of adaptive section.
        if (
            "by tapping i agree" in norm
            or "agree to instagram" in norm
            or "agree to instagram's terms" in norm
        ):
            return True, final_username, None

        # ── Password
        if not password_done and ("create a password" in norm):
            await _progress(device, 55, "Setting password…")
            await _tap_first_edittext(device)
            await _type(device, password)
            await _tap_next(device, wait_after=0.5)
            password_done = True
            continue

        # ── Birthday picker
        if not birthday_done and (
            "what's your birthday" in norm or "set date" in norm
        ):
            await _progress(device, 63, "Setting birthday…")
            ok = await _set_birthday(device, *birthday)
            if not ok:
                return False, final_username, {
                    "success": False,
                    "error": "Could not set birthday",
                }
            # IG then shows a confirmation screen with the resolved age.
            # Tap Next on it.
            await asyncio.sleep(0.4)
            await _tap_next(device, wait_after=0.5)
            birthday_done = True
            continue

        # ── Full name
        if not name_done and (
            "what's your name" in norm or "full name" in norm
        ):
            await _progress(device, 70, "Setting name…")
            await _tap_first_edittext(device)
            await _type(device, ig_name, typing_mode="human")
            await _tap_next(device, wait_after=0.6)
            name_done = True
            continue

        # ── Username — IG usually pre-fills based on the email local part.
        if not username_done and (
            "create a username" in norm or "add a username" in norm
        ):
            await _progress(device, 76, "Confirming username…")
            # Read whatever IG pre-filled.
            current_uname = _extract_prefilled_username(xml)
            ok_marker = "input username is valid" in norm

            if current_uname and ok_marker and not ig_username_hint:
                # Happy path: IG suggested a username and it's already
                # validated. No need to retype or wait.
                final_username = current_uname
                await _tap_next(device, wait_after=0.6)
                username_done = True
                continue

            # If IG already pre-filled a username but the validity marker
            # hasn't rendered yet (slow network), give it a brief poll
            # before deciding to overwrite — the pre-fill is almost
            # always good and re-typing over it makes the run look more
            # bot-like (which is one of IG's flag triggers on fresh
            # accounts).
            if current_uname and not ig_username_hint:
                for _step_ms in (200, 200, 300, 300):
                    if ok_marker:
                        break
                    await asyncio.sleep(_step_ms / 1000.0)
                    xml = await _refresh(device)
                    norm = _normalize(xml)
                    ok_marker = "input username is valid" in norm
                if ok_marker:
                    final_username = current_uname
                    await _tap_next(device, wait_after=0.6)
                    username_done = True
                    continue

            # Caller-supplied a specific hint OR IG didn't pre-fill — we
            # have to type. Use brute-clear because device.clear() does
            # not actually empty the prism EditText (proven live; the
            # value would otherwise get APPENDED to whatever IG put
            # there, producing invalid handles).
            candidate = ig_username_hint or current_uname or (
                ig_name.lower().replace(" ", ".") if ig_name else "user"
            )
            for attempt in range(4):
                if attempt > 0:
                    candidate = f"{(ig_username_hint or candidate)[:24]}{random.randint(10, 9999)}"
                edit = await device.find_element_by_class(
                    "android.widget.EditText"
                )
                if edit:
                    await device.click(edit)
                    await asyncio.sleep(0.2)
                await _brute_clear(device, max_chars=40)
                await _type(device, candidate)

                # Poll for IG's verdict — green tick or error — instead
                # of blind-sleeping. Most builds answer in 400-900ms.
                verdict = None
                for step in (300, 200, 200, 200, 300, 300):
                    await asyncio.sleep(step / 1000.0)
                    xml = await _refresh(device)
                    nn = _normalize(xml)
                    if (
                        "input username is valid" in nn
                        or "username available" in nn
                    ):
                        verdict = "ok"
                        break
                    if (
                        "isn't available" in nn
                        or "is not available" in nn
                        or "not available" in nn
                        or "already taken" in nn
                    ):
                        verdict = "err"
                        break

                if verdict == "ok":
                    final_username = candidate
                    break
                if verdict is None:
                    # No clear signal — accept and move on; IG will reject
                    # later if there's a real conflict.
                    final_username = candidate
                    break

            await _tap_next(device, wait_after=0.6)
            username_done = True
            continue

        # Unknown screen — try a generic Next, otherwise bail.
        if await _tap_next(device, wait_after=0.5):
            await _log(
                device, f"Adaptive: unknown screen (round {round_idx}); tapped Next"
            )
            continue
        break

    return False, final_username, None


def _extract_prefilled_username(xml: str) -> Optional[str]:
    """Grab the username IG auto-suggested from the EditText content-desc."""
    m = re.search(
        r'content-desc="Username,([^"]+)"\s+checkable',
        xml or "",
    )
    if m:
        return m.group(1).strip()
    # Alternate: text="zarahahn144" inside an EditText
    m2 = re.search(
        r'<node[^>]*class="android.widget.EditText"[^>]*text="([^"]+)"',
        xml or "",
    )
    if m2:
        candidate = m2.group(1).strip()
        if candidate and "@" not in candidate and " " not in candidate:
            return candidate
    return None


# ── Post-signup onboarding sweep ──────────────────────────────────────


async def _finish_post_signup(
    device: WSDeviceAdapter, *, max_rounds: int = 10
) -> Optional[dict]:
    """Dismiss the onboarding stack. Returns checkpoint payload if hit."""
    for round_idx in range(max_rounds):
        xml = await _refresh(device)
        norm = _normalize(xml)

        if await _is_checkpoint(device, xml):
            return _checkpoint_error(f"post_signup_round_{round_idx}")

        # Already on the logged-in shell.
        if (
            "your story" in norm
            or "tab_bar" in norm
            or "com.instagram.android:id/feed_tab" in norm
        ):
            return None

        acted = False

        # Notifications onboarding screen — IG-side Skip.
        if "turn on notifications" in norm:
            await _tap_label(device, ("Skip", "SKIP", "Not now"), wait_after=0.5)
            acted = True

        # Contacts onboarding screen.
        elif (
            "allow access to your contacts" in norm
            or "sync your contacts" in norm
            or "connect_contacts_sync_button" in xml
        ):
            await _tap_label(device, ("Next", "NEXT", "Skip"), wait_after=0.5)
            acted = True

        # Android permission dialog for contacts/photos/notifications.
        elif "permissioncontroller" in xml.lower():
            # Always Deny — we run hands-off.
            await _tap_label(
                device,
                ("Don't allow", "Don’t allow", "Deny"),
                wait_after=0.6,
            )
            acted = True

        # Profile photo onboarding — Skip is in the TOP-RIGHT corner on
        # this screen family (bounds [949,170][1038,233] on Pixel 6,
        # verified live). _tap_label with text 'Skip' usually finds the
        # right one even without coords; the resource-id skip_button is
        # the more reliable selector but isn't always present.
        elif (
            "add a profile picture" in norm
            or "add profile photo" in norm
            or "add a photo" in norm
        ):
            if not await _tap_first(
                device,
                rids=("com.instagram.android:id/skip_button",),
                descs=("Skip",),
                texts=("Skip", "SKIP", "Not now"),
                wait_after=0.5,
            ):
                # Top-right Skip fallback for the modern PFP layout.
                await device.tap(993, 201)
                await asyncio.sleep(0.5)
            acted = True

        # "Add a mobile number" — same top-right Skip pattern.
        elif (
            "add a mobile number" in norm
            or "what's your mobile number" in norm
            or "enter the mobile number where you can be contacted" in norm
        ):
            if not await _tap_first(
                device,
                rids=("com.instagram.android:id/skip_button",),
                descs=("Skip",),
                texts=("Skip", "SKIP", "Not now"),
                wait_after=0.5,
            ):
                await device.tap(993, 201)
                await asyncio.sleep(0.5)
            acted = True

        # "Follow N or more people" suggestion screen — top-right Skip.
        elif (
            "follow 5 or more people" in norm
            or ("follow" in norm and "or more people" in norm)
            or "following isn't required" in norm
        ):
            if not await _tap_first(
                device,
                rids=("com.instagram.android:id/skip_button",),
                descs=("Skip",),
                texts=("Skip", "SKIP", "Not now"),
                wait_after=0.5,
            ):
                await device.tap(993, 201)
                await asyncio.sleep(0.5)
            acted = True

        # Swipe-nav tip / "Got it" card that fires once after onboarding.
        elif (
            "swipe to easily access" in norm
            or "we've simplified our navigation" in norm
        ):
            if not await _tap_label(
                device, ("Got it", "OK", "Continue"), wait_after=0.5
            ):
                # The card's primary CTA sometimes lives at the bottom-
                # center; tap there as a fallback.
                await device.tap(540, 2173)
                await asyncio.sleep(0.5)
            acted = True

        # Generic onboarding card with a primary button labelled Continue.
        elif "lets get started" in norm or "start customizing your experience" in norm:
            await asyncio.sleep(0.4)
            acted = True

        if not acted:
            # Last-resort: try a Skip tap anywhere on the screen.
            if not await _tap_label(
                device, ("Skip", "Not now", "Cancel"), wait_after=0.4
            ):
                # Nothing actionable; give the shell another moment to load.
                await asyncio.sleep(0.3)

    return None


async def _tap_first(
    device: WSDeviceAdapter,
    *,
    rids: tuple = (),
    descs: tuple = (),
    texts: tuple = (),
    wait_after: float = 0.4,
) -> bool:
    """Try each selector in order; tap the first that resolves.

    Mirrors the pattern used in edit_profile.py — resource-id is the
    most stable selector, then content-desc, then visible text.
    """
    for rid in rids:
        el = await device.find_element_by_id(rid)
        if el:
            await device.click(el)
            await asyncio.sleep(wait_after)
            return True
    for desc in descs:
        el = await device.find_element_by_content_desc(desc)
        if el:
            await device.click(el)
            await asyncio.sleep(wait_after)
            return True
    for text in texts:
        el = await device.find_element_by_text(text)
        if el:
            await device.click(el)
            await asyncio.sleep(wait_after)
            return True
    return False


# ── Pre-grant media permission ────────────────────────────────────────
#
# Validated live 2026-05-20 on lilojung299 (user 34). Path:
#   1. Profile tab (content-desc="Profile" or coord 972, 2274)
#   2. "Create New" button on profile header (content-desc="Create New",
#      top-LEFT bounds [0,128][127,275] center ~63, 201). Not top-right.
#   3. Bottom sheet -> tap "Create new reel" (content-desc) — any of
#      Create new {post,reel,story} triggers the media-permission
#      prompt; reel is the path our own post modules use most.
#   4. System permission dialog: resource-id
#      com.android.permissioncontroller:id/permission_allow_all_button
#      Tap Allow all.
#   5. IG opens its media picker — back out twice to return to profile.
#
# Pre-granting on the fresh account in the SAME session as signup is
# safer than waiting for the post module to handle it later: this run
# already passed IG's bot-checks (we're on home, account is alive), so
# adding one tap-Allow is low risk vs hitting the popup mid-post which
# is when accounts seem to get flagged.


async def _pregrant_ig_media_permission(device: WSDeviceAdapter) -> bool:
    """Walk Profile -> Create New -> Reel -> Allow all to pre-grant
    IG's media permission so post modules don't trip on it later.
    Best-effort: returns False on any miss; the caller treats this as
    non-fatal."""
    try:
        # 1. Profile tab.
        profile_tab = await device.find_element_by_content_desc("Profile")
        if profile_tab:
            await device.click(profile_tab)
        else:
            await device.tap(972, 2274)
        await asyncio.sleep(1.2)

        # 2. Create New button on profile header (top-LEFT, not top-right).
        create_btn = await device.find_element_by_content_desc("Create New")
        if not create_btn:
            await _log(device, "Pre-grant: Create New button not found on profile")
            return False
        await device.click(create_btn)
        await asyncio.sleep(1.0)

        # 3. Bottom sheet — tap "Create new reel" (or fallback to post).
        for label in ("Create new reel", "Create new post", "Create new story"):
            tap_target = await device.find_element_by_content_desc(label)
            if tap_target:
                await device.click(tap_target)
                break
        else:
            await _log(device, "Pre-grant: create-sheet option not found")
            await device.back()
            return False

        # 4. Wait for permission popup to render and tap Allow all.
        for _ in range(8):
            await asyncio.sleep(0.5)
            xml = await _refresh(device)
            allow_all = await device.find_element_by_id(
                "com.android.permissioncontroller:id/permission_allow_all_button"
            )
            if allow_all:
                await device.click(allow_all)
                await _log(device, "✅ Media permission pre-granted (Allow all)")
                await asyncio.sleep(0.8)
                break
            if "permissioncontroller" not in (xml or "").lower():
                # Picker opened directly (permission was already granted)
                await _log(device, "Pre-grant: media permission already granted")
                break
        else:
            await _log(device, "Pre-grant: Allow all button never rendered")

        # 5. Back out twice to return to profile.
        await asyncio.sleep(0.4)
        await device.back()
        await asyncio.sleep(0.4)
        await device.back()
        await asyncio.sleep(0.4)
        return True
    except Exception as e:
        await _log(device, f"Pre-grant media permission failed: {e}")
        return False


# ── Native Google sign-in (replaces legacy execute_gmail_login_ws) ───
#
# Verified live 2026-05-20 against a fresh GrapheneOS user 33
# (berghahn198@gmail.com). The path:
#
#   1. am start -a android.settings.ADD_ACCOUNT_SETTINGS
#      -> ChooseAccountActivity with rows: Google / Exchange / IMAP / POP3
#   2. Tap the "Google" row.
#      -> com.google.android.gms/MinuteMaidActivity loads a Chromium
#         webview with the Google sign-in page.
#   3. Email field: <EditText resource-id="identifierId" hint="Email or phone">
#      Tap it, type the email, tap Next.
#   4. Password field: container has resource-id="password", inside it is
#      an <EditText password="true" hint="Enter your password">.
#      Type password, tap Next.
#   5. Terms screen: <Button text="I agree"> in MinuteMaidActivity.
#   6. Follow-up modals (any of):
#        - "Save your recovery email" -> Skip
#        - "Add/Set home address" -> Skip
#        - Random GMS popups -> Skip / Not now
#
# Bypasses the legacy 500-line execute_gmail_login_ws helper which has
# its own slow + sometimes-infinite-loop dismiss sweep on the Gmail
# Welcome activity. Our path goes straight through Settings so we never
# touch Gmail's welcome flow at all — the account ends up on the
# profile and Gmail just sees it on first launch.

GMS_PKG = "com.google.android.gms"
SETTINGS_PKG = "com.android.settings"


def _google_security_wall_error(norm: str):
    """If `norm` (normalized screen text) is one of Google's anti-abuse
    walls that automation cannot pass — phone/SMS verification, device
    confirmation — return a clean failure dict so the caller bails fast
    with an actionable message instead of hanging on a screen with no
    password / terms / modal it recognises. Otherwise return None.

    Verified live 2026-05-21: signing a Gmail into a fresh profile can
    trip "Verify your phone number / There is something unusual about
    your activity". No module can pass SMS verification."""
    if (
        "verify your phone number" in norm
        or "something unusual about your activity" in norm
        or ("verify it" in norm and "device or phone number" in norm)
    ):
        return {
            "success": False,
            "error": (
                "Google flagged this sign-in for phone verification "
                "(\"unusual activity\"). Automation cannot pass SMS "
                "verification — verify this account's phone once "
                "manually, or use a pre-warmed account on a trusted "
                "profile/IP."
            ),
        }
    return None


async def _google_signin_via_settings(
    device: WSDeviceAdapter,
    email: str,
    password: str,
    recovery_email: str = "",
) -> dict:
    """Add a Google account to the active Android user via Settings.

    Returns {success: bool, error?: str}. Never raises — failures are
    caught and surfaced via the dict.
    """
    try:
        # Force-stop residual Google/Gmail/Settings before launching.
        for pkg in (SETTINGS_PKG, GMS_PKG, GMAIL_PKG):
            try:
                await device.shell(f"am force-stop {pkg}")
            except Exception:
                pass
        await asyncio.sleep(0.5)

        # 1) Open the add-account picker.
        await device.shell(
            "am start -a android.settings.ADD_ACCOUNT_SETTINGS"
        )

        # 2) Wait for ChooseAccountActivity to render, THEN tap "Google".
        # The previous build polled once after a 1s sleep and silently
        # fell through if neither marker matched — so on slow profiles
        # we'd skip the Google tap entirely and end up waiting for
        # MinuteMaid identifiers that never load. Now we poll for up to
        # ~6s and only fall through if we land directly on MinuteMaid
        # (rare; some single-account-type builds skip the picker).
        google_tapped = False
        for picker_attempt in range(12):
            await asyncio.sleep(0.5)
            xml = await _refresh(device)
            norm = _normalize(xml)
            if re.search(r'resource-id="identifierId"', xml or "") or "minute_maid" in norm:
                # Skipped straight to the sign-in webview (no picker shown).
                # Detect by the email field / minute_maid container resource-id —
                # the activity name "MinuteMaidActivity" is NOT in uiautomator
                # dumps (the dump is the view hierarchy, not the activity).
                break
            if "chooseaccountactivity" in norm or (
                "google" in norm and ("exchange" in norm or "personal (imap)" in norm)
            ):
                google_row = await device.find_element_by_text("Google")
                if not google_row:
                    # Could be on the picker but with a localized "Google"
                    # label — retry once more.
                    continue
                await device.click(google_row)
                google_tapped = True
                break

        if not google_tapped:
            _picker_xml = await _refresh(device)
            _on_signin_webview = bool(
                re.search(r'resource-id="identifierId"', _picker_xml or "")
            ) or "minute_maid" in _normalize(_picker_xml)
            if not _on_signin_webview:
                return {
                    "success": False,
                    "error": (
                        "Account picker (ChooseAccountActivity) didn't render "
                        "after 6s — Settings may have crashed or this profile "
                        "doesn't have GMS installed correctly."
                    ),
                }

        # 3) Wait for the Google sign-in webview to render the email field.
        # Detect the field directly by regexing for resource-id="identifierId"
        # in the uiautomator dump. Confirmed live 2026-05-21: the dump contains
        #   <node resource-id="identifierId" class="android.widget.EditText"
        #         bounds="[63,905][1015,1052]" hint="Email or phone" />
        #
        # The previous code gated this on the literal string "minutemaidactivity"
        # appearing in the dump. That is the ACTIVITY name — and a uiautomator
        # dump contains only the VIEW HIERARCHY (packages, resource-ids,
        # classes, text), never the activity name. So the gate never opened and
        # the run failed "did not render the email field" even with identifierId
        # fully present. Cold GMS load on a fresh profile takes up to ~30s
        # (50 iterations × 0.6s).
        identifier_found = False
        for _ in range(50):
            await asyncio.sleep(0.6)
            xml = await _refresh(device)
            if re.search(r'resource-id="identifierId"', xml or ""):
                identifier_found = True
                break

        if not identifier_found:
            foreground = "unknown"
            try:
                fg = await device.shell(
                    "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'"
                )
                foreground = (fg or "").strip().replace("\n", " ")[:160]
            except Exception:
                pass
            return {
                "success": False,
                "error": (
                    "Google sign-in webview did not render the email "
                    f"field within 30s (foreground={foreground})"
                ),
            }

        # Type email with verify-and-retry. Anyro hit this live twice:
        # webview renders identifierId before it's interactive, send_keys
        # types into limbo, field stays empty.
        #
        # Strategy:
        #   1. Get the exact center coords from the identifier_el bounds
        #      (don't trust the element ref after a re-render).
        #   2. Tap, wait 1.5s for the keyboard to slide up and webview to
        #      accept focus.
        #   3. Type via `input text` shell directly (bypass WSDeviceAdapter
        #      wrapper to eliminate any extra hops).
        #   4. Verify by re-reading identifierId's text= attribute. A
        #      non-empty value is success.
        #   5. On failure, tap a different point first to break focus,
        #      brute-clear, then re-tap and retry. Up to 4 attempts.
        #   6. Log the XML snippet on each failed attempt for diagnosis.
        async def _type_email_with_verify() -> bool:
            # Re-resolve coords each loop in case the webview reflows.
            for attempt in range(4):
                xml_pre = await _refresh(device)
                m_id = re.search(
                    r'<node[^>]*resource-id="identifierId"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                    xml_pre or "",
                )
                if not m_id:
                    await _log(
                        device,
                        f"Attempt {attempt + 1}: identifierId disappeared from XML",
                    )
                    await asyncio.sleep(1.0)
                    continue

                cx = (int(m_id.group(1)) + int(m_id.group(3))) // 2
                cy = (int(m_id.group(2)) + int(m_id.group(4))) // 2

                # Break focus first on retries (tap an empty area).
                if attempt > 0:
                    await device.tap(cx, 400)  # tap above the field
                    await asyncio.sleep(0.3)
                    await _brute_clear(device, max_chars=len(email) + 10)

                await device.tap(cx, cy)
                # Generous focus + keyboard-slide budget. 1.5s is the
                # measured worst case on a cold Pixel webview.
                await asyncio.sleep(1.5)

                await device.send_keys(email)
                await asyncio.sleep(0.7)

                # Verify by re-reading identifierId's text or content-desc.
                xml_after = await _refresh(device)
                m_check = re.search(
                    r'<node[^>]*resource-id="identifierId"[^>]*?(?:text|content-desc)="([^"]*)"',
                    xml_after or "",
                )
                got_text = m_check.group(1) if m_check else ""
                # Some webviews surface the value in content-desc with
                # extra label prefix ("Email or phone, lilojung299@gmail.com").
                # Match either exact or contains.
                if email.lower() in (got_text or "").lower() or email.lower() in (
                    xml_after or ""
                ).lower():
                    return True

                await _log(
                    device,
                    f"Email not registered (attempt {attempt + 1}/4) — "
                    f"field text was [REDACTED length={len(got_text)}]; retrying",
                )

            return False

        if not await _type_email_with_verify():
            return {
                "success": False,
                "error": (
                    "Could not get email into the Google sign-in field "
                    "after 4 attempts — webview may not be accepting "
                    "input. Check the phone screen: is the keyboard "
                    "showing? Is there a system prompt covering the "
                    "webview?"
                ),
            }

        # Tap Next. Webview Next button is sometimes rendered just
        # below the keyboard ribbon; allow a couple retries to handle
        # the brief animation as the keyboard slides up.
        next_tapped = False
        for _ in range(4):
            if await _tap_label(device, ("Next",), wait_after=0.6):
                next_tapped = True
                break
            await asyncio.sleep(0.4)
        if not next_tapped:
            return {
                "success": False,
                "error": "Could not tap Next after email",
            }

        # 4) Wait for the password screen and type. The webview navigates
        # email -> password, which can take 1-3s depending on network.
        # Worst case allowed: 16 × 0.5s = 8s before bailing.
        password_typed = False
        for _ in range(30):
            xml = await _refresh(device)
            norm = _normalize(xml)
            # Anti-abuse wall (phone verification) — bail cleanly.
            wall = _google_security_wall_error(norm)
            if wall:
                return wall
            # reCAPTCHA "Verify it's you / I'm not a robot" interstitial.
            # Google interjects this between the email and password
            # screens on untrusted profiles. The checkbox passes on a
            # single tap (verified live 2026-05-21); an image challenge
            # cannot be solved by automation.
            if "not a robot" in norm or "recaptcha" in norm:
                if "select all" in norm or "images with" in norm:
                    return {
                        "success": False,
                        "error": (
                            "Google escalated to a reCAPTCHA image "
                            "challenge — automation can't solve it. Use "
                            "a trusted profile/IP or a pre-warmed account."
                        ),
                    }
                m_cb = re.search(
                    r'resource-id="recaptcha-anchor"[^>]*'
                    r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                    xml or "",
                )
                if m_cb:
                    cx = (int(m_cb.group(1)) + int(m_cb.group(3))) // 2
                    cy = (int(m_cb.group(2)) + int(m_cb.group(4))) // 2
                    await _log(device, "reCAPTCHA — tapping 'I'm not a robot'")
                    await device.tap(cx, cy)
                    await asyncio.sleep(2.5)
                    continue
            if (
                "couldn't find your google account" in norm
                or "couldn't find your account" in norm
            ):
                return {
                    "success": False,
                    "error": f"Google says it can't find account {email}",
                }
            if "wrong password" in norm:
                return {
                    "success": False,
                    "error": "Google says the password is wrong",
                }
            # Detect the password container via resource-id.
            if 'resource-id="password"' in (xml or ""):
                # The actual EditText is a child of the container; it's
                # the EditText with password="true" attribute.
                m = re.search(
                    r'<node[^>]*password="true"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                    xml or "",
                )
                pw_cx = pw_cy = None
                if m:
                    pw_cx = (int(m.group(1)) + int(m.group(3))) // 2
                    pw_cy = (int(m.group(2)) + int(m.group(4))) // 2

                # Same retry-with-verify pattern as email — webview field
                # can render before it's interactive, especially right
                # after navigation from the email screen.
                for attempt in range(3):
                    if pw_cx is not None:
                        await device.tap(pw_cx, pw_cy)
                    await asyncio.sleep(0.9 if attempt == 0 else 0.6)
                    await device.send_keys(password)
                    await asyncio.sleep(0.6)
                    xml_after = await _refresh(device)
                    # Best-effort dot-readback. A masked password field inside a
                    # Chromium webview usually does NOT expose its value — or
                    # even a dot string — in a uiautomator dump. So a missing
                    # dot string does NOT mean the password failed to type.
                    dots = re.search(r'text="(•+|\*+|·+)"', xml_after or "")
                    if dots and len(dots.group(1)) >= len(password) - 1:
                        password_typed = True
                        break
                    # No readable dots. If this is the last attempt, accept it
                    # anyway — we sent the keystrokes, and a genuinely wrong
                    # password is caught downstream by the "wrong password"
                    # detection. The old code brute-cleared + retried on every
                    # miss, looping forever backspacing a password that WAS
                    # entered (the field visibly showed the dots on-device).
                    if attempt >= 2:
                        await _log(
                            device,
                            "Password dot-readback unavailable — proceeding; "
                            "wrong-password is verified downstream",
                        )
                        password_typed = True
                        break
                    await _log(
                        device,
                        f"Password readback inconclusive (attempt {attempt + 1}/3) — retyping",
                    )
                    await _brute_clear(device, max_chars=len(password) + 10)
                if password_typed:
                    break
            await asyncio.sleep(0.5)

        if not password_typed:
            return {
                "success": False,
                "error": "Password screen never appeared after email Next",
            }

        # Tap Next after password — retry briefly since the password
        # field also slides with the keyboard.
        next_after_pw = False
        for _ in range(4):
            if await _tap_label(device, ("Next",), wait_after=0.7):
                next_after_pw = True
                break
            await asyncio.sleep(0.4)
        if not next_after_pw:
            return {
                "success": False,
                "error": "Could not tap Next after password",
            }

        # 5) Terms screen. Has 'I agree' button. Some accounts skip this
        # if they've previously agreed to the same terms elsewhere. The
        # terms webview also has a non-trivial load time — allow up to
        # 12s (24 × 0.5s) before treating absence as "no terms shown".
        terms_handled = False
        for _ in range(24):
            await asyncio.sleep(0.5)
            xml = await _refresh(device)
            norm = _normalize(xml)
            # Phone-verification wall can also fire AFTER the password
            # (Google's "unusual activity" check) — bail cleanly here too.
            wall = _google_security_wall_error(norm)
            if wall:
                return wall
            if "i agree" in norm or "agree and continue" in norm:
                if await _tap_label(
                    device, ("I agree", "Agree and continue", "Accept"),
                    wait_after=0.8,
                ):
                    terms_handled = True
                    break
            # If terms got skipped we may already be on a follow-up screen.
            if (
                "save your recovery email" in norm
                or "save recovery email" in norm
                or "home address" in norm
                or "couldn't sign you in" in norm
            ):
                terms_handled = True
                break
            # If the Google sign-in webview root (yDmH0d) is gone, sign-in is done.
            # (Activity names like "MinuteMaidActivity" never appear in
            # uiautomator dumps, so yDmH0d is the only reliable signal.)
            if "yDmH0d" not in (xml or ""):
                terms_handled = True
                break

        # 6) Follow-up modals — recovery options, home address, phone,
        # final Done card. These show INCONSISTENTLY (Google's quirk):
        # sometimes all 3 fire, sometimes 1, sometimes none. We poll
        # at 0.4s intervals (fast enough to feel snappy) and use a
        # consecutive-idle counter so we bail after 2 rounds with no
        # actionable screen detected. Worst case: 12 rounds × 0.4s =
        # 4.8s before we give up — but typical: 2-4 rounds for the
        # screens that DO fire.
        idle_rounds = 0
        for _ in range(12):
            xml = await _refresh(device)
            norm = _normalize(xml)

            # Bail as soon as we're back on a terminal surface
            # (launcher / Play Store / Gmail inbox).
            if (
                "launcher3" in (xml or "")
                or "quickstep" in (xml or "")
                or "AssetBrowserActivity" in (xml or "")  # play store
                or ("primary" in norm and "search in mail" in norm)
            ):
                break

            # Account Recovery Options screen — title is "Make sure you
            # can always sign in" with phone + recovery email fields and
            # Save / Cancel buttons. Verified live 2026-05-20 on user 35:
            # Google pre-fills the recovery email field if it was provided
            # to the sign-in flow, so we just tap Save. If we didn't
            # provide one, the field is empty and Save advances anyway.
            if (
                "make sure you can always sign in" in norm
                or "account recovery options" in norm
                or "your recovery info is used to reach you" in norm
            ):
                if recovery_email:
                    # Pre-fill the recovery email field if it's not
                    # already filled. The field with hint "Enter recovery
                    # email" — find by text or class.
                    if recovery_email.lower() not in (xml or "").lower():
                        # Try to find the recovery-email EditText and type.
                        edits = re.findall(
                            r'<node[^>]*class="android\.widget\.EditText"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                            xml or "",
                        )
                        # Pick the LAST EditText (recovery email field is
                        # below the phone field in the layout).
                        if edits:
                            x1, y1, x2, y2 = edits[-1]
                            cx = (int(x1) + int(x2)) // 2
                            cy = (int(y1) + int(y2)) // 2
                            await device.tap(cx, cy)
                            await asyncio.sleep(0.8)
                            await _brute_clear(device, max_chars=80)
                            await device.send_keys(recovery_email)
                            await asyncio.sleep(0.4)
                # Tap Save (button bottom-right) — falls back to Skip if
                # Save is greyed out (no fields filled and not provided).
                if not await _tap_first(
                    device,
                    texts=("Save",),
                    descs=("Save",),
                    wait_after=0.6,
                ):
                    await _tap_first(
                        device,
                        texts=("Skip", "Not now", "Cancel"),
                        descs=("Skip", "Cancel"),
                        wait_after=0.6,
                    )
                idle_rounds = 0
                continue

            # Home address capture screen — title is "Set a home address".
            # Skip button is content-desc="Skip" (NOT text="Skip" — the
            # button has no text label, just the desc). Use _tap_first
            # which tries content-desc before text.
            if (
                "set a home address" in norm
                or ("home address" in norm and "personalize" in norm)
            ):
                if not await _tap_first(
                    device,
                    descs=("Skip",),
                    texts=("Skip", "Not now", "Later"),
                    wait_after=0.6,
                ):
                    await device.back()
                idle_rounds = 0
                continue

            # Phone-only step — sometimes Google shows JUST the phone
            # field as a separate screen ("Add phone number to your
            # account?" / "Add a recovery phone").
            if (
                "add a recovery phone" in norm
                or "add phone number" in norm
                or ("phone number" in norm and "skip" in norm)
            ):
                if not await _tap_first(
                    device,
                    descs=("Skip",),
                    texts=("Skip", "Not now", "No thanks"),
                    wait_after=0.6,
                ):
                    await device.back()
                idle_rounds = 0
                continue

            # MinuteMaid 'Done' / final confirmation.
            if await _tap_label(
                device, ("More", "Done"), wait_after=0.4
            ):
                idle_rounds = 0
                continue

            # Nothing actionable on this round. If we hit 2 consecutive
            # idle rounds AND the foreground isn't a Google/Settings
            # surface, the modals are done — sign-in is complete.
            idle_rounds += 1
            if idle_rounds >= 2:
                low_xml = (xml or "").lower()
                # uiautomator dumps never contain activity names — detect the
                # sign-in stack by the GMS package, Settings package, or the
                # Google webview root (yDmH0d).
                in_signin_stack = (
                    "com.google.android.gms" in low_xml
                    or "com.android.settings/" in low_xml
                    or "yDmH0d" in (xml or "")  # Google sign-in webview root
                )
                if not in_signin_stack:
                    break
            await asyncio.sleep(0.4)

        # Close MinuteMaid / Settings to clear the foreground for our
        # downstream IG launch.
        for pkg in (SETTINGS_PKG, GMS_PKG):
            try:
                await device.shell(f"am force-stop {pkg}")
            except Exception:
                pass
        await asyncio.sleep(0.3)

        # Verify the account landed via dumpsys.
        try:
            current_user = (await device.shell("am get-current-user") or "0").strip()
            dump = await device.shell(
                f"dumpsys account | grep -A3 'User UserInfo{{{current_user}'"
            ) or ""
            if email.lower() in (dump or "").lower():
                return {"success": True, "data": {"verified": True}}
        except Exception:
            pass

        # Couldn't verify but no error along the way — call it success.
        return {"success": True, "data": {"verified": False}}

    except Exception as e:
        return {"success": False, "error": f"Google sign-in error: {e}"}


# ── Public entrypoint ─────────────────────────────────────────────────


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """WSDeviceAdapter entrypoint for the `account_creation` module.

    Config keys:
        email           (required)
        password        (required when create_ig)
        name / ig_name  (required when create_ig)
        ig_username     (optional override; usually IG's pre-fill is fine)
        recovery_email  (passed to nested gmail_login)
        create_ig       (bool, default True)
        skip_gmail_login (bool, default False)
        use_custom_birthday + birthday_month/day/year — defaults to a
            random adult age (year 2000-2003).
    """
    email = str(config.get("email", "") or "").strip()
    password = str(config.get("password", "") or "").strip()
    ig_name = str(config.get("ig_name", config.get("name", "")) or "").strip()
    ig_username_raw = config.get("ig_username") or config.get("username")
    ig_username_hint = (
        str(ig_username_raw).strip() if ig_username_raw is not None else None
    ) or None
    create_ig = _coerce_bool(config.get("create_ig", True), True)
    skip_gmail_login = _coerce_bool(config.get("skip_gmail_login", False), False)
    gmail_password = str(config.get("gmail_password", "") or "").strip()
    recovery_email = str(config.get("recovery_email", "") or "").strip()

    use_custom_bday = _coerce_bool(config.get("use_custom_birthday", False), False)
    if use_custom_bday:
        bday_year = int(config.get("birthday_year") or 2002)
        bday_month = int(config.get("birthday_month") or 5)
        bday_day = int(config.get("birthday_day") or 15)
    else:
        # Random adult — IG enforces 13+ but flags very-young accounts more.
        bday_year = random.randint(2000, 2003)
        bday_month = random.randint(1, 12)
        bday_day = random.randint(1, 28)

    if not email:
        return {"success": False, "error": "Email is required"}
    if create_ig and not password:
        return {"success": False, "error": "Account password is required"}
    if create_ig and not ig_name:
        return {"success": False, "error": "Name is required"}

    await _progress(device, 5, "Enumerating Gmail accounts on profile…")
    gmail_accounts = await _gmail_accounts_on_profile(device)
    gmail_count = len(gmail_accounts)
    await _log(
        device,
        f"📧 Found {gmail_count} Gmail account{'s' if gmail_count != 1 else ''} on this profile",
    )

    if gmail_count >= 5:
        return {
            "success": False,
            "error": "Profile is full (5 Gmail accounts). Use a different profile.",
        }

    if not create_ig:
        await _progress(device, 100, "Account check complete")
        return {
            "success": True,
            "data": {
                "gmail_count": gmail_count,
                "gmail_slots_left": 5 - gmail_count,
                "accounts": gmail_accounts,
            },
        }

    # ── Gmail login (native — bypasses legacy execute_gmail_login_ws)
    #
    # Previously this delegated to execute_gmail_login_ws in server.py
    # which drove the Gmail Welcome activity and had a slow + sometimes-
    # infinite-loop popup dismiss sweep. We now do the sign-in directly
    # via Settings -> Add account -> Google so we never touch Gmail's
    # first-launch stack at all. ~30s typical vs the legacy's 60-180s.
    effective_pw = gmail_password or password
    email_present = email.lower() in [a.lower() for a in gmail_accounts]
    if not skip_gmail_login and effective_pw and not email_present:
        await _progress(device, 12, f"Adding Google account: {email}…")
        signin_result = await _google_signin_via_settings(
            device, email, effective_pw, recovery_email,
        )
        if not signin_result.get("success"):
            err = str(signin_result.get("error") or "unknown error")
            if not err.lower().startswith("gmail login failed:"):
                err = f"Gmail login failed: {err}"
            return {"success": False, "error": err}
        await _log(device, "✅ Google account added to profile")
    elif email_present:
        await _log(device, f"📧 {email} already on profile, skipping Gmail login")

    # ── IG launch + logout if needed
    await _progress(device, 24, "Launching Instagram…")
    # Force-stop residual Gmail/Settings tasks before launching IG.
    # execute_gmail_login_ws can leave the device on a Google modal
    # (Save recovery email / address capture / account picker), and a
    # bare `am start IG` only brings up IG if its task isn't covered
    # by a higher-priority Google modal owning the foreground.
    for stale_pkg in (GMAIL_PKG, "com.google.android.gms", "com.android.settings"):
        try:
            await device.shell(f"am force-stop {stale_pkg}")
        except Exception:
            pass
    await asyncio.sleep(0.4)

    # Launch IG and verify foreground actually flipped — retry up to 3
    # times with force-stops between attempts. Without this, a residual
    # modal can leave the run silently stuck (Anyro reported "after
    # making the ig or logging into it it doesn't proceed").
    ig_in_foreground = False
    for ig_attempt in range(3):
        await device.shell(
            f"am start -n {IG_PKG}/.activity.MainTabActivity"
        )
        await asyncio.sleep(1.2 if ig_attempt == 0 else 0.6)
        xml = await _refresh(device)
        if "com.instagram.android" in (xml or ""):
            ig_in_foreground = True
            break
        await _log(
            device,
            f"IG not in foreground (attempt {ig_attempt + 1}/3); force-stopping residual apps",
        )
        for stale_pkg in (GMAIL_PKG, "com.google.android.gms", "com.android.settings"):
            try:
                await device.shell(f"am force-stop {stale_pkg}")
            except Exception:
                pass
        await asyncio.sleep(0.3)

    if not ig_in_foreground:
        return {
            "success": False,
            "error": (
                "Could not bring Instagram to the foreground after Gmail "
                "login. A Google modal may still own the screen — try "
                "again, or check the phone for a stuck Save / Address / "
                "Account-picker prompt."
            ),
        }

    await _ensure_ig_logged_out(device)

    # Android 13+ pops a POST_NOTIFICATIONS permission dialog over IG's first
    # launch on a fresh profile; clear it or the launch screen (and the
    # "Create new account" button) stays covered.
    await _dismiss_system_permission_dialog(device)

    # ── Signup entry points
    await _progress(device, 28, "Tapping Create new account…")
    if not await _tap_create_new_account(device):
        return {
            "success": False,
            "error": "Could not find 'Create new account' button",
        }
    if await _is_checkpoint(device):
        return _checkpoint_error("after_signup_entry")

    await _progress(device, 32, "Sign up with email…")
    if not await _tap_sign_up_with_email(device):
        return {
            "success": False,
            "error": "Could not find 'Sign up with email' button",
        }

    # ── Email
    await _progress(device, 36, f"Entering {email}…")
    await _tap_first_edittext(device)
    await _type(device, email)
    await _tap_next(device, wait_after=0.6)
    if await _is_checkpoint(device):
        return _checkpoint_error("after_email")

    # ── Code retrieval (fast path)
    await _progress(device, 42, "Fetching verification code from Gmail inbox…")
    code = await _fetch_ig_code_via_inbox_snippet(device, email)
    if not code:
        await _log(
            device,
            "Inbox-snippet path returned no code; falling back to "
            "RemoteDevice email-open helper",
        )
        try:
            from server import _ig_get_code_from_gmail  # type: ignore
            code = await _ig_get_code_from_gmail(device.device, email)
        except Exception as e:
            await _log(device, f"Fallback code fetch failed: {e}")
            code = None

    if not code:
        return {
            "success": False,
            "error": "Could not retrieve IG verification code from Gmail",
        }

    # Return focus to IG. WSDeviceAdapter.launch_app bakes in a 2-second
    # sleep after the `am start` which dominates the Gmail->IG hand-off.
    # Use direct `am start` here so we control the settle window and can
    # bail as soon as the refresh confirms IG is foreground.
    await _progress(device, 48, "Switching back to Instagram…")
    for return_attempt in range(3):
        await device.shell(
            f"am start -n {IG_PKG}/.activity.MainTabActivity"
        )
        await asyncio.sleep(0.4)
        xml = await _refresh(device)
        if "com.instagram.android" in (xml or ""):
            break
        if return_attempt < 2:
            await _log(
                device,
                f"IG not in foreground after launch (attempt {return_attempt + 1}/3); retrying",
            )
            # Force-close Gmail to clear its task and try again.
            try:
                await device.shell(f"am force-stop {GMAIL_PKG}")
            except Exception:
                pass
            await asyncio.sleep(0.2)

    if await _is_checkpoint(device):
        return _checkpoint_error("ig_resume_for_code")

    # Type code. IG's code field is the only EditText on screen.
    await _progress(device, 50, f"Entering code {code}…")
    await _tap_first_edittext(device)
    await _type(device, code)
    await _tap_next(device, wait_after=0.7)

    if await _is_checkpoint(device):
        return _checkpoint_error("after_code")

    # ── Adaptive: password / birthday / name / username (any order)
    terms_reached, final_username, checkpoint_err = await _adaptive_signup_loop(
        device,
        password=password,
        ig_name=ig_name,
        ig_username_hint=ig_username_hint,
        birthday=(bday_year, bday_month, bday_day),
    )
    if checkpoint_err:
        return checkpoint_err
    if not terms_reached:
        await _log(device, "Adaptive loop exited without reaching terms screen")

    # ── Terms / I agree
    await _progress(device, 82, "Accepting terms…")
    for _ in range(4):
        if await _is_checkpoint(device):
            return _checkpoint_error("terms_loop")
        if await _tap_label(device, IAGREE_DESCS, wait_after=0.9):
            break
        if await _tap_by_text(device, ("I agree",), wait_after=0.9):
            break
        await asyncio.sleep(0.8)

    # ── Onboarding sweep
    await _progress(device, 90, "Sweeping post-signup onboarding…")
    checkpoint_err = await _finish_post_signup(device)
    if checkpoint_err:
        # Account is technically created; flag for manual review.
        return checkpoint_err

    # ── Pre-grant media permission (Profile -> Create New -> Reel ->
    # Allow all). Validated live on lilojung299 — pre-granting in the
    # same session as signup is safer than letting the post module
    # trip on the popup mid-post (which is when accounts seem to get
    # flagged). Best-effort: a miss here doesn't fail the signup.
    await _progress(device, 96, "Pre-granting media permission…")
    try:
        await _pregrant_ig_media_permission(device)
    except Exception as e:
        await _log(device, f"Media permission pre-grant skipped: {e}")

    await _progress(device, 100, "Done!")
    return {
        "success": True,
        "data": {
            "username": final_username or email.split("@")[0],
            "email": email,
            "birthday": f"{bday_year}-{bday_month:02d}-{bday_day:02d}",
        },
    }
