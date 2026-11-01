"""Retired WORLD experiment, kept for historical diagnostics; qq_sing never uses it."""
import json
import math
import hashlib
import re
import sys
import wave
import subprocess
import os
from pathlib import Path

ROOT=next(p for p in Path(__file__).resolve().parents if (p/'bot-home').is_dir())

def melody(notes, bpm=100):
    if not isinstance(notes,list) or not 1<=len(notes)<=32: raise ValueError('notes_count')
    if type(bpm) not in (int,float) or not 50<=bpm<=180: raise ValueError('bpm_range')
    result=[]
    for row in notes:
        note=str(row.get('note','')); beats=row.get('beats',1)
        if type(beats) not in (int,float) or not .25<=beats<=4: raise ValueError('note_duration')
        if note=='rest': frequency=0
        else:
            m=re.fullmatch(r'([A-G])([#b]?)([3-5])',note)
            if not m: raise ValueError('note_name')
            midi=(int(m[3])+1)*12+{'C':0,'D':2,'E':4,'F':5,'G':7,'A':9,'B':11}[m[1]]+{'':0,'#':1,'b':-1}[m[2]]
            frequency=440*2**((midi-69)/12)
            if not 180<=frequency<=700: raise ValueError('note_outside_voice_range')
        result.append((frequency,beats*60/bpm))
    if sum(duration for _,duration in result)>20: raise ValueError('melody_too_long')
    return result

def render(notes,bpm,out,source_audio=None):
    import numpy as np
    import pyworld as pw
    cfg=json.loads((ROOT/'bot-home/media/onebot/tts-voice.json').read_text(encoding='utf8'))
    reference=(ROOT/cfg['reference']['path']).resolve()
    if hashlib.sha256(reference.read_bytes()).hexdigest()!=cfg['reference']['sha256']: raise ValueError('reference_changed')
    if source_audio:
        source=Path(source_audio).resolve(strict=True)
        if not source.is_relative_to((ROOT/'bot-home/media/onebot').resolve()):raise ValueError('singing_source_rejected')
        decoded=subprocess.run(['ffmpeg','-v','error','-nostdin','-i',str(source),'-f','f64le','-ac','1','-ar','24000','pipe:1'],
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True,timeout=10,creationflags=0x08000000 if os.name=='nt' else 0)
        x=np.frombuffer(decoded.stdout,dtype='<f8').copy();rate=24000
        if len(x)>rate*45:raise ValueError('singing_source_too_long')
    else:
        with wave.open(str(reference),'rb') as source:
            rate=source.getframerate();channels=source.getnchannels()
            if source.getsampwidth()!=2:raise ValueError('reference_pcm16_required')
            x=np.frombuffer(source.readframes(source.getnframes()),dtype='<i2').astype('float64')/32768
            if channels>1:x=x.reshape(-1,channels).mean(axis=1)
    f0,t=pw.harvest(x,rate,f0_floor=100,f0_ceil=750,frame_period=5)
    f0=pw.stonemask(x,f0,t,rate)
    sp=pw.cheaptrick(x,f0,t,rate);ap=pw.d4c(x,f0,t,rate)
    voiced=np.flatnonzero((f0>180)&(f0<650))
    if len(voiced)<8: raise ValueError('reference_has_no_stable_voice')
    # One stable voiced region from her own approved recording supplies the envelope.
    groups=np.split(voiced,np.where(np.diff(voiced)>1)[0]+1)
    region=max(groups,key=len);mid=region[len(region)//2]
    region=np.arange(max(region[0],mid-8),min(region[-1]+1,mid+9))
    spectrum=np.mean(sp[region],axis=0);noise=np.mean(ap[region],axis=0)
    parts=melody(notes,bpm); frames=[];amplitudes=[]
    previous=0
    for freq,duration in parts:
        count=max(2,round(duration/.005));times=np.arange(count)*.005
        contour=np.full(count,freq,dtype='float64')
        envelope=np.ones(count)
        if freq:
            contour*=1+0.008*np.sin(2*np.pi*5.1*times)*np.minimum(1,times/.2)
            edge=min(8,count//3)
            if previous:
                contour[:edge]=np.linspace(previous,freq,edge)
            envelope[:edge]=np.linspace(.05,1,edge);envelope[-edge:]=np.linspace(1,.05,edge)
        else:envelope[:]=0
        frames.extend(contour);amplitudes.extend(envelope);previous=freq
    frames=np.asarray(frames,dtype='float64'); env=np.asarray(amplitudes)
    if source_audio:
        count=sum(freq>0 for freq,_ in parts)
        # Commas in the fixed-voice source separate syllables. Choose nearby energy
        # minima for boundaries, preserving consonants instead of a fixed vowel.
        energy=np.array([np.mean(x[max(0,int(at*rate)-240):min(len(x),int(at*rate)+240)]**2) for at in t])
        voiced_range=np.flatnonzero(energy>max(float(energy.max())*.012,1e-7))
        if len(voiced_range)<count*4:raise ValueError('singing_source_empty')
        lo,hi=voiced_range[0],voiced_range[-1]+1;bounds=[lo]
        for index in range(1,count):
            center=lo+(hi-lo)*index/count;window=(hi-lo)/count*.35
            left=max(bounds[-1]+4,int(center-window));right=min(hi-4,int(center+window))
            if right<=left:raise ValueError('singing_alignment_invalid')
            bounds.append(left+int(np.argmin(energy[left:right])))
        bounds.append(hi)
        spectral=[];aperiodic=[];cursor=0;syllable=0
        for freq,duration in parts:
            n=max(2,round(duration/.005))
            if freq:
                start,end=bounds[syllable:syllable+2];syllable+=1
                positions=np.linspace(start,end-1,n);left=positions.astype(int);right=np.minimum(left+1,end-1);mix=(positions-left)[:,None]
                spectral.extend(sp[left]*(1-mix)+sp[right]*mix)
                aperiodic.extend(ap[left]*(1-mix)+ap[right]*mix)
                frames[cursor:cursor+n]*=(f0[np.round(positions).astype(int)]>0)
            else:
                spectral.extend(np.tile(spectrum,(n,1)));aperiodic.extend(np.tile(noise,(n,1)))
            cursor+=n
        spectral=np.maximum(np.asarray(spectral),1e-12);aperiodic=np.clip(np.asarray(aperiodic),1e-6,1)
    else:
        spectral=np.tile(np.maximum(spectrum,1e-12),(len(frames),1))
        aperiodic=np.tile(np.clip(noise,1e-6,1),(len(frames),1))
    audio=pw.synthesize(frames,spectral,aperiodic,rate,frame_period=5)
    audio*=np.interp(np.arange(len(audio))/rate,np.arange(len(env))*.005,env)
    if not np.isfinite(audio).all():raise ValueError('invalid_humming_audio')
    peak=float(np.max(np.abs(audio)))
    if peak:audio*=.85/peak
    out=Path(out).resolve();media=(ROOT/'bot-home/media/onebot').resolve()
    if not out.is_relative_to(media):raise ValueError('output_path_rejected')
    out.parent.mkdir(parents=True,exist_ok=True)
    import wave as wav
    with wav.open(str(out),'wb') as target:
        target.setnchannels(1);target.setsampwidth(2);target.setframerate(rate)
        target.writeframes((np.clip(audio,-.99,.99)*32767).astype('<i2').tobytes())
    return {'path':str(out),'seconds':len(audio)/rate,'kind':'short_singing' if source_audio else 'wordless_humming','referenceSha256':cfg['reference']['sha256']}

if __name__=='__main__':
    args=json.load(sys.stdin)
    print(json.dumps(render(args['notes'],args.get('bpm',100),args['out'],args.get('sourceAudio'))),flush=True)
