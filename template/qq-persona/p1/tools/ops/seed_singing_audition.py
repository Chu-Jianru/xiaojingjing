"""Offline, pinned Seed-VC F0 singing comparison. Never enables QQ or approves quality."""
from argparse import Namespace
import hashlib
import json
import os
from pathlib import Path
import sys
import time
from unittest.mock import patch

from singing_worker import ROOT,RUNTIME,reference_profile,spoken_timbre_profile,watch_parent
from score_singing_audition import cpu_environment


def sha(path):
    with Path(path).open('rb') as handle:return hashlib.file_digest(handle,'sha256').hexdigest()


def main():
    cpu_environment()
    watch_parent(os.getppid())
    source=RUNTIME/'song-reference/douyin-7547374117817683258/performance.wav'
    expected_source='bd046089029bdf63c8db7120c08461e4eb8a77eb0f9eee5de3773972304eeb89'
    if sha(source)!=expected_source:raise ValueError('source_changed')
    anchor,anchor_sha=reference_profile()
    voice,speech_sha=spoken_timbre_profile(anchor_sha,anchor)
    manifest=json.loads((RUNTIME/'seed-model-manifest.json').read_text(encoding='utf8'))
    assets=manifest['assets']
    for entry in assets.values():
        folder=Path(entry['path']).resolve()
        if not folder.is_relative_to((RUNTIME/'models/seed-vc').resolve()):raise ValueError('asset_path_rejected')
        for name,digest in entry['sha256'].items():
            if sha(folder/name)!=digest:raise ValueError('asset_hash_mismatch')
    if set(assets)!={'singing','pitch','speaker','content','vocoder'}:raise ValueError('assets_incomplete')
    upstream=RUNTIME/'seed-vc-benchmark'
    provenance=json.loads((upstream/'benchmark-source.json').read_text(encoding='utf8'))
    if provenance['revision']!='51383efd921027683c89e5348211d93ff12ac2a8':raise ValueError('seed_source_changed')
    # All loaded pickle checkpoints are from official pinned repositories and
    # SHA verified above. This compatibility setting applies only in this process.
    os.environ['TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD']='1'
    import torch
    import yaml
    import librosa
    import numpy as np
    import soundfile as sf
    torch.set_num_threads(2);torch.set_num_interop_threads(1);torch.manual_seed(20261031)
    sys.path.insert(0,str(upstream))
    import inference
    inference.device=torch.device('cpu')
    singing=Path(assets['singing']['path'])
    config=yaml.safe_load((singing/'config_dit_mel_seed_uvit_whisper_base_f0_44k.yml').read_text())
    config['model_params']['vocoder']['name']=assets['vocoder']['path']
    config['model_params']['speech_tokenizer']['name']=assets['content']['path']
    folder=ROOT/'bot-home/media/onebot/music/.diagnostics/seed-v2109'
    folder.mkdir(parents=True,exist_ok=True)
    if list(folder.glob('vc_*.wav')):raise ValueError('audition_exists_do_not_overwrite')
    local_config=folder/'local-config.yml'
    local_config.write_text(yaml.safe_dump(config),encoding='utf8')
    def local_asset(repo,filename,config_filename=None):
        for entry in assets.values():
            if entry['repo']==repo and filename in entry['sha256']:
                if config_filename:raise ValueError('unexpected_asset_config')
                return str(Path(entry['path'])/filename)
        raise ValueError('unreviewed_hub_asset')
    from transformers import WhisperModel
    original_whisper=WhisperModel.from_pretrained
    def cpu_whisper(name,*args,**kwargs):
        if str(name)!=assets['content']['path']:raise ValueError('unreviewed_content_model')
        kwargs.update(torch_dtype=torch.float32,local_files_only=True)
        return original_whisper(name,*args,**kwargs)
    args=Namespace(source=str(source),target=str(voice),output=str(folder),diffusion_steps=32,
        length_adjust=1.,inference_cfg_rate=.7,f0_condition=True,auto_f0_adjust=False,semi_tone_shift=0,
        checkpoint=str(singing/'DiT_seed_v2_uvit_whisper_base_f0_44k_bigvgan_pruned_ft_ema_v2.pth'),
        config=str(local_config),fp16=False)
    started=time.monotonic()
    with patch.object(inference,'load_custom_model_from_hf',local_asset),patch.object(WhisperModel,'from_pretrained',cpu_whisper):
        inference.main(args)
    raw=next(folder.glob('vc_*.wav'))
    wave,sr=sf.read(raw,dtype='float32')
    if wave.ndim!=1 or not np.isfinite(wave).all() or not 1<=len(wave)/sr<=25:raise ValueError('seed_output_invalid')
    original_duration=sf.info(source).duration
    if abs(len(wave)/sr-original_duration)>.15:raise ValueError('seed_duration_changed')
    rms=float(np.sqrt(np.mean(wave**2)));peak=float(np.max(np.abs(wave)))
    if rms<1e-5:raise ValueError('seed_output_silent')
    wave*=min(.12/rms,.96/max(peak,1e-8))
    # Common format/gain for comparison with SoulX and eventual QQ transport.
    wave=librosa.resample(wave,orig_sr=sr,target_sr=24000)
    if sha(source)!=expected_source or reference_profile()[1]!=anchor_sha or spoken_timbre_profile(anchor_sha,anchor)[1]!=speech_sha:
        raise ValueError('singing_identity_changed')
    out=folder/'wo-kan-guo-seed.wav';sf.write(out,wave,24000,subtype='PCM_16')
    report=dict(backend='seed_vc_singing',model=manifest,codeRevision=provenance['revision'],
        sourceSha256=expected_source,voiceSha256=anchor_sha,speechTimbreSha256=speech_sha,
        outputSha256=sha(out),durationSeconds=len(wave)/24000,elapsedSeconds=round(time.monotonic()-started,2),
        f0Condition=True,autoF0Adjust=False,pitchShift=False,steps=32,guidance=.7,cpuThreads=2,
        sourceWaveformMixed=False,fineTuned=False,subjectiveQualityApproved=False,productionReady=False)
    out.with_suffix('.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(dict(event='seed-audition-complete',path=str(out),seconds=report['durationSeconds'],elapsedSeconds=report['elapsedSeconds'])),flush=True)


if __name__=='__main__':main()
