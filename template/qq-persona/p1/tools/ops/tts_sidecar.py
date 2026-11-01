"""Local Qwen3-TTS service. Loopback only; no text/history sent to a cloud API."""
from __future__ import annotations

import argparse
from collections import OrderedDict
import hashlib
import json
import math
import queue
import os
from pathlib import Path
import subprocess
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = next(p for p in Path(__file__).resolve().parents if (p / 'bot-home').is_dir() and (p / 'qq-persona').is_dir())
RUNTIME = REPO / 'bot-home' / 'tts-runtime'
MODEL = RUNTIME / 'models' / 'Qwen3-TTS-12Hz-1.7B-CustomVoice'
CONFIG = REPO / 'bot-home' / 'media' / 'onebot' / 'tts-voice.json'
STYLES = {
    'cute-slow': '保留温柔轻软的底色，用软糯甜美、略带稚气的少女声说话，声音轻盈细腻，音高自然略高一点。语速比平常稍慢，咬字清晰放松，短句之间自然停半拍，不要把单个字拖长。语气亲昵，带一点好奇和轻轻的笑意，像在熟人身边慢慢聊天。不要尖嗓，不要播音腔，不要夸张卖萌。',
    'cute': '用软糯甜美、轻盈细腻的少女女声，音高自然偏高一点，带轻轻的笑意和一点点撒娇，像在和很熟悉的人贴近聊天。咬字放松清楚，节奏轻快但不急，句尾柔柔收住，有自然换气和小停顿。不要播音腔，不要尖嗓，不要夸张拉长尾音。',
    'soft': '用年轻、甜美、柔软而自然的女声说话，像熟悉的人面对面轻声聊天。语气亲近，带一点笑意，语速自然偏舒缓，停顿随语义，不要播音腔，不要夸张撒娇。',
    'lively': '用年轻甜美的女声自然地说话，语气明亮、开心、俏皮可爱，像和熟人聊天。有自然的轻重和停顿，不要尖叫，不要夸张卖萌，不要播音腔。',
    'quiet': '用年轻温柔的女声轻轻地说话，声音柔软甜美，亲近、放松，语速稍慢，停顿自然。不要气声过重，不要拖长尾音，不要播音腔。',
}

class PCMCache:
    """Completed fixed-profile speech only. RAM bounded; no history/audio files."""
    def __init__(self, max_bytes=8*1024*1024, ttl=1800, clock=time.monotonic):
        self.max_bytes, self.ttl, self.clock = max_bytes, ttl, clock
        self.rows = OrderedDict(); self.bytes = 0; self.lock = threading.Lock()

    def get(self, key):
        with self.lock:
            row = self.rows.get(key)
            if row is None: return None
            stamp, rate, chunks, size = row
            if self.clock()-stamp >= self.ttl:
                self.rows.pop(key); self.bytes -= size; return None
            self.rows.move_to_end(key)
            return rate, chunks

    def put(self, key, rate, chunks):
        size = sum(map(len, chunks))
        if not size or size > self.max_bytes: return
        with self.lock:
            old = self.rows.pop(key, None)
            if old: self.bytes -= old[3]
            self.rows[key] = (self.clock(), rate, tuple(chunks), size); self.bytes += size
            while self.bytes > self.max_bytes or len(self.rows) > 32:
                _, row = self.rows.popitem(last=False); self.bytes -= row[3]


def load_profile(config_path=CONFIG):
    raw = json.loads(Path(config_path).read_text(encoding='utf-8-sig'))
    if not isinstance(raw, dict):
        raise ValueError('invalid voice configuration')
    profile = {'locked': raw.get('voiceLocked') is True, 'mode': raw.get('mode', 'builtin'),
               'speaker': raw.get('speaker', 'Serena'), 'style': raw.get('style', 'soft'),
               'seed': raw.get('seed', 20261026)}
    if profile['mode'] not in ('builtin', 'reference') or type(profile['seed']) is not int:
        raise ValueError('invalid voice mode/seed')
    if profile['speaker'] not in ('Serena', 'Vivian') or profile['style'] not in STYLES:
        raise ValueError('invalid configured voice')
    if profile['mode'] == 'reference':
        ref = raw.get('reference', {})
        if not isinstance(ref, dict):
            raise ValueError('invalid reference configuration')
        profile['locked'] = True
        path = (REPO / str(ref.get('path', ''))).resolve()
        if not path.is_relative_to(REPO.resolve()) or path.suffix.lower() not in ('.wav', '.mp3', '.flac'):
            raise ValueError('reference must be an audio file inside the project')
        text = str(ref.get('text', '')).strip()
        digest = str(ref.get('sha256', '')).lower()
        if not 0 < len(text) <= 400 or not path.is_file() or path.stat().st_size > 10 * 1024**2:
            raise ValueError('invalid reference audio/transcript')
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError('reference checksum mismatch; refusing to change voice')
        profile.update(reference_path=path, reference_text=text, reference_sha256=digest)
        identity = ['reference-v1', digest, text, str(profile['seed'])]
    else:
        identity = ['builtin-v1', profile['speaker'], profile['style'], str(profile['seed'])]
    # Keep the approved synthesis seed separate from delivery/cache identity.
    profile['conditioning_key'] = hashlib.sha256(json.dumps(identity, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    delivery = raw.get('delivery', {})
    if not isinstance(delivery, dict): raise ValueError('invalid voice delivery')
    instruct, tempo, gain = delivery.get('instruct', ''), delivery.get('tempo', 1.0), delivery.get('gainDb', 0)
    if (not isinstance(instruct, str) or len(instruct) > 800
            or type(tempo) not in (int, float) or not math.isfinite(tempo) or not .6 <= tempo <= 1.2
            or type(gain) not in (int, float) or not math.isfinite(gain) or not -6 <= gain <= 9):
        raise ValueError('invalid voice delivery')
    if delivery and profile['mode'] != 'reference': raise ValueError('delivery requires reference voice')
    profile.update(instruct=instruct, tempo=float(tempo), gain_db=float(gain))
    if instruct or tempo != 1:
        identity = ['reference-delivery-v1', profile['conditioning_key'], instruct, int(tempo) if tempo == int(tempo) else float(tempo)]
    if gain != 0:
        identity = ['reference-delivery-v2', profile['conditioning_key'], instruct, int(tempo) if tempo == int(tempo) else float(tempo), int(gain) if gain == int(gain) else float(gain)]
    profile['key'] = hashlib.sha256(json.dumps(identity, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    return profile


class Synthesizer:
    def __init__(self, model_path: Path, profile=None):
        self.model_path = model_path
        self.profile = profile or {'mode': 'builtin', 'locked': False, 'speaker': 'Serena', 'style': 'soft'}
        self.model = None
        self.error = ''
        self.lock = threading.Lock()
        self.ready = threading.Event()

    def load(self):
        try:
            os.environ['USE_TF'] = '0'
            os.environ['USE_FLAX'] = '0'
            os.environ.setdefault('HF_HOME', str(RUNTIME / 'hf-cache'))
            os.environ.setdefault('HF_HUB_OFFLINE', '1')
            os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')
            import torch
            from faster_qwen3_tts import FasterQwen3TTS
            if not torch.cuda.is_available():
                raise RuntimeError('CUDA is unavailable; refusing slow CPU inference')
            torch.set_num_threads(4)
            torch.backends.cuda.matmul.allow_tf32 = True
            started = time.perf_counter()
            self.model = FasterQwen3TTS.from_pretrained(
                str(self.model_path), device='cuda:0', dtype=torch.bfloat16,
                attn_implementation='sdpa', max_seq_len=1024,
            )
            self.generate('嗯，我在呢。', self.profile['speaker'], self.profile['style'])
            if self.profile['mode'] == 'reference':
                for _pcm, _rate in self.stream('嗯，我在呢。'): pass
            self.ready.set()
            print(json.dumps({'event': 'tts-ready', 'backend': 'cuda-graphs', 'load_ms': round((time.perf_counter() - started) * 1000),
                              'gpu_mb': round(torch.cuda.max_memory_allocated() / 1024**2)}), flush=True)
        except Exception as error:
            self.error = type(error).__name__ + ': ' + str(error)
            self.model = None
            import gc
            gc.collect()
            try:
                import torch
                torch.cuda.empty_cache()
            except Exception:
                pass
            print(json.dumps({'event': 'tts-load-error', 'error': self.error}), flush=True)

    def generate(self, text: str, speaker: str, style: str):
        import torch
        import numpy as np
        started = time.perf_counter()
        if self.profile.get('locked'):
            speaker, style = self.profile['speaker'], self.profile['style']
            seed = int.from_bytes(hashlib.sha256((self.profile.get('conditioning_key', self.profile['key']) + text).encode()).digest()[:4], 'big')
            torch.manual_seed(seed)
        with torch.inference_mode():
            limits = dict(text=text, language='Chinese', max_new_tokens=min(768, max(160, len(text) * 14)))
            if self.profile['mode'] == 'reference':
                # FasterQwen caches the reference features and transcript once;
                # each line uses the same approved speaker conditioning.
                waves, sample_rate = self.model.generate_voice_clone(
                    **limits, ref_audio=str(self.profile['reference_path']),
                    ref_text=self.profile['reference_text'], non_streaming_mode=True,
                    **({'instruct': self.profile['instruct']} if self.profile.get('instruct') else {}))
            else:
                waves, sample_rate = self.model.generate_custom_voice(
                    **limits, speaker=speaker, instruct=STYLES[style])
        wave = np.asarray(waves[0], dtype=np.float32)
        if wave.size == 0 or not np.isfinite(wave).all():
            raise RuntimeError('invalid audio samples')
        peak = float(np.max(np.abs(wave)))
        if peak > 0.98:
            wave *= 0.98 / peak
        # A gentle, pitch-preserving slowdown makes the requested pace
        # reliable; natural-language speed instructions alone vary by take.
        tempo = self.profile.get('tempo', 1.0) if self.profile['mode'] == 'reference' else (0.90 if style == 'cute-slow' else 1.0)
        audio_filter = delivery_filter(tempo, self.profile.get('gain_db', 0))
        filters = ['-af', audio_filter] if audio_filter else []
        completed = subprocess.run([
            'ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', str(sample_rate),
            '-ac', '1', '-i', 'pipe:0', *filters, '-codec:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', 'pipe:1',
        ], input=wave.tobytes(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=10, check=True, creationflags=0x08000000 if os.name == 'nt' else 0)
        return completed.stdout, round((time.perf_counter() - started) * 1000), wave.size / sample_rate / tempo

    def stream(self, text):
        yield from tempo_stream(self.raw_stream(text), self.profile.get('tempo', 1.0), self.profile.get('gain_db', 0))

    def raw_stream(self, text):
        import torch
        import numpy as np
        if self.profile['mode'] != 'reference' or not self.profile.get('locked'):
            raise RuntimeError('Streaming requires the locked reference profile')
        seed = int.from_bytes(hashlib.sha256((self.profile.get('conditioning_key', self.profile['key']) + text).encode()).digest()[:4], 'big')
        torch.manual_seed(seed)
        with torch.inference_mode():
            chunks = self.model.generate_voice_clone_streaming(text=text, language='Chinese',
                max_new_tokens=min(768, max(160, len(text)*14)),
                ref_audio=str(self.profile['reference_path']), ref_text=self.profile['reference_text'],
                non_streaming_mode=True, chunk_size=6,
                **({'instruct': self.profile['instruct']} if self.profile.get('instruct') else {}))
            try:
                for wave, rate, _timing in chunks:
                    pcm = np.asarray(wave, dtype='<f4').reshape(-1)
                    if not len(pcm): continue
                    if not np.isfinite(pcm).all(): raise RuntimeError('Invalid streaming audio')
                    yield np.clip(pcm, -.98, .98).astype('<f4').tobytes(), int(rate)
            finally:
                chunks.close()



def delivery_filter(tempo, gain_db=0):
    filters = [f'atempo={tempo}'] if tempo != 1 else []
    if gain_db != 0:
        filters.extend([f'volume={gain_db}dB', 'alimiter=limit=0.97:level=false:attack=5:release=50'])
    return ','.join(filters)


def tempo_stream(chunks, tempo, gain_db=0):
    """One continuous atempo filter; bounded pipes, same rate, close before unlock.

    GPU iteration stays on one feeder thread (including inference-mode context).
    No chunk-by-chunk filter reset or full-utterance buffering.
    """
    audio_filter = delivery_filter(tempo, gain_db)
    if not audio_filter:
        yield from chunks
        return
    ready = queue.Queue(maxsize=1)
    stopped = threading.Event()
    state = {}; errors = []

    def feed():
        announced = False
        try:
            for pcm, rate in chunks:
                if stopped.is_set(): break
                if rate not in (16000, 24000, 48000) or not pcm or len(pcm) % 4:
                    raise RuntimeError('Invalid tempo input')
                if 'process' not in state:
                    process = subprocess.Popen([
                        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
                        '-f', 'f32le', '-ar', str(rate), '-ac', '1', '-probesize', '32', '-analyzeduration', '0',
                        '-i', 'pipe:0', '-af', audio_filter, '-f', 'f32le',
                        '-flush_packets', '1', '-blocksize', '4096', 'pipe:1'],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        creationflags=0x08000000 if os.name == 'nt' else 0)
                    state.update(process=process, rate=rate)
                    ready.put((process, rate)); announced = True
                if rate != state['rate']: raise RuntimeError('Tempo input rate changed')
                state['process'].stdin.write(pcm)
                state['process'].stdin.flush()
        except Exception as error:
            if not stopped.is_set(): errors.append(error)
        finally:
            try:
                chunks.close()
            except Exception as error:
                if not stopped.is_set(): errors.append(error)
            process = state.get('process')
            if process is not None:
                try: process.stdin.close()
                except (OSError, ValueError): pass
            if not announced: ready.put(None)

    worker = threading.Thread(target=feed, name='tts-tempo-feed', daemon=True)
    worker.start()
    try:
        opened = ready.get(timeout=30)
        if opened is None:
            worker.join()
            if errors: raise RuntimeError('Tempo source failed') from errors[0]
            raise RuntimeError('Empty tempo source')
        process, rate = opened
        while True:
            pcm = process.stdout.read(4096)
            if not pcm: break
            if len(pcm) % 4: raise RuntimeError('Truncated tempo PCM')
            yield pcm, rate
        worker.join()
        if errors: raise RuntimeError('Tempo source failed') from errors[0]
        if process.wait(timeout=5) != 0: raise RuntimeError('Tempo filter failed')
    finally:
        stopped.set()
        process = state.get('process')
        if process is not None and process.poll() is None:
            process.terminate()
        # Also handle cancellation racing with process creation on the feeder.
        # Do not release the synthesis lock while its feeder can still infer.
        while worker.is_alive():
            process = state.get('process')
            if process is not None and process.poll() is None: process.terminate()
            worker.join(timeout=.1)
        process = state.get('process')
        if process is not None:
            try: process.wait(timeout=3)
            except subprocess.TimeoutExpired: process.kill(); process.wait()
            for pipe in (process.stdin, process.stdout, process.stderr):
                try: pipe.close()
                except (OSError, ValueError): pass


def handler_for(synth: Synthesizer, port: int):
    cache = PCMCache()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # No user text or request body in logs.

        def respond_json(self, status, value):
            body = json.dumps(value).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def valid_host(self):
            return self.headers.get('Host') == f'127.0.0.1:{port}'

        def do_GET(self):
            if not self.valid_host() or self.path != '/health':
                return self.respond_json(404, {'error': 'not found'})
            return self.respond_json(200, {'service': 'dsh-qwen-tts', 'voiceProfileKey': getattr(synth, 'profile', {}).get('key'), 'ready': synth.ready.is_set(),
                                       'busy': synth.lock.locked(), 'failed': bool(synth.error)})

        def do_POST(self):
            if not self.valid_host() or self.path not in ('/speech', '/speech-stream'):
                return self.respond_json(404, {'error': 'not found'})
            if not self.headers.get('Content-Type', '').startswith('application/json'):
                return self.respond_json(415, {'error': 'JSON required'})
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 8192:
                    raise ValueError('invalid request size')
                request = json.loads(self.rfile.read(size))
                text = request.get('text', '').strip()
                speaker = request.get('speaker', 'Serena')
                style = request.get('style', 'soft')
                profile = getattr(synth, 'profile', {})
                if profile.get('locked'):
                    speaker, style = profile['speaker'], profile['style']
                if not 0 < len(text) <= 120 or speaker not in ('Serena', 'Vivian') or style not in STYLES:
                    raise ValueError('invalid speech request')
            except (ValueError, TypeError, AttributeError):
                return self.respond_json(400, {'error': 'invalid speech request'})
            if self.path == '/speech-stream' and (not profile.get('locked') or profile.get('mode') != 'reference'
                    or request.get('voiceProfileKey') != profile.get('key')):
                return self.respond_json(409, {'error': 'locked reference profile mismatch'})
            if self.path == '/speech-stream':
                if profile.get('mode') != 'reference' or not profile.get('locked') or request.get('voiceProfileKey') != profile.get('key'):
                    return self.respond_json(409, {'error': 'voice profile mismatch'})
                cached = cache.get((profile['key'], text))
                if cached is not None:
                    return self.cached_response(text, profile, cached)
            if not synth.ready.is_set() or not synth.lock.acquire(blocking=False):
                return self.respond_json(503, {'error': 'warming up or busy'})
            if self.path == '/speech-stream':
                return self.stream_response(text, profile)
            try:
                try:
                    audio, elapsed_ms, duration = synth.generate(text, speaker, style)
                finally:
                    # Only inference owns the lock; a completed response still
                    # being written must not reject the next voice request.
                    synth.lock.release()
                self.send_response(200)
                self.send_header('Content-Type', 'audio/mpeg')
                self.send_header('Content-Length', str(len(audio)))
                self.send_header('X-TTS-Synthesis-Ms', str(elapsed_ms))
                self.send_header('X-TTS-Audio-Seconds', f'{duration:.3f}')
                self.end_headers()
                self.wfile.write(audio)
                print(json.dumps({'event': 'tts-generated', 'chars': len(text), 'mode': getattr(synth, 'profile', {}).get('mode', 'builtin'), 'speaker': speaker,
                                  'style': style, 'synthesis_ms': elapsed_ms, 'audio_seconds': round(duration, 3)}), flush=True)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            except Exception as error:
                print(json.dumps({'event': 'tts-generation-error', 'error_type': type(error).__name__}), flush=True)
                self.respond_json(500, {'error': 'speech generation failed'})

        def cached_response(self, text, profile, cached):
            rate, frames = cached
            try:
                self.send_response(200)
                self.send_header('Content-Type', 'application/x-dsh-pcm-stream')
                self.send_header('X-Audio-Sample-Rate', str(rate))
                self.send_header('X-Voice-Profile-Key', profile['key'])
                self.send_header('Cache-Control', 'no-store'); self.end_headers()
                for pcm in frames:
                    self.wfile.write(struct.pack('<I', len(pcm)) + pcm); self.wfile.flush()
                self.wfile.write(struct.pack('<I', 0)); self.wfile.flush()
                print(json.dumps({'event':'tts-stream-cache-hit','chars':len(text)}), flush=True)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError): pass
            finally: self.close_connection = True

        def stream_response(self, text, profile):
            started = time.perf_counter(); first = True; rate = None; samples = 0
            chunks = None; retained = []; retained_bytes = 0
            try:
                chunks = synth.stream(text)
                for pcm, sample_rate in chunks:
                    if sample_rate not in (16000, 24000, 48000) or len(pcm) % 4:
                        raise RuntimeError('Invalid PCM stream')
                    if first:
                        rate = sample_rate
                        self.send_response(200)
                        self.send_header('Content-Type', 'application/x-dsh-pcm-stream')
                        self.send_header('X-Audio-Sample-Rate', str(rate))
                        self.send_header('X-Voice-Profile-Key', profile['key'])
                        self.send_header('Cache-Control', 'no-store')
                        self.end_headers()
                        first = False
                        print(json.dumps({'event':'tts-stream-first', 'first_ms':round((time.perf_counter()-started)*1000), 'chars':len(text)}), flush=True)
                    if rate != sample_rate: raise RuntimeError('PCM rate changed')
                    self.wfile.write(struct.pack('<I',len(pcm)) + pcm); self.wfile.flush(); samples += len(pcm)//4
                    retained_bytes += len(pcm)
                    if retained_bytes <= cache.max_bytes: retained.append(bytes(pcm))
                    else: retained.clear()
                if first: raise RuntimeError('Empty PCM stream')
                self.wfile.write(struct.pack('<I',0)); self.wfile.flush()
                if retained_bytes <= cache.max_bytes: cache.put((profile['key'], text), rate, retained)
                print(json.dumps({'event':'tts-stream-done', 'elapsed_ms':round((time.perf_counter()-started)*1000), 'audio_seconds':round(samples/rate,3)}), flush=True)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                print(json.dumps({'event':'tts-stream-cancelled'}), flush=True)
            except Exception as error:
                print(json.dumps({'event':'tts-stream-error','error_type':type(error).__name__}), flush=True)
                if first: self.respond_json(500, {'error':'stream generation failed'})
            finally:
                try:
                    if chunks is not None: chunks.close()
                finally: synth.lock.release()
                self.close_connection = True
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8398)
    parser.add_argument('--model', type=Path)
    parser.add_argument('--config', type=Path, default=CONFIG)
    args = parser.parse_args()
    profile = load_profile(args.config)
    model = args.model or (RUNTIME / 'models' / 'Qwen3-TTS-12Hz-1.7B-Base' if profile['mode'] == 'reference' else MODEL)
    if not (model / 'model.safetensors').is_file():
        raise SystemExit('TTS model not installed: ' + str(model))
    synth = Synthesizer(model, profile)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), handler_for(synth, args.port))
    server.daemon_threads = True
    threading.Thread(target=synth.load, daemon=True).start()
    print(json.dumps({'event': 'tts-listening', 'port': args.port}), flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
