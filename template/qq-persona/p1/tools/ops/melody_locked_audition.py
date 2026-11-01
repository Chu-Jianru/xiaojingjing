"""Continuous-F0 conditioned offline singing; failed pitch gates never publish.

No waveform pitch correction. Reuses the installed SoulX SVS and approved voice.
"""
import copy
import gc
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import subprocess
import sys
import time
import argparse

from score_singing_audition import cpu_environment, prompt_metadata, phonemes, stage, UPSTREAM
from singing_worker import ROOT, RUNTIME, reference_profile, spoken_timbre_profile, watch_parent

FOLDER = RUNTIME / 'song-reference/douyin-7547374117817683258'
TEXT = '亲爱的不要再说你还爱我因为看过你爱我的样子我看过的最美的落日是你陪我看海的样子'
HALF = '亲爱的不要再说你还爱我因为看过你爱我的样子'


def normalize(text):
    return ''.join(c for c in text.translate(str.maketrans('親愛說還為過樣這', '亲爱说还为过样这')) if '\u4e00' <= c <= '\u9fff')


def pitch_gate(reference, output):
    length = min(len(reference), len(output))
    ref_voiced = sum(math.isfinite(x) and x > 0 for x in reference)
    errors = [float(abs(1200 * math.log2(b / a))) for a, b in zip(reference[:length], output[:length])
              if math.isfinite(a) and math.isfinite(b) and a > 0 and b > 0]
    median = statistics.median(errors) if errors else None
    within = sum(x <= 50 for x in errors) / len(errors) if errors else 0
    coverage = float(len(errors) / ref_voiced) if ref_voiced else 0.0
    passed = median is not None and median <= 35 and within >= .8 and coverage >= .8
    return dict(passed=passed, medianCents=median, fractionWithin50Cents=within,
                voicedCoverage=coverage, commonFrames=len(errors))


def aligned_units(record, total_frames):
    units, cursor, text = [], 0, ''
    for word in record['words']:
        chars = normalize(word['word'])
        if not chars:
            continue
        start = max(cursor, round(word['start'] * 50))
        end = min(total_frames, round(word['end'] * 50))
        if end - start < 2 * len(chars):
            raise ValueError('alignment_too_short')
        if start > cursor:
            units.append((None, cursor, start))
        for i, char in enumerate(chars):
            units.append((char, start + round(i * (end-start)/len(chars)), start + round((i+1)*(end-start)/len(chars))))
        cursor = end
        text += chars
    if text != TEXT:
        raise ValueError('reference_lyrics_mismatch')
    if cursor < total_frames:
        units.append((None, cursor, total_frames))
    return units


def repair_brief_pitch_gaps(f0, confidence, rms):
    """Recover only short, energetic, pitch-consistent confidence dropouts.

    Do not turn actual breaths, consonants, long gaps or note changes into vowels.
    These are input contour repairs, never waveform edits or pitch correction.
    """
    if not (len(f0) == len(confidence) == len(rms)):
        raise ValueError('contour_length_mismatch')
    raw = [float(x) for x in f0]
    if any(not math.isfinite(x) or x <= 0 for x in raw):
        raise ValueError('invalid_raw_contour')
    if any(not math.isfinite(float(x)) for x in confidence) or any(not math.isfinite(float(x)) or x < 0 for x in rms):
        raise ValueError('invalid_contour_confidence_or_energy')
    result = [x if c >= .45 else 0.0 for x, c in zip(raw, confidence)]
    maximum = max(rms, default=0)
    repairs, index = [], 0
    while index < len(result):
        if result[index] > 0:
            index += 1
            continue
        end = index + 1
        while end < len(result) and result[end] == 0:
            end += 1
        if index > 0 and end < len(result) and end-index <= 3 and maximum > 0:
            left, right = result[index-1], result[end]
            compatible = abs(1200*math.log2(right/left)) <= 100
            for k in range(index,end):
                expected = left * (right/left)**((k-index+1)/(end-index+1))
                compatible = compatible and confidence[k] >= .2 and rms[k] >= .1*maximum and abs(1200*math.log2(raw[k]/expected)) <= 100
            if compatible:
                result[index:end] = raw[index:end]
                repairs.append(dict(startSeconds=index/50,endSeconds=end/50))
        index = end
    return result, repairs


def run(continuous=False, gentle=False):
    continuous = continuous or gentle
    cpu_environment()
    watch_parent(os.getppid())
    import numpy as np
    import torch
    import librosa
    import soundfile as sf
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    torch.manual_seed(20261031)
    anchor, anchor_sha = reference_profile()
    reference, speech_sha = spoken_timbre_profile(anchor_sha, anchor)
    source = FOLDER / 'performance.wav'
    source_sha = hashlib.sha256(source.read_bytes()).hexdigest()
    y, sr = sf.read(source, dtype='float32')
    y16 = librosa.resample(y, orig_sr=sr, target_sr=16000)
    total_frames = int(len(y) / sr * 50)
    stage('extract-continuous-reference-f0')
    repairs = []
    if continuous:
        import torchcrepe
        settings = dict(method='torchcrepe-full',sampleRate=16000,hop=320,fmin=90,fmax=750,pad=True)
        cache = FOLDER/'reference-contour.npz'
        cached_track = np.load(cache,allow_pickle=False) if cache.exists() else None
        if cached_track is not None and str(cached_track['sourceSha256'])==source_sha and json.loads(str(cached_track['settings']))==settings:
            raw_f0, confidence = cached_track['f0'].copy(), cached_track['confidence'].copy()
            stage('reuse-source-contour')
        else:
            with torch.inference_mode():
                tracked, confidence = torchcrepe.predict(torch.from_numpy(y16).unsqueeze(0),16000,
                    hop_length=320,fmin=90,fmax=750,model='full',return_periodicity=True,batch_size=128,device='cpu',pad=True)
            raw_f0=tracked[0].numpy()[:total_frames]
            confidence=confidence[0].numpy()[:total_frames]
            np.savez(cache,f0=raw_f0,confidence=confidence,sourceSha256=source_sha,settings=json.dumps(settings,sort_keys=True))
        if cached_track is not None:
            cached_track.close()
        if len(raw_f0)!=total_frames or len(confidence)!=total_frames:
            raise ValueError('source_contour_frames_mismatch')
        gate_f0 = np.where(confidence>=.45,raw_f0,0)
        f0 = gate_f0.copy()
        if gentle:
            rms = librosa.feature.rms(y=y16,frame_length=1024,hop_length=320)[0][:total_frames]
            f0, repairs = repair_brief_pitch_gaps(raw_f0,confidence,rms)
            f0 = np.array(f0)
            stage('source-contour-repairs',repairs=repairs)
    else:
        f0, _, _ = librosa.pyin(y16, sr=16000, fmin=90, fmax=750, frame_length=1024, hop_length=320)
        f0 = np.nan_to_num(f0[:total_frames])
        gate_f0 = f0
    units = aligned_units(json.loads((FOLDER/'performance-alignment.json').read_text(encoding='utf8')), total_frames)
    split = next(a for i, (char,a,b) in enumerate(units) if char and ''.join(u[0] or '' for u in units[:i]) == HALF)
    phones_path = UPSTREAM/'soulxsinger/utils/phoneme/phone_set.json'
    inventory = set(json.loads(phones_path.read_text(encoding='utf8')))
    phones = iter(phonemes(TEXT, inventory))
    units = [(next(phones) if char else '<SP>', a, b) for char,a,b in units]
    prompt_meta = prompt_metadata(reference, speech_sha, inventory)
    pt_audio, pt_sr = sf.read(reference, dtype='float32')
    pt16 = librosa.resample(pt_audio, orig_sr=pt_sr, target_sr=16000)
    pt_f0,_,_ = librosa.pyin(pt16, sr=16000, fmin=90, fmax=750, frame_length=1024, hop_length=320)
    prompt_meta['f0'] = ' '.join(map(str, np.nan_to_num(pt_f0[:int(len(pt_audio)/pt_sr*50)])))
    manifest = json.loads((RUNTIME/'score-model-manifest.json').read_text(encoding='utf8'))
    model_path = Path(manifest['path'])/'model.pt'
    revision = subprocess.check_output(['git','-C',str(UPSTREAM),'rev-parse','HEAD'],text=True).strip()
    if revision != manifest['codeRevision']:
        raise ValueError('melody_code_changed')
    with model_path.open('rb') as handle:
        if hashlib.file_digest(handle,'sha256').hexdigest() != manifest['sha256']:
            raise ValueError('melody_model_changed')
    sys.path.insert(0,str(UPSTREAM))
    from omegaconf import OmegaConf
    from soulxsinger.models.soulxsinger import SoulXSinger
    from soulxsinger.utils.data_processor import DataProcessor
    stage('load-direct-melody-model')
    started = time.monotonic()
    model = SoulXSinger(OmegaConf.load(UPSTREAM/'soulxsinger/config/soulxsinger.yaml')).eval()
    checkpoint = torch.load(model_path,map_location='cpu',weights_only=False,mmap=True)
    model.load_state_dict(checkpoint['state_dict'],strict=True)
    del checkpoint
    gc.collect()
    processor = DataProcessor(480,24000,phoneset_path=str(phones_path),device='cpu')
    prompt = processor.process(copy.deepcopy(prompt_meta),str(reference))
    folder = ROOT/'bot-home/media/onebot/music/.diagnostics'
    folder.mkdir(exist_ok=True)
    version = 'v2103' if gentle else ('v2102' if continuous else 'v2101')
    guidance, steps = (1.5,48) if gentle else (3,32)
    f0_method = 'torchcrepe-full-045-short-gaps' if gentle else ('torchcrepe-full-045' if continuous else 'pyin')
    final = folder.parent/f'preview-{version}-wo-kan-guo-direct-melody.wav'
    waves, results = [], []
    for index,(a,b) in enumerate([(0,total_frames)] if continuous else [(0,split),(split,total_frames)],1):
        selected = [(p,max(a,s),min(b,e)) for p,s,e in units if s < b and e > a]
        meta = dict(phoneme=' '.join(p for p,s,e in selected), duration=' '.join(f'{(e-s)/50:.8f}' for p,s,e in selected),
                    note_pitch=' '.join('0' for _ in selected), note_type=' '.join('1' if p=='<SP>' else '2' for p,s,e in selected),
                    f0=' '.join(map(str,f0[a:b])))
        cached = folder/f'{version}-half{index}.wav'
        binding = dict(sourceSha256=source_sha,speechSha256=speech_sha,anchorSha256=anchor_sha,
                       modelSha256=manifest['sha256'],alignmentSha256=hashlib.sha256((FOLDER/'performance-alignment.json').read_bytes()).hexdigest(),start=a,end=b,
                       f0Method=f0_method)
        if gentle:
            binding.update(guidance=guidance,steps=steps,
                contourSha256=hashlib.sha256(f0.astype('<f8').tobytes()).hexdigest())
        cache_record = cached.with_suffix('.cache.json')
        saved = json.loads(cache_record.read_text(encoding='utf8')) if cache_record.exists() else {}
        if cached.exists() and saved.get('binding')==binding and saved.get('waveSha256')==hashlib.sha256(cached.read_bytes()).hexdigest():
            stage('reuse-bound-half',half=index)
            wave,_ = sf.read(cached,dtype='float32')
        else:
            stage('render-direct-melody-half',half=index)
            with torch.inference_mode():
                wave = model.infer(dict(prompt=prompt,target=processor.process(meta)),control='melody',auto_shift=False,
                                   pitch_shift=0,n_steps=steps,cfg=guidance,use_fp16=False).squeeze().numpy()
        expected = (b-a)*480
        if not np.isfinite(wave).all() or abs(len(wave)-expected)>480:
            raise ValueError('direct_melody_output_invalid')
        wave = np.pad(wave[:expected],(0,max(0,expected-len(wave))))
        sf.write(cached,wave,24000,subtype='FLOAT')
        cache_record.write_text(json.dumps(dict(binding=binding,waveSha256=hashlib.sha256(cached.read_bytes()).hexdigest())),encoding='utf8')
        candidate_f0,_,_ = librosa.pyin(librosa.resample(wave,orig_sr=24000,target_sr=16000),sr=16000,
            fmin=90,fmax=750,frame_length=1024,hop_length=320)
        result = pitch_gate(gate_f0[a:b],candidate_f0)
        result['half'] = index
        results.append(result)
        (folder/f'{version}-pitch-gates.json').write_text(json.dumps(results,indent=2),encoding='utf8')
        stage('direct-melody-gate',**result)
        if not result['passed']:
            stage('rejected-before-public-audition',half=index)
            return
        waves.append(wave)
    if reference_profile()[1]!=anchor_sha or spoken_timbre_profile(anchor_sha,anchor)[1]!=speech_sha or hashlib.sha256(source.read_bytes()).hexdigest()!=source_sha:
        raise ValueError('direct_melody_identity_changed')
    wave = np.concatenate(waves)
    wave *= min(.12/max(float(np.sqrt(np.mean(wave**2))),1e-8),.96/max(float(np.max(np.abs(wave))),1e-8))
    sf.write(final,wave,24000)
    report = dict(backend='soulx_direct_f0',gates=results,voiceSha256=anchor_sha,speechTimbreSha256=speech_sha,
        sourceSha256=source_sha,durationSeconds=len(wave)/24000,elapsedSeconds=time.monotonic()-started,
        subjectiveQualityApproved=False,productionReady=False,pitchShift=False,
        continuous=continuous,f0Method=f0_method,guidance=guidance,steps=steps,contourRepairs=repairs)
    final.with_suffix('.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    stage('direct-melody-complete',**report)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--continuous',action='store_true')
    parser.add_argument('--gentle',action='store_true',help='Offline continuous low-guidance audition; never enables QQ singing')
    args=parser.parse_args()
    run(args.continuous,args.gentle)
