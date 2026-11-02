"""Synchronize the public distribution without replacing personal runtime data."""
from __future__ import annotations
import argparse
from datetime import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

BASE = Path(__file__).resolve().parent
REPOSITORY = 'Chu-Jianru/xiaojingjing'
TEXT = {'.py', '.js', '.mjs', '.cjs', '.json', '.jsonl', '.md', '.yml', '.ps1', '.cmd', '.html', '.txt'}


def safe(root, name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or '\\' in name or ':' in name:
        raise ValueError('Unsafe update path')
    target = root.joinpath(*path.parts)
    if not target.resolve().is_relative_to(root.resolve()): raise ValueError('Update path escapes installation')
    return target


def verify(root):
    manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
    if not isinstance(manifest.get('files'), dict) or len(manifest['files']) > 5000:
        raise ValueError('Invalid update manifest')
    for name, digest in manifest['files'].items():
        path = safe(root, name)
        if not path.is_file() or path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError('Update integrity check failed: ' + name)
        if not (name.startswith('template/') or name in {'setup.py', 'update.py', 'README.md', 'THIRD_PARTY.md', '.gitignore'} or '/' not in name and name.endswith('.cmd')):
            raise ValueError('Unexpected managed update path: ' + name)
    return manifest


def managed(name):
    # Runtime states/configuration are never update targets, including newly added ones.
    return (name.startswith(('vendor/', 'scripts/', 'qq-persona/p1/tools/', 'qq-persona/p1/stickers/', 'qq-persona/p1/voice/'))
            or name in {'qq-persona/p1/core.md', 'qq-persona/p1/avatar.png',
                        'bot-home/embed/provider.mjs', 'bot-home/embed/package.json', 'bot-home/embed/package-lock.json',
                        'bot-home/web-runtime/package.json', 'bot-home/web-runtime/package-lock.json',
                        'bot-home/creative-runtime/package.json', 'bot-home/creative-runtime/package-lock.json',
                        'bot-home/profiles/companion/package.json'}
            or name.startswith('bot-home/media/onebot/stickers/memes/'))


def rendered(data, name, config):
    if Path(name).suffix.lower() not in TEXT: return data
    replacements = {'__BOT_QQ__': config['bot_qq'], '__ADMIN_QQ__': config['admin_qq'],
                    '__GROUP_QQ__': config.get('group_qq', ''), '__MODEL__': config['model'],
                    '__BASE_URL__': config['base_url'], '__ONEBOT_TOKEN__': config['onebot_token'],
                    '__CONTEXT_WINDOW__': str(config.get('context_window', 131072)),
                    '__MAX_TOKENS__': str(config.get('max_tokens', 16384))}
    text = data.decode('utf-8-sig')
    for old, new in replacements.items(): text = text.replace(old, str(new))
    return (b'\xef\xbb\xbf' if data.startswith(b'\xef\xbb\xbf') else b'') + text.encode('utf-8')


def ensure_stopped(instance):
    if os.name != 'nt': raise ValueError('Runtime update currently supports Windows only')
    # Only inspect processes, never stop QQ or alter login state automatically.
    env = os.environ.copy(); env['WHALE_UPDATE_INSTANCE'] = str(instance.resolve())
    script = "$r=$env:WHALE_UPDATE_INSTANCE; $p=@(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -and $_.CommandLine.IndexOf($r,[StringComparison]::OrdinalIgnoreCase) -ge 0}); if($p.Count){exit 7}; $l=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.LocalPort -in 18081,8643}); if($l.Count){exit 7}"
    result = subprocess.run(['powershell', '-NoProfile', '-Command', script], env=env, capture_output=True)
    if result.returncode: raise ValueError('Close the bot/DSH and voice services before updating. No data was changed.')


def synchronize(source, base=BASE, stopped_check=ensure_stopped):
    base, source = base.resolve(), source.resolve()
    latest = verify(source)
    old = verify(base)
    if latest['files'] == old['files']: return {'updated': False, 'version': latest['version']}
    instance = base / 'instance'
    config = None
    if instance.exists():
        stopped_check(instance)
        config = json.loads((base / 'settings.local.json').read_text(encoding='utf-8'))
        # A customized generated profile must be reviewed, not silently overwritten.
        generator = instance / 'qq-persona/p1/tools/persona/build_persona.py'
        result = subprocess.run([sys.executable, str(generator), '--check'], capture_output=True)
        if result.returncode: raise ValueError('Local persona/profile customization preserved; synchronize generated files before updating')
    writes = {}
    # Root updates leave unknown files, settings, models, caches, and data alone.
    for name in latest['files']:
        if not name.startswith('template/'):
            writes[name] = safe(source, name).read_bytes()
        else:
            writes[name] = safe(source, name).read_bytes()
            relative = name[len('template/'):]
            if config is not None and managed(relative):
                destination = 'instance/' + relative
                current = safe(base, destination)
                old_source = safe(base, name)
                if current.exists() and (not old_source.exists() or current.read_bytes() != rendered(old_source.read_bytes(), relative, config)):
                    raise ValueError('Local customization preserved; merge before updating: ' + relative)
                writes[destination] = rendered(safe(source, name).read_bytes(), relative, config)
    # npm may install a copied file dependency rather than a junction: update its lib too.
    plugin = instance / 'bot-home/profiles/companion/node_modules/dsh-onebot-qq'
    vendor = instance / 'vendor/dsh-onebot-qq'
    if config is not None and plugin.is_dir() and plugin.resolve() != vendor.resolve():
        prefix = 'template/vendor/dsh-onebot-qq/'
        for name in latest['files']:
            if name.startswith(prefix) and (name[len(prefix):].startswith('lib/') or name[len(prefix):] == 'cordis.patch.yml'):
                rel = name[len(prefix):]
                dest = 'instance/bot-home/profiles/companion/node_modules/dsh-onebot-qq/' + rel
                current = safe(base, dest)
                old_src = safe(base, name)
                if current.exists() and (not old_src.exists() or current.read_bytes() != rendered(old_src.read_bytes(), rel, config)):
                    raise ValueError('Installed plugin customization preserved: ' + rel)
                writes[dest] = rendered(safe(source, name).read_bytes(), rel, config)
    writes['manifest.json'] = (source / 'manifest.json').read_bytes()
    # Program-only snapshot: personal data/models never copied or touched by update.
    backup = base / 'update-backups' / datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    backup.mkdir(parents=True)
    originals = {}
    generated = ['instance/qq-persona/p1/prompt.md', 'instance/bot-home/profiles/companion/cordis.patch.yml'] if config else []
    for name in set(writes) | set(generated):
        path = safe(base, name)
        originals[name] = path.read_bytes() if path.is_file() else None
        if originals[name] is not None:
            copy = safe(backup, name); copy.parent.mkdir(parents=True, exist_ok=True); copy.write_bytes(originals[name])
    (backup / 'rollback.json').write_text(json.dumps({'paths': list(originals), 'created': [n for n,v in originals.items() if v is None]}), encoding='utf-8')
    try:
        for name, data in writes.items():
            path = safe(base, name); path.parent.mkdir(parents=True, exist_ok=True)
            temp = path.with_name(path.name + '.update-tmp'); temp.write_bytes(data); os.replace(temp, path)
        if config:
            subprocess.run([sys.executable, str(instance / 'qq-persona/p1/tools/persona/build_persona.py')], check=True, capture_output=True)
    except BaseException:
        for name, data in originals.items():
            path = safe(base, name)
            if data is None: path.unlink(missing_ok=True)
            else: path.write_bytes(data)
        raise
    return {'updated': True, 'version': latest['version'], 'backup': str(backup),
            'dependenciesChanged': any(n.endswith(('package.json','package-lock.json','requirements.txt')) and originals[n] != writes[n] for n in writes),
            'nativeBridgeMayNeedRedeployment': config is not None}


def download(url, limit, timeout=30):
    request = urllib.request.Request(url, headers={'User-Agent': 'xiaojingjing-updater'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = response.read(limit + 1)
    if len(data) > limit: raise ValueError('Update download exceeds size limit')
    return data


def remote(check=False):
    commit = json.loads(download('https://api.github.com/repos/' + REPOSITORY + '/commits/main', 1024*1024, 10))['sha']
    if len(commit) != 40 or any(c not in '0123456789abcdef' for c in commit): raise ValueError('Invalid upstream commit')
    state = BASE / 'update-state.json'
    if state.exists() and json.loads(state.read_text())['commit'] == commit:
        print('Already synchronized.'); return
    if check:
        print('An upstream version is available. Close the bot, then run update.cmd to synchronize.'); return
    with tempfile.TemporaryDirectory(prefix='.update-', dir=BASE) as temp:
        root = Path(temp)
        archive = root / 'source.zip'
        archive.write_bytes(download('https://codeload.github.com/' + REPOSITORY + '/zip/' + commit, 100*1024*1024, 60))
        with zipfile.ZipFile(archive) as bundle:
            if sum(x.file_size for x in bundle.infolist()) > 200*1024*1024: raise ValueError('Expanded update too large')
            for item in bundle.infolist():
                safe(root, item.filename)
                if stat.S_ISLNK(item.external_attr >> 16): raise ValueError('Symlinks are not accepted in updates')
            bundle.extractall(root)
        result = synchronize(root / ('xiaojingjing-' + commit))
        state.write_text(json.dumps({'commit': commit}), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=False))
        if result.get('updated'):
            print('Memory, relationships, chat history and keys were preserved. Restart the bot to use updated code.')
            print('If dependencies changed, run install.cmd; native QQ bridge changes require enable-calls.cmd before restarting QQ.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    lock = BASE / 'update.lock'
    acquired = False
    try:
        with lock.open('x', encoding='ascii') as handle: handle.write(str(os.getpid()))
        acquired = True
        remote(args.check)
    except Exception as exc:
        print('Update failed: ' + str(exc), file=sys.stderr); sys.exit(1)
    finally:
        if acquired: lock.unlink(missing_ok=True)
