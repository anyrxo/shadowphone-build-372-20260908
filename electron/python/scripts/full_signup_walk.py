"""Full IG signup walk on a fresh profile.

Sequence:
  1. Airplane ON
  2. Switch to fresh user
  3. Airplane OFF (forces IP rotation)
  4. Wait for Tailscale to reconnect
  5. Open IG -> Add Instagram account -> Create new account
  6. Username next, Accounts Center "No mobile/email"
  7. Password (random)
  8. Birthday picker (RANDOM month/day/year 2003-2007)
  9. Mobile number -- buy smspool IG number, type with +1
 10. Wait for SMS code, enter, Next
 11. Terms -- I agree (clickable parent, y>=1000)
 12. Post-signup loop with new _find_skip -- 9 screens
 13. Land home (tab_avatar)
 14. MEDIA PRE-GRANT: Profile tab -> Create New -> Create new reel -> Allow all
 15. KEYCODE_BACK x2 -> back to Profile
 16. Declare complete + write a sentinel file
"""
import json
import os
import random
import re
import subprocess
import sys
import time
import urllib.request

ADB = "C:/adb/platform-tools/adb.exe"
SERIAL = "1A121FDF60082H"
# smspool key is required from the environment — no baked-in fallback. Fail
# CLOSED here so a misconfigured run can't silently drain the pooled balance.
SMSPOOL_KEY = (os.environ.get("SMSPOOL_API_KEY", "") or "").strip()
if not SMSPOOL_KEY:
    sys.exit("SMSPOOL_API_KEY not configured — set the SMSPOOL_API_KEY environment variable before running full_signup_walk.")
SMSPOOL_SVC_IG = "457"
TARGET_USER = sys.argv[1] if len(sys.argv) > 1 else "11"
PKG = "com.instagram.android"


def sh(args, timeout=15):
    return subprocess.run([ADB, "-s", SERIAL] + args,
                          capture_output=True, text=True, timeout=timeout)


def dump():
    sh(["shell", "uiautomator", "dump", "//sdcard//d.xml"])
    sh(["pull", "//sdcard//d.xml", "/tmp/screen.xml"])
    return open("/tmp/screen.xml", encoding="utf-8", errors="ignore").read()


def tap(x, y):
    sh(["shell", "input", "tap", str(x), str(y)])


def log(msg):
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}")


def find_cd(xml, cd, exact=True):
    if exact:
        pat = re.compile(rf'content-desc="{re.escape(cd)}"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
    else:
        pat = re.compile(rf'content-desc="[^"]*{re.escape(cd)}[^"]*"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
    matches = []
    for m in pat.finditer(xml):
        x1, y1, x2, y2 = map(int, m.groups())
        matches.append(((x2 - x1) * (y2 - y1), ((x1 + x2) // 2, (y1 + y2) // 2)))
    if not matches:
        return None
    matches.sort(reverse=True)
    return matches[0][1]


def find_text(xml, txt, exact=True):
    if exact:
        pat = re.compile(rf'text="{re.escape(txt)}"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
    else:
        pat = re.compile(rf'text="[^"]*{re.escape(txt)}[^"]*"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
    matches = []
    for m in pat.finditer(xml):
        x1, y1, x2, y2 = map(int, m.groups())
        matches.append(((x2 - x1) * (y2 - y1), ((x1 + x2) // 2, (y1 + y2) // 2)))
    if not matches:
        return None
    matches.sort(reverse=True)
    return matches[0][1]


def find_rid(xml, rid, exact=False):
    if exact:
        pat = re.compile(rf'resource-id="{re.escape(rid)}"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
    else:
        pat = re.compile(rf'resource-id="[^"]*{re.escape(rid)}[^"]*"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
    matches = []
    for m in pat.finditer(xml):
        x1, y1, x2, y2 = map(int, m.groups())
        matches.append(((x2 - x1) * (y2 - y1), ((x1 + x2) // 2, (y1 + y2) // 2)))
    if not matches:
        return None
    matches.sort(reverse=True)
    return matches[0][1]


def find_clickable_skip(xml):
    """Walk up from Skip-bearing nodes to find smallest clickable ancestor."""
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
            'has_skip': bool(re.search(r'text="Skip"', node) or re.search(r'content-desc="Skip"', node)),
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


def find_clickable_text(xml, txt):
    """Find the smallest clickable ancestor of any node bearing this text."""
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
            'has_txt': (re.search(rf'text="{re.escape(txt)}"', node) is not None or
                        re.search(rf'content-desc="{re.escape(txt)}"', node) is not None),
        })
    cands = []
    for n in nodes:
        if not n['has_txt']:
            continue
        if n['clickable']:
            x1, y1, x2, y2 = n['bounds']
            cands.append(((x2-x1)*(y2-y1), ((x1+x2)//2, (y1+y2)//2)))
            continue
        sx1, sy1, sx2, sy2 = n['bounds']
        best = None
        for a in nodes:
            if a is n or not a['clickable']:
                continue
            ax1, ay1, ax2, ay2 = a['bounds']
            if not (ax1 <= sx1 and ay1 <= sy1 and ax2 >= sx2 and ay2 >= sy2):
                continue
            if a['span'][0] >= n['span'][0]:
                continue
            area = (ax2-ax1)*(ay2-ay1)
            if best is None or area < best[0]:
                best = (area, ((ax1+ax2)//2, (ay1+ay2)//2))
        if best:
            cands.append(best)
    if cands:
        cands.sort(reverse=True)
        return cands[0][1]
    return None


# ─────────────────────────────────────────────────────────────
# Phase 1: airplane -> switch -> airplane
# ─────────────────────────────────────────────────────────────

def phase1_rotate():
    cur = sh(["shell", "am", "get-current-user"]).stdout.strip()
    log(f"PHASE 1: rotating from user {cur} -> user {TARGET_USER}")
    log("  Airplane ON")
    sh(["shell", "cmd", "connectivity", "airplane-mode", "enable"])
    time.sleep(3)
    log(f"  Switch user -> {TARGET_USER}")
    sh(["shell", "am", "switch-user", TARGET_USER])
    time.sleep(8)
    log("  Airplane OFF")
    sh(["shell", "cmd", "connectivity", "airplane-mode", "disable"])
    # Wait for connectivity to fully come back
    for i in range(20):
        time.sleep(3)
        r = sh(["shell", "ip", "-4", "addr", "show", "tun0"], timeout=8)
        if "100." in r.stdout:
            log(f"  +{(i+1)*3}s Tailnet up: {[x for x in r.stdout.split() if x.startswith('100.')][0]}")
            break
    new_user = sh(["shell", "am", "get-current-user"]).stdout.strip()
    log(f"  Current user: {new_user}")
    if new_user != TARGET_USER:
        log(f"  WARN: expected {TARGET_USER}, got {new_user}")
    time.sleep(2)


# ─────────────────────────────────────────────────────────────
# Phase 2: open IG, navigate to Create new account
# ─────────────────────────────────────────────────────────────

def phase2_open_ig():
    log("PHASE 2: open IG")
    sh(["shell", "am", "force-stop", PKG])
    time.sleep(2)
    sh(["shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1"])
    time.sleep(8)

    # Dismiss any blocking modal that lands first (notifs-off promo, OS notif perm, etc.)
    for attempt in range(6):
        xml = dump()
        # OS notification perm dialog
        if "Allow Instagram to send you notifications" in xml or 'permission_deny_and_dont_ask_again_button' in xml:
            d = find_rid(xml, "permission_deny_and_dont_ask_again_button") or find_rid(xml, "permission_deny_button")
            if d:
                log(f"  modal dismiss: notif OS perm at {d}")
                tap(*d); time.sleep(3); continue
        # IG notifs-off in-app promo
        if "Your notifications are off" in xml or ("Turn on" in xml and "Not now" in xml):
            nn = find_clickable_text(xml, "Not now")
            if nn:
                log(f"  modal dismiss: notifs-off promo at {nn}")
                tap(*nn); time.sleep(3); continue
        break

    # Settle: retry welcome detection a few times after modals dismissed
    # (IG can have transition screens that briefly show none of the matches).
    xml = dump()
    for _ in range(4):
        if ("Create new account" in xml or "Get started" in xml or "I already have a profile" in xml or
            "Add Instagram account" in xml or "Your story" in xml or "tab_avatar" in xml):
            break
        time.sleep(2)
        xml = dump()
    if "Create new account" in xml and ("Log in" in xml or "Log into existing account" in xml):
        log("  Fresh profile -- direct welcome screen")
        target = find_clickable_text(xml, "Create new account")
        if not target:
            target = find_cd(xml, "Create new account", exact=True)
        if target:
            tap(*target)
            time.sleep(4)
            return True

    # Has existing -- long-press profile tab
    log("  Has existing account -- long-press profile tab")
    prof = find_rid(xml, "com.instagram.android:id/profile_tab")
    if prof:
        sh(["shell", "input", "swipe", str(prof[0]), str(prof[1]), str(prof[0]), str(prof[1]), "800"])
        time.sleep(3)
        xml = dump()
        add = find_cd(xml, "Add Instagram account", exact=True) or find_clickable_text(xml, "Add Instagram account")
        if add:
            tap(*add)
            time.sleep(4)
            xml = dump()
            create = find_cd(xml, "Create new account", exact=True) or find_clickable_text(xml, "Create new account")
            if create:
                tap(*create)
                time.sleep(4)
                return True
    log("  FAIL: couldn't navigate to Create new account")
    return False


# ─────────────────────────────────────────────────────────────
# Phase 3: username -> password -> birthday -> phone -> SMS -> terms
# ─────────────────────────────────────────────────────────────

def phase3_signup_data():
    """State-machine: handles BOTH classic (username->password->birthday->mobile)
    AND v2 (mobile->SMS->password->birthday->name->username) orderings by
    detecting each screen as it appears."""
    log("PHASE 3: signup data entry (state-machine)")
    state = {'phone_done': False, 'order_id': None, 'phone': None,
             'pwd_done': False, 'bday_done': False, 'name_done': False, 'username_done': False}
    for it in range(40):
        time.sleep(2)
        xml = dump()
        xml_l = xml.lower()
        # Home feed reached - AccountsCenter shortcut path
        if any(x in xml for x in ['tab_avatar', 'reels_tray_container', 'Your story']):
            log(f"  iter {it+1}: LANDED HOME via AccountsCenter shortcut (no phone needed)")
            state['landed_home_early'] = True
            return state
        # Done -- Terms screen reached
        if 'I agree' in xml and ('tapping' in xml_l or 'Terms' in xml):
            log(f"  iter {it+1}: Terms screen reached, exit phase 3")
            return state if state['phone_done'] else state
        # Username (classic and v2 PRE-FILLED case)
        if ('Create a username' in xml or 'Input Username is valid' in xml) and not state['username_done']:
            log(f"  iter {it+1}: username screen, accept + Next")
            nxt = find_clickable_text(xml, "Next") or find_cd(xml, "Next", exact=True)
            if nxt: tap(*nxt); time.sleep(3); state['username_done'] = True; continue
        # Accounts Center
        if "Accounts Center" in xml and "Create a new Instagram account" in xml:
            no = find_cd(xml, "No, use mobile number or email", exact=True) or find_clickable_text(xml, "No, use mobile number or email")
            if no:
                log(f"  iter {it+1}: AccountsCenter, No mobile/email")
                tap(*no); time.sleep(3); continue
        # Password
        if 'Create a password' in xml and not state['pwd_done']:
            pwd = "Auto" + str(random.randint(100000, 999999)) + "Xz!"
            pf = find_cd(xml, "Password,", exact=True)
            if pf:
                log(f"  iter {it+1}: password screen ({len(pwd)} chars)")
                tap(*pf); time.sleep(1)
                for _ in range(30): sh(["shell", "input", "keyevent", "KEYCODE_DEL"])
                sh(["shell", "input", "text", pwd]); time.sleep(1)
                state['pwd_done'] = True
            # Re-dump after typing — keyboard shifts the layout and stale
            # Next coords miss the actual button.
            sh(["shell", "input", "keyevent", "KEYCODE_BACK"]); time.sleep(0.5)  # close keyboard
            time.sleep(1)
            xml = dump()
            nxt = find_clickable_text(xml, "Next") or find_cd(xml, "Next", exact=True)
            if nxt: tap(*nxt); time.sleep(3); continue
        # Birthday picker
        if ('Set date' in xml or 'datePicker' in xml or 'NumberPicker' in xml) and not state['bday_done']:
            ty = random.randint(2003, 2007); tm = random.randint(1, 12); td = random.randint(1, 28)
            log(f"  iter {it+1}: birthday picker, target {ty}-{tm:02d}-{td:02d}")
            # Both attribute orderings on real IG uiautomator dumps.
            cols_raw = re.findall(r'class="android.widget.NumberPicker"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
            # text= comes BEFORE resource-id= in uiautomator output on Android 16.
            vals = re.findall(r'text="([^"]+)"[^>]*?resource-id="android:id/numberpicker_input"', xml)
            if len(cols_raw) >= 3 and len(vals) >= 3:
                cols = [tuple(map(int, c)) for c in cols_raw]
                months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
                cmn = months.index(vals[0][:3]) + 1 if vals[0][:3] in months else 5
                cd_ = int(vals[1]); cy = int(vals[2])
                for col_idx, cur, tgt in [(2, cy, ty), (0, cmn, tm), (1, cd_, td)]:
                    c = cols[col_idx]; cx = (c[0]+c[2])//2
                    top = c[1] + int((c[3]-c[1])*0.15); bot = c[1] + int((c[3]-c[1])*0.85)
                    delta = tgt - cur
                    if col_idx == 0:
                        if delta > 6: delta -= 12
                        if delta < -6: delta += 12
                    yt = top if delta < 0 else bot
                    for _ in range(abs(delta)):
                        sh(["shell", "input", "tap", str(cx), str(yt)]); time.sleep(0.07)
                    time.sleep(0.4)
                time.sleep(1)
                setb = find_rid(dump(), "android:id/button1", exact=True)
                if setb: tap(*setb); time.sleep(3); state['bday_done'] = True; continue
        # Birthday confirm
        if "What's your birthday" in xml or 'Birthday (' in xml:
            nxt = find_clickable_text(xml, "Next") or find_cd(xml, "Next", exact=True)
            if nxt: log(f"  iter {it+1}: bday confirm Next"); tap(*nxt); time.sleep(3); continue
        # Name (v2)
        if not state['name_done'] and ('Full name' in xml or "What's your name" in xml or 'your name' in xml_l):
            nf = find_cd(xml, "Full name,", exact=True) or find_cd(xml, "Full name", exact=False)
            if nf:
                log(f"  iter {it+1}: name screen")
                tap(*nf); time.sleep(1)
                sh(["shell", "input", "text", "Eileen"]); time.sleep(1)
                state['name_done'] = True
            sh(["shell", "input", "keyevent", "KEYCODE_BACK"]); time.sleep(0.5)
            time.sleep(1)
            xml = dump()
            nxt = find_clickable_text(xml, "Next") or find_cd(xml, "Next", exact=True)
            if nxt: tap(*nxt); time.sleep(3); continue
        # Mobile + SMS
        if not state['phone_done'] and ('Mobile Number' in xml or "What's your mobile number" in xml):
            log(f"  iter {it+1}: mobile screen, buy smspool")
            order_url = f"https://api.smspool.net/purchase/sms?key={SMSPOOL_KEY}&country=1&service={SMSPOOL_SVC_IG}&max_price=2.50"
            try:
                order = json.loads(urllib.request.urlopen(order_url, timeout=20).read().decode())
            except urllib.error.HTTPError as e:
                body = e.read().decode() if hasattr(e, 'read') else str(e)
                log(f"    smspool HTTP {e.code}: {body[:200]}")
                return None
            if not order.get('success'): log(f"    smspool fail: {order}"); return None
            state['phone'] = "+1" + str(order['phonenumber']); state['order_id'] = order['order_id']
            log(f"    {state['phone']} order {state['order_id']}")
            mob = find_cd(xml, 'Mobile Number', exact=True)
            if mob:
                tap(*mob); time.sleep(1)
                for _ in range(20): sh(["shell", "input", "keyevent", "KEYCODE_DEL"])
                sh(["shell", "input", "text", state['phone']]); time.sleep(1)
            sh(["shell", "input", "keyevent", "KEYCODE_BACK"]); time.sleep(0.5)
            time.sleep(1)
            xml = dump()
            nxt = find_clickable_text(xml, "Next") or find_cd(xml, "Next", exact=True)
            if nxt: tap(*nxt); time.sleep(5)
            code = None
            for i in range(72):
                time.sleep(5)
                r = urllib.request.urlopen(f"https://api.smspool.net/sms/check?key={SMSPOOL_KEY}&orderid={state['order_id']}", timeout=10).read().decode()
                d = json.loads(r)
                if d.get('status') == 3 and d.get('sms'):
                    code = d['sms']; log(f"    SMS at +{(i+1)*5}s: {code}"); break
            if not code: log("    SMS TIMEOUT"); return None
            xml2 = dump()
            ci = find_cd(xml2, 'Code input entry field', exact=False)
            if ci:
                tap(*ci); time.sleep(1)
                sh(["shell", "input", "text", str(code).strip()]); time.sleep(1)
                sh(["shell", "input", "keyevent", "KEYCODE_BACK"]); time.sleep(0.5)
                time.sleep(1)
            xml2 = dump()
            nxt = find_clickable_text(xml2, "Next") or find_cd(xml2, "Next", exact=True)
            if nxt: tap(*nxt); time.sleep(5)
            state['phone_done'] = True; continue
        # Unrecognized
        sigs = sorted(set(re.findall(r'(?:text|content-desc)="([A-Z][^"]{2,40})"', xml)))[:5]
        log(f"  iter {it+1}: unrecognized {sigs}")
        time.sleep(1)
    log("  PHASE3 TIMEOUT")
    return None


def _dead_phase3():
    """OBSOLETE classic-only path - kept as ref."""
    xml = dump()
    if "Create a username" in xml or "username" in xml.lower():
        nxt = find_clickable_text(xml, "Next") or find_cd(xml, "Next", exact=True)
        if nxt:
            log("  Accept username, Next")
            tap(*nxt)
            time.sleep(4)

    # Accounts Center
    xml = dump()
    if "Accounts Center" in xml:
        log("  Accounts Center -- choose mobile/email")
        no = find_cd(xml, "No, use mobile number or email", exact=True) or find_clickable_text(xml, "No, use mobile number or email")
        if no:
            tap(*no)
            time.sleep(4)

    # Password
    xml = dump()
    if "Create a password" in xml:
        pwd = "Auto" + str(random.randint(1000, 9999)) + "!x"
        log(f"  Set password ({len(pwd)} chars)")
        pf = find_cd(xml, "Password,", exact=True)
        if pf:
            tap(*pf)
            time.sleep(1)
            sh(["shell", "input", "text", pwd])
            time.sleep(1)
        nxt = find_clickable_text(xml, "Next") or find_cd(xml, "Next", exact=True)
        if nxt:
            tap(*nxt)
            time.sleep(4)

    # Birthday -- RANDOM
    xml = dump()
    if "Set date" in xml or "datePicker" in xml:
        # Random year 2003-2007, random month, day 1-28
        target_year = random.randint(2003, 2007)
        target_month = random.randint(1, 12)
        target_day = random.randint(1, 28)
        log(f"  Random birthday: {target_year}-{target_month:02d}-{target_day:02d}")

        # NumberPicker columns
        cols = re.findall(r'class="android.widget.NumberPicker"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
        if len(cols) >= 3:
            # Selected values
            vals = re.findall(r'numberpicker_input"[^>]*?text="([^"]+)"', xml)
            if len(vals) >= 3:
                cur_month_str, cur_day, cur_year = vals[0], int(vals[1]), int(vals[2])
                months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
                cur_month_n = months.index(cur_month_str[:3]) + 1 if cur_month_str[:3] in months else 5
                log(f"    Current: {cur_month_str} {cur_day}, {cur_year}")

                # Year: decrement
                yr_col = [int(x) for x in cols[2]]
                yr_cx = (yr_col[0]+yr_col[2])//2
                yr_top_y = yr_col[1] + int((yr_col[3]-yr_col[1]) * 0.15)
                yr_bot_y = yr_col[1] + int((yr_col[3]-yr_col[1]) * 0.85)
                year_delta = target_year - cur_year
                taps = abs(year_delta)
                y_tap = yr_top_y if year_delta < 0 else yr_bot_y
                log(f"    Year: {taps}x tap at ({yr_cx}, {y_tap})")
                for _ in range(taps):
                    sh(["shell", "input", "tap", str(yr_cx), str(y_tap)])
                    time.sleep(0.07)
                time.sleep(0.5)

                # Month
                mo_col = [int(x) for x in cols[0]]
                mo_cx = (mo_col[0]+mo_col[2])//2
                mo_top_y = mo_col[1] + int((mo_col[3]-mo_col[1]) * 0.15)
                mo_bot_y = mo_col[1] + int((mo_col[3]-mo_col[1]) * 0.85)
                month_delta = target_month - cur_month_n
                # Month wraps; pick shortest direction
                if month_delta > 6: month_delta -= 12
                if month_delta < -6: month_delta += 12
                taps = abs(month_delta)
                m_tap = mo_top_y if month_delta < 0 else mo_bot_y
                log(f"    Month: {taps}x tap at ({mo_cx}, {m_tap})")
                for _ in range(taps):
                    sh(["shell", "input", "tap", str(mo_cx), str(m_tap)])
                    time.sleep(0.07)
                time.sleep(0.5)

                # Day
                d_col = [int(x) for x in cols[1]]
                d_cx = (d_col[0]+d_col[2])//2
                d_top_y = d_col[1] + int((d_col[3]-d_col[1]) * 0.15)
                d_bot_y = d_col[1] + int((d_col[3]-d_col[1]) * 0.85)
                day_delta = target_day - cur_day
                taps = abs(day_delta)
                day_tap = d_top_y if day_delta < 0 else d_bot_y
                log(f"    Day: {taps}x tap at ({d_cx}, {day_tap})")
                for _ in range(taps):
                    sh(["shell", "input", "tap", str(d_cx), str(day_tap)])
                    time.sleep(0.07)
                time.sleep(1)

                # Tap SET
                set_btn = find_rid(xml, "android:id/button1", exact=True)
                if set_btn:
                    log(f"    SET: {set_btn}")
                    tap(*set_btn)
                    time.sleep(3)

    # Birthday confirm screen
    xml = dump()
    if "What's your birthday" in xml or "Birthday (" in xml:
        nxt = find_clickable_text(xml, "Next") or find_cd(xml, "Next", exact=True)
        if nxt:
            log("  Birthday confirm -- Next")
            tap(*nxt)
            time.sleep(4)

    # Mobile number -- buy smspool
    xml = dump()
    if "mobile number" in xml.lower() or "Mobile Number" in xml:
        log("  Mobile screen -- buy smspool")
        order = urllib.request.urlopen(
            f"https://api.smspool.net/purchase/sms?key={SMSPOOL_KEY}&country=1&service={SMSPOOL_SVC_IG}&max_price=2.50",
            timeout=20).read().decode()
        order_d = json.loads(order)
        if not order_d.get("success"):
            log(f"  smspool error: {order}")
            return None
        phone = "+1" + str(order_d["phonenumber"])
        order_id = order_d["order_id"]
        log(f"    Got number {phone} order {order_id}")

        mob = find_cd(xml, "Mobile Number", exact=True)
        if mob:
            tap(*mob)
            time.sleep(1)
            for _ in range(20):
                sh(["shell", "input", "keyevent", "KEYCODE_DEL"])
            sh(["shell", "input", "text", phone])
            time.sleep(1)
        nxt = find_clickable_text(xml, "Next") or find_cd(xml, "Next", exact=True)
        if nxt:
            tap(*nxt)
            time.sleep(5)

        # Wait for SMS
        log("    Polling SMS...")
        code = None
        for i in range(60):
            time.sleep(5)
            r = urllib.request.urlopen(
                f"https://api.smspool.net/sms/check?key={SMSPOOL_KEY}&orderid={order_id}",
                timeout=10).read().decode()
            d = json.loads(r)
            if d.get("status") == 3 and d.get("sms"):
                code = d["sms"]
                log(f"    SMS at +{(i+1)*5}s: {code}")
                break
        if not code:
            log("    SMS TIMEOUT")
            return None

        # Enter code
        xml = dump()
        ci = find_cd(xml, "Code input entry field", exact=False)
        if ci:
            tap(*ci); time.sleep(1)
            sh(["shell", "input", "text", str(code).strip()])
            time.sleep(1)
        xml = dump()
        nxt = find_clickable_text(xml, "Next") or find_cd(xml, "Next", exact=True)
        if nxt:
            tap(*nxt)
            time.sleep(5)

        return {"username": None, "phone": phone, "order_id": order_id, "password": None}

    return {"username": None, "phone": None, "order_id": None, "password": None}


# ─────────────────────────────────────────────────────────────
# Phase 4: I agree (with retry-on-loading)
# ─────────────────────────────────────────────────────────────

def phase4_terms():
    log("PHASE 4: Terms -- I agree")
    for attempt in range(15):
        xml = dump()
        if "I agree" in xml:
            # Find clickable I agree with y >= 1000
            node_pat = re.compile(r'<node\s[^>]*?(?:/>|>)')
            cands = []
            for m in node_pat.finditer(xml):
                node = m.group(0)
                if 'clickable="true"' not in node:
                    continue
                if 'I agree' not in node:
                    continue
                bm = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
                if not bm:
                    continue
                x1, y1, x2, y2 = map(int, bm.groups())
                if y1 < 1000:
                    continue
                cands.append(((x2-x1)*(y2-y1), ((x1+x2)//2, (y1+y2)//2)))
            if cands:
                cands.sort(reverse=True)
                cx, cy = cands[0][1]
                log(f"  Attempt {attempt+1}: tap I agree at ({cx},{cy})")
                tap(cx, cy)
                time.sleep(5)
                continue
        elif "Loading" in xml:
            log(f"  Attempt {attempt+1}: Loading -- wait")
            time.sleep(5)
            continue
        # Advanced
        log("  Advanced past Terms")
        return True
    log("  TIMEOUT on Terms")
    return False


# ─────────────────────────────────────────────────────────────
# Phase 5: post-signup screens with new _find_skip
# ─────────────────────────────────────────────────────────────

def phase5_post_signup():
    log("PHASE 5: post-signup loop")
    for it in range(30):
        time.sleep(2)
        xml = dump()

        # Home detection
        if any(x in xml for x in [
            "com.instagram.android:id/tab_avatar",
            "com.instagram.android:id/reels_tray_container",
        ]):
            log(f"  Iter {it+1}: LANDED HOME")
            return True

        # Finalize reject
        if "There was a problem setting up your account" in xml:
            log(f"  Iter {it+1}: FINALIZE REJECT")
            return False

        # Confirm-human wall
        if "Confirm you're human" in xml or "confirm you're human" in xml.lower():
            log(f"  Iter {it+1}: HUMAN-CHECK WALL")
            return False

        # Lets get started interstitial
        if "Lets get started" in xml or "let's get started" in xml.lower():
            log(f"  Iter {it+1}: Lets-get-started interstitial -- wait 3s")
            time.sleep(3)
            continue

        # Profile picture
        if "Add a profile picture" in xml or "Add a profile photo" in xml or "photo_redesign_root_view" in xml:
            sk = find_clickable_skip(xml)
            log(f"  Iter {it+1}: profile pic -> Skip at {sk}")
            if sk: tap(*sk); time.sleep(3)
            continue

        # Contacts sync intro (igds_button = Next)
        if "connect_contacts_sync_button" in xml or "sync your contacts" in xml.lower() or "you can allow access to your contacts" in xml.lower():
            bt = find_rid(xml, "igds_button") or find_rid(xml, "button_text")
            log(f"  Iter {it+1}: contacts intro -> Next at {bt}")
            if bt: tap(*bt); time.sleep(3)
            continue

        # Contacts perm dialog
        if "Allow Instagram to access contacts" in xml:
            d = find_rid(xml, "permission_deny_button")
            log(f"  Iter {it+1}: contacts perm -> deny at {d}")
            if d: tap(*d); time.sleep(3)
            continue

        # Notifications intro
        if "Turn on notifications" in xml or "turn on notifications" in xml.lower() or "notifications_nux_constraint_container" in xml:
            bt = find_rid(xml, "igds_button") or find_rid(xml, "button_text")
            log(f"  Iter {it+1}: notif intro -> Next at {bt}")
            if bt: tap(*bt); time.sleep(3)
            continue

        # Notif perm
        if "Allow Instagram to send you notifications" in xml or "permission_deny_and_dont_ask_again_button" in xml:
            d = find_rid(xml, "permission_deny_and_dont_ask_again_button") or find_rid(xml, "permission_deny_button")
            log(f"  Iter {it+1}: notif perm -> deny at {d}")
            if d: tap(*d); time.sleep(3)
            continue

        # Follow 5
        if any(x in xml for x in ["5+ people", "5 or more people", "Follow 5", "Follow people", "following 5+", "Try following"]):
            sk = find_clickable_skip(xml)
            log(f"  Iter {it+1}: follow-5 -> Skip at {sk}")
            if sk: tap(*sk); time.sleep(3)
            continue

        # Email
        if "Add an email address" in xml or "Add an email" in xml:
            sk = find_clickable_skip(xml)
            log(f"  Iter {it+1}: email -> Skip at {sk}")
            if sk: tap(*sk); time.sleep(3)
            continue

        # Preferences
        if any(x in xml for x in ["See more of what you love", "Your preferences help shape",
                                    "Pick what you want to see more of", "reels_tuning_container"]):
            sk = find_clickable_skip(xml)
            log(f"  Iter {it+1}: preferences -> Skip at {sk}")
            if sk: tap(*sk); time.sleep(3)
            continue

        # Got it tip
        if "Swipe to easily access" in xml or "Got it" in xml:
            got = find_clickable_text(xml, "Got it")
            log(f"  Iter {it+1}: Got it at {got}")
            if got: tap(*got); time.sleep(3)
            continue

        # Bio
        if "Add bio" in xml or "Create a profile" in xml:
            sk = find_clickable_skip(xml)
            log(f"  Iter {it+1}: bio -> Skip at {sk}")
            if sk: tap(*sk); time.sleep(3)
            continue

        # Unrecognized
        signals = sorted(set(re.findall(r'(?:text|content-desc)="([A-Z][^"]{2,60})"', xml)))[:6]
        log(f"  Iter {it+1}: unrecognized. Signals: {signals}")
        time.sleep(1.2)

    log("  TIMED OUT")
    return False


# ─────────────────────────────────────────────────────────────
# Phase 6: media pre-grant (Profile -> Create New -> Reel -> Allow all)
# ─────────────────────────────────────────────────────────────

def phase6_media_pregrant():
    log("PHASE 6: media pre-grant validation")
    xml = dump()

    # Tap Profile tab
    prof = find_rid(xml, "com.instagram.android:id/profile_tab")
    if not prof:
        prof = find_cd(xml, "Profile", exact=True)
        if prof and prof[1] < 2000:
            prof = None  # not the bottom nav
    log(f"  Profile tab: {prof}")
    if prof:
        tap(*prof); time.sleep(3)
    else:
        log("  FAIL: profile tab not found")
        return False

    # Tap Create New (top-left of profile action bar)
    xml = dump()
    cn = find_cd(xml, "Create New", exact=True) or find_cd(xml, "Create", exact=False)
    log(f"  Create New: {cn}")
    if cn:
        tap(*cn); time.sleep(3)
    else:
        log("  WARN: Create New not found, trying alternative")

    # Bottom sheet -- tap Create new reel (or post or story fallback)
    xml = dump()
    reel = find_cd(xml, "Create new reel", exact=True) or find_cd(xml, "Create new post", exact=True) or find_cd(xml, "Create new story", exact=True)
    log(f"  Create new <type>: {reel}")
    if reel:
        tap(*reel); time.sleep(5)

    # OS media perm dialog -- tap Allow all
    xml = dump()
    allow_all = find_rid(xml, "permission_allow_all_button")
    log(f"  Allow all: {allow_all}")
    if allow_all:
        tap(*allow_all); time.sleep(3)
        log("  [OK] Media perm granted: Allow all")
    else:
        # Check if perm dialog was bypassed (already granted)
        if "permissioncontroller" not in xml:
            log("  Media perm already granted (no dialog)")
        else:
            log("  WARN: dialog present but Allow all not found")
            return False

    # KEYCODE_BACK x2 to return to Profile
    sh(["shell", "input", "keyevent", "KEYCODE_BACK"])
    time.sleep(2)
    sh(["shell", "input", "keyevent", "KEYCODE_BACK"])
    time.sleep(2)
    return True


# ─────────────────────────────────────────────────────────────
# Orchestration
# ─────────────────────────────────────────────────────────────

def main():
    log(f"=== FULL IG SIGNUP WALK target user {TARGET_USER} ===")
    t_start = time.time()

    phase1_rotate()

    if not phase2_open_ig():
        log("FAIL phase 2"); return False

    data = phase3_signup_data()
    if data is None:
        log("FAIL phase 3 (smspool / mobile entry)"); return False
    # AccountsCenter shortcut: skip terms + post-signup
    if data.get('landed_home_early'):
        log("Skipping phase 4 + 5 (AccountsCenter shortcut already landed home)")
    else:
        if not phase4_terms():
            log("FAIL phase 4 (terms)"); return False
        if not phase5_post_signup():
            log("FAIL phase 5 (post-signup)"); return False

    if not phase6_media_pregrant():
        log("FAIL phase 6 (media pregrant)"); return False

    dur = int(time.time() - t_start)
    log(f"=== COMPLETE {dur}s ===")
    log("Account ready for posting (media pre-granted)")
    return True


if __name__ == "__main__":
    ok = main()
    sys.exit(0 if ok else 1)
