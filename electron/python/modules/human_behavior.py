#!/usr/bin/env python3
"""
HUMAN BEHAVIOR SIMULATION MODULE v1.0
=====================================
Centralized utilities for making automation UNDETECTABLE.

Key principles:
1. Humans are NEVER perfectly on time
2. Energy varies throughout the day
3. Attention is not constant - distractions happen
4. Mood affects engagement patterns
5. Fatigue sets in over time

Usage:
    from modules.human_behavior import HumanBehavior
    hb = HumanBehavior()
    
    # Get schedule jitter (humans are late more than early)
    jitter_minutes = hb.get_schedule_jitter()  # -3 to +8 min
    
    # Get current energy level based on time of day
    energy = hb.get_energy_level()  # 0.4 to 1.0
    
    # Get session mood (affects engagement patterns)
    mood = hb.get_session_mood()  # 'engaged', 'passive', 'active', 'distracted'
"""

import random
import time
from datetime import datetime
from typing import Tuple, Dict, Optional

class HumanBehavior:
    """Centralized human behavior simulation for undetectable automation"""
    
    # ========== DEFAULT SETTINGS (TUNE THESE!) ==========
    DEFAULT_SETTINGS = {
        # Schedule behavior
        'schedule_jitter_early_min': -3,      # Max minutes early
        'schedule_jitter_late_max': 8,        # Max minutes late
        'schedule_jitter_late_bias': 0.80,    # 80% chance of being late
        
        # Engagement rates
        'base_like_chance': 0.28,             # 28% base like probability
        'base_comment_chance': 0.08,          # 8% base comment probability
        'base_follow_chance': 0.15,           # 15% follow back chance
        
        # Session behavior
        'session_extension_chance': 0.80,     # 80% browse after tasks
        'max_extension_minutes': 10,          # Max 10 min post-task browsing
        
        # Distraction behavior
        'distraction_minor_chance': 0.15,     # 15% minor distraction
        'distraction_major_chance': 0.05,     # 5% major distraction
        'distraction_minor_seconds': (2, 8),  # Duration range
        'distraction_major_seconds': (8, 20), # Duration range
        
        # Fatigue rates (per action)
        'fatigue_scroll': 0.002,
        'fatigue_like': 0.005,
        'fatigue_comment': 0.015,
        'fatigue_post': 0.02,
        'fatigue_story_view': 0.003,
        'fatigue_follow': 0.01,
        'fatigue_general': 0.003,
        'fatigue_cap': 0.50,                  # Max fatigue level
        
        # Text generation
        'typo_chance': 0.02,                  # 2% typo rate for comments
        'emoji_variation': True,              # Vary emojis in captions
        'punctuation_variance': True,         # Sometimes skip punctuation
    }
    
    # Session mood probabilities
    MOOD_WEIGHTS = {
        'engaged': 0.40,     # Normal engagement
        'passive': 0.35,     # Low energy, mostly scrolling
        'active': 0.20,      # High engagement, more likes/comments
        'distracted': 0.05   # Almost no engagement, just browsing
    }
    
    # Time of day energy curves (0-23 hours)
    ENERGY_CURVE = {
        # Hour: (energy_level, speed_modifier, engagement_modifier)
        0: (0.3, 0.7, 0.4),   # Midnight - very tired
        1: (0.2, 0.6, 0.3),
        2: (0.2, 0.5, 0.2),
        3: (0.2, 0.5, 0.2),
        4: (0.3, 0.6, 0.3),
        5: (0.4, 0.7, 0.4),
        6: (0.5, 0.8, 0.5),   # Early morning
        7: (0.6, 0.85, 0.6),
        8: (0.75, 0.9, 0.7),
        9: (0.85, 0.95, 0.8),
        10: (0.95, 1.0, 0.9), # Peak morning
        11: (1.0, 1.0, 1.0),  # Peak
        12: (0.9, 0.95, 0.85),# Lunch dip
        13: (0.8, 0.9, 0.75),
        14: (0.85, 0.95, 0.8),
        15: (0.9, 1.0, 0.85),
        16: (0.85, 0.95, 0.8),
        17: (0.8, 0.9, 0.75), # End of work day
        18: (0.75, 0.85, 0.7),
        19: (0.7, 0.8, 0.65), # Evening wind down
        20: (0.6, 0.75, 0.6),
        21: (0.5, 0.7, 0.55),
        22: (0.4, 0.65, 0.5),
        23: (0.35, 0.6, 0.45),
    }
    
    def __init__(self):
        self.session_start_time = datetime.now()
        self.current_mood = None
        self.fatigue_level = 0.0  # Increases over session
        self.actions_this_session = 0
        
    def get_schedule_jitter(self, base_minutes: int = 0) -> int:
        """
        Get schedule jitter in minutes.
        Humans are late more often than early.
        
        Distribution:
        - 20% chance: 1-3 minutes EARLY
        - 80% chance: 0-8 minutes LATE
        
        Returns: Minutes to add to scheduled time (negative = early)
        """
        roll = random.random()
        
        if roll < 0.20:
            # Early (rare)
            return random.randint(-3, -1)
        elif roll < 0.50:
            # On time-ish (0-2 min late)
            return random.randint(0, 2)
        elif roll < 0.80:
            # Moderately late (2-5 min)
            return random.randint(2, 5)
        else:
            # Running late (5-8 min)
            return random.randint(5, 8)
    
    def get_energy_level(self, hour: Optional[int] = None) -> Tuple[float, float, float]:
        """
        Get current energy levels based on time of day.
        
        Returns: (energy, speed_modifier, engagement_modifier)
        - energy: 0.2-1.0 (affects everything)
        - speed_modifier: 0.5-1.0 (affects action speed)
        - engagement_modifier: 0.2-1.0 (affects like/comment probability)
        """
        if hour is None:
            hour = datetime.now().hour
        
        base = self.ENERGY_CURVE.get(hour, (0.7, 0.8, 0.7))
        
        # Add small random variance
        energy = base[0] + random.uniform(-0.1, 0.1)
        speed = base[1] + random.uniform(-0.05, 0.05)
        engagement = base[2] + random.uniform(-0.1, 0.1)
        
        # Apply fatigue penalty
        fatigue_penalty = min(0.3, self.fatigue_level * 0.5)
        energy = max(0.2, energy - fatigue_penalty)
        engagement = max(0.2, engagement - fatigue_penalty)
        
        return (
            max(0.2, min(1.0, energy)),
            max(0.5, min(1.0, speed)),
            max(0.2, min(1.0, engagement))
        )
    
    def get_session_mood(self) -> str:
        """
        Get a random session mood that affects engagement patterns.
        
        Returns: 'engaged', 'passive', 'active', or 'distracted'
        """
        if self.current_mood is None:
            roll = random.random()
            cumulative = 0.0
            
            for mood, weight in self.MOOD_WEIGHTS.items():
                cumulative += weight
                if roll <= cumulative:
                    self.current_mood = mood
                    break
            
            if self.current_mood is None:
                self.current_mood = 'engaged'
        
        return self.current_mood
    
    def get_mood_modifiers(self) -> Dict[str, float]:
        """
        Get engagement modifiers based on current mood.
        
        Returns dict with:
        - like_multiplier: 0.1-1.5
        - comment_multiplier: 0.0-1.8
        - scroll_speed: 0.5-1.5
        - attention_span: 0.3-1.2
        """
        mood = self.get_session_mood()
        
        modifiers = {
            'engaged': {
                'like_multiplier': 1.0,
                'comment_multiplier': 1.0,
                'scroll_speed': 1.0,
                'attention_span': 1.0
            },
            'passive': {
                'like_multiplier': 0.4,
                'comment_multiplier': 0.1,
                'scroll_speed': 0.8,
                'attention_span': 0.6
            },
            'active': {
                'like_multiplier': 1.5,
                'comment_multiplier': 1.8,
                'scroll_speed': 1.2,
                'attention_span': 1.2
            },
            'distracted': {
                'like_multiplier': 0.1,
                'comment_multiplier': 0.0,
                'scroll_speed': 1.5,  # Fast scrolling, not paying attention
                'attention_span': 0.3
            }
        }
        
        return modifiers.get(mood, modifiers['engaged'])
    
    def get_micro_pause(self) -> float:
        """
        Get a small natural pause duration (50-400ms).
        These happen between rapid actions.
        """
        return random.uniform(0.05, 0.4)
    
    def get_distraction_pause(self) -> Tuple[bool, float]:
        """
        Randomly decide if user gets "distracted" and for how long.
        
        Returns: (should_pause, duration_seconds)
        - 15% chance of 0.5-2 second distraction
        - 5% chance of 2-4 second distraction (really distracted)
        - 80% chance of no distraction
        """
        roll = random.random()
        
        if roll < 0.05:
            # Major distraction (phone notification, thinking)
            return (True, random.uniform(2, 4))
        elif roll < 0.20:
            # Minor distraction (reading caption, glancing away)
            return (True, random.uniform(0.5, 2))
        else:
            return (False, 0)
    
    def get_session_extension(self) -> Tuple[str, float]:
        """
        After main tasks, how long does user keep browsing?
        
        Returns: (extension_type, duration_seconds)
        """
        roll = random.random()
        
        if roll < 0.20:
            # Quick exit
            return ('quick_exit', random.uniform(0, 30))
        elif roll < 0.70:
            # Normal browse
            return ('normal', random.uniform(30, 120))
        elif roll < 0.95:
            # Extended session
            return ('extended', random.uniform(120, 300))
        else:
            # Long session (rare)
            return ('long', random.uniform(300, 600))
    
    def get_scroll_pattern(self) -> Dict:
        """
        Get humanized scroll parameters.
        
        Returns dict with:
        - speed: 'slow', 'normal', 'fast', 'flick'
        - duration_ms: scroll duration
        - pause_after: seconds to pause after scroll
        """
        patterns = [
            {'speed': 'slow', 'duration_ms': 400, 'pause_after': (1.0, 3.0), 'weight': 0.15},
            {'speed': 'normal', 'duration_ms': 250, 'pause_after': (0.5, 2.0), 'weight': 0.50},
            {'speed': 'fast', 'duration_ms': 150, 'pause_after': (0.3, 1.0), 'weight': 0.25},
            {'speed': 'flick', 'duration_ms': 100, 'pause_after': (0.2, 0.5), 'weight': 0.10},
        ]
        
        # Weighted random selection
        roll = random.random()
        cumulative = 0.0
        
        for pattern in patterns:
            cumulative += pattern['weight']
            if roll <= cumulative:
                return {
                    'speed': pattern['speed'],
                    'duration_ms': pattern['duration_ms'] + random.randint(-30, 30),
                    'pause_after': random.uniform(*pattern['pause_after'])
                }
        
        return patterns[1]  # Default to normal
    
    def add_fatigue(self, action_type: str = 'general'):
        """
        Add fatigue based on action type.
        Fatigue reduces energy and engagement over time.
        """
        fatigue_values = {
            'scroll': 0.002,
            'like': 0.005,
            'comment': 0.015,
            'post': 0.02,
            'story_view': 0.003,
            'general': 0.003
        }
        
        self.fatigue_level += fatigue_values.get(action_type, 0.003)
        self.fatigue_level = min(0.5, self.fatigue_level)  # Cap at 50%
        self.actions_this_session += 1
    
    def should_take_break(self) -> Tuple[bool, float]:
        """
        Should the user take a break?
        Based on fatigue and random chance.
        
        Returns: (should_break, duration_seconds)
        """
        # Higher fatigue = higher break chance
        break_chance = 0.05 + (self.fatigue_level * 0.3)
        
        if random.random() < break_chance:
            if self.fatigue_level > 0.3:
                # Tired - longer break
                return (True, random.uniform(30, 120))
            else:
                # Quick break
                return (True, random.uniform(5, 30))
        
        return (False, 0)
    
    def reset_session(self):
        """Reset session state for new cycle"""
        self.session_start_time = datetime.now()
        self.current_mood = None
        self.fatigue_level = 0.0
        self.actions_this_session = 0
    
    def get_post_posting_behavior(self) -> Dict:
        """
        What should happen after posting content?
        Real users often check their post.
        
        Returns dict with behaviors to execute
        """
        behaviors = {
            'admire_post': random.random() < 0.60,        # 60% scroll to see post
            'admire_duration': random.uniform(2, 8),      # How long to look
            'refresh_check': random.random() < 0.25,      # 25% refresh feed
            'check_profile': random.random() < 0.15,      # 15% check own profile
            'browse_feed': random.random() < 0.40,        # 40% browse feed a bit
            'browse_duration': random.uniform(10, 60),    # Browse duration
        }
        
        return behaviors
    
    def get_human_delay(self, base_seconds: float, variance: float = 0.3) -> float:
        """
        Get a humanized delay with variance.
        
        Args:
            base_seconds: Base delay
            variance: Variance factor (0.3 = ±30%)
        
        Returns: Humanized delay in seconds
        """
        energy, speed, _ = self.get_energy_level()
        
        # Slower when tired
        fatigue_modifier = 1 + (self.fatigue_level * 0.5)
        
        # Apply variance
        delay = base_seconds * random.uniform(1 - variance, 1 + variance)
        
        # Apply energy/fatigue modifiers
        delay = delay * fatigue_modifier / speed
        
        return max(0.5, delay)


# Singleton instance for easy access
_human_behavior_instance = None

def get_human_behavior() -> HumanBehavior:
    """Get or create singleton HumanBehavior instance"""
    global _human_behavior_instance
    if _human_behavior_instance is None:
        _human_behavior_instance = HumanBehavior()
    return _human_behavior_instance


if __name__ == "__main__":
    # Test the module
    hb = HumanBehavior()
    
    print("🧠 HUMAN BEHAVIOR SIMULATION TEST")
    print("=" * 50)
    
    # Test schedule jitter
    print("\n📅 Schedule Jitter (10 samples):")
    for _ in range(10):
        jitter = hb.get_schedule_jitter()
        print(f"   {jitter:+d} min {'(early)' if jitter < 0 else '(late)' if jitter > 0 else '(on time)'}")
    
    # Test energy levels
    print("\n⚡ Energy Levels by Hour:")
    for hour in [6, 10, 14, 18, 22]:
        energy, speed, engagement = hb.get_energy_level(hour)
        print(f"   {hour:02d}:00 - Energy: {energy:.2f}, Speed: {speed:.2f}, Engagement: {engagement:.2f}")
    
    # Test moods
    print("\n🎭 Session Moods (10 samples):")
    for _ in range(10):
        hb.current_mood = None  # Reset
        mood = hb.get_session_mood()
        mods = hb.get_mood_modifiers()
        print(f"   {mood}: Like={mods['like_multiplier']:.1f}x, Comment={mods['comment_multiplier']:.1f}x")
    
    # Test scroll patterns
    print("\n📜 Scroll Patterns (5 samples):")
    for _ in range(5):
        pattern = hb.get_scroll_pattern()
        print(f"   {pattern['speed']}: {pattern['duration_ms']}ms + {pattern['pause_after']:.1f}s pause")
    
    # Test post-posting behavior
    print("\n📸 Post-Posting Behavior:")
    behavior = hb.get_post_posting_behavior()
    for key, value in behavior.items():
        print(f"   {key}: {value}")
    
    print("\n✅ Human behavior module working!")
