"""Offline score-conditioned audition, deliberately separate from QQ readiness.

Speech-only conditioning is experimental. No ready file or production config is
written, and neither source singing nor the original recording is mixed in.
"""
from pathlib import Path
import argparse
import copy
import gc
import hashlib
import json
import os
import subprocess
import sys
import time

from singing_score import ROOT, load_score, phrase_events, metadata
from singing_worker import reference_profile, spoken_timbre_profile, watch_parent

RUNTIME = ROOT / 'bot-home/singing-runtime'
UPSTREAM = RUNTIME / 'SoulX-Singer'


def stage(name, **fields):
    print(json.dumps(dict(stage=name, **fields), ensure_ascii=False), flush=True)


def cpu_environment():
    os.environ.update(CUDA_VISIBLE_DEVICES='-1', OMP_NUM_THREADS='2', MKL_NUM_THREADS='2',
                      HF_HOME=str(RUNTIME / 'hf-cache'), HF_HUB_OFFLINE='1',
                      USE_TF='0', USE_FLAX='0', TOKENIZERS_PARALLELISM='false')
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        if not kernel.SetPriorityClass(kernel.GetCurrentProcess(), 0x4000):
            raise ctypes.WinError(ctypes.get_last_error())


def phonemes(text, phone_set):
    from pypinyin import lazy_pinyin, Style
    result = ['zh_' + p for p in lazy_pinyin(text, style=Style.TONE3, neutral_tone_with_five=True)]
    # This syllable is "en" in the actual audition; the model has no zh_en2.
    result = ['zh_en4' if p in ('zh_ň2', 'zh_ń2', 'zh_en2', 'zh_ng2') else p for p in result]
    # The official inventory uses citation-tone bu4, not spoken sandhi bu2.
    for index, phone in enumerate(result):
        if text[index] == '嗯':
            result[index] = 'zh_en4'
            continue
        if phone not in phone_set:
            canonical = 'zh_' + lazy_pinyin(text[index], style=Style.TONE3, neutral_tone_with_five=True)[0]
            if canonical in phone_set:
                result[index] = canonical
    if any(p not in phone_set for p in result):
        raise ValueError('unsupported_phoneme:' + str([p for p in result if p not in phone_set]))
    return result


def prompt_metadata(path, speech_sha, phone_set):
    """Approximate ASR word alignment of the approved OUTPUT, not raw anchor text."""
    import librosa
    import numpy as np
    import soundfile as sf
    audio, sr = sf.read(path, dtype='float32')
    align = json.loads((path.parent / 'spoken-alignment.json').read_text(encoding='utf8'))
    if align['speechTimbreSha256'] != speech_sha:
        raise ValueError('reference_alignment_changed')
    expected = '嗯今天有没有什么开心的事想讲给我听呀'
    clean = ''.join(c for c in align['text'] if '\u4e00' <= c <= '\u9fff')
    if clean != expected:
        raise ValueError('approved_output_transcript_mismatch')
    # Redistribute only the ASR's impossibly short 今/天/有 group to >= 3 frames.
    rows = [(0, .74, '嗯'), (.74, .88, None), (.88, 1.06, '今天'),
            (1.06, 1.20, '有'), (1.20, 1.34, '没有'), (1.34, 1.52, '什么'),
            (1.52, 1.84, '开'), (1.84, 1.98, '心'), (1.98, 2.20, '的'),
            (2.20, 2.46, '事'), (2.46, 3.64, None), (3.64, 3.90, '想'),
            (3.90, 4.08, '讲'), (4.08, 4.42, '给我'), (4.42, 4.66, '听'),
            (4.66, 4.96, '呀'), (4.96, len(audio) / sr, None)]
    phones = iter(phonemes(expected, phone_set))
    mono = librosa.resample(audio, orig_sr=sr, target_sr=16000)
    f0, _, _ = librosa.pyin(mono, sr=16000, fmin=90, fmax=650, frame_length=1024, hop_length=320)
    result = []
    for start, end, text in rows:
        if text is None:
            result.append(('<SP>', end - start, 0, 1))
            continue
        duration = (end - start) / len(text)
        for i in range(len(text)):
            a = start + i * duration
            pitches = f0[int(a * 50):max(int((a + duration) * 50), int(a * 50) + 1)]
            pitches = pitches[np.isfinite(pitches)]
            midi = round(float(librosa.hz_to_midi(np.median(pitches)))) if len(pitches) else 60
            result.append((next(phones), duration, midi, 2))
    return dict(phoneme=' '.join(r[0] for r in result),
                duration=' '.join(f'{r[1]:.8f}' for r in result),
                note_pitch=' '.join(str(r[2]) for r in result),
                note_type=' '.join(str(r[3]) for r in result))


def run(args):
    cpu_environment()
    watch_parent(os.getppid())
    import numpy as np
    import torch
    import soundfile as sf
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    out = Path(args.out).resolve()
    if not out.is_relative_to((ROOT / 'bot-home/media/onebot/music').resolve()) or out.suffix != '.wav':
        raise ValueError('audition_output_rejected')
    out.parent.mkdir(parents=True, exist_ok=True)
    anchor, anchor_sha = reference_profile()
    reference, speech_sha = spoken_timbre_profile(anchor_sha, anchor)
    score, events = load_score()
    groups = phrase_events(score, events)
    phones_path = UPSTREAM / 'soulxsinger/utils/phoneme/phone_set.json'
    phone_set = set(json.loads(phones_path.read_text(encoding='utf8')))
    metas = []
    for line, group in zip(score['lines'], groups):
        phones, previous = iter(phonemes(line, phone_set)), None
        for e in group:
            if e['noteType'] == 2:
                previous = next(phones)
            if e['char']:
                e['phoneme'] = previous
        metas.append(metadata(group, score['bpm'], lambda _: None))
    manifest = json.loads((RUNTIME / 'score-model-manifest.json').read_text(encoding='utf8'))
    revision = subprocess.check_output(['git', '-C', str(UPSTREAM), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != manifest['codeRevision']:
        raise ValueError('score_code_revision_changed')
    model_path = Path(manifest['path']) / 'model.pt'
    stage('verify-model')
    with model_path.open('rb') as weights:
        if hashlib.file_digest(weights, 'sha256').hexdigest() != manifest['sha256']:
            raise ValueError('score_model_hash_mismatch')
    stage('prepare-approved-output-alignment')
    prompt_meta = prompt_metadata(reference, speech_sha, phone_set)
    out.with_suffix('.input.json').write_text(json.dumps(dict(prompt=prompt_meta, targets=metas,
        speechTimbreSha256=speech_sha, score=score), ensure_ascii=False, indent=2), encoding='utf8')
    sys.path.insert(0, str(UPSTREAM))
    from omegaconf import OmegaConf
    from soulxsinger.models.soulxsinger import SoulXSinger
    from soulxsinger.utils.data_processor import DataProcessor
    config = OmegaConf.load(UPSTREAM / 'soulxsinger/config/soulxsinger.yaml')
    processor = DataProcessor(hop_size=480, sample_rate=24000, phoneset_path=str(phones_path), device='cpu')
    prompt = processor.process(copy.deepcopy(prompt_meta), str(reference))
    started = time.monotonic()
    stage('load-score-model', device='cpu', threads=2)
    model = SoulXSinger(config).eval()
    # The official, pinned and SHA-verified training checkpoint includes vocoder.
    checkpoint = torch.load(model_path, map_location='cpu', weights_only=False, mmap=True)
    model.load_state_dict(checkpoint['state_dict'], strict=True)
    del checkpoint
    gc.collect()
    stage('model-loaded', seconds=round(time.monotonic() - started, 2))
    segments, records = [], []
    for index, target_meta in enumerate(metas):
        stage('render-line', index=index + 1, total=len(metas))
        line_started = time.monotonic()
        target = processor.process(copy.deepcopy(target_meta))
        with torch.inference_mode():
            wave = model.infer(dict(prompt=prompt, target=target), auto_shift=False,
                               pitch_shift=0, n_steps=args.steps, cfg=3,
                               control='score', use_fp16=False).squeeze().numpy()
        expected = round(sum(e['beats'] for e in groups[index]) * 60 / score['bpm'] * 24000)
        wave = np.pad(wave[:expected], (0, max(0, expected - len(wave))))
        if not np.all(np.isfinite(wave)):
            raise ValueError('score_audio_nonfinite')
        sf.write(out.with_name(out.stem + f'-line{index + 1}.wav'), wave, 24000, subtype='FLOAT')
        segments.append(wave)
        records.append(dict(line=index + 1, seconds=len(wave) / 24000,
                            renderSeconds=round(time.monotonic() - line_started, 2)))
        stage('line-complete', **records[-1])
    wave = np.concatenate(segments)
    rms = float(np.sqrt(np.mean(wave ** 2)))
    peak = float(np.max(np.abs(wave)))
    gain = min(10 ** (-20 / 20) / max(rms, 1e-8), .96 / max(peak, 1e-8), 4)
    wave *= gain
    wave[:120] *= np.linspace(0, 1, 120)
    wave[-120:] *= np.linspace(1, 0, 120)
    if reference_profile()[1] != anchor_sha or spoken_timbre_profile(anchor_sha, anchor)[1] != speech_sha:
        raise ValueError('voice_changed_during_render')
    sf.write(out, wave, 24000, subtype='PCM_16')
    report = dict(backend='soulx_score', scoreSource=score['source'], model=manifest,
                  anchorSha256=anchor_sha, speechTimbreSha256=speech_sha, steps=args.steps,
                  lyrics=score['lines'], segments=records, durationSeconds=len(wave) / 24000,
                  peak=float(np.max(np.abs(wave))), gainDb=float(20 * np.log10(gain)),
                  renderSeconds=round(time.monotonic() - started, 2),
                  promptAlignment='approximate ASR + CPU pYIN; approved spoken output',
                  subjectiveQualityApproved=False, productionReady=False)
    out.with_suffix('.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    stage('audition-complete', out=str(out), **report)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    parser.add_argument('--steps', type=int, choices=[16, 32], default=32)
    parser.add_argument('--seed', type=int, default=20261031)
    run(parser.parse_args())
