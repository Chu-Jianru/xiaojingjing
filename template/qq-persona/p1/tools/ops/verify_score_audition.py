"""Offline diagnostics, explicitly not a subjective voice/emotion approval."""
import argparse
import gc
import json
import os
from pathlib import Path
import unicodedata
import urllib.request

from score_singing_audition import cpu_environment, stage
from singing_worker import watch_parent
from singing_score import ROOT, load_score, phrase_events


def edit_distance(a, b):
    previous = list(range(len(b) + 1))
    for i, left in enumerate(a, 1):
        current = [i]
        for j, right in enumerate(b, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (left != right)))
        previous = current
    return previous[-1]


def run(path, engine='sensevoice'):
    cpu_environment()
    watch_parent(os.getppid())
    import numpy as np
    import torch
    import librosa
    import soundfile as sf
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    path = Path(path).resolve(strict=True)
    if not path.is_relative_to((ROOT / 'bot-home/media/onebot/music').resolve()):
        raise ValueError('audition_input_rejected')
    audio, sr = sf.read(path, dtype='float32')
    if audio.ndim != 1 or len(audio) / sr > 60:
        raise ValueError('audition_mono_excerpt_required')
    score, events = load_score()
    if abs(len(audio) / sr - sum(e['beats'] for e in events) * 60 / score['bpm']) > .04:
        raise ValueError('audition_duration_does_not_match_score')
    y = librosa.resample(audio, orig_sr=sr, target_sr=16000)
    stage('extract-f0-cpu')
    f0, _, voiced = librosa.pyin(y, sr=16000, fmin=70, fmax=750, frame_length=1024, hop_length=320)
    midi = librosa.hz_to_midi(f0)
    notes = []
    for e in events:
        if not e['char']:
            continue
        # Compare interior note centres, excluding consonant attacks/transitions.
        start = (e['startBeat'] + .35 * e['beats']) * 60 / score['bpm']
        end = (e['startBeat'] + .90 * e['beats']) * 60 / score['bpm']
        frames = midi[round(start * 50):max(round(end * 50), round(start * 50) + 1)]
        frames = frames[np.isfinite(frames)]
        detected = float(np.median(frames)) if len(frames) else None
        notes.append(dict(char=e['char'], expectedMidi=e['midi'], medianMidi=detected,
                          errorCents=(detected - e['midi']) * 100 if detected else None,
                          durationSeconds=e['beats'] * 60 / score['bpm']))
    errors = [abs(n['errorCents']) for n in notes if n['errorCents'] is not None]
    stage('transcribe-without-lyric-prompt', engine=engine)
    asr_segments = []
    if engine == 'sensevoice':
        # Long uninterrupted singing lost later phrases in SenseVoice despite
        # correct per-phrase recognition. Split the ACTUAL merged output at the
        # known score boundaries, rather than trusting earlier raw line files.
        token = (ROOT / 'bot-home/media/onebot/calls/control.token').read_text(encoding='utf8').strip()
        folder = path.parent / '.verification'
        folder.mkdir(exist_ok=True)
        offset = 0
        for index, group in enumerate(phrase_events(score, events), 1):
            count = round(sum(e['beats'] for e in group) * 60 / score['bpm'] * sr)
            chunk = folder / (path.stem + f'-line{index}.wav')
            sf.write(chunk, audio[offset:offset + count], sr, subtype='PCM_16')
            offset += count
            request = urllib.request.Request('http://127.0.0.1:8401/transcribe',
                data=json.dumps({'path': str(chunk)}).encode(),
                headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
            with urllib.request.urlopen(request, timeout=20) as response:
                part = json.load(response)
            asr_segments.append(dict(line=index, text=part['text']))
        result = {'text': ''.join(part['text'] for part in asr_segments)}
    else:
        import whisper
        model = whisper.load_model(str(ROOT / 'bot-home/singing-runtime/models/whisper/medium.pt'), device='cpu')
        result = model.transcribe(y, language='zh', fp16=False, condition_on_previous_text=False,
                                  beam_size=1, best_of=1, temperature=0, verbose=False)
        del model
        gc.collect()
    clean = lambda s: ''.join(c for c in unicodedata.normalize('NFKC', s) if '\u4e00' <= c <= '\u9fff')
    expected, recognized = clean(''.join(score['lines'])), clean(result['text'])
    report = dict(file=str(path), durationSeconds=len(audio) / sr,
                  rms=float(np.sqrt(np.mean(audio ** 2))), peak=float(np.max(np.abs(audio))),
                  clippedSamples=int(np.sum(np.abs(audio) >= .999)),
                  transcription=result['text'], asrEngine=engine, asrSegments=asr_segments, expectedText=expected,
                  characterEditDistance=edit_distance(expected, recognized),
                  medianNoteErrorCents=float(np.median(errors)) if errors else None,
                  notesWithin50Cents=sum(x <= 50 for x in errors), measuredNotes=len(errors),
                  totalNotes=len(notes), notes=notes,
                  caution='ASR and pYIN are diagnostics; neither approves timbre, perceived age, emotion or naturalness.')
    path.with_suffix('.verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    stage('verification-complete', **{k: v for k, v in report.items() if k != 'notes'})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('path')
    parser.add_argument('--asr', choices=['sensevoice', 'whisper'], default='sensevoice')
    args = parser.parse_args()
    run(args.path, args.asr)
