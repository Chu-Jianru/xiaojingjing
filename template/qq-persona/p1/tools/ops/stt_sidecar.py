"""Local CPU SenseVoice fallback for QQ voice messages; no second chat turn."""
import hashlib
import json
import os
import secrets
import subprocess
import threading
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = next(p for p in Path(__file__).resolve().parents if (p/'bot-home').is_dir())
MEDIA = (ROOT/'bot-home/media/onebot').resolve()
MODEL = ROOT/'bot-home/call-runtime/models/sensevoice'

def audio_path(value, media=MEDIA):
    path = Path(value).resolve(strict=True)
    if not path.is_file() or not path.is_relative_to(media.resolve()) or path.stat().st_size > 20*1024*1024:
        raise ValueError('audio_path_rejected')
    return path

class Transcriber:
    def __init__(self):
        import sherpa_onnx
        # Reuse the already installed CPU recognition model, never download at runtime.
        models = list((ROOT/'bot-home/call-runtime').rglob('model.int8.onnx'))
        model = next((p for p in models if 'sense' in str(p).lower()), None)
        if model is None: raise RuntimeError('SenseVoice model unavailable')
        self.recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(model=str(model), tokens=str(model.parent/'tokens.txt'),
            num_threads=2, provider='cpu', use_itn=True, debug=False)
        self.lock = threading.Lock()
        self.cache = OrderedDict()

    def transcribe(self, value):
        import numpy as np
        path = audio_path(value)
        stat = path.stat()
        key = (str(path), stat.st_mtime_ns, stat.st_size)
        with self.lock:
            if key in self.cache: return self.cache[key]
            decoded = subprocess.run(['ffmpeg','-v','error','-nostdin','-i',str(path),'-t','91','-f','f32le','-ar','16000','-ac','1','pipe:1'],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=12, check=True,
                creationflags=0x08000000 if os.name=='nt' else 0)
            pcm = np.frombuffer(decoded.stdout, dtype='<f4')
            if len(pcm)>90*16000: raise ValueError('voice_message_too_long')
            if not len(pcm): return ''
            stream = self.recognizer.create_stream()
            stream.accept_waveform(16000, pcm)
            self.recognizer.decode_stream(stream)
            text = stream.result.text.strip()
            if not any(c.isalnum() for c in text): text = ''
            self.cache[key] = text
            while len(self.cache)>64: self.cache.popitem(last=False)
            return text

def handler_for(transcriber, token, port=8401):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def respond(self, status, data):
            body=json.dumps(data,ensure_ascii=False).encode('utf8')
            self.send_response(status); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
        def do_GET(self):
            self.respond(200 if self.path=='/health' else 404, {'ready':True,'engine':'sensevoice-cpu'})
        def do_POST(self):
            if self.path!='/transcribe': return self.respond(404,{})
            if self.headers.get('Host') not in (f'127.0.0.1:{port}',f'localhost:{port}') or not secrets.compare_digest(self.headers.get('Authorization',''),'Bearer '+token):
                return self.respond(403,{})
            try:
                length=int(self.headers.get('Content-Length','0'))
                if not 0<length<=4096: raise ValueError('body_size')
                body=json.loads(self.rfile.read(length))
                self.respond(200,{'text':transcriber.transcribe(body.get('path',''))})
            except Exception as error:
                self.respond(422,{'error':type(error).__name__})
    return Handler

if __name__=='__main__':
    token=(MEDIA/'calls/control.token').read_text(encoding='utf8').strip()
    if len(token)<32: raise RuntimeError('Missing local control token')
    transcriber=Transcriber()
    print('stt_ready engine=sensevoice-cpu',flush=True)
    ThreadingHTTPServer(('127.0.0.1',8401),handler_for(transcriber,token)).serve_forever()
