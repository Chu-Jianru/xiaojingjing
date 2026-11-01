"""Install the isolated Windows AV host and owner-only native call bridge.

No login caches, account settings or system audio defaults are modified.
Only our plugin ID is added to NapCat's whitelist. Revert removes our exact
insertions rather than restoring an old bundle over later unrelated patches.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import hashlib
import shutil

REPO = next(p for p in Path(__file__).resolve().parents if (p / 'bot-home').is_dir() and (p / 'qq-persona').is_dir())
SOURCE = REPO / 'qq-persona/p1/tools/calls/native'
TARGET = Path(os.environ.get('NAPCAT_MJS') or str(Path.home() / 'NapCat-p1/shell/versions/9.9.33-52230/resources/app/napcat/napcat.mjs'))
PLUGIN = 'napcat-plugin-dsh-call'
PREFIX = ('// [dsh-native-call-host] isolated AVSDK host, normal bot entry remains unchanged\n'
          'if (process.env.DSH_QQ_CALL_HOST === "1") {\n'
          '  await import("./dsh-call/host.cjs");\n'
          '  await new Promise(() => {});\n'
          '}\n')

def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

def load_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig')) if path.exists() else {}

def copy_changed(source, target):
    # Reapplying an identical deployment must not overwrite a loaded .pyd.
    source, target = Path(source), Path(target)
    if target.exists() and source.stat().st_size == target.stat().st_size:
        with source.open('rb') as before, target.open('rb') as after:
            if hashlib.file_digest(before, 'sha256').digest() == hashlib.file_digest(after, 'sha256').digest():
                return str(target)
    return shutil.copy2(source, target)

def deploy_route_guard(host_dir, token_file, check=False):
    """Only trusted C-drive deployment enters the isolated audio child."""
    guard_dir = host_dir / 'route-guard'
    packages = REPO / 'bot-home/call-runtime/.venv/Lib/site-packages'
    base_python = Path(sys._base_executable).resolve()
    if base_python.drive.lower() != host_dir.drive.lower():
        raise RuntimeError('Use the trusted base Python on the bot installation drive')
    sources = ['route_guard.py', 'audio-route-guard.js', 'windows_audio.py', 'LICENSE', 'NOTICE.md']
    if check:
        cfg = load_json(guard_dir / 'route-guard-config.json')
        return (all((guard_dir / name).exists() and (guard_dir / name).read_bytes() == (SOURCE / name).read_bytes() for name in sources)
                and bool(cfg.get('files')) and all((guard_dir / name).exists()
                    and hashlib.sha256((guard_dir / name).read_bytes()).hexdigest() == digest for name, digest in cfg['files'].items()))
    guard_dir.mkdir(parents=True, exist_ok=True)
    for name in sources: copy_changed(SOURCE / name, guard_dir / name)
    for name in ['frida', 'psutil']:
        if not (packages / name).is_dir(): raise RuntimeError('Install call-runtime requirements before deploying the audio guard')
        shutil.copytree(packages / name, guard_dir / 'python-deps' / name, dirs_exist_ok=True,
                        copy_function=copy_changed, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        metadata = list(packages.glob(name + '-*.dist-info'))
        if len(metadata) != 1: raise RuntimeError('Ambiguous audio guard dependency metadata')
        shutil.copytree(metadata[0], guard_dir / 'python-deps' / metadata[0].name, dirs_exist_ok=True,
                        copy_function=copy_changed)
    qq_exe = next(p / 'QQ.exe' for p in host_dir.parents if (p / 'QQ.exe').exists())
    files = {str(p.relative_to(guard_dir)): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in guard_dir.rglob('*') if p.is_file() and
             ('python-deps' in p.parts and p.suffix != '.pyc' or p.name in sources)}
    save_json(guard_dir / 'route-guard-config.json', {'qqExe': str(qq_exe),
        'qqSha256': hashlib.sha256(qq_exe.read_bytes()).hexdigest(), 'files': files,
        'tokenFile': str(token_file), 'statusFile': str(token_file.with_name('route-guard-status.json'))})
    return True

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--check', action='store_true')
    group.add_argument('--revert', action='store_true')
    args = parser.parse_args()
    original = TARGET.read_bytes()
    newline = b'\r\n' if b'\r\n' in original else b'\n'
    prefix = PREFIX.encode().replace(b'\n', newline)
    allow = ('  "' + PLUGIN + '",' + newline.decode()).encode()
    anchor = b'  "napcat-plugin-builtin",'
    plugin_dir = TARGET.parent / 'plugins' / PLUGIN
    host_dir = TARGET.parent / 'dsh-call'
    package_path = TARGET.parent.parent / 'package.json'
    package = load_json(package_path)
    entry = TARGET.parent / 'dsh-call-entry.mjs'
    bootstrap = ('if (process.env.DSH_QQ_CALL_HOST === "1") {\n'
                 '  await import("./dsh-call/host.cjs");\n'
                 '} else {\n'
                 '  await import("./napcat.mjs");\n'
                 '}\n')
    files = {SOURCE / 'native-bridge.mjs': plugin_dir / 'index.mjs',
             SOURCE / 'social.mjs': plugin_dir / 'social.mjs',
             SOURCE / 'LICENSE': plugin_dir / 'LICENSE',
             SOURCE / 'host.cjs': host_dir / 'host.cjs',
             SOURCE / 'host.html': host_dir / 'host.html',
             SOURCE / 'audio-devices.cjs': host_dir / 'audio-devices.cjs',
             SOURCE / 'route-guard.cjs': host_dir / 'route-guard.cjs'}
    # Host and bridge carry their upstream license in each deployment directory.
    copies = list(files.items()) + [(SOURCE / 'LICENSE', host_dir / 'LICENSE'),
        (SOURCE / 'NOTICE.md', host_dir / 'NOTICE.md'), (SOURCE / 'NOTICE.md', plugin_dir / 'NOTICE.md')]
    if args.check:
        ok = allow in original and entry.exists() and entry.read_text() == bootstrap
        ok = ok and package.get('main') == './napcat/dsh-call-entry.mjs'
        ok = ok and all(dst.exists() and src.read_bytes() == dst.read_bytes() for src, dst in copies)
        ok = ok and deploy_route_guard(host_dir, REPO / 'bot-home/media/onebot/calls/control.token', check=True)
        print('native-call bridge: ' + ('OK' if ok else 'OUT OF SYNC'))
        raise SystemExit(0 if ok else 1)
    if args.revert:
        text = original.replace(prefix, b'', 1).replace(allow, b'', 1)
        # Leave private configs/diagnostics and source files for an explicit
        # uninstall; the bridge cannot load without its own whitelist entry.
        cfg = TARGET.parent / 'config/plugins.json'
        status = load_json(cfg)
        status[PLUGIN] = False
        save_json(cfg, status)
        if package.get('main') == './napcat/dsh-call-entry.mjs':
            package['main'] = './napcat/napcat.mjs'
            save_json(package_path, package)
    else:
        text = original
        text = text.replace(prefix, b'', 1)
        if allow not in text:
            if text.count(anchor) != 1:
                raise SystemExit('NapCat whitelist anchor changed; no bundle write')
            text = text.replace(anchor, allow + anchor, 1)
        token_file = REPO / 'bot-home/media/onebot/calls/control.token'
        if not token_file.exists():
            token_file.parent.mkdir(parents=True, exist_ok=True)
            token_file.write_text(secrets.token_hex(32), encoding='ascii')
        if len(token_file.read_text().strip()) < 32:
            raise SystemExit('Invalid existing control token; refusing to replace silently')
        for src, dst in copies:
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(src.read_bytes())
        deploy_route_guard(host_dir, token_file)
        if package.get('main') not in ['./napcat/napcat.mjs', 'napcat/napcat.mjs', './napcat/dsh-call-entry.mjs']:
            raise SystemExit('Unexpected QQ entry; refusing to replace')
        entry.write_text(bootstrap, encoding='utf-8')
        package['main'] = './napcat/dsh-call-entry.mjs'
        save_json(package_path, package)
        save_json(plugin_dir / 'package.json', {'name': PLUGIN, 'version': '0.1.0', 'type': 'module', 'main': 'index.mjs', 'license': 'GPL-3.0-only', 'description': 'DSH native QQ call bridge (Windows adaptation)'})
        config = load_json(plugin_dir / 'bridge-config.json')
        config.setdefault('allowedCallers', ['__ADMIN_QQ__'])
        config.update(tokenFile=str(token_file))
        save_json(plugin_dir / 'bridge-config.json', config)
        save_json(host_dir / 'host-config.json', {'tokenFile': str(token_file), 'bridgeDir': str(host_dir), 'avsdkPath': str(TARGET.parent.parent / 'avsdk/AVSDKPlugin.dll'), 'guardPython': str(Path(sys._base_executable).resolve())})
        cfg = TARGET.parent / 'config/plugins.json'
        status = load_json(cfg)
        status[PLUGIN] = True
        save_json(cfg, status)
    if text != original:
        # Parse the full new entry before replacing the working bundle.
        tmp = TARGET.with_name('napcat.dsh-call-check.mjs')
        tmp.write_bytes(text)
        try:
            subprocess.run(['node', '--check', str(tmp)], check=True, capture_output=True)
            tmp.replace(TARGET)
        finally:
            tmp.unlink(missing_ok=True)
    print('Native-call files ' + ('reverted' if args.revert else 'installed (unarmed until audio controller ready)') + '; restart only the bot QQ instance for entry changes.')

if __name__ == '__main__':
    main()
