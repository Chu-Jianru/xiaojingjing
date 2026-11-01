"""Pinned CPU SenseVoice model from sherpa-onnx's official release asset."""
from pathlib import Path
import hashlib
import tarfile
from urllib.request import urlopen

ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'bot-home').is_dir() and (p / 'qq-persona').is_dir())
NAME = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/' + NAME + '.tar.bz2'
SHA256 = '7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e'
TARGET = ROOT / 'bot-home/call-runtime/models'

def main():
    TARGET.mkdir(parents=True, exist_ok=True)
    model = TARGET / NAME / 'model.int8.onnx'
    if model.exists():
        print('ASR model already installed; no download')
        return
    archive = TARGET / (NAME + '.tar.bz2')
    if not archive.exists():
        temporary = archive.with_suffix('.part')
        try:
            with urlopen(URL, timeout=45) as response, temporary.open('wb') as output:
                size = 0
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > 200 * 1024 * 1024:
                        raise ValueError('Oversized ASR archive')
                    output.write(chunk)
            temporary.replace(archive)
        finally:
            temporary.unlink(missing_ok=True)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
        raise ValueError('ASR archive SHA256 mismatch; archive retained for diagnosis')
    with tarfile.open(archive) as bundle:
        members = bundle.getmembers()
        if sum(m.size for m in members) > 500 * 1024 * 1024:
            raise ValueError('Oversized model contents')
        bundle.extractall(TARGET, filter='data')
    if not model.is_file():
        raise ValueError('ASR model missing after extraction')
    archive.unlink()
    print('ASR model downloaded, release digest verified and extracted inside workspace')

if __name__ == '__main__':
    main()
