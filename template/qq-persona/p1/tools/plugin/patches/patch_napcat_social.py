"""Update the existing trusted native plugin's social endpoint (no QQ restart)."""
from pathlib import Path
import os
import sys
import subprocess

REPO = next(p for p in Path(__file__).resolve().parents if (p / 'bot-home').is_dir() and (p / 'qq-persona').is_dir())
SOURCE = REPO / 'qq-persona/p1/tools/calls/native'
TARGET = Path(os.environ.get('NAPCAT_MJS') or str(Path.home() / 'NapCat-p1/shell/versions/9.9.33-52230/resources/app/napcat/napcat.mjs')).parent / 'plugins/napcat-plugin-dsh-call'
files = {'native-bridge.mjs': 'index.mjs', 'social.mjs': 'social.mjs'}
if '--check' in sys.argv:
    ok = all((TARGET / target).exists() and (SOURCE / source).read_bytes() == (TARGET / target).read_bytes() for source, target in files.items())
    print('native social: ' + ('OK' if ok else 'OUT OF SYNC'))
    raise SystemExit(0 if ok else 1)
if not (TARGET / 'bridge-config.json').exists(): raise SystemExit('Install native bridge first')
for source in files:
    subprocess.run(['node', '--check', str(SOURCE / source)], check=True)
for source, target in files.items():
    (TARGET / target).write_bytes((SOURCE / source).read_bytes())
print('native social installed; reload napcat-plugin-dsh-call while idle')
