"""Offline identity diagnostic using the existing Qwen speaker encoder only.

Cosine similarity is a diagnostic, never an approval of singing naturalness,
perceived age, musical expression, or voice identity by the user.
"""
from pathlib import Path
import os,json,argparse
ROOT=next(p for p in Path(__file__).resolve().parents if (p/'bot-home').is_dir())

def compare(reference,candidates):
    os.environ.update(CUDA_VISIBLE_DEVICES='-1',HF_HUB_OFFLINE='1',USE_TF='0',USE_FLAX='0',
        HF_HOME=str(ROOT/'bot-home/tts-runtime/hf-cache'),OMP_NUM_THREADS='2',MKL_NUM_THREADS='2')
    import torch,torchaudio,soundfile as sf
    from safetensors import safe_open
    from qwen_tts.core.models.configuration_qwen3_tts import Qwen3TTSSpeakerEncoderConfig
    from qwen_tts.core.models.modeling_qwen3_tts import Qwen3TTSSpeakerEncoder,mel_spectrogram
    torch.set_num_threads(2)
    model_dir=ROOT/'bot-home/tts-runtime/models/Qwen3-TTS-12Hz-1.7B-Base'
    config=json.loads((model_dir/'config.json').read_text(encoding='utf8'))
    encoder=Qwen3TTSSpeakerEncoder(Qwen3TTSSpeakerEncoderConfig(**config['speaker_encoder_config'])).eval()
    state={}
    for path in model_dir.glob('*.safetensors'):
        with safe_open(path,framework='pt',device='cpu') as tensors:
            for key in tensors.keys():
                if key.startswith('speaker_encoder.'):
                    state[key.removeprefix('speaker_encoder.')]=tensors.get_tensor(key)
    encoder.load_state_dict(state,strict=True)
    def embedding(value):
        path=Path(value).resolve(strict=True)
        if not path.is_relative_to(ROOT) or path.stat().st_size>100*1024**2:raise ValueError('speaker_audio_rejected')
        audio,sr=sf.read(path,dtype='float32')
        if audio.ndim==2:audio=audio.mean(axis=1)
        samples=torch.from_numpy(audio[:int(sr*30)])
        if sr!=24000:samples=torchaudio.functional.resample(samples,sr,24000)
        with torch.inference_mode():
            mels=mel_spectrogram(samples.unsqueeze(0),n_fft=1024,num_mels=128,sampling_rate=24000,
                hop_size=256,win_size=1024,fmin=0,fmax=12000).transpose(1,2)
            return torch.nn.functional.normalize(encoder(mels)[0].float(),dim=0)
    anchor=embedding(reference)
    return {str(Path(path).name):round(float(torch.dot(anchor,embedding(path))),6) for path in candidates}

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--reference',required=True);parser.add_argument('audio',nargs='+')
    args=parser.parse_args();print(json.dumps(compare(args.reference,args.audio),indent=2),flush=True)
