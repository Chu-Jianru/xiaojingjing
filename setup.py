"""Small Windows bootstrap; private configuration stays outside template/."""
from __future__ import annotations
import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile

BASE = Path(__file__).resolve().parent
INSTANCE = BASE / 'instance'
SETTINGS = BASE / 'settings.local.json'


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if os.name != 'nt': path.chmod(0o600)


def verify_bundle():
    manifest = json.loads((BASE / 'manifest.json').read_text(encoding='utf-8'))
    for name, digest in manifest['files'].items():
        file = (BASE / name).resolve()
        if not file.is_relative_to(BASE.resolve()) or not file.is_file():
            raise ValueError('Distribution file missing or unsafe: ' + name)
        if hashlib.sha256(file.read_bytes()).hexdigest() != digest:
            raise ValueError('Distribution file changed: ' + name)


def validate(config):
    for key in ['bot_qq', 'admin_qq']:
        if not re.fullmatch(r'[1-9][0-9]{4,11}', str(config.get(key, ''))):
            raise ValueError('Invalid ' + key)
    if config['bot_qq'] == config['admin_qq']: raise ValueError('Bot and administrator must be different accounts')
    group = str(config.get('group_qq', ''))
    if group and not re.fullmatch(r'[1-9][0-9]{4,11}', group): raise ValueError('Invalid group_qq')
    if not re.fullmatch(r'[A-Za-z0-9._:/-]{1,160}', config.get('model', '')):
        raise ValueError('Model ID contains unsupported characters')
    if not re.fullmatch(r'https?://[A-Za-z0-9.:[\]/_-]+', config.get('base_url', '')):
        raise ValueError('Use an HTTP(S) API base URL without credentials/query parameters')
    if not isinstance(config.get('api_key'), str) or not config['api_key'].strip(): raise ValueError('API key is required')
    window = int(config.get('context_window', 131072))
    output = int(config.get('max_tokens', 16384))
    if not 65536 <= window <= 1048576 or not 1024 <= output <= 32768 or output >= window // 2:
        raise ValueError('Invalid context/output token budgets')
    config.update(context_window=window, max_tokens=output)
    for key in ['dsh_cli', 'napcat_mjs']:
        value = str(config.get(key, ''))
        if any(c in value for c in '\r\n%&|<>^!"'):
            raise ValueError('Unsupported shell character in ' + key)
    token = config.setdefault('onebot_token', secrets.token_hex(32))
    if not re.fullmatch(r'[a-f0-9]{64}', token): raise ValueError('Invalid OneBot token')
    return config


def configure(config):
    config = validate(dict(config))
    if INSTANCE.exists() or SETTINGS.exists():
        raise ValueError('Already configured. Existing instance and personal data will not be overwritten.')
    verify_bundle()
    replacements = {'__BOT_QQ__': config['bot_qq'], '__ADMIN_QQ__': config['admin_qq'],
                    '__GROUP_QQ__': config.get('group_qq', ''), '__MODEL__': config['model'],
                    '__BASE_URL__': config['base_url'], '__ONEBOT_TOKEN__': config['onebot_token'],
                    '__CONTEXT_WINDOW__': str(config['context_window']), '__MAX_TOKENS__': str(config['max_tokens'])}
    with tempfile.TemporaryDirectory(prefix='.configure-', dir=BASE) as temp:
        stage = Path(temp) / 'instance'
        shutil.copytree(BASE / 'template', stage)
        for p in stage.rglob('*'):
            if p.is_file() and p.suffix.lower() in {'.py', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.ps1', '.cmd', '.html', '.txt'}:
                raw = p.read_bytes()
                text = raw.decode('utf-8-sig')
                for old, new in replacements.items(): text = text.replace(old, str(new))
                p.write_bytes((b'\xef\xbb\xbf' if raw.startswith(b'\xef\xbb\xbf') else b'') + text.encode('utf-8'))
        for rel in ['bot-home/logs', 'bot-home/tmp', 'bot-home/sessions', 'bot-home/storages',
                    'bot-home/media/onebot/memory', 'qq-persona/p1/workspace', 'logs']:
            (stage / rel).mkdir(parents=True, exist_ok=True)
        # Config paths embed the final instance location, so generate after moving.
        shutil.move(str(stage), str(INSTANCE))
    try:
        run([sys.executable, str(INSTANCE / 'qq-persona/p1/tools/persona/build_persona.py')])
        client = {'name': 'xiaojingjing', 'enable': True, 'url': 'ws://127.0.0.1:8643',
                  'messagePostFormat': 'array', 'reportSelfMessage': False, 'reconnectInterval': 3000,
                  'token': config['onebot_token'], 'debug': False, 'heartInterval': 30000, 'verifyCertificate': True}
        save(INSTANCE / 'napcat-config' / ('onebot11_' + config['bot_qq'] + '.json'),
             {'network': {'httpServers': [], 'httpSseServers': [], 'httpClients': [],
                          'websocketServers': [], 'websocketClients': [client], 'plugins': []},
              'musicSignUrl': '', 'enableLocalFile2Url': False, 'parseMultMsg': False})
        save(INSTANCE / 'bot-home/media/onebot/calls/config.json', {'enabled': False})
        save(SETTINGS, config)
    except Exception:
        # Leave files for diagnosis; no runtime data existed before this transaction.
        raise RuntimeError('Configuration incomplete; keep the instance for diagnosis and retry in a fresh extracted directory') from None
    print('Configured: a new empty instance was created. Run install.cmd next.')


def run(command, cwd=None, env=None):
    subprocess.run([str(x) for x in command], check=True, cwd=cwd or INSTANCE, env=env)


def load():
    if not SETTINGS.exists(): raise ValueError('Run configure.cmd first')
    return validate(json.loads(SETTINGS.read_text(encoding='utf-8')))


def venv(name):
    root = INSTANCE / 'bot-home' / name / '.venv'
    python = root / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if not python.exists(): run([sys.executable, '-m', 'venv', root])
    return python


def install():
    config = load()
    verify_bundle()
    npm = shutil.which('npm.cmd') or shutil.which('npm')
    if not npm: raise ValueError('Install Node.js 22 or newer, then reopen this window')
    node = subprocess.check_output(['node', '-p', 'process.versions.node'], text=True).strip()
    if int(node.split('.')[0]) < 22: raise ValueError('Node.js 22 or newer is required')
    if not Path(config['dsh_cli']).is_file(): raise ValueError('Install DSH and set its dsh.cmd path in settings.local.json')
    napcat = Path(config['napcat_mjs'])
    if not napcat.is_file(): raise ValueError('Install a dedicated bot QQ + NapCat and set napcat_mjs in settings.local.json')
    for rel in ['vendor/dsh-onebot-qq', 'bot-home/profiles/companion', 'bot-home/embed', 'bot-home/web-runtime', 'bot-home/creative-runtime']:
        run([npm, 'install', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund'], INSTANCE / rel)
    # Package contains the exact patched plugin: never reinstall an unpatched npm release over it.
    dest = INSTANCE / 'bot-home/profiles/companion/node_modules/dsh-onebot-qq'
    if not dest.exists(): raise ValueError('Patched QQ plugin installation failed')
    call_python = venv('call-runtime')
    ops = INSTANCE / 'qq-persona/p1/tools/ops'
    calls = INSTANCE / 'qq-persona/p1/tools/calls'
    run([call_python, '-m', 'pip', 'install', '-r', calls / 'requirements.txt'])
    run([call_python, calls / 'download_asr.py'])
    run([call_python, calls / 'download_vad.py'])
    if config.get('install_voice', True):
        if not shutil.which('ffmpeg'): raise ValueError('Install ffmpeg and add it to PATH, then run install.cmd again')
        python = venv('tts-runtime')
        run([python, '-m', 'pip', 'install', 'torch==2.6.0', 'torchaudio==2.6.0', '--index-url', 'https://download.pytorch.org/whl/cu124'])
        run([python, '-m', 'pip', 'install', '--no-deps', 'qwen-tts==0.1.1', 'faster-qwen3-tts==0.2.6'])
        run([python, '-m', 'pip', 'install', '-r', ops / 'tts-runtime-requirements.txt'])
        # Dependencies omitted with qwen-tts's demo/UI stack; inference needs these.
        run([python, '-m', 'pip', 'install', 'sentencepiece', 'huggingface-hub', 'safetensors', 'scipy', 'numpy', 'einops'])
        run([python, ops / 'download_tts_model.py', '--variant', 'base'])
    config_dir = napcat.parent / 'config'
    target = config_dir / ('onebot11_' + config['bot_qq'] + '.json')
    generated = INSTANCE / 'napcat-config' / target.name
    if target.exists() and target.read_bytes() != generated.read_bytes():
        raise ValueError('An existing NapCat account config was preserved. Import instance/napcat-config/' + target.name + ' manually, then rerun.')
    config_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(generated, target)
    # Buddy/poke histories start empty; patches only run against the explicitly chosen bot installation.
    env = os.environ.copy(); env['NAPCAT_MJS'] = str(napcat)
    for name in ['patch_napcat_buddy_dump.py', 'patch_napcat_poke_dump.py']:
        run([sys.executable, INSTANCE / 'qq-persona/p1/tools/plugin/patches' / name], env=env)
    print('Dependencies installed. Run enable-calls.cmd for the native social/call bridge, then start.cmd.')


def enable_calls():
    config = load()
    napcat = Path(config['napcat_mjs'])
    if not napcat.is_file(): raise ValueError('Configured napcat.mjs is missing')
    # User must close only their dedicated bot QQ before this explicit operation.
    print('Close the dedicated bot QQ before enabling native bridge/calls. Personal QQ must use another installation.')
    answer = input('Is the dedicated bot QQ closed? Type YES: ')
    if answer != 'YES': raise ValueError('No changes made')
    env = os.environ.copy(); env['NAPCAT_MJS'] = str(napcat)
    python = INSTANCE / 'bot-home/call-runtime/.venv/Scripts/python.exe'
    run([python, INSTANCE / 'qq-persona/p1/tools/plugin/patches/patch_napcat_calls.py'], env=env)
    save(INSTANCE / 'bot-home/media/onebot/calls/config.json', {'enabled': True})
    print('Native social/call bridge installed. VB-Cable and the approved voice service must be ready before calls can be accepted.')


def install_vision():
    load()
    python = venv('model-download-runtime')
    run([python, '-m', 'pip', 'install', 'huggingface-hub==0.36.0'])
    # Exact quantization mix used by the shipped sidecar; no chat/API key needed.
    script = '''from huggingface_hub import snapshot_download
import os
from pathlib import Path
root=Path.cwd()
os.environ['HF_HOME']=str(root/'bot-home/model-download-runtime/cache')
snapshot_download('onnx-community/Qwen2-VL-2B-Instruct',token=False,
    local_dir=root/'bot-home/embed/models/onnx-community/Qwen2-VL-2B-Instruct',
    allow_patterns=['*.json','*.txt','onnx/decoder_model_merged_q4.onnx','onnx/embed_tokens_q4f16.onnx','onnx/vision_encoder_q4f16.onnx'])
'''
    run([python, '-c', script])
    print('Vision model installed. Use instance/scripts/vision-on.cmd when needed.')


def start():
    config = load()
    env = os.environ.copy()
    env.update(DSH_HOME=str(INSTANCE / 'bot-home'), WHALE_API_KEY=config['api_key'], NAPCAT_MJS=config['napcat_mjs'],
               NAPCAT_WEBUI_CONFIG=str(Path(config['napcat_mjs']).parent / 'config/webui.json'))
    shell = next((p for p in Path(config['napcat_mjs']).parents if (p / 'NapCatWinBootMain.exe').exists()), None)
    if shell is None: raise ValueError('NapCatWinBootMain.exe not found above napcat.mjs')
    if not Path(config['dsh_cli']).is_file(): raise ValueError('Configured DSH CLI is missing')
    # Do not start a duplicate instance or connect the wrong bot account.
    import socket
    for port in [18081, 8643]:
        with socket.socket() as sock:
            if sock.connect_ex(('127.0.0.1', port)) == 0: raise ValueError('Port already in use: ' + str(port))
    subprocess.Popen([str(shell / 'NapCatWinBootMain.exe'), config['bot_qq']], cwd=shell, env=env)
    for script in ['start-tts.ps1', 'start-stt.ps1', 'start-calls.ps1']:
        subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(INSTANCE / 'scripts' / script)], env=env, check=True)
    print('Scan the QR code in the dedicated bot QQ if prompted. DSH logs are under instance/bot-home/logs/.')
    run([config['dsh_cli'], '--profile', 'companion', '--no-open', '--port', '18081'], INSTANCE / 'bot-home', env)


def doctor():
    verify_bundle()
    config = load()
    checks = {'python_3_12': sys.version_info[:2] == (3, 12),
              'node': bool(shutil.which('node')), 'ffmpeg': bool(shutil.which('ffmpeg')),
              'dsh_cli': Path(config['dsh_cli']).is_file(), 'napcat': Path(config['napcat_mjs']).is_file(),
              'plugin': (INSTANCE / 'bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib/index.js').exists(),
              'tts_python': (INSTANCE / 'bot-home/tts-runtime/.venv/Scripts/python.exe').exists(),
              'tts_model': (INSTANCE / 'bot-home/tts-runtime/models/Qwen3-TTS-12Hz-1.7B-Base/model.safetensors').exists()}
    # Never dump settings or tokens in diagnostics.
    print(json.dumps(checks, indent=2))
    run([sys.executable, INSTANCE / 'qq-persona/p1/tools/persona/build_persona.py', '--check'])
    if not all(checks.values()): raise ValueError('Some dependencies are missing; inspect the checks above')


def interactive():
    print('Use a dedicated bot QQ/NapCat installation. Private settings are saved only in settings.local.json.')
    config = {key: input(label).strip().strip('"') for key, label in [
        ('bot_qq', 'Bot QQ: '), ('admin_qq', 'Administrator QQ: '), ('group_qq', 'Default group QQ (optional): '),
        ('base_url', 'OpenAI-compatible API base URL (including /v1): '), ('model', 'Model ID: '),
        ('dsh_cli', 'Installed DSH dsh.cmd absolute path: '), ('napcat_mjs', 'Dedicated bot napcat.mjs absolute path: ')]}
    config['api_key'] = getpass.getpass('API Key (hidden): ')
    config['install_voice'] = input('Install current cloned voice (NVIDIA CUDA GPU required)? [Y/n]: ').lower() != 'n'
    configure(config)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    for arg in ['interactive', 'install', 'start', 'doctor', 'calls', 'vision']: group.add_argument('--' + arg, action='store_true')
    group.add_argument('--config', type=Path, help='Initialize from a private JSON file (no installation/start)')
    args = parser.parse_args()
    try:
        if sys.version_info < (3, 12): raise ValueError('Python 3.12 or newer is required; Python 3.12 is the tested target')
        if args.config: configure(json.loads(args.config.read_text(encoding='utf-8-sig')))
        elif args.interactive: interactive()
        elif args.install: install()
        elif args.calls: enable_calls()
        elif args.vision: install_vision()
        elif args.start: start()
        else: doctor()
    except (ValueError, RuntimeError, subprocess.CalledProcessError, OSError) as exc:
        print('Setup failed: ' + str(exc), file=sys.stderr)
        sys.exit(1)
