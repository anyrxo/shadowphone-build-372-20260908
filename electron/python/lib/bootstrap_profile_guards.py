"""
Reusable verified guards for bootstrap/account/profile progression.

Goals:
- centralize small verified-state checks already used in scattered modules
- keep behavior additive, logging-oriented, and production-safe
- support both Appium-driver and adb-ui-dump based modules
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional
import time
import re
import asyncio

from lib.instagram_screen_classifier import (
    classify_instagram_screen,
    IG_HOME,
    IG_PROFILE,
    IG_ACCOUNT_SWITCHER,
    IG_PROFILE_PICKER_OR_SETTINGS,
    IG_POPUP_OR_CHALLENGE,
)
from lib.screen_state import ScreenObservation
from modules.ig_selectors import InstagramSelectors


@dataclass
class VerifiedStateResult:
    ok: bool
    screen_type: str
    confidence: str
    reasons: list[str] = field(default_factory=list)
    context_label: str = ""


class BootstrapProfileGuards:
    def __init__(self, observation_builder: Callable[[], ScreenObservation], log: Optional[Callable[[str], None]] = None):
        self._observation_builder = observation_builder
        self._log = log or print

    def _emit(self, message: str):
        try:
            self._log(message)
        except Exception:
            pass

    def classify_current_screen(self):
        return classify_instagram_screen(observation=self._observation_builder())

    def verify_state(self, expected_screen: str, context_label: str) -> VerifiedStateResult:
        try:
            classification = self.classify_current_screen()
            self._emit(
                f"{context_label}: classified {classification.screen_type} ({classification.confidence})"
            )
            return VerifiedStateResult(
                ok=classification.screen_type == expected_screen,
                screen_type=classification.screen_type,
                confidence=classification.confidence,
                reasons=list(classification.reasons or []),
                context_label=context_label,
            )
        except Exception as e:
            self._emit(f"{context_label}: classifier unavailable or inconclusive ({e})")
            return VerifiedStateResult(False, "unknown", "low", [], context_label)

    def verify_home_ready(self) -> VerifiedStateResult:
        return self.verify_state(IG_HOME, "Home/bootstrap verification")

    def verify_profile_tab(self) -> VerifiedStateResult:
        return self.verify_state(IG_PROFILE, "Profile tab verification")

    def verify_account_switcher(self) -> VerifiedStateResult:
        return self.verify_state(IG_ACCOUNT_SWITCHER, "Account switcher verification")

    def verify_profile_picker_or_settings(self) -> VerifiedStateResult:
        return self.verify_state(
            IG_PROFILE_PICKER_OR_SETTINGS,
            "Profile/settings picker verification",
        )

    def verify_target_account_active(self, target_username: str) -> VerifiedStateResult:
        normalized_target = re.sub(r'^@+', '', str(target_username or '').strip()).lower()
        if not normalized_target:
            return VerifiedStateResult(False, 'unknown', 'low', ['missing target username'], 'Target account verification')

        try:
            observation = self._observation_builder()
            xml = str(getattr(observation, 'xml_source', '') or '')
            classification = classify_instagram_screen(observation=observation)

            username_title_id = re.escape(InstagramSelectors.PROFILE_HEADER_IDS['username_title'])
            profile_picture_suffix = re.escape(InstagramSelectors.PROFILE_HEADER_CONTENT_DESC_PATTERNS['profile_picture_suffix'])
            username_patterns = [
                rf'text="(@?{re.escape(normalized_target)})"[^>]*resource-id="{username_title_id}"',
                rf'content-desc="(@?{re.escape(normalized_target)}), {profile_picture_suffix}"',
                rf'text="(@?{re.escape(normalized_target)})"',
            ]
            matched_username = any(re.search(pattern, xml, re.IGNORECASE) for pattern in username_patterns)
            profile_ok = classification.screen_type == IG_PROFILE

            if matched_username and profile_ok:
                return VerifiedStateResult(
                    ok=True,
                    screen_type='ig_target_account_active',
                    confidence='high',
                    reasons=[f'target username visible: {normalized_target}', 'profile tab verified'],
                    context_label='Target account verification',
                )

            if matched_username:
                return VerifiedStateResult(
                    ok=True,
                    screen_type='ig_target_account_visible',
                    confidence='medium',
                    reasons=[f'target username visible: {normalized_target}', f'screen={classification.screen_type}'],
                    context_label='Target account verification',
                )

            return VerifiedStateResult(
                ok=False,
                screen_type=classification.screen_type,
                confidence=classification.confidence,
                reasons=[f'target username not confirmed: {normalized_target}', *list(classification.reasons or [])],
                context_label='Target account verification',
            )
        except Exception as e:
            self._emit(f'Target account verification: classifier unavailable or inconclusive ({e})')
            return VerifiedStateResult(False, 'unknown', 'low', [str(e)], 'Target account verification')

    def confirm_target_account_with_recovery(
        self,
        target_username: str,
        recovery_action: Optional[Callable[[], bool]] = None,
        settle_seconds: float = 1.0,
    ) -> VerifiedStateResult:
        first = self.verify_target_account_active(target_username)
        if first.ok and first.confidence == 'high':
            return first

        if recovery_action:
            try:
                recovered = recovery_action()
                if recovered:
                    time.sleep(settle_seconds)
                    second = self.verify_target_account_active(target_username)
                    if second.ok:
                        second.reasons = [*list(second.reasons or []), 'post-switch recovery confirmation applied']
                    return second
            except Exception as e:
                self._emit(f'Target account recovery attempt failed: {e}')

        return first

    async def nudge_via_existing_nav(
        self,
        primary_action: Optional[Callable[[], Awaitable[bool] | bool]] = None,
        fallback_action: Optional[Callable[[], Awaitable[bool] | bool]] = None,
    ) -> bool:
        for action in (primary_action, fallback_action):
            if not action:
                continue
            try:
                result = action()
                if asyncio.iscoroutine(result):
                    result = await result
                if result:
                    return True
            except Exception as e:
                self._emit(f"Navigation nudge failed: {e}")
        return False

    async def confirm_target_account_with_async_recovery(
        self,
        target_username: str,
        recovery_action: Optional[Callable[[], object]] = None,
        settle_seconds: float = 1.0,
    ) -> VerifiedStateResult:
        first = self.verify_target_account_active(target_username)
        if first.ok and first.confidence == 'high':
            return first

        if recovery_action:
            try:
                recovered = recovery_action()
                if asyncio.iscoroutine(recovered):
                    recovered = await recovered
                if recovered:
                    await asyncio.sleep(settle_seconds)
                    second = self.verify_target_account_active(target_username)
                    if second.ok:
                        second.reasons = [*list(second.reasons or []), 'post-switch recovery confirmation applied']
                    return second
            except Exception as e:
                self._emit(f'Target account recovery attempt failed: {e}')

        return first

    def ensure_home_with_retry(
        self,
        navigate_home: Callable[[], bool],
        popup_dismiss: Optional[Callable[[], bool]] = None,
        popup_assess: Optional[Callable[[], object]] = None,
        nudge_action: Optional[Callable[[], bool]] = None,
        attempts: int = 2,
        settle_seconds: float = 2.5,
        verify_after_navigation: Optional[Callable[[], bool]] = None,
    ) -> bool:
        for _attempt in range(1, attempts + 1):
            if not navigate_home():
                continue
            time.sleep(settle_seconds)
            if verify_after_navigation:
                try:
                    if verify_after_navigation():
                        return True
                except Exception as e:
                    self._emit(f"⚠️ Guard semantic post-navigation verification failed: {e}")
            state = self.verify_home_ready()
            if state.ok:
                return True
            if state.screen_type == IG_POPUP_OR_CHALLENGE:
                assessment = None
                if popup_assess:
                    try:
                        assessment = popup_assess()
                        self._emit(
                            f"⚠️ Guard popup/challenge assessment: category={getattr(assessment, 'category', 'unknown')}, confidence={getattr(assessment, 'confidence', 'low')}, reasons={getattr(assessment, 'reasons', [])}"
                        )
                    except Exception as e:
                        self._emit(f"⚠️ Guard popup assessment failed: {e}")
                if popup_dismiss and getattr(assessment, 'category', 'unknown_popup') != 'blocker_like':
                    try:
                        self._emit("⚠️ Guard detected popup/challenge during bootstrap, attempting dismiss...")
                        popup_dismiss()
                        time.sleep(1.0)
                    except Exception:
                        pass
                elif nudge_action:
                    try:
                        self._emit("⚠️ Guard detected non-dismissable popup/challenge, attempting one bounded navigation nudge...")
                        nudge_action()
                        time.sleep(1.0)
                    except Exception:
                        pass
        return False
