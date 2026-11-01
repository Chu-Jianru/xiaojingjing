"""Offline melody-conditioned style regeneration with approved speech delivery.

Human performance supplies melody; approved speech supplies style AND identity.
This is an experiment, not a perceived-age or emotional-quality guarantee.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time

from performance_singing_audition import validate_paths, decode_reference
from singing_worker import ROOT, RUNTIME, MODEL, reference_profile, spoken_timbre_profile, load_pipeline, watch_parent, progress

LYRICS = '亲爱的不要再说你还爱我，因为看过你爱我的样子，我看过的最美的落日，是你陪我看海的样子。'


def validated_style(reference, digest):
    record = json.loads((reference.parent / 'spoken-alignment.json').read_text(encoding='utf8'))
    if record.get('speechTimbreSha256') != digest:
        raise ValueError('style_transcript_voice_mismatch')
    text = record.get('text', '').strip()
    if not 1 <= len(text) <= 120:
        raise ValueError('style_transcript_invalid')
    return text


def generate(source, out):
    source, out = validate_paths(source, out)
    anchor, anchor_sha = reference_profile()
    reference, speech_sha = spoken_timbre_profile(anchor_sha, anchor)
    style_text = validated_style(reference, speech_sha)
    clip, source_sha, interval = decode_reference(source, 0, None)
    manifest = json.loads((RUNTIME / 'model-manifest.json').read_text(encoding='utf8'))
    progress('verify-style-models')
    for name, digest in manifest['sha256'].items():
        with (MODEL / name).open('rb') as file:
            if hashlib.file_digest(file, 'sha256').hexdigest() != digest:
                raise ValueError('style_model_hash_mismatch')
    started = time.monotonic()
    pipeline = load_pipeline()
    import numpy as np
    import torch
    import soundfile as sf
    torch.manual_seed(20261031)
    progress('regenerate-style', loadSeconds=round(time.monotonic() - started, 2))
    original = pipeline.ar_model.generate
    def ar_generate(*args, **kwargs):
        progress('style-content')
        result = original(*args, **kwargs)
        progress('style-content-ready', tokens=int(result.shape[-1] - kwargs['input_ids'].shape[-1]))
        return result
    pipeline.ar_model.generate = ar_generate
    with torch.inference_mode():
        audio = pipeline.inference_ar_and_fm(target_text=LYRICS,
            prosody_wav_path=str(clip), style_ref_wav_path=str(reference),
            style_ref_wav_text=style_text, timbre_ref_wav_path=str(reference),
            use_prosody_code=True, predict_target_prosody=False, use_pitch_shift=False,
            flow_matching_steps=32, top_p=.8, temperature=.7,
            used_duration_of_timbre_ref_wav_path=9, display_audio=False)
    samples = audio.detach().float().cpu().numpy().reshape(-1)
    if not np.isfinite(samples).all() or not 24000 <= len(samples) <= 24000 * 25:
        raise ValueError('style_output_invalid')
    rms, peak = float(np.sqrt(np.mean(samples ** 2))), float(np.max(np.abs(samples)))
    if rms < 1e-5:
        raise ValueError('style_output_silent')
    samples *= min(.12 / rms, .96 / max(peak, 1e-8))
    if reference_profile()[1] != anchor_sha or spoken_timbre_profile(anchor_sha, anchor)[1] != speech_sha:
        raise ValueError('style_voice_changed')
    if hashlib.sha256(source.read_bytes()).hexdigest() != source_sha:
        raise ValueError('style_source_changed')
    out.parent.mkdir(parents=True, exist_ok=True)
    sf.write(out, samples, 24000, subtype='PCM_16')
    report = dict(backend='vevo2_style_regeneration', voiceSha256=anchor_sha,
        speechTimbreSha256=speech_sha, styleSource='approved_spoken_output',
        styleTranscript=style_text, melodySource=str(source), melodySha256=source_sha,
        durationSeconds=len(samples) / 24000, elapsedSeconds=round(time.monotonic() - started, 2),
        lyrics=LYRICS, modelRevision=manifest['revision'], pitchShift=False,
        humanWaveformMixed=False, subjectiveQualityApproved=False, productionReady=False,
        fineTuned=False, peak=float(np.max(np.abs(samples))))
    out.with_suffix('.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    progress('style-audition-complete', **report)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    watch_parent(os.getppid())
    generate(args.source, args.out)
