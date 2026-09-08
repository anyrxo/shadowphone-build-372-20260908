"""
Backward-compatible wrapper around reusable bootstrap/profile guards.

This module is retained so existing imports keep working while the shared
helper layer lives in bootstrap_profile_guards.py.
"""

from __future__ import annotations

from lib.bootstrap_profile_guards import BootstrapProfileGuards
from lib.screen_state import ScreenObservation


class InstagramNavigationGuards(BootstrapProfileGuards):
    def __init__(self, driver, device_id: str):
        self.driver = driver
        self.device_id = device_id
        super().__init__(self.build_observation, log=print)

    def build_observation(self) -> ScreenObservation:
        page_source = None
        package = None
        activity = None
        try:
            page_source = self.driver.page_source
        except Exception:
            page_source = None
        try:
            package = self.driver.current_package
        except Exception:
            package = None
        try:
            activity = self.driver.current_activity
        except Exception:
            activity = None
        return ScreenObservation(
            observed_at="driver_snapshot",
            device_id=self.device_id,
            package=package,
            activity=activity,
            xml_source=page_source,
        )


class GuardedInstagramState:
    def __init__(self, screen_type: str, confidence: str, reasons=None):
        self.screen_type = screen_type
        self.confidence = confidence
        self.reasons = list(reasons or [])
