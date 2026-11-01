"""Native QQ call audio worker: CPU ASR -> existing private chat -> locked TTS.

No microphone/system-wide capture, cloud ASR, extra chat model or audio archive.
Only an authenticated, resolved owner call can start the process-loopback tap.
"""
from __future__ import annotations
import json
import logging
from pathlib import Path
import queue
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError
sys.path.insert(0, str(Path(__file__).parent / 'native'))
from windows_audio import cable_render_device, native_device_inventory

ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'bot-home').is_dir() and (p / 'qq-persona').is_dir())
PRIVATE = ROOT / 'bot-home/media/onebot/calls'
MODEL = ROOT / 'bot-home/call-runtime/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
LOG = logging.getLogger('dsh-call')
VAD_MODEL = MODEL.parent / 'silero-vad-v5.onnx'

def vad_config():
    import sherpa_onnx
    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = str(VAD_MODEL)
    config.silero_vad.threshold = .6
    config.silero_vad.min_speech_duration = .16
    config.silero_vad.min_silence_duration = .55
    config.silero_vad.max_speech_duration = 20
    config.sample_rate = 16000; config.num_threads = 1; config.provider = 'cpu'
    return config

def meaningful_speech(text):
    return any(character.isalnum() for character in text)

def prepare_capture(pid, factory=None):
    if factory is None:
        from proctap import ProcessAudioCapture
        factory = ProcessAudioCapture
    started = time.monotonic()
    tap = factory(pid, resample_quality='fast')
    try:
        native = tap._backend._native
        if native.is_process_specific() is not True:
            raise RuntimeError('Process-only capture unavailable; desktop fallback refused')
    except BaseException:
        tap.close(); raise
    LOG.info('call_capture_prepared elapsed_ms=%d process_only=true', (time.monotonic()-started)*1000)
    return tap  # Initialized but NOT started; no PCM is collected while idle.

def warm_recognizer(recognizer):
    import numpy as np
    started = time.monotonic()
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, np.zeros(16000, dtype='float32'))
    recognizer.decode_stream(stream)
    LOG.info('call_asr_warmed elapsed_ms=%d', (time.monotonic()-started)*1000)

def pcm_chunks(response):
    pending = bytearray(); size = None
    while True:
        data = response.read1(8192)
        if not data: raise RuntimeError('PCM stream ended without completion marker')
        pending.extend(data)
        while True:
            if size is None:
                if len(pending) < 4: break
                size = struct.unpack('<I',pending[:4])[0]; del pending[:4]
                if size == 0: return
                if size > 4*1024*1024 or size % 4: raise RuntimeError('Invalid PCM frame size')
            if len(pending) < size: break
            yield bytes(pending[:size]); del pending[:size]; size = None

class API:
    def __init__(self, token): self.token = token
    def request(self, port, path, data=None, timeout=3):
        request = Request(f'http://127.0.0.1:{port}{path}',
            data=json.dumps(data).encode() if data is not None else None,
            headers={'Content-Type': 'application/json',
                **({'Authorization': 'Bearer ' + self.token} if port in (6110, 6111, 8400) else {})})
        with urlopen(request, timeout=timeout) as response:
            return json.load(response)

    def speech_stream(self, item, cancelled=lambda: False):
        port = item.get('port')
        if type(port) is not int or not 1024 <= port <= 65535: raise RuntimeError('Invalid TTS port')
        if item.get('preparation'):
            prepared = Request('http://127.0.0.1:8400/prepared',
                data=json.dumps({'id':item['callId'], 'preparation':item['preparation'],
                                 'voiceProfileKey':item['voiceProfileKey']}).encode(),
                headers={'Content-Type':'application/json', 'Authorization':'Bearer '+self.token})
            if cancelled(): raise RuntimeError('Speech playback cancelled')
            try: return urlopen(prepared, timeout=10)
            except HTTPError as error:
                if error.code not in (409,503): raise
                # Unclaimed/expired speculation emitted no PCM. Synthesize the
                # exact same committed words normally, never replay partial audio.
        request = Request(f'http://127.0.0.1:{port}/speech-stream',
            data=json.dumps({'text':item['text'], 'voiceProfileKey':item['voiceProfileKey']}).encode(),
            headers={'Content-Type':'application/json'})
        deadline = time.monotonic()+2.5
        while True:
            if cancelled(): raise RuntimeError('Speech playback cancelled')
            try: return urlopen(request, timeout=10)
            except HTTPError as error:
                if error.code != 503 or time.monotonic() >= deadline: raise
                time.sleep(.15)

class CallAudio:
    def __init__(self, api, recognizer, call_id, caller, host_pid, prepared_tap=None):
        self.api, self.recognizer, self.id = api, recognizer, call_id
        self.caller, self.pid = caller, host_pid
        self.stop = threading.Event(); self.audio = queue.Queue(maxsize=200)
        self.utterances = queue.Queue(maxsize=4); self.speaking = False
        self.generation = 0; self.sequence = 0; self.tap = prepared_tap; self.threads = []
        self.revision = 0
        self.fault = False
        self.play_response = None
        self.output_hold = threading.Event()
        self.speech_lock = threading.Lock()
        self.speech_epoch = 0; self.interrupted_epoch = -1

    def control(self, path, **data):
        return self.api.request(8400, path, {'id': self.id, **data})

    def start(self):
        started = time.monotonic()
        self.control('/begin', caller=self.caller)
        def receive(data, _frames):
            if self.stop.is_set(): return
            try: self.audio.put_nowait(data)
            except queue.Full:
                # An overloaded capture must be surfaced, not silently lose a
                # user's words and continue pretending the call is healthy.
                self.fault = True; self.stop.set()
        if self.tap is None: self.tap = prepare_capture(self.pid)
        self.tap.set_callback(receive)
        try:
            self.tap.start()
            for target in [self.listen, self.recognize, self.play]:
                worker = threading.Thread(target=self.guard, args=(target,), daemon=True)
                worker.start(); self.threads.append(worker)
            LOG.info('call_audio_started elapsed_ms=%d', (time.monotonic()-started)*1000)
        except BaseException:
            self.close(); raise

    def guard(self, operation):
        try: operation()
        except Exception as error:
            LOG.warning('call_audio_failed operation=%s error=%s', operation.__name__, type(error).__name__)
            self.fault = True; self.stop.set()

    def interrupt(self):
        self.generation += 1
        self.cancel_stream()
        self.revision = self.control('/interrupt')['revision']

    def cancel_stream(self):
        # Interrupt a blocking PCM read without waiting for the next model
        # chunk; closing a buffered reader from this thread can block instead.
        response = self.play_response
        if response is not None:
            try: response.fp.raw._sock.shutdown(socket.SHUT_RDWR)
            except (AttributeError, OSError): pass

    def transcribe(self, blocks):
        import numpy as np
        if self.stop.is_set(): return ''
        pcm = np.concatenate(blocks)
        stream = self.recognizer.create_stream()
        stream.accept_waveform(16000, pcm.astype('float32') / 32768)
        started = time.monotonic(); self.recognizer.decode_stream(stream)
        text = stream.result.text.strip()
        LOG.info('asr_ready elapsed_ms=%d chars=%d', (time.monotonic()-started)*1000, len(text))
        return text if not self.stop.is_set() and meaningful_speech(text) else ''

    def input(self, text):
        generation = self.generation
        if self.speaking: return False
        self.sequence += 1
        revision = self.revision
        # A retry keeps the same id, so ambiguous HTTP completion cannot create
        # a second model turn. No recognized text is printed in service logs.
        for attempt in range(2):
            try:
                if self.speaking or generation != self.generation: return False
                self.control('/input', sequence=self.sequence, text=text, revision=revision)
                return True
            except HTTPError as error:
                if error.code == 409: return False
                if attempt: raise
                if self.stop.wait(.15): return False
            except Exception:
                if attempt: raise
                if self.stop.wait(.15): return

    def begin_speech(self):
        with self.speech_lock:
            self.speech_epoch += 1
            self.speaking = True
            self.output_hold.set()
        # Pause first. Noise must not cancel a sentence or create a model turn.

    def release_output(self):
        with self.speech_lock:
            if not self.speaking and self.utterances.empty(): self.output_hold.clear()

    def recognize(self):
        pending = []
        while not self.stop.is_set():
            try: utterance = self.utterances.get(timeout=.1)
            except queue.Empty: utterance = None
            if utterance:
                epoch, blocks = utterance
                text = self.transcribe(blocks)
                if text:
                    if epoch != self.interrupted_epoch:
                        self.interrupt(); self.interrupted_epoch = epoch
                    pending.append(text)
            if not self.speaking and self.utterances.empty():
                if pending:
                    if self.input('\n'.join(pending)): pending.clear()
                if not pending: self.release_output()

    def finish_utterance(self, blocks, voiced, final=True):
        if voiced >= 4: self.utterances.put_nowait((self.speech_epoch, blocks))
        if final:
            with self.speech_lock: self.speaking = False

    def listen(self):
        import numpy as np
        import sherpa_onnx
        config = vad_config()
        vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=35)
        window = config.silero_vad.window_size
        pending = np.empty(0, dtype='float32'); source = pending
        last = time.monotonic(); quiet = 0
        def drain(force_final=False):
            while not vad.empty():
                segment = np.asarray(vad.front.samples, dtype='float32').copy()
                vad.pop()
                # A max-duration ASR chunk does not end a continuing utterance.
                continued = len(segment) >= 19 * 16000 and not force_final
                blocks = [(np.clip(segment, -1, 1) * 32767).astype('int16')]
                self.finish_utterance(blocks, 4, final=force_final or not (vad.is_speech_detected() or continued))
        while not self.stop.is_set():
            try: raw = self.audio.get(timeout=.1)
            except queue.Empty:
                if self.speaking and time.monotonic()-last > .65:
                    vad.flush(); drain(force_final=True); vad.reset()
                    with self.speech_lock: self.speaking = False
                continue
            last = time.monotonic()
            samples = np.frombuffer(raw, dtype='<f4').reshape(-1, 2).mean(axis=1)
            if not np.isfinite(samples).all(): raise RuntimeError('Invalid capture samples')
            source = np.concatenate((source, samples))
            end = len(source)//3*3
            pending = np.concatenate((pending, source[:end].reshape(-1, 3).mean(axis=1)))
            source = source[end:]
            while len(pending) >= window and not self.stop.is_set():
                vad.accept_waveform(pending[:window]); pending = pending[window:]
                detected = vad.is_speech_detected()
                if detected:
                    quiet = 0
                    if not self.speaking: self.begin_speech()
                else: quiet += 1
                drain()
                if self.speaking and not detected and quiet * window >= .6 * 16000:
                    with self.speech_lock: self.speaking = False

    def wait_output(self, item, generation):
        while self.output_hold.is_set() and self.current_audio(item, generation):
            self.stop.wait(.02)
        return self.current_audio(item, generation)

    def play(self):
        import numpy as np
        import sounddevice as sd
        device = cable_render_device()
        ffmpeg = shutil.which('ffmpeg')
        if not ffmpeg: raise RuntimeError('FFmpeg unavailable')
        while not self.stop.is_set():
            result = self.control('/next'); item = result.get('item')
            if not item:
                self.stop.wait(.08); continue
            generation = self.generation
            if not self.wait_output(item, generation): continue
            if item.get('kind') == 'speech':
                self.play_stream(item, generation, device)
                continue
            file = Path(item['file']).resolve()
            if not file.is_relative_to((ROOT/'bot-home/media/onebot').resolve()) or not file.is_file():
                raise RuntimeError('Call audio outside media fence')
            decoded = subprocess.run([ffmpeg, '-v', 'error', '-i', str(file), '-f', 'f32le', '-ar', '48000', '-ac', '2', 'pipe:1'],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=20, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
            pcm = np.frombuffer(decoded.stdout, dtype='float32').reshape(-1, 2)
            if not len(pcm): raise RuntimeError('Empty call audio')
            if not self.current_audio(item, generation): continue
            with sd.OutputStream(device=device, samplerate=48000, channels=2, dtype='float32', blocksize=960) as output:
                if not self.wait_output(item, generation): continue
                # Ack only after the first frame entered the virtual endpoint;
                # this is local playback evidence, not proof of remote hearing.
                output.write(pcm[:960])
                LOG.info('call_playback_started samples=%d', len(pcm))
                try: self.control('/played', receipt=item['receipt'])
                except HTTPError as error:
                    if error.code == 409: output.abort(); continue
                    raise
                for start in range(960, len(pcm), 960):
                    if not self.wait_output(item, generation):
                        output.abort(); break
                    output.write(pcm[start:start+960])

    def current_audio(self, item, generation):
        return not self.stop.is_set() and generation == self.generation and item.get('revision') == self.revision

    def play_stream(self, item, generation, device):
        import numpy as np
        import sounddevice as sd
        response = None; output = None; acked = False
        started = time.monotonic()
        try:
            response = self.api.speech_stream(item, cancelled=lambda: not self.current_audio(item,generation))
            self.play_response = response
            rate = int(response.headers.get('X-Audio-Sample-Rate', '0'))
            if (response.headers.get('Content-Type') != 'application/x-dsh-pcm-stream' or rate not in (16000,24000,48000)
                    or response.headers.get('X-Voice-Profile-Key') != item['voiceProfileKey']):
                raise RuntimeError('Streaming voice profile/format mismatch')
            for data in pcm_chunks(response):
                mono = np.frombuffer(data, dtype='<f4')
                if not np.isfinite(mono).all(): raise RuntimeError('Invalid streamed samples')
                if not self.current_audio(item, generation): break
                if output is None:
                    output = sd.OutputStream(device=device, samplerate=rate, channels=2, dtype='float32',
                        blocksize=rate//50, extra_settings=sd.WasapiSettings(auto_convert=True))
                    output.start()
                for start in range(0,len(mono),rate//50):
                    if not self.wait_output(item, generation): break
                    output.write(np.repeat(mono[start:start+rate//50,None],2,axis=1))
                    if not acked:
                        self.control('/played', receipt=item['receipt'])
                        acked = True
                        LOG.info('call_playback_started streaming=true first_ms=%d', (time.monotonic()-started)*1000)
                if not self.current_audio(item, generation): break
            if self.current_audio(item, generation) and not acked: raise RuntimeError('Empty PCM stream')
        except Exception:
            if self.current_audio(item, generation): raise
        finally:
            self.play_response = None
            if response is not None: response.close()
            if output is not None:
                if not self.current_audio(item, generation): output.abort()
                output.close()

    def close(self):
        self.stop.set(); self.generation += 1
        self.cancel_stream()
        if self.tap: self.tap.close(); self.tap = None
        try: self.control('/end')
        except Exception: pass
        for worker in self.threads:
            if worker is not threading.current_thread(): worker.join(timeout=3)

def main():
    import sherpa_onnx
    import psutil
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
    # Import/capture dependencies before arming, not after the first answered
    # call. This does not open the microphone or start desktop capture.
    from proctap import ProcessAudioCapture
    import numpy, sounddevice
    # Load CPU VAD before answering; no new Torch/CUDA model.
    sherpa_onnx.VoiceActivityDetector(vad_config(), buffer_size_in_seconds=35)
    PRIVATE.mkdir(parents=True, exist_ok=True)
    config = json.loads((PRIVATE/'config.json').read_text())
    if config.get('enabled') is not True: raise RuntimeError('Voice calls disabled')
    api = API((PRIVATE/'control.token').read_text().strip())
    cable_render_device()
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(model=str(MODEL/'model.int8.onnx'),
        tokens=str(MODEL/'tokens.txt'), num_threads=4, provider='cpu', use_itn=True, debug=False)
    warm_recognizer(recognizer)
    (PRIVATE/'worker.pid').write_text(str(__import__('os').getpid()))
    LOG.info('call_worker_ready asr=cpu fixed_voice=true')
    current = None; last_health = 0; healthy = False; owner = None; allowed_callers = []
    prepared_tap = None; prepared_host = None
    last_route_ready = None
    try:
        while not (PRIVATE/'stop.request').exists():
            try:
                bridge = api.request(6110, '/v1/status')['data']
                host = api.request(6111, '/v1/status')['data']
                if time.monotonic()-last_health > 4:
                    dsh = api.request(8400, '/state')
                    tts = api.request(8398, '/health')
                    healthy = dsh['awake'] and bool(tts.get('ready'))
                    owner = dsh['owner']; allowed_callers = dsh.get('allowedCallers', [owner]); last_health = time.monotonic()
                process = psutil.Process(int(host['pid']))
                bot_exe = (Path.home()/'NapCat-p1/shell/QQ.exe').resolve()
                verified = Path(process.exe()).resolve() == bot_exe and process.cmdline()[-1] == '0'
                if host.get('ready') and not bridge['avHost'].get('loginSucceeded'):
                    api.request(6110, '/v1/initialize', {})
                if host.get('ready') and not (host.get('audioSelection') or {}).get('confirmed'):
                    api.request(6111, '/v1/select-audio', {'devices':native_device_inventory()})
                route_ready = verified and bool((host.get('audioRouteGuard') or {}).get('ready'))
                if route_ready != last_route_ready:
                    LOG.info('call_route_guard ready=%s', bool(route_ready))
                    last_route_ready = route_ready
                call = bridge['call']
                same = current and current.id == call.get('inviteAt') and call['phase'] in ['accepted', 'connected']
                if current and (not same or current.stop.is_set() or not route_ready):
                    fault = current.fault
                    if fault or not route_ready: api.request(6110, '/v1/hangup', {'id': current.id})
                    current.close(); current = None
                    if fault: raise RuntimeError('Audio worker unhealthy')
                identity = (host['pid'], process.create_time())
                if prepared_tap and (not route_ready or prepared_host != identity):
                    prepared_tap.close(); prepared_tap = None; prepared_host = None
                if not current and route_ready and healthy and prepared_tap is None:
                    # Cold COM activation can take seconds. Do it before arming,
                    # without starting capture, rather than after answering.
                    api.request(6110, '/v1/arm', {'ready': False})
                    prepared_tap = prepare_capture(host['pid']); prepared_host = identity
                ready = healthy and route_ready and bool(current or prepared_tap) and bool((host.get('audioSelection') or {}).get('confirmed')) and bridge['avHost'].get('loginSucceeded')
                api.request(6110, '/v1/arm', {'ready': bool(ready), 'allowedCallers': allowed_callers})
                caller = str(call.get('callerUin'))
                if not current and call['phase'] == 'connected' and call.get('inviteType') == 1 and caller in allowed_callers and ready:
                    current = CallAudio(api, recognizer, call['inviteAt'], caller, host['pid'], prepared_tap=prepared_tap)
                    prepared_tap = None; prepared_host = None
                    current.start(); LOG.info('call_audio_connected')
                if current: current.control('/heartbeat')
                time.sleep(.5 if current else 1)
            except Exception as error:
                healthy = False; last_health = 0
                if current:
                    try: api.request(6110, '/v1/hangup', {'id': current.id})
                    except Exception: pass
                    current.close(); current = None
                try: api.request(6110, '/v1/arm', {'ready': False})
                except Exception: pass
                LOG.warning('call_not_ready error=%s', type(error).__name__)
                time.sleep(3)
    finally:
        if prepared_tap: prepared_tap.close()
        if current:
            try: api.request(6110, '/v1/hangup', {'id': current.id})
            except Exception: pass
            current.close()
        try: api.request(6110, '/v1/arm', {'ready': False})
        except Exception: pass
        (PRIVATE/'worker.pid').unlink(missing_ok=True)

if __name__ == '__main__': main()
