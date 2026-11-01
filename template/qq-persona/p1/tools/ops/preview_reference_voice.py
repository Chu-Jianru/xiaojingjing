"""Offline candidate auditions using the installed Base model, never live config.

Run with the TTS venv after pausing the audio worker/TTS on an idle call bridge.
This performs reference cloning, not training or modifying model weights.
"""
from pathlib import Path
import argparse
import hashlib
import json
import socket
import subprocess
import time
from urllib.request import Request, urlopen

from tts_sidecar import CONFIG, REPO, RUNTIME, Synthesizer, load_profile

CANDIDATES = REPO / 'qq-persona/p1/voice/candidates'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--expressive', action='store_true', help='ICL style instructions and calibrated pitch-preserving tempo audition')
    parser.add_argument('--smile', action='store_true', help='Brighter smiling delivery, slightly faster than expressive preview')
    args = parser.parse_args()
    if args.expressive and args.smile: parser.error('Choose one delivery preview')
    config = args.config.resolve()
    if not config.is_relative_to(CANDIDATES.resolve()):
        raise ValueError('Preview configuration must be in voice/candidates')
    profile = load_profile(config)
    if profile['mode'] != 'reference' or not profile['reference_path'].is_relative_to(config.parent):
        raise ValueError('Use a checksummed reference within this candidate directory')
    if args.check:
        print(json.dumps({'candidateProfileKey': profile['key'], 'productionConfigChanged': False}))
        return
    token = (REPO / 'bot-home/media/onebot/calls/control.token').read_text().strip()
    with urlopen(Request('http://127.0.0.1:6110/v1/status',
                         headers={'Authorization': 'Bearer ' + token}), timeout=3) as response:
        bridge = json.load(response)['data']
    if bridge['armed'] or bridge['call']['phase'] not in ('idle', 'ended'):
        raise RuntimeError('Pause answering on an idle bridge before GPU auditions')
    try:
        connection = socket.create_connection(('127.0.0.1', 8398), timeout=1)
    except OSError:
        pass
    else:
        connection.close()
        raise RuntimeError('Stop the resident TTS first; do not load two GPU models')
    before = hashlib.sha256(CONFIG.read_bytes()).hexdigest()
    active = load_profile()
    output = config.parent / 'samples'
    output.mkdir(exist_ok=True)
    model = RUNTIME / 'models/Qwen3-TTS-12Hz-1.7B-Base'
    synth = Synthesizer(model, profile)
    synth.load()
    if not synth.ready.is_set(): raise RuntimeError(synth.error)
    if args.expressive or args.smile:
        expressive_preview(synth, output, before, smile=args.smile)
        return
    cases = [
        ('candidate-short', '老大，我在呢。你慢慢说，小鲸鲸听着。', synth),
        ('candidate-chat', '今天有没有什么开心的事，想讲给我听呀？', synth),
    ]
    baseline = Synthesizer(model, active)
    baseline.model = synth.model
    cases.append(('current-voice-comparison', cases[0][1], baseline))
    results = []
    for name, text, engine in cases:
        audio, elapsed, seconds = engine.generate(text, engine.profile['speaker'], engine.profile['style'])
        destination = output / (name + '.mp3')
        destination.write_bytes(audio)
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(destination), '-f', 'null', '-'],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)
        results.append({'file': destination.name, 'text': text, 'synthesisMs': elapsed,
                        'audioSeconds': round(seconds, 3), 'sha256': hashlib.sha256(audio).hexdigest(),
                        'voiceProfileKey': engine.profile['key']})
    start = time.monotonic(); first = None; duration = 0
    for pcm, rate in synth.stream(cases[0][1]):
        if first is None: first = round((time.monotonic() - start) * 1000)
        duration += len(pcm) / 4 / rate
    after = hashlib.sha256(CONFIG.read_bytes()).hexdigest()
    if after != before: raise RuntimeError('Production configuration changed externally during the audition')
    report = {'method': 'reference-clone-not-finetuning', 'weightsTrained': False,
              'candidateProfileKey': profile['key'], 'productionConfigChanged': False,
              'listeningReviewRequired': True, 'samples': results,
              'candidateStreamFirstMs': first, 'candidateStreamAudioSeconds': round(duration, 3)}
    (output / 'audition.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=True), flush=True)


def expressive_preview(synth, output, before, smile=False):
    import numpy as np
    import torch
    common = '保持参考录音中同一个人的音色、音高范围和轻软甜美的底色。像和熟悉的人面对面聊天，音量轻松自然。根据语义改变轻重音和句尾走向，分句间自然换气，不要平直朗读，不要夸张表演或把每个字拖长。'
    cases = [
        ('expressive-short-slow086', '老大，我在呢。你慢慢说，小鲸鲸听着。',
         common + '第一句是带笑意的亲昵回应，第二句放柔、安抚，句尾轻轻落下。', .86),
        ('expressive-chat-slow0688', '嗯？今天有没有什么开心的事，想讲给我听呀？',
         common + '开头轻轻带一点好奇，问到开心的事时明亮一点，最后亲切地邀请对方分享，疑问语气自然上扬。', .688),
    ]
    targets = {}
    if smile:
        common = '保持参考录音中同一个人的音色和身份。声音轻盈、清亮、甜软，像嘴角轻轻上扬、带着自然笑意和熟人说话；不是发出笑声。音区自然明亮一些，不压低嗓子，不用低沉的安抚腔或重气声，也不要尖嗓。语速轻松流畅，轻重音和小停顿随语义变化，不逐字拖长。'
        cases = [
            ('smile-short', cases[0][1], common + '开头亲昵地回应，接着温柔地邀请对方慢慢说，笑意贯穿整句，句尾轻巧自然。', None),
            ('smile-chat', cases[1][1], common + '像含笑问朋友今天的趣事，开心两个字略明亮，问句轻轻上扬，有好奇但不夸张撒娇。', None),
        ]
        earlier = json.loads((output / 'expressive-preview.json').read_text(encoding='utf-8'))
        targets = {row['text']: row['audioSeconds']/1.06 for row in earlier['samples']}
    results = []
    for name, text, instruct, tempo in cases:
        started = time.monotonic()
        seed = int.from_bytes(hashlib.sha256((synth.profile['key'] + text).encode()).digest()[:4], 'big')
        torch.manual_seed(seed)
        with torch.inference_mode():
            waves, rate = synth.model.generate_voice_clone(text=text, language='Chinese',
                max_new_tokens=min(768, max(160, len(text)*14)),
                ref_audio=str(synth.profile['reference_path']), ref_text=synth.profile['reference_text'],
                non_streaming_mode=True, xvec_only=False, instruct=instruct)
        wave = np.asarray(waves[0], dtype='<f4').reshape(-1)
        if not len(wave) or not np.isfinite(wave).all(): raise RuntimeError('Invalid candidate PCM')
        peak = float(np.max(np.abs(wave)))
        if peak > .98: wave *= .98 / peak
        if tempo is None:
            tempo = max(.6, min(1.2, len(wave)/rate/targets[text]))
        destination = output / (name + '.wav')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(rate),
            '-ac', '1', '-i', 'pipe:0', '-af', f'atempo={tempo}', '-c:a', 'pcm_s16le', str(destination)],
            input=wave.tobytes(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, check=True)
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(destination), '-f', 'null', '-'],
            capture_output=True, check=True, timeout=15)
        seconds = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries',
            'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', str(destination)], timeout=10))
        results.append(dict(file=destination.name, text=text, instruct=instruct, tempo=tempo,
            audioSeconds=seconds, targetSeconds=targets.get(text), generationAndProcessingMs=round((time.monotonic()-started)*1000),
            sha256=hashlib.sha256(destination.read_bytes()).hexdigest()))
    if hashlib.sha256(CONFIG.read_bytes()).hexdigest() != before:
        raise RuntimeError('Production configuration changed externally during the audition')
    report = dict(method='icl-instruct-plus-pitch-preserving-tempo-preview', weightsTrained=False,
        sourceVoiceProfileKey=synth.profile['key'], productionConfigChanged=False,
        listeningReviewRequired=True, onlineStreamingStyleNotImplemented=True, samples=results)
    report['delivery'] = 'bright-smile' if smile else 'expressive'
    (output / ('smile-preview.json' if smile else 'expressive-preview.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=True), flush=True)


if __name__ == '__main__': main()
