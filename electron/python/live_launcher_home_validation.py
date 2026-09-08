import sys
import subprocess

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

from modules.instagram_launcher_module import InstagramLauncher


def _adb_devices(device_id: str):
    try:
        result = subprocess.run(['adb', 'devices'], capture_output=True, text=True, timeout=10)
        connected = device_id in (result.stdout or '') and '\tdevice' in (result.stdout or '')
        return connected, (result.stdout or '').strip()
    except Exception as e:
        return False, f'adb_devices_error:{e}'


def _foreground_package(device_id: str):
    try:
        result = subprocess.run(
            ['adb', '-s', device_id, 'shell', 'dumpsys', 'window', 'windows'],
            capture_output=True,
            text=True,
            timeout=10,
        )
        output = result.stdout or ''
        for line in output.splitlines():
            lowered = line.lower()
            if ('mcurrentfocus' in lowered or 'mfocusedapp' in lowered) and '/' in line:
                focus_part = line.split()[-1]
                return focus_part.split('/')[0].strip() or 'unknown'
        return 'unknown'
    except Exception as e:
        return f'foreground_query_error:{e}'


def main():
    device_id = '1A121FDF60082H'
    print('LIVE_LAUNCHER_HOME: start')
    adb_connected, adb_output = _adb_devices(device_id)
    print(f'LIVE_LAUNCHER_HOME: adb_connected={adb_connected}')
    print(f'LIVE_LAUNCHER_HOME: adb_devices_output={adb_output}')
    if adb_connected:
        print(f'LIVE_LAUNCHER_HOME: foreground_package={_foreground_package(device_id)}')
    launcher = InstagramLauncher(device_id=device_id)
    outcome = launcher.open_instagram_home_strict()
    print(f"LIVE_LAUNCHER_HOME: verified_home_ready={bool(outcome.get('verified_home_ready'))}")
    print(f"LIVE_LAUNCHER_HOME: screen_type={outcome.get('screen_type')}")
    print(f"LIVE_LAUNCHER_HOME: reason={outcome.get('reason')}")
    print('LIVE_LAUNCHER_HOME: done')


if __name__ == '__main__':
    main()
