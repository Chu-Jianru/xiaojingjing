"""Pinned Silero v5 model; local CPU inference through existing sherpa-onnx."""
from pathlib import Path
import hashlib
from urllib.request import urlopen

ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'bot-home').is_dir() and (p / 'qq-persona').is_dir())
URL = 'https://raw.githubusercontent.com/snakers4/silero-vad/v5.0/files/silero_vad.onnx'
SHA256 = '6b99cbfd39246b6706f98ec13c7c50c6b299181f2474fa05cbc8046acc274396'
TARGET = ROOT / 'bot-home/call-runtime/models/silero-vad-v5.onnx'


def main():
    if TARGET.exists() and hashlib.sha256(TARGET.read_bytes()).hexdigest() == SHA256:
        print('Silero v5 model verified'); return
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    with urlopen(URL, timeout=30) as response:
        data = response.read(4 * 1024 * 1024 + 1)
    if len(data) > 4 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != SHA256:
        raise RuntimeError('Silero model size/digest mismatch')
    temporary = TARGET.with_suffix('.part')
    temporary.write_bytes(data); temporary.replace(TARGET)
    print('Silero v5 model downloaded and verified inside workspace')


if __name__ == '__main__': main()
