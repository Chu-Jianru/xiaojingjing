"""Native-call preflight. --audio-test uses only VB-Cable and our own PID."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import queue
import sys
import time
sys.path.insert(0, str(Path(__file__).parent / 'native'))
from windows_audio import cable_render_device, cable_capture_device

def audio_test():
    import numpy as np
    from proctap import ProcessAudioCapture
    import sounddevice as sd
    chunks = queue.Queue(maxsize=500)
    def receive(data, frames):
        try:
            chunks.put_nowait(data)
        except queue.Full:
            pass
    tap = None
    try:
        tap = ProcessAudioCapture(os.getpid(), on_data=receive)
        tap.start()
        tone = (0.02 * np.sin(2 * np.pi * 440 * np.arange(24000) / 48000)).astype('float32')
        stereo = np.repeat(tone[:, None], 2, axis=1)
        # Capture only the virtual endpoint; never use sd.default.device.
        recorded = sd.playrec(stereo, samplerate=48000, channels=2, dtype='float32',
                              device=(cable_capture_device(), cable_render_device()), blocking=True)
        time.sleep(0.3)
        peak = float(np.max(np.abs(recorded)))
        values = []
        while not chunks.empty():
            values.append(np.frombuffer(chunks.get_nowait(), dtype='float32'))
        process_peak = max((float(np.max(np.abs(x))) for x in values if len(x)), default=0)
        return {'virtualRoundtripPeak': peak, 'ownProcessLoopbackPeak': process_peak,
                'ok': peak > 0.001 and process_peak > 0.001}
    finally:
        if tap:
            tap.close()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audio-test', action='store_true')
    parser.add_argument('--asr-test', action='store_true')
    args = parser.parse_args()
    import importlib.metadata as metadata
    print(json.dumps({'virtualCaptureFound': cable_capture_device() >= 0,
                      'renderDevice': cable_render_device(),
                      'dependencies': {x: metadata.version(x) for x in ['proc-tap', 'sherpa-onnx']}}))
    if args.asr_test:
        import sherpa_onnx
        import numpy as np
        import subprocess
        import shutil
        from call_runtime import MODEL, ROOT
        recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(model=str(MODEL/'model.int8.onnx'),
            tokens=str(MODEL/'tokens.txt'), num_threads=4, provider='cpu', use_itn=True)
        # Existing approved sample, never a microphone capture or QQ message.
        raw = subprocess.check_output([shutil.which('ffmpeg'), '-v', 'error', '-i',
            str(ROOT/'qq-persona/p1/voice/approved-audio-1-20261029/approved-audition.wav'), '-f', 'f32le', '-ac', '1', '-ar', '16000', 'pipe:1'])
        stream = recognizer.create_stream(); stream.accept_waveform(16000, np.frombuffer(raw, dtype='float32'))
        started = time.monotonic(); recognizer.decode_stream(stream)
        print(json.dumps({'asrText': stream.result.text, 'decodeMs': round((time.monotonic()-started)*1000), 'provider': 'cpu'}, ensure_ascii=True))
    if args.audio_test:
        result = audio_test()
        print(json.dumps(result))
        raise SystemExit(0 if result['ok'] else 1)

if __name__ == '__main__':
    main()
