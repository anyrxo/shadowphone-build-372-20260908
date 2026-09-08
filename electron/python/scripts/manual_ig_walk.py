"""Manually walk through the IG account creation flow step-by-step.
Dumps UI XML at every step, finds selectors, taps coords, advances.
Used to debug the post-signup loop end-to-end.
"""
import re
import subprocess
import sys
import time

ADB = "C:/adb/platform-tools/adb.exe"
SERIAL = "1A121FDF60082H"


def sh(args, timeout=15):
    return subprocess.run([ADB, "-s", SERIAL] + args,
                          capture_output=True, text=True, timeout=timeout)


def dump():
    sh(["shell", "uiautomator", "dump", "//sdcard//d.xml"])
    sh(["pull", "//sdcard//d.xml", "/tmp/screen.xml"])
    return open("/tmp/screen.xml", encoding="utf-8", errors="ignore").read()


def find_by_cd(xml, cd, exact=True):
    """Find center of node with given content-desc."""
    if exact:
        pat = re.compile(rf'content-desc="{re.escape(cd)}"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
    else:
        pat = re.compile(rf'content-desc="[^"]*{re.escape(cd)}[^"]*"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
    matches = []
    for m in pat.finditer(xml):
        x1, y1, x2, y2 = map(int, m.groups())
        matches.append(((x1 + x2) // 2, (y1 + y2) // 2, (x2 - x1) * (y2 - y1)))
    if not matches:
        return None
    matches.sort(key=lambda x: -x[2])
    return (matches[0][0], matches[0][1])


def find_by_text(xml, text, exact=True):
    if exact:
        pat = re.compile(rf'text="{re.escape(text)}"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
    else:
        pat = re.compile(rf'text="[^"]*{re.escape(text)}[^"]*"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
    matches = []
    for m in pat.finditer(xml):
        x1, y1, x2, y2 = map(int, m.groups())
        matches.append(((x1 + x2) // 2, (y1 + y2) // 2, (x2 - x1) * (y2 - y1)))
    if not matches:
        return None
    matches.sort(key=lambda x: -x[2])
    return (matches[0][0], matches[0][1])


def find_clickable_skip(xml):
    """Mimics the new _find_skip from server.py — finds Skip-bearing clickable
    or walks up to clickable ancestor. Used to validate the fix live."""
    node_pat = re.compile(r'<node\s[^>]*?(?:/>|>)')
    nodes = []
    for m in node_pat.finditer(xml):
        node = m.group(0)
        bm = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
        if not bm:
            continue
        x1, y1, x2, y2 = map(int, bm.groups())
        nodes.append({
            'span': m.span(),
            'bounds': (x1, y1, x2, y2),
            'clickable': 'clickable="true"' in node,
            'has_skip': (re.search(r'text="Skip"', node) is not None
                          or re.search(r'content-desc="Skip"', node) is not None),
        })
    candidates = []
    for n in nodes:
        if not n['has_skip']:
            continue
        if n['clickable']:
            x1, y1, x2, y2 = n['bounds']
            area = max(1, (x2 - x1) * (y2 - y1))
            candidates.append((area, ((x1 + x2) // 2, (y1 + y2) // 2)))
            continue
        sx1, sy1, sx2, sy2 = n['bounds']
        best_anc = None
        best_area = None
        for a in nodes:
            if a is n or not a['clickable']:
                continue
            ax1, ay1, ax2, ay2 = a['bounds']
            if not (ax1 <= sx1 and ay1 <= sy1 and ax2 >= sx2 and ay2 >= sy2):
                continue
            if a['span'][0] >= n['span'][0]:
                continue
            area = max(1, (ax2 - ax1) * (ay2 - ay1))
            if best_area is None or area < best_area:
                best_area = area
                best_anc = a
        if best_anc:
            ax1, ay1, ax2, ay2 = best_anc['bounds']
            candidates.append((best_area, ((ax1 + ax2) // 2, (ay1 + ay2) // 2)))
    if candidates:
        candidates.sort(reverse=True)
        return candidates[0][1]
    return None


def tap(x, y):
    sh(["shell", "input", "tap", str(x), str(y)])


def screen_signals(xml, limit=12):
    signals = set()
    for m in re.finditer(r'(text|content-desc)="([A-Z][^"]{2,80})"', xml):
        signals.add(f'{m.group(1)}={m.group(2)[:60]}')
    return sorted(signals)[:limit]


def step(label):
    print(f"\n=== {label} ===")
    xml = dump()
    print("Signals:")
    for s in screen_signals(xml):
        print(f"  {s}")
    return xml


# ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    xml = step("Current screen")
