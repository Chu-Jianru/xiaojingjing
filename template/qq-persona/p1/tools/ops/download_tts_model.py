"""Download the official Qwen3-TTS weights inside this repository (resumable)."""
from pathlib import Path
import os
import argparse
import shutil

REPO = next(p for p in Path(__file__).resolve().parents if (p / 'bot-home').is_dir() and (p / 'qq-persona').is_dir())
runtime = REPO / 'bot-home' / 'tts-runtime'
os.environ['MODELSCOPE_CACHE'] = str(runtime / 'modelscope-cache')
os.environ.setdefault('MODELSCOPE_DOWNLOAD_PARALLEL_WORKERS', '8')
from modelscope_hub import HubApi, TqdmCallback

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--variant', choices=['custom', 'base'], default='custom')
    args = parser.parse_args()
    name = 'Qwen3-TTS-12Hz-1.7B-' + ('Base' if args.variant == 'base' else 'CustomVoice')
    target = runtime / 'models' / name
    # The official models share their speech tokenizer. Existing files are
    # verified against upstream metadata by the hub downloader before reuse.
    shared = runtime / 'models' / 'Qwen3-TTS-12Hz-1.7B-CustomVoice' / 'speech_tokenizer'
    if args.variant == 'base' and shared.is_dir():
        shutil.copytree(shared, target / 'speech_tokenizer', dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns('*.incomplete', '*_0_*', '*_167*', '*_335*', '*_503*', '*_671*'))
    model = HubApi().download_repo(
        'Qwen/' + name, 'model', local_dir=target,
        max_workers=4, progress_callbacks=[TqdmCallback],
    )
    print('MODEL_READY', model, flush=True)
