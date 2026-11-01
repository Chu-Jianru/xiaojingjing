"""Compare a converted audition to its supplied performance, not a note grid.

Contour/dynamics/ASR diagnostics cannot approve emotion or speaker likeness.
"""
import argparse
import json
import os
from pathlib import Path
import urllib.request

from performance_singing_audition import ROOT, REFERENCE_ROOT, OUTPUT_ROOT
from score_singing_audition import cpu_environment
from singing_worker import watch_parent


def run(source, candidate):
    cpu_environment()
    watch_parent(os.getppid())
    import numpy as np
    import librosa
    import soundfile as sf
    source, candidate = Path(source).resolve(strict=True), Path(candidate).resolve(strict=True)
    if not source.is_relative_to(REFERENCE_ROOT.resolve()) or not candidate.is_relative_to(OUTPUT_ROOT.resolve()):
        raise ValueError('performance_verification_path_rejected')
    waves = []
    for path in (source, candidate):
        wave, sr = sf.read(path, dtype='float32')
        if wave.ndim != 1 or not 1 <= len(wave) / sr <= 25:
            raise ValueError('performance_verification_mono_short_required')
        waves.append(librosa.resample(wave, orig_sr=sr, target_sr=16000))
    source_wave, output_wave = waves
    tracks, rms_tracks = [], []
    for wave in waves:
        f0, _, _ = librosa.pyin(wave, sr=16000, fmin=90, fmax=750, frame_length=1024, hop_length=320)
        tracks.append(f0)
        rms_tracks.append(librosa.feature.rms(y=wave, frame_length=800, hop_length=320)[0])
    length = min(map(len, tracks))
    left, right = tracks[0][:length], tracks[1][:length]
    common = np.isfinite(left) & np.isfinite(right)
    errors = np.abs(1200 * np.log2(right[common] / left[common]))
    rms_length = min(map(len, rms_tracks))
    logs = [20 * np.log10(np.maximum(track[:rms_length], 1e-6)) for track in rms_tracks]
    correlation = float(np.corrcoef(*logs)[0, 1])
    token = (ROOT / 'bot-home/media/onebot/calls/control.token').read_text(encoding='utf8').strip()
    request = urllib.request.Request('http://127.0.0.1:8401/transcribe',
        data=json.dumps({'path': str(candidate)}).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
    with urllib.request.urlopen(request, timeout=20) as response:
        transcript = json.load(response)['text']
    report = dict(source=str(source), candidate=str(candidate),
        sourceSeconds=len(source_wave) / 16000, candidateSeconds=len(output_wave) / 16000,
        commonVoicedFrames=int(common.sum()),
        medianContourErrorCents=float(np.median(errors)) if len(errors) else None,
        voicedFramesWithin50Cents=int(np.sum(errors <= 50)),
        logRmsEnvelopeCorrelation=correlation,
        clippedSamples=int(np.sum(np.abs(output_wave) >= .999)),
        transcription=transcript,
        caveat='Framewise contour and energy metrics are not listening approval of emotion, perceived age or timbre.')
    candidate.with_suffix('.verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--candidate', required=True)
    args = parser.parse_args()
    run(args.source, args.candidate)
