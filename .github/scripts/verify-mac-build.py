import hashlib
import json
import os
import pathlib
import platform
import re
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
ARCH = os.environ['TARGET_ARCH']
MACHINE = {'x64': 'x86_64', 'arm64': 'arm64'}[ARCH]
MANIFEST = ROOT / 'build-source-manifest.json'
EXPECTED = os.environ['EXPECTED_MANIFEST_SHA256']

def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()

def check_source():
    assert re.fullmatch('[a-f0-9]{64}', EXPECTED), 'Invalid expected manifest hash'
    assert digest(MANIFEST) == EXPECTED, 'Unexpected source manifest'
    manifest = json.loads(MANIFEST.read_text())
    for item in manifest:
        file = ROOT / item['file']
        assert file.resolve().is_relative_to(ROOT.resolve()), 'Invalid source path'
        assert file.is_file() and file.stat().st_size == item['bytes'] and digest(file) == item['sha256'], item['file']
    expected_files = {item['file'] for item in manifest} | {'build-source-manifest.json'}
    actual_files = {file.relative_to(ROOT).as_posix() for file in ROOT.rglob('*')
                    if file.is_file() and '.git' not in file.relative_to(ROOT).parts}
    assert actual_files == expected_files, 'Unexpected or missing payload files'
    assert platform.machine() == MACHINE, 'Runner architecture mismatch'
    assert subprocess.check_output(['node', '-p', 'process.arch'], text=True).strip() == ARCH
    package = json.loads((ROOT / 'electron/package.json').read_text())
    lock = json.loads((ROOT / 'electron/package-lock.json').read_text())
    assert package['version'] == lock['version'] == lock['packages']['']['version']
    print(json.dumps({'source_manifest_sha256': EXPECTED, 'files':len(manifest), 'arch': ARCH, 'version':package['version']}))

def check_artifact():
    package = json.loads((ROOT / 'electron/package.json').read_text())
    version = package['version']
    app = ROOT / 'electron/dist' / ('mac' if ARCH == 'x64' else 'mac-arm64') / 'ShadowPhone.app'
    brain = app / 'Contents/Resources/python-brain/server/server'
    executable = app / 'Contents/MacOS/ShadowPhone'
    for file in (brain, executable):
        architectures = subprocess.check_output(['lipo', '-archs', str(file)], text=True).strip().split()
        assert architectures == [MACHINE], f'Wrong binary architecture: {file.name}'
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
    resources = app / 'Contents/Resources'
    forbidden = ('config/', 'defaults/profile_settings.json', 'modules/usernames.txt', 'modules/defaults/repost_accounts.txt')
    for parent in (resources / 'python', brain.parent / '_internal'):
        for file in parent.rglob('*'):
            name = file.relative_to(parent).as_posix()
            assert not any(name == value or name.startswith(value) for value in forbidden), 'Private operator data in package'
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = {**os.environ, 'LOCAL_MODE':'1', 'PORT':str(port), 'BIND_HOST':'127.0.0.1',
           'SHADOWPHONE_API_SECRET':'isolated-build-readiness', 'ANDROID_ADB_SERVER_PORT':'5137'}
    ready = None
    log_path = ROOT / 'electron/dist/brain-readiness.log'
    with log_path.open('wb') as log:
        process = subprocess.Popen([str(brain)], cwd=brain.parent, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(40):
                assert process.poll() is None, f'Packaged Brain exited with code {process.poll()}'
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{port}/ready', timeout=2) as response:
                        ready = json.load(response)
                    if ready.get('ready') is True:
                        break
                except OSError:
                    pass
                time.sleep(1)
            assert ready and ready.get('ready') is True and ready.get('required_count') == 16
            assert not ready.get('missing_modules') and not ready.get('failed_modules')
        except Exception as error:
            log.flush()
            with log_path.open('rb') as saved:
                saved.seek(max(0, log_path.stat().st_size - 32768))
                tail = saved.read(32768).decode('utf-8', errors='replace')
            tail = tail.replace(env['SHADOWPHONE_API_SECRET'], '[REDACTED]')
            failure = {'architecture': ARCH, 'runnerMachine': platform.machine(),
                       'githubCommit': os.environ.get('GITHUB_SHA'), 'sourceManifestSha256': EXPECTED,
                       'exit_code': process.poll(), 'error': str(error), 'ready': ready,
                       'startup_log_tail': tail}
            (ROOT / 'electron/dist' / f'mac-failure-{ARCH}.json').write_text(json.dumps(failure, indent=2))
            print(json.dumps(failure), flush=True)
            raise
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
    dmg = ROOT / 'electron/dist' / f'ShadowPhone-{version}-{ARCH}.dmg'
    assert dmg.is_file() and dmg.stat().st_size > 1_000_000
    subprocess.run(['hdiutil', 'verify', str(dmg)], check=True)
    report = {'version':version, 'architecture':ARCH, 'runnerMachine':platform.machine(),
              'sourceManifestSha256':EXPECTED, 'fileName':dmg.name, 'bytes':dmg.stat().st_size,
              'sha256':digest(dmg), 'brainSha256':digest(brain), 'brainArchitecture':MACHINE,
              'electronArchitecture':MACHINE, 'signatureVerified':True, 'diskImageVerified':True,
              'privateDataExcluded':True, 'ready':ready, 'githubCommit':os.environ.get('GITHUB_SHA')}
    (ROOT / 'electron/dist' / f'mac-build-{ARCH}.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))

if sys.argv[1:] == ['source']:
    check_source()
elif sys.argv[1:] == ['artifact']:
    check_artifact()
else:
    raise SystemExit('Expected source or artifact')
