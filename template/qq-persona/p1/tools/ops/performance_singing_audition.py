"""Offline performance-preserving SVC with the approved Xiaojingjing timbre.

Uses a user-supplied performance as musical content, never as speaker identity.
This is reference-conditioned inference, not weight training or production ready.
"""
from pathlib import Path
import argparse
import hashlib
import json
import math
import os
import subprocess
import time

from singing_worker import ROOT, RUNTIME, MODEL, reference_profile, spoken_timbre_profile, watch_parent, load_pipeline, progress

REFERENCE_ROOT = RUNTIME / 'song-reference'
OUTPUT_ROOT = ROOT / 'bot-home/media/onebot/music'


def validate_paths(source, out):
    source, out = Path(source).resolve(strict=True), Path(out).resolve()
    if not source.is_file() or not source.is_relative_to(REFERENCE_ROOT.resolve()) or source.suffix.lower() not in {'.wav', '.mp4', '.m4a', '.mp3', '.webm', '.mov'}:
        raise ValueError('performance_source_rejected')
    if source.stat().st_size > 100 * 1024 ** 2:
        raise ValueError('performance_source_too_large')
    if not out.is_relative_to(OUTPUT_ROOT.resolve()) or out.suffix.lower() != '.wav':
        raise ValueError('performance_output_rejected')
    return source, out


def decode_reference(source, start, end):
    if not math.isfinite(start) or start < 0 or (end is not None and (not math.isfinite(end) or end <= start)):
        raise ValueError('performance_clip_invalid')
    flags = {'creationflags': 0x08000000} if os.name == 'nt' else {}
    info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'json', str(source)], timeout=15, **flags))
    duration = float(info['format']['duration'])
    end = duration if end is None else end
    if not math.isfinite(duration) or end > duration + .05 or not 1 <= end - start <= 25:
        # The content tokenizer's Whisper encoder accepts at most 30s; never
        # silently trim a longer performance and report the complete lyrics.
        raise ValueError('performance_clip_must_be_1_to_25_seconds')
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    folder = source.parent / 'prepared'
    folder.mkdir(exist_ok=True)
    path = folder / f'{digest[:16]}-{round(start * 1000)}-{round(end * 1000)}.wav'
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', str(source), '-ss', str(start),
        '-t', str(end - start), '-vn', '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', str(path)],
        check=True, timeout=30, **flags)
    return path, digest, dict(startSeconds=start, endSeconds=end)


def generate(source, out, *, start=0, end=None, pipeline=None, backend='vevo2'):
    if backend == 'soulx':
        return generate_soulx(source,out,start=start,end=end)
    if backend != 'vevo2':
        raise ValueError('performance_backend_rejected')
    source, out = validate_paths(source, out)
    anchor, anchor_sha = reference_profile()
    reference, speech_sha = spoken_timbre_profile(anchor_sha, anchor)
    clip, source_sha, interval = decode_reference(source, start, end)
    manifest = json.loads((RUNTIME / 'model-manifest.json').read_text(encoding='utf8'))
    # A conversion needs only these existing checkpoints, not the AR/prosody models.
    required = ('tokenizer/contentstyle_fvq16384_12.5hz/model.safetensors',
                'acoustic_modeling/fm_emilia101k_singnet7k_repa/model.safetensors',
                'vocoder/model.safetensors')
    progress('verify-conversion-models')
    for name in required:
        with (MODEL / name).open('rb') as file:
            if hashlib.file_digest(file, 'sha256').hexdigest() != manifest['sha256'][name]:
                raise ValueError('performance_model_hash_mismatch')
    started = time.monotonic()
    if pipeline is None:
        pipeline = load_pipeline(conversion_only=True)
    import numpy as np
    import torch
    import soundfile as sf
    torch.manual_seed(20261031)
    progress('convert-performance', loadSeconds=round(time.monotonic() - started, 2))
    with torch.inference_mode():
        audio = pipeline.inference_fm(src_wav_path=str(clip), timbre_ref_wav_path=str(reference),
            use_pitch_shift=False, whisper_spec_perturb=False, flow_matching_steps=32,
            used_duration_of_timbre_ref_wav_path=9, display_audio=False)
    samples = audio.detach().float().cpu().numpy().reshape(-1)
    original, sample_rate = sf.read(clip, dtype='float32')
    if not np.all(np.isfinite(samples)) or abs(len(samples) - len(original)) > 2400:
        raise ValueError('performance_output_invalid_or_truncated')
    rms, peak = float(np.sqrt(np.mean(samples ** 2))), float(np.max(np.abs(samples)))
    if rms < 1e-5:
        raise ValueError('performance_output_silent')
    # One constant gain only; no pitch grid, formant shift, timing warp, copied
    # human audio, or envelope pumping mixed into the generated waveform.
    gain = min(.12 / rms, .96 / max(peak, 1e-8))
    samples = (samples * gain).astype('float32')
    if reference_profile()[1] != anchor_sha or spoken_timbre_profile(anchor_sha, anchor)[1] != speech_sha:
        raise ValueError('voice_changed_during_conversion')
    if hashlib.sha256(source.read_bytes()).hexdigest() != source_sha:
        raise ValueError('performance_changed_during_conversion')
    out.parent.mkdir(parents=True, exist_ok=True)
    sf.write(out, samples, sample_rate, subtype='PCM_16')
    report = dict(backend='vevo2_performance_svc', source=str(source), sourceSha256=source_sha,
        sourceInterval=interval, voiceSha256=anchor_sha, speechTimbreSha256=speech_sha,
        modelRevision=manifest['revision'], durationSeconds=len(samples) / sample_rate,
        sourceDurationSeconds=len(original) / sample_rate, elapsedSeconds=round(time.monotonic() - started, 2),
        outputSha256=hashlib.sha256(out.read_bytes()).hexdigest(), rms=float(np.sqrt(np.mean(samples ** 2))),
        peak=float(np.max(np.abs(samples))), pitchShift=False, humanWaveformMixed=False,
        fineTuned=False, subjectiveQualityApproved=False, productionReady=False)
    out.with_suffix('.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    progress('performance-audition-complete', **report)
    return report


def generate_soulx(source,out,*,start=0,end=None):
    """Audio-content SVC, avoiding approximate word-duration conditions entirely."""
    source,out=validate_paths(source,out)
    anchor,anchor_sha=reference_profile()
    reference,speech_sha=spoken_timbre_profile(anchor_sha,anchor)
    from score_singing_audition import cpu_environment, UPSTREAM
    cpu_environment()
    import sys,gc
    import numpy as np
    import torch,librosa,soundfile as sf
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    torch.manual_seed(20261031)
    clip,source_sha,interval=decode_reference(source,start,end)
    manifest=json.loads((RUNTIME/'svc-model-manifest.json').read_text(encoding='utf8'))
    revision=subprocess.check_output(['git','-C',str(UPSTREAM),'rev-parse','HEAD'],text=True).strip()
    if revision!=manifest['codeRevision']:
        raise ValueError('svc_code_revision_changed')
    content=manifest['contentEncoder']
    model_path=Path(manifest['path'])/manifest['filename']
    content_path=Path(content['path'])
    progress('verify-soulx-svc-assets')
    for path,digest in [(model_path,manifest['sha256']),(content_path/content['filename'],content['sha256'])]:
        if not path.resolve().is_relative_to(RUNTIME.resolve()):
            raise ValueError('svc_model_path_rejected')
        with path.open('rb') as handle:
            if hashlib.file_digest(handle,'sha256').hexdigest()!=digest:
                raise ValueError('svc_asset_hash_mismatch')
    samples,sr=sf.read(clip,dtype='float32')
    frame_count=int(len(samples)/sr*50)
    samples=samples[:frame_count*480]
    y16=librosa.resample(samples,orig_sr=sr,target_sr=16000)
    settings=dict(method='torchcrepe-full',sampleRate=16000,hop=320,fmin=90,fmax=750,pad=True)
    cache=source.parent/'reference-contour.npz'
    tracked=None
    if start==0 and end is None and cache.exists():
        with np.load(cache,allow_pickle=False) as saved:
            if str(saved['sourceSha256'])==source_sha and json.loads(str(saved['settings']))==settings:
                tracked,confidence=saved['f0'].copy()[:frame_count],saved['confidence'].copy()[:frame_count]
    if tracked is None:
        import torchcrepe
        with torch.inference_mode():
            tracked,confidence=torchcrepe.predict(torch.from_numpy(y16).unsqueeze(0),16000,hop_length=320,
                fmin=90,fmax=750,model='full',return_periodicity=True,batch_size=128,device='cpu',pad=True)
        tracked,confidence=tracked[0].numpy()[:frame_count],confidence[0].numpy()[:frame_count]
    from melody_locked_audition import repair_brief_pitch_gaps,pitch_gate
    gate_f0=np.where(confidence>=.45,tracked,0)
    rms=librosa.feature.rms(y=y16,frame_length=1024,hop_length=320)[0][:frame_count]
    target_f0,repairs=repair_brief_pitch_gaps(tracked,confidence,rms)
    prompt_wave,prompt_sr=sf.read(reference,dtype='float32')
    prompt_f0,_,_=librosa.pyin(librosa.resample(prompt_wave,orig_sr=prompt_sr,target_sr=16000),
        sr=16000,fmin=90,fmax=750,frame_length=1024,hop_length=320)
    sys.path.insert(0,str(UPSTREAM))
    from transformers import WhisperFeatureExtractor,WhisperModel
    from soulxsinger.models.modules import whisper_encoder
    # The reviewed upstream class hardcodes a Hub model ID. Resolve only that
    # constructor to our SHA-verified local assets; never edit vendor source or
    # let inference silently fetch another revision / move onto CUDA.
    def local_content_encoder(self,device=None):
        self.fe=WhisperFeatureExtractor.from_pretrained(content_path,local_files_only=True)
        self.model=WhisperModel.from_pretrained(content_path,local_files_only=True).to('cpu').eval()
    from omegaconf import OmegaConf
    from soulxsinger.models.soulxsinger_svc import SoulXSingerSVC
    started=time.monotonic()
    progress('load-soulx-svc-model')
    original_content_constructor=whisper_encoder.WhisperEncoder.__init__
    try:
        whisper_encoder.WhisperEncoder.__init__=local_content_encoder
        model=SoulXSingerSVC(OmegaConf.load(UPSTREAM/'soulxsinger/config/soulxsinger.yaml')).eval()
    finally:
        whisper_encoder.WhisperEncoder.__init__=original_content_constructor
    checkpoint=torch.load(model_path,map_location='cpu',weights_only=False,mmap=True)
    model.load_state_dict(checkpoint['state_dict'],strict=True)
    del checkpoint
    gc.collect()
    prompt_tensor=torch.from_numpy(prompt_wave).unsqueeze(0)
    with torch.inference_mode():
        prompt_frames=model.mel(prompt_tensor).shape[1]
    prompt_f0=np.nan_to_num(prompt_f0)
    prompt_f0=np.pad(prompt_f0,(0,max(0,prompt_frames-len(prompt_f0))))[:prompt_frames]
    progress('convert-soulx-svc-performance',steps=32,guidance=1,sourceFrames=frame_count)
    with torch.inference_mode():
        wave,shift=model.infer(pt_wav=prompt_tensor,gt_wav=torch.from_numpy(samples).unsqueeze(0),
            pt_f0=torch.tensor(prompt_f0,dtype=torch.float32).unsqueeze(0),
            gt_f0=torch.tensor(target_f0,dtype=torch.float32).unsqueeze(0),
            auto_shift=False,pitch_shift=0,n_steps=32,cfg=1,use_fp16=False)
    wave=wave.detach().cpu().numpy().reshape(-1)
    if not np.isfinite(wave).all() or len(wave)!=len(samples) or shift!=0:
        raise ValueError('svc_output_invalid')
    rms,peak=float(np.sqrt(np.mean(wave**2))),float(np.max(np.abs(wave)))
    if rms<1e-5:
        raise ValueError('svc_output_silent')
    wave*=min(.12/rms,.96/max(peak,1e-8))
    diagnostic=OUTPUT_ROOT/'.diagnostics'/out.name
    diagnostic.parent.mkdir(exist_ok=True,parents=True)
    sf.write(diagnostic,wave,24000,subtype='PCM_16')
    output_f0,_,_=librosa.pyin(librosa.resample(wave,orig_sr=24000,target_sr=16000),
        sr=16000,fmin=90,fmax=750,frame_length=1024,hop_length=320)
    gate=pitch_gate(gate_f0,output_f0)
    report=dict(backend='soulx_performance_svc',source=str(source),sourceSha256=source_sha,sourceInterval=interval,
        voiceSha256=anchor_sha,speechTimbreSha256=speech_sha,modelRevision=manifest['revision'],
        modelSha256=manifest['sha256'],contentEncoderRevision=content['revision'],
        durationSeconds=len(wave)/24000,elapsedSeconds=round(time.monotonic()-started,2),
        peak=float(np.max(np.abs(wave))),gates=[gate],guidance=1,steps=32,contourRepairs=repairs,
        pitchShift=False,humanWaveformMixed=False,fineTuned=False,subjectiveQualityApproved=False,productionReady=False)
    diagnostic.with_suffix('.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    if not gate['passed']:
        progress('soulx-svc-rejected-pitch-gate',**gate)
        return report
    if reference_profile()[1]!=anchor_sha or spoken_timbre_profile(anchor_sha,anchor)[1]!=speech_sha:
        raise ValueError('voice_changed_during_conversion')
    if hashlib.sha256(source.read_bytes()).hexdigest()!=source_sha:
        raise ValueError('performance_changed_during_conversion')
    out.parent.mkdir(exist_ok=True,parents=True)
    sf.write(out,wave,24000,subtype='PCM_16')
    report['outputSha256']=hashlib.sha256(out.read_bytes()).hexdigest()
    out.with_suffix('.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    progress('soulx-svc-audition-complete',**report)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--start', type=float, default=0)
    parser.add_argument('--end', type=float)
    parser.add_argument('--backend',choices=['vevo2','soulx'],default='vevo2')
    args = parser.parse_args()
    watch_parent(os.getppid())
    generate(args.source, args.out, start=args.start, end=args.end,backend=args.backend)
