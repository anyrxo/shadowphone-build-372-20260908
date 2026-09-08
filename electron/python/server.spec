# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for the ShadowPhone local Python brain.

Freezes electron/python/server.py (FastAPI/uvicorn WS server) plus every
dynamically-loaded brain module into a self-contained brain so the Electron
desktop app works for users with NO Python installed.

PACKAGING MODE IS PLATFORM-CONDITIONAL:
  - Windows (sys.platform == 'win32'): ONEFILE — a single dist/server.exe.
    A onefile binary unpacks itself to a temp dir and re-execs from there;
    that is fine on Windows and is the committed, working layout.
  - macOS (else): ONEDIR — dist/server/ containing the `server` executable
    plus an `_internal/` folder of dylibs. A onefile mac binary re-execs out
    of a random temp dir, which macOS hardened-runtime / Gatekeeper kills on a
    deep-signed .app. ONEDIR sits in a real directory inside the bundle,
    signed in place, with nothing extracted at runtime.

BUILD CWD MUST BE electron/python/ so the `lib` / `modules` packages resolve.
Windows: driven by electron/scripts/build-python-brain.ps1, which copies the
resulting dist/server.exe to electron/python-bundle/server.exe.
macOS: driven by .github/workflows/build-macos.yml, which copies the whole
dist/server/ onedir to electron/python-bundle/server/.

Why the explicit hiddenimports:
  - lib.ws_modules.* are loaded via lib/ws_module_adapter.py (some via
    __import__()), so PyInstaller's static analysis never sees them.
  - uvicorn loads its loop/protocol/lifespan workers by string name at
    runtime — PyInstaller misses every one.
  - supabase/gotrue/postgrest/realtime/storage3 + their httpx/websockets
    transports are imported lazily inside server.get_supabase().
"""

import os
import sys
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

# Spec is run with cwd = electron/python (see build-python-brain.ps1), so
# SPECPATH is electron/python and every package path below is relative to it.
PYDIR = os.path.abspath(SPECPATH)


# --- Hidden imports ---------------------------------------------------------

hiddenimports = []

# Every brain package + submodule. collect_submodules walks lib/ and modules/
# recursively so lib.ws_modules.* (loaded dynamically by ws_module_adapter)
# and modules.* are all pulled in even though static analysis misses them.
hiddenimports += collect_submodules('lib')
hiddenimports += collect_submodules('modules')
# Defensive belt-and-suspenders: explicitly name the lib.ws_modules package
# AND each submodule. collect_submodules alone has been observed to ship the
# individual .py files but NOT the package's own __init__.py for empty
# package roots — at runtime that produces "No module named 'lib.ws_modules'"
# even though the submodules are physically in the archive. Naming the
# package root explicitly forces PyInstaller to include __init__.py too.
hiddenimports += [
    'lib',
    'lib.ws_modules',
    'lib.ws_modules.vpn_connect',
    'lib.ws_modules.vpn_disconnect',
    'lib.ws_modules.profile_switch',
    'lib.ws_modules.airplane_toggle',
    'lib.ws_modules.ig_launcher',
    'lib.ws_modules.gallery_clean',
    'lib.ws_modules.engagement',
    'lib.ws_modules.post_feed',
    'lib.ws_modules.post_story',
    'lib.ws_modules.post_trial_reel',
    'lib.ws_modules.follow',
    'lib.ws_modules.ig_login',
    'lib.ws_modules.detect_accounts',
    'lib.ws_modules.edit_profile',
    'lib.ws_modules.view_stories',
    'lib.ws_modules.send_dm',
    'lib.ws_modules.switch_ig_account',
    'lib.ws_modules.stats_scraper',
    'lib.ws_modules.repost',
    'lib.ws_modules.twitter_launcher',
    'lib.ws_modules.twitter_engagement',
    'lib.ws_modules.twitter_follow',
    'lib.ws_modules.twitter_post',
    'lib.ws_modules.tiktok_launcher',
    'lib.ws_modules.tiktok_engagement',
    'lib.ws_modules.tiktok_post',
    'lib.ws_modules.threads_launcher',
    'lib.ws_modules.threads_engagement',
    'lib.ws_modules.threads_post',
    'lib.ws_modules.dismiss_popups',
    'lib.ws_modules.account_creation',
    'lib.ws_modules_shared',
    'lib.ws_module_adapter',
]

# uvicorn picks its event loop / HTTP / WS / lifespan implementations by
# string name at runtime — none are discoverable statically.
hiddenimports += collect_submodules('uvicorn')
hiddenimports += [
    'uvicorn.lifespan.on',
    'uvicorn.lifespan.off',
    'uvicorn.loops.auto',
    'uvicorn.loops.asyncio',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.http.h11_impl',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.protocols.websockets.websockets_impl',
    'uvicorn.protocols.websockets.wsproto_impl',
    'uvicorn.logging',
]

# Supabase SDK is imported lazily in server.get_supabase(); collect every
# submodule of the SDK + its sibling client packages.
for _pkg in ('supabase', 'gotrue', 'postgrest', 'realtime', 'storage3',
             'supafunc'):
    try:
        hiddenimports += collect_submodules(_pkg)
    except Exception:
        # Older supabase releases fold some of these into the main package.
        pass

# Async / HTTP / validation stack — assorted submodules PyInstaller misses.
hiddenimports += collect_submodules('anyio')
hiddenimports += collect_submodules('httpx')
hiddenimports += collect_submodules('httpcore')
hiddenimports += collect_submodules('websockets')
hiddenimports += [
    # FastAPI / Starlette / pydantic core
    'fastapi',
    'starlette',
    'pydantic',
    'pydantic.deprecated.decorator',
    'pydantic_core',
    # uvicorn standard extras
    'h11',
    'wsproto',
    'websockets.legacy',
    'websockets.legacy.client',
    'websockets.legacy.server',
    # multipart form parsing (python-multipart) — FastAPI File/Form/UploadFile
    'multipart',
    'python_multipart',
    # auth / crypto
    'jwt',
    'jwt.algorithms',
    'cryptography',
    # rate limiting
    'slowapi',
    'slowapi.errors',
    'slowapi.util',
    # env loading
    'dotenv',
    # http client used by lib/supabase_client.py + supabase transport
    'requests',
    'certifi',
    'charset_normalizer',
    'idna',
    'urllib3',
    'sniffio',
    # email validation pulled in transitively by pydantic in some stacks
    'email_validator',
]

# De-dup while preserving order.
hiddenimports = list(dict.fromkeys(m for m in hiddenimports if m))


# --- Data files -------------------------------------------------------------
# Non-.py assets the brain reads by __file__-relative path at runtime. In a
# one-file build __file__ resolves into the PyInstaller _MEIPASS extraction
# dir, so these must ship inside the binary.
#
#   defaults/         -> read by content_manager.ContentManager (base_dir
#                        = parent of modules/, i.e. electron/python)
#   modules/defaults/ -> caption/comment pools for reels/threads/tiktok/etc.
#   lib/ig_ui_map.md  -> Instagram UI reference consumed by selectors
# Operator config, profile snapshots and account lists are local state.

datas = []
for _rel, _names in (
    ('defaults', ('usernames.txt', 'story_captions.txt', 'comments.txt', 'post_captions.txt')),
    (os.path.join('modules', 'defaults'), (
        'reels_captions.txt', 'threads_captions.txt', 'tiktok_captions.txt',
        'tiktok_comments.txt', 'twitter_captions.txt', 'universal_captions.txt',
    )),
):
    for _name in _names:
        _abs = os.path.join(PYDIR, _rel, _name)
        if os.path.isfile(_abs):
            datas.append((_abs, _rel))

# Bundle the markdown UI map next to lib/ so __file__-relative reads resolve.
_ig_ui_map = os.path.join(PYDIR, 'lib', 'ig_ui_map.md')
if os.path.isfile(_ig_ui_map):
    datas.append((_ig_ui_map, 'lib'))

# Package data shipped inside dependencies (certifi cacert.pem, etc.).
for _pkg in ('certifi',):
    try:
        datas += collect_data_files(_pkg)
    except Exception:
        pass


# --- Build ------------------------------------------------------------------

block_cipher = None

a = Analysis(
    ['server.py'],
    pathex=[PYDIR],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Exclude heavyweight libs the brain never touches at runtime to keep the
    # frozen binary lean. yt-dlp/aiohttp were already removed from
    # requirements.txt; tkinter/test suites are pure dead weight.
    excludes=[
        'tkinter',
        'unittest',
        'pydoc',
        'pytest',
        'IPython',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

if sys.platform == 'win32':
    # Windows: ONEFILE — a single dist/server.exe with the interpreter + deps
    # + brain embedded. local-brain.js pickBrainEntrypoint expects exactly this
    # name under <resources>/python-brain/. UNCHANGED — this is the committed,
    # working Windows layout; do not risk it.
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.zipfiles,
        a.datas,
        [],
        name='server',
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        upx_exclude=[],
        runtime_tmpdir=None,
        console=True,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
    )
else:
    # macOS: ONEDIR — exclude_binaries=True on the EXE keeps the executable
    # thin; COLLECT then drops every binary/dylib/data file into a real
    # dist/server/ directory (PyInstaller >=6 nests them in server/_internal/).
    # Nothing extracts at runtime, so the deep-signed .app's hardened runtime
    # stays happy. local-brain.js pickBrainEntrypoint resolves the executable
    # at <resources>/python-brain/server/server.
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name='server',
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        console=True,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
    )
    coll = COLLECT(
        exe,
        a.binaries,
        a.zipfiles,
        a.datas,
        strip=False,
        upx=False,
        upx_exclude=[],
        name='server',
    )
