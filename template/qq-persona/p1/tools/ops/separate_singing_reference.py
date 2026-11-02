"""Prepare an isolated vocal reference from a local real-song preview, CPU only."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
import time

from singing_worker import ROOT,RUNTIME,watch_parent
from score_singing_audition import cpu_environment


def run(source,start,seconds):
    source=Path(source).resolve(strict=True)
    if (not source.is_relative_to((RUNTIME/'song-reference').resolve()) or source.stat().st_size>100*1024**2
            or not math.isfinite(start) or not math.isfinite(seconds) or not 1<=seconds<=25 or start<0):
        raise ValueError('song_reference_rejected')
    out=source.parent/'vocals.wav'
    if out.exists():raise ValueError('reference_already_prepared')
    cpu_environment();watch_parent(os.getppid())
    os.environ['TORCH_HOME']=str(RUNTIME/'separation-models')
    # Only the official Demucs download is deserialized in this isolated process.
    os.environ['TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD']='1'
    import torch
    import numpy as np
    import soundfile as sf
    from demucs.pretrained import get_model
    from demucs.apply import apply_model
    torch.set_num_threads(2)
    if torch.get_num_interop_threads()!=1:torch.set_num_interop_threads(1)
    started=time.monotonic()
    model=get_model('htdemucs').to('cpu').eval()
    with tempfile.TemporaryDirectory(dir=source.parent) as temp:
        clip=Path(temp)/'clip.wav'
        flags={'creationflags':0x08000000} if os.name=='nt' else {}
        subprocess.run(['ffmpeg','-v','error','-nostdin','-i',str(source),'-ss',str(start),'-t',str(seconds),
            '-ar',str(model.samplerate),'-ac','2','-c:a','pcm_s16le',str(clip)],check=True,timeout=30,**flags)
        wave,sr=sf.read(clip,dtype='float32',always_2d=True)
        if abs(len(wave)/sr-seconds)>.1:raise ValueError('reference_clip_truncated')
        audio=torch.from_numpy(wave.T)
        reference=audio.mean(0);mean=reference.mean();std=reference.std()
        if std<1e-6:raise ValueError('reference_silent')
        with torch.inference_mode():
            separated=apply_model(model,((audio-mean)/std)[None],device='cpu',shifts=0,split=True,overlap=.25,progress=False,num_workers=0)[0]
        vocals=(separated[model.sources.index('vocals')]*std+mean).numpy().mean(0)
        if not np.isfinite(vocals).all() or float(np.sqrt(np.mean(vocals**2)))<1e-5:raise ValueError('separation_invalid')
        peak=float(np.max(np.abs(vocals)))
        if peak>.96:vocals*=.96/peak
        sf.write(out,vocals,sr,subtype='PCM_16')
    hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (RUNTIME/'separation-models/hub/checkpoints').glob('*.th')}
    report=dict(backend='demucs-4.0.1-htdemucs',sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),
        outputSha256=hashlib.sha256(out.read_bytes()).hexdigest(),models=hashes,startSeconds=start,durationSeconds=len(vocals)/sr,
        elapsedSeconds=round(time.monotonic()-started,2),cpuThreads=2,subjectiveQualityApproved=False)
    out.with_suffix('.separation.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps(dict(event='reference-separated',path=str(out),**report)),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--source',required=True)
    parser.add_argument('--start',type=float,default=0);parser.add_argument('--seconds',type=float,default=20)
    args=parser.parse_args();run(args.source,args.start,args.seconds)
