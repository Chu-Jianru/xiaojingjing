"""Native text-to-singing with the approved voice reference, entirely on CPU.

Vevo2 generates content/prosody and a neural acoustic waveform; no WORLD pitch
replacement, per-character TTS, forced pitch grid, or appended backing track.
"""
from pathlib import Path
import os,sys,json,hashlib,time,math,ast

ROOT=next(p for p in Path(__file__).resolve().parents if (p/'bot-home').is_dir())
RUNTIME=ROOT/'bot-home/singing-runtime'
UPSTREAM=RUNTIME/'Amphion'
MODEL=RUNTIME/'models/Vevo2'
STYLES={
    'gentle':('breathy.wav','breathy_text'),
    'expressive':('vibrato.wav','vibrato_text'),
}

def style_transcript(variable):
    # Reuse the pinned upstream sample's transcript without executing its demo.
    tree=ast.parse((UPSTREAM/'models/svc/vevo2/infer_vevo2_ar.py').read_text(encoding='utf8'))
    for node in ast.walk(tree):
        if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id==variable for t in node.targets):
            text=ast.literal_eval(node.value)
            if isinstance(text,str) and 0<len(text)<200:return text
    raise ValueError('singing_style_transcript_missing')

def watch_parent(pid):
    """Hard host exits must not leave a model interpreter running on Windows."""
    if os.name!='nt':return
    import ctypes,threading
    from ctypes import wintypes
    api=ctypes.WinDLL('kernel32',use_last_error=True)
    api.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD];api.OpenProcess.restype=wintypes.HANDLE
    api.WaitForSingleObject.argtypes=[wintypes.HANDLE,wintypes.DWORD];api.WaitForSingleObject.restype=wintypes.DWORD
    api.CloseHandle.argtypes=[wintypes.HANDLE]
    handle=api.OpenProcess(0x100000,False,int(pid))
    if not handle:raise RuntimeError('singing_parent_unavailable')
    def wait():
        result=api.WaitForSingleObject(handle,0xffffffff);api.CloseHandle(handle)
        if result==0:os._exit(3)
    threading.Thread(target=wait,name='singing-parent-watch',daemon=True).start()

def progress(stage,**fields):
    print(json.dumps({'event':'singing-stage','stage':stage,**fields}),flush=True)

def reference_profile():
    cfg=json.loads((ROOT/'bot-home/media/onebot/tts-voice.json').read_text(encoding='utf8'))
    if cfg.get('mode')!='reference' or cfg.get('voiceLocked') is not True:raise ValueError('approved_voice_required')
    path=(ROOT/cfg['reference']['path']).resolve(strict=True)
    if not path.is_relative_to(ROOT) or hashlib.sha256(path.read_bytes()).hexdigest()!=cfg['reference']['sha256']:
        raise ValueError('approved_voice_changed')
    return path,cfg['reference']['sha256']

def spoken_timbre_profile(anchor_digest,anchor_path=None):
    folder=(anchor_path if anchor_path is not None else reference_profile()[0]).parent
    approval=json.loads((folder/'approval.json').read_text(encoding='utf8'))
    path=(folder/'approved-audition.wav').resolve(strict=True)
    digest=hashlib.sha256(path.read_bytes()).hexdigest()
    if approval.get('status')!='active' or approval.get('referenceSha256')!=anchor_digest or approval.get('selectedSampleSha256')!=digest:
        raise ValueError('approved_spoken_timbre_changed')
    return path,digest

def singing_style_audio(value):
    if not value:return None
    path=Path(value).resolve(strict=True)
    if not path.is_relative_to((ROOT/'bot-home/media/onebot/music').resolve()) or path.suffix.lower()!='.wav':
        raise ValueError('singing_style_audio_rejected')
    import wave
    with wave.open(str(path)) as audio:
        if audio.getnchannels()!=1 or not 1<=audio.getnframes()/audio.getframerate()<=20:
            raise ValueError('singing_style_audio_invalid')
    return path

def validate_request(args):
    if set(args)-{'lyrics','style','out','seed','voiceSha256','speechTimbreSha256','modelRevision','styleAudio','styleText'}:
        raise ValueError('singing_unknown_or_retired_option')
    lyrics=str(args.get('lyrics','')).strip()
    if not lyrics or len(lyrics)>120 or any(c in lyrics for c in ['\x00','<','>']):raise ValueError('singing_lyrics_invalid')
    style=args.get('style','gentle')
    if style not in STYLES:raise ValueError('singing_style_invalid')
    path=Path(args['out']).resolve()
    if not path.is_relative_to((ROOT/'bot-home/media/onebot/music').resolve()):raise ValueError('singing_output_rejected')
    return lyrics,style,path

def load_pipeline(*,conversion_only=False):
    whisper_file=RUNTIME/'models/whisper/medium.pt'
    os.environ.update(HF_HOME=str(RUNTIME/'hf-cache'),HF_HUB_OFFLINE='1',HF_HUB_DISABLE_XET='1',CUDA_VISIBLE_DEVICES='-1',
        TOKENIZERS_PARALLELISM='false',OMP_NUM_THREADS='2',MKL_NUM_THREADS='2',USE_TF='0',USE_FLAX='0')
    if os.name=='nt':
        import ctypes
        from ctypes import wintypes
        api=ctypes.WinDLL('kernel32',use_last_error=True)
        api.GetCurrentProcess.restype=wintypes.HANDLE
        api.SetPriorityClass.argtypes=[wintypes.HANDLE,wintypes.DWORD];api.SetPriorityClass.restype=wintypes.BOOL
        if not api.SetPriorityClass(api.GetCurrentProcess(),0x4000):raise ctypes.WinError(ctypes.get_last_error())
    sys.path.insert(0,str(UPSTREAM))
    import torch
    torch.set_num_threads(2);torch.set_num_interop_threads(1)
    import whisper
    original_whisper=whisper.load_model
    def local_whisper(name,device=None,**kwargs):
        kwargs['download_root']=str(RUNTIME/'models/whisper')
        encoder=original_whisper(str(whisper_file) if name=='medium' else name,device='cpu',**kwargs)
        # Vevo only calls embed_audio; the transcription decoder is unused.
        del encoder.decoder
        return encoder
    whisper.load_model=local_whisper
    from models.svc.vevo2 import vevo2_utils as vevo
    # Checkpoint directories/configs are official local inference assets.
    # Patch only the local config's relative stats filename in memory.
    original_config=vevo.load_config
    def local_config(path,*args,**kwargs):
        cfg=original_config(path,*args,**kwargs)
        coco=getattr(getattr(cfg,'model',None),'coco',None)
        if coco is not None and hasattr(coco,'whisper_stats_path'):
            coco.whisper_stats_path=str(MODEL/'acoustic_modeling/fm_emilia101k_singnet7k_repa/whisper_stats.pt')
        return cfg
    vevo.load_config=local_config
    def cpu_ar(path,device):
        return vevo.AutoModelForCausalLM.from_pretrained(path,device_map='cpu',
            torch_dtype=torch.float32,trust_remote_code=False,local_files_only=True).eval()
    vevo.build_ar_model=cpu_ar
    # Use official Qwen2 vocab/merges with the Python tokenizer, avoiding fast
    # JSON serialization version coupling. Added singing code IDs are unchanged.
    from transformers import Qwen2Tokenizer
    vevo.AutoTokenizer=Qwen2Tokenizer
    # CPU execution keeps CUDA free
    # for the existing ordinary voice/phone service.
    progress('loading',device='cpu')
    ar=MODEL/'contentstyle_modeling/posttrained';fm=MODEL/'acoustic_modeling/fm_emilia101k_singnet7k_repa'
    pipeline=vevo.Vevo2InferencePipeline(
        prosody_tokenizer_ckpt_path=None if conversion_only else str(MODEL/'tokenizer/prosody_fvq512_6.25hz'),
        content_style_tokenizer_ckpt_path=str(MODEL/'tokenizer/contentstyle_fvq16384_12.5hz'),
        ar_cfg_path=None if conversion_only else str(ar/'amphion_config.json'),
        ar_ckpt_path=None if conversion_only else str(ar),
        fmt_cfg_path=str(fm/'config.json'),fmt_ckpt_path=str(fm),
        vocoder_cfg_path=str(MODEL/'vocoder/config.json'),vocoder_ckpt_path=str(MODEL/'vocoder'),
        device=torch.device('cpu'))
    return pipeline

def generate(args,pipeline=None):
    lyrics,style,out=validate_request(args)
    reference,digest=reference_profile()
    if args.get('voiceSha256') and args['voiceSha256']!=digest:raise ValueError('queued_voice_changed')
    manifest=json.loads((RUNTIME/'model-manifest.json').read_text(encoding='utf8'))
    whisper_file=RUNTIME/'models/whisper/medium.pt'
    if not whisper_file.is_file():raise FileNotFoundError('singing_whisper_weights_missing')
    reference,speech_digest=spoken_timbre_profile(digest,anchor_path=reference)
    if args.get('speechTimbreSha256') and args['speechTimbreSha256']!=speech_digest:raise ValueError('queued_spoken_timbre_changed')
    if args.get('modelRevision') and args['modelRevision']!=manifest['revision']:raise ValueError('queued_model_changed')
    style_audio=singing_style_audio(args.get('styleAudio'))
    if style_audio and (not isinstance(args.get('styleText'),str) or not 1<=len(args['styleText'])<=120):
        raise ValueError('singing_style_text_required')
    started=time.monotonic()
    if pipeline is None:pipeline=load_pipeline()
    import torch
    seed=int(args.get('seed',20261031));torch.manual_seed(seed)
    import numpy as np
    np.random.seed(seed%2**32)
    style_file,transcript_variable=STYLES[style]
    style_text=style_transcript(transcript_variable)
    style_path=UPSTREAM/'models/svc/vevosing/wav'/style_file
    if style_audio:
        style_path=style_audio
        style_text=args['styleText']
    progress('generating',loadSeconds=round(time.monotonic()-started,2))
    # Report stages and lengths only, keeping lyrics out of worker diagnostics.
    original_ar_generate=pipeline.ar_model.generate
    def ar_generate(*args,**kwargs):
        progress('melody')
        tokens=original_ar_generate(*args,**kwargs)
        progress('melody-ready',tokens=int(tokens.shape[-1]-kwargs['input_ids'].shape[-1]))
        return tokens
    pipeline.ar_model.generate=ar_generate
    original_acoustic=pipeline.code2mel
    def acoustic(*args,**kwargs):
        progress('acoustic',contentFrames=int(args[0].shape[-1]))
        return original_acoustic(*args,**kwargs)
    pipeline.code2mel=acoustic
    original_waveform=pipeline.mel2audio
    def waveform(*args,**kwargs):
        progress('waveform')
        return original_waveform(*args,**kwargs)
    pipeline.mel2audio=waveform
    with torch.inference_mode():
        audio=pipeline.inference_ar_and_fm(target_text=lyrics,style_ref_wav_path=str(style_path),
            style_ref_wav_text=style_text,timbre_ref_wav_path=str(reference),
            use_prosody_code=False,use_pitch_shift=False,used_duration_of_timbre_ref_wav_path=9,
            flow_matching_steps=32,top_p=.85,temperature=.9,display_audio=False)
    samples=audio.detach().float().cpu().numpy().reshape(-1)
    if not 24000<=len(samples)<=24000*45 or not np.isfinite(samples).all():raise ValueError('singing_audio_invalid')
    rms=float(np.sqrt(np.mean(samples**2)));peak=float(np.max(np.abs(samples)))
    if not math.isfinite(rms) or rms<1e-5:raise ValueError('singing_audio_silent')
    # Only uniform gain/peak protection: no pitch correction or timing warp.
    gain=min(.9/max(peak,1e-8),.12/rms)
    samples=(samples*gain).astype('float32')
    out.parent.mkdir(parents=True,exist_ok=True)
    import soundfile as sf
    sf.write(out,samples,24000,subtype='PCM_16')
    return {'event':'singing-result','path':str(out),'backend':'vevo2_native','voiceSha256':digest,
        'speechTimbreSha256':speech_digest,'styleSource':'candidate_self_singing' if style_audio else style,
        'styleAudioSha256':hashlib.sha256(style_audio.read_bytes()).hexdigest() if style_audio else None,
        'modelRevision':manifest['revision'],'durationSeconds':round(len(samples)/24000,3),
        'elapsedSeconds':round(time.monotonic()-started,2),'seed':seed,'acappella':True}

if __name__=='__main__':
    watch_parent(int(os.environ.get('WHALE_SINGING_PARENT_PID',os.getppid())))
    request=json.load(sys.stdin)
    result=generate(request)
    print(json.dumps(result),flush=True)
