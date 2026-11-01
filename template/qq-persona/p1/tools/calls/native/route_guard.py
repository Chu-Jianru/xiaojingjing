"""Scoped Core Audio guard lifecycle; no desktop capture or system defaults.

The isolated AV Host launches the C-drive copy with the trusted base Python.
Frida and this script are deployed under the bot installation, never injected
from the low-integrity workspace. The only eligible target is its PPAPI child.
"""
from pathlib import Path
import hashlib
import json
import os
import sys
import threading
import time


def valid_status(state, host_pid):
    return (isinstance(state, dict) and state.get('hostPid') == host_pid
            and isinstance(state.get('pid'), int) and state['pid'] > 0
            and state.get('installed') is True and state.get('errors') == 0)


def eligible_processes(host, expected_exe, process_factory):
    """Exact process identity; a main/personal QQ can never be a target."""
    parent = process_factory(int(host['pid']))
    if Path(parent.exe()).resolve() != expected_exe or parent.cmdline()[-1:] != ['0']:
        raise RuntimeError('Unverified isolated AV Host')
    candidates = []
    for pid in set(host.get('audioProcessIds', [])):
        process = process_factory(pid)
        if Path(process.exe()).resolve() == expected_exe and '--type=ppapi' in process.cmdline():
            candidates.append(process)
    if len(candidates) != 1: raise RuntimeError('Expected one isolated PPAPI audio process')
    return parent, candidates[0]


def run_helper(host_pid):
    # Read fixed local deployment metadata; no arbitrary target/path arguments.
    here = Path(__file__).resolve().parent
    config = json.loads((here / 'route-guard-config.json').read_text())
    expected = Path(config['qqExe']).resolve()
    if hashlib.sha256(expected.read_bytes()).hexdigest() != config['qqSha256']:
        raise RuntimeError('QQ build changed; revalidate audio guard before deployment')
    for name, digest in config['files'].items():
        path = (here / name).resolve()
        if not path.is_relative_to(here) or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError('Guard dependency integrity mismatch')
    temp = here / 'guard-temp'
    temp.mkdir(exist_ok=True)
    os.environ['TEMP'] = os.environ['TMP'] = str(temp)
    sys.path.insert(0, str(here / 'python-deps'))
    import psutil
    import frida
    from windows_audio import native_device_inventory
    from urllib.request import Request, urlopen
    token = Path(config['tokenFile']).read_text().strip()
    def status():
        with urlopen(Request('http://127.0.0.1:6111/v1/status',
                             headers={'Authorization': 'Bearer ' + token}), timeout=2) as response:
            host = json.load(response)['data']
        if host['pid'] != host_pid: raise RuntimeError('AV Host changed')
        return host
    parent, target = eligible_processes(status(), expected, psutil.Process)
    identity = (parent.create_time(), target.pid, target.create_time())
    inventory = native_device_inventory()['input']
    cables = [d for d in inventory if d['name'] == 'CABLE Output (VB-Audio Virtual Cable)']
    if len(cables) != 1: raise RuntimeError('Virtual capture device missing or ambiguous')
    agent_config = {'capture': cables[0]['guid'], 'inputs': [d['guid'] for d in inventory]}
    agent_source = (here / 'audio-route-guard.js').read_text().replace('__CONFIG__', json.dumps(agent_config))
    stop = threading.Event()
    def input_closed():
        sys.stdin.readline(); stop.set()
    threading.Thread(target=input_closed, daemon=True).start()
    session = frida.attach(target.pid)
    session.on('detached', lambda *_: stop.set())
    script = session.create_script(agent_source)
    script.on('message', lambda message, _: stop.set() if message.get('type') == 'error' else None)
    private = Path(config['statusFile'])
    try:
        script.load()
        while not stop.is_set():
            p, t = eligible_processes(status(), expected, psutil.Process)
            if (p.create_time(), t.pid, t.create_time()) != identity:
                raise RuntimeError('Audio process identity changed')
            state = dict(script.exports_sync.status(), hostPid=host_pid, at=int(time.time() * 1000))
            # Diagnostics contain counters/process IDs only, never PCM/text/keys.
            encoded = json.dumps(state)
            temporary = private.with_suffix('.tmp')
            temporary.write_text(encoded, encoding='ascii'); temporary.replace(private)
            print(encoded, flush=True)
            if not valid_status(state, host_pid): break
            stop.wait(1)
    finally:
        session.detach()


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3 or sys.argv[1] != '--host': raise ValueError('Invalid guard invocation')
        run_helper(int(sys.argv[2]))
    except Exception as error:
        print(json.dumps({'installed': False, 'errors': 1, 'error': type(error).__name__}), flush=True)
        raise SystemExit(1)
