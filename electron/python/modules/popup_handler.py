#!/usr/bin/env python3
"""
🔔 INSTAGRAM POPUP HANDLER
Automatically dismiss popups, promos, and dialogs that interrupt automation

Usage:
    from modules.popup_handler import PopupHandler
    
    handler = PopupHandler(driver)
    handler.dismiss_any_popup()  # Call before any action
"""

try:
    from appium.webdriver.common.appiumby import AppiumBy
except ImportError:
    class AppiumBy:
        ID = "id"
        ACCESSIBILITY_ID = "accessibility id"

try:
    from selenium.webdriver.common.by import By
except ImportError:
    class By:
        XPATH = "xpath"

import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass

from lib.instagram_screen_classifier import classify_instagram_screen, IG_POPUP_OR_CHALLENGE
from lib.screen_state import ScreenObservation

# Import selectors
try:
    from modules.ig_selectors import InstagramSelectors
    SELECTORS_AVAILABLE = True
except ImportError:
    SELECTORS_AVAILABLE = False
    print("⚠️ Instagram selectors not available")


@dataclass
class PopupAssessment:
    present: bool
    category: str
    confidence: str
    reasons: list[str]
    persisted_after_back: bool = False


class PopupHandler:
    """Handle Instagram popups, promos, and dialogs"""
    
    def __init__(self, driver):
        self.driver = driver
        
        # Known popup button selectors (in priority order)
        self.POPUP_BUTTONS = [
            # Promo dialogs (like "Swipe to access Reels")
            "com.instagram.android:id/igds_headline_primary_action_button",
            # Alert dialogs
            "com.instagram.android:id/igds_alert_dialog_primary_button",
            "com.instagram.android:id/igds_alert_dialog_secondary_button",
            # Generic dialogs
            "com.instagram.android:id/primary_button",
            "com.instagram.android:id/secondary_button",
        ]
        
        # Common dismiss text patterns
        self.DISMISS_TEXT = [
            "Got it", "OK", "Dismiss", "Close", "Not Now", 
            "Skip", "Cancel", "Maybe Later", "Done", "I Understand"
        ]
        
        # Dialog container selectors (to detect if popup is present)
        self.DIALOG_CONTAINERS = [
            "com.instagram.android:id/dialog_container",
            "com.instagram.android:id/igds_promo_dialog_headline",
            "com.instagram.android:id/igds_headline_primary_action_button",
            "com.instagram.android:id/igds_headline_image",
            "com.instagram.android:id/modal_container",
            "com.instagram.android:id/overlay_layout_container",
        ]
    
    def _build_observation_from_driver(self):
        """Best-effort Appium observation for classifier usage without changing behavior."""
        try:
            page_source = self.driver.page_source
        except Exception:
            page_source = None

        package = None
        try:
            package = self.driver.current_package
        except Exception:
            package = None

        return ScreenObservation(
            observed_at="driver_snapshot",
            device_id="appium",
            package=package,
            xml_source=page_source,
        )

    def assess_popup_surface(self):
        reasons = []
        try:
            observation = self._build_observation_from_driver()
            classification = classify_instagram_screen(observation=observation)
            xml = str(getattr(observation, 'xml_source', '') or '').lower()
            if classification.screen_type == IG_POPUP_OR_CHALLENGE:
                blocker_markers = [
                    'challenge required',
                    'confirm it\'s you',
                    'help us confirm',
                    'action blocked',
                    'suspended',
                    'try again later',
                ]
                matched_blockers = [marker for marker in blocker_markers if marker in xml]
                if matched_blockers:
                    return PopupAssessment(True, 'blocker_like', 'high', matched_blockers)
                dismissable_markers = [
                    'not now',
                    'allow',
                    'save your login info',
                    'turn on notifications',
                    'ok',
                    'dismiss',
                    'close',
                    'skip',
                ]
                matched_dismissable = [marker for marker in dismissable_markers if marker in xml]
                if matched_dismissable:
                    return PopupAssessment(True, 'dismissable', 'medium', matched_dismissable)
                reasons.append(f'classifier={classification.screen_type}')
                return PopupAssessment(True, 'unknown_popup', classification.confidence, reasons)
        except Exception as e:
            reasons.append(str(e))

        for container_id in self.DIALOG_CONTAINERS:
            try:
                self.driver.find_element(AppiumBy.ID, container_id)
                return PopupAssessment(True, 'dismissable', 'low', [f'container={container_id}'])
            except:
                continue
        return PopupAssessment(False, 'none', 'low', reasons)

    def is_popup_present(self):
        """Check if any popup dialog is currently visible"""
        return self.assess_popup_surface().present
    
    def dismiss_by_button_id(self):
        """Try to dismiss popup using known button IDs"""
        for button_id in self.POPUP_BUTTONS:
            try:
                button = self.driver.find_element(AppiumBy.ID, button_id)
                button.click()
                time.sleep(0.5)
                print(f"✅ Popup dismissed via button ID: {button_id.split('/')[-1]}")
                return True
            except:
                continue
        return False
    
    def dismiss_by_accessibility_id(self):
        """Try to dismiss popup using accessibility IDs"""
        for text in self.DISMISS_TEXT:
            try:
                button = self.driver.find_element(AppiumBy.ACCESSIBILITY_ID, text)
                button.click()
                time.sleep(0.5)
                print(f"✅ Popup dismissed via accessibility ID: '{text}'")
                return True
            except:
                continue
        return False
    
    def dismiss_by_text(self):
        """Try to dismiss popup by finding button text"""
        for text in self.DISMISS_TEXT:
            try:
                # Try exact text match
                button = self.driver.find_element(By.XPATH, f"//android.widget.TextView[@text='{text}']")
                button.click()
                time.sleep(0.5)
                print(f"✅ Popup dismissed via text: '{text}'")
                return True
            except:
                pass
            
            try:
                # Try clickable parent with text
                button = self.driver.find_element(
                    By.XPATH, 
                    f"//android.widget.FrameLayout[.//android.widget.TextView[@text='{text}']]"
                )
                button.click()
                time.sleep(0.5)
                print(f"✅ Popup dismissed via parent container with text: '{text}'")
                return True
            except:
                continue
        return False
    
    def dismiss_by_back_button(self):
        """Try to dismiss popup using Android back button"""
        try:
            self.driver.back()
            time.sleep(0.5)
            print("✅ Popup dismissed via Android back button")
            return True
        except Exception as e:
            print(f"⚠️ Back button failed: {e}")
            return False
    
    def dismiss_any_popup(self, max_attempts=3):
        """
        Main method: Attempt to dismiss any visible popup
        
        Returns:
            bool: True if a popup was dismissed, False if no popup or couldn't dismiss
        """
        for attempt in range(max_attempts):
            assessment = self.assess_popup_surface()
            if not assessment.present:
                if attempt == 0:
                    return False
                return True

            print(f"🔔 Popup detected (attempt {attempt + 1}/{max_attempts}) [{assessment.category}]")
            if assessment.category == 'blocker_like':
                print(f"⛔ Popup appears blocker-like: {assessment.reasons}")
                return False
            
            # Try each dismiss method in order
            if self.dismiss_by_button_id():
                time.sleep(0.3)
                continue
            
            if self.dismiss_by_accessibility_id():
                time.sleep(0.3)
                continue
            
            if self.dismiss_by_text():
                time.sleep(0.3)
                continue
            
            # Last resort: back button with bounded persistence diagnosis
            if self.dismiss_by_back_button():
                time.sleep(0.3)
                follow_up = self.assess_popup_surface()
                if follow_up.present and follow_up.category == 'unknown_popup' and follow_up.confidence == 'high':
                    print("⛔ Popup persisted after bounded back attempt; treating as blocker-like unknown popup")
                continue
            
            print(f"⚠️ Could not dismiss popup on attempt {attempt + 1}")
        
        # Final check
        final_assessment = self.assess_popup_surface()
        if not final_assessment.present:
            return True
        if final_assessment.category == 'unknown_popup' and final_assessment.confidence == 'high':
            final_assessment.category = 'blocker_like'
            final_assessment.persisted_after_back = True
            final_assessment.reasons = [*list(final_assessment.reasons or []), 'persisted after bounded back attempt']
            print(f"⛔ Popup remains after bounded handling; upgraded assessment to blocker-like: {final_assessment.reasons}")
        print("❌ Failed to dismiss popup after all attempts")
        return False
    
    def dismiss_all_popups(self, max_popups=5, delay=0.5):
        """
        Dismiss multiple consecutive popups
        
        Some flows trigger multiple popups in succession.
        This method handles them all.
        """
        dismissed_count = 0
        
        for i in range(max_popups):
            if self.dismiss_any_popup():
                dismissed_count += 1
                time.sleep(delay)
            else:
                break
        
        if dismissed_count > 0:
            print(f"✅ Dismissed {dismissed_count} popup(s)")
        
        return dismissed_count


def dismiss_popup(driver, max_attempts=3):
    """
    Convenience function for quick popup dismissal
    
    Usage:
        from modules.popup_handler import dismiss_popup
        dismiss_popup(driver)
    """
    handler = PopupHandler(driver)
    return handler.dismiss_any_popup(max_attempts)


# Example integration into other modules:
"""
class InstagramEngager:
    def __init__(self, ...):
        ...
        self.popup_handler = PopupHandler(self.driver)
    
    def like(self):
        # Dismiss any popup before action
        self.popup_handler.dismiss_any_popup()
        
        # Now perform the like action
        ...
"""
