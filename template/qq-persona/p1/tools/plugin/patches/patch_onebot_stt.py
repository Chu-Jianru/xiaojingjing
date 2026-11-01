"""v2.95: recognize ordinary voice before the single inbound chat turn."""
from pathlib import Path
import sys
ROOT=next(p for p in Path(__file__).resolve().parents if (p/'bot-home').is_dir())
LIB=ROOT/'bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib'

def expected(text):
    pairs=[
        ("import { renderProfileBlock } from './profiles.js';", "import { renderProfileBlock } from './profiles.js';\nimport { transcribeVoice, nativeTranscript } from './voice-fallback.js';"),
        ("const spoken = String(ptt?.text ?? '').trim();", "const spoken = nativeTranscript(ptt);"),
        ("const ptt = await this.ctx.call('fetch_ptt_text', { message_id: messageId });", "const ptt = await Promise.race([this.ctx.call('fetch_ptt_text', { message_id: messageId }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('native_stt_timeout')), 3500); timer.unref?.(); })]);"),
    ]
    for old,new in pairs:
        if new not in text:
            if text.count(old)!=1: raise SystemExit('STT anchor mismatch: '+old)
            text=text.replace(old,new,1)
    start=text.index("            case 'voice': {")
    end=text.index("            case 'video':",start)
    text=text[:start]+'''            case 'voice': {
                try {
                    const spoken = await transcribeVoice(resolved.path, this.ctx.config.mediaDir);
                    if (spoken) return '[语音]「' + spoken + '」';
                } catch { this.ctx.log('debug', 'local voice recognition unavailable'); }
                return '[语音：这条未识别出内容，不能据此判断永久听不到语音]';
            }
'''+text[end:]
    return text

def main():
    path=LIB/'inbound.js'; raw=path.read_bytes()
    raw=raw.replace(b"import { transcribeVoice, nativeTranscript } from './stt.js';", b"import { transcribeVoice, nativeTranscript } from './voice-fallback.js';")
    data=expected(raw.decode('utf8').replace('\r\n','\n')).replace('\n','\r\n' if b'\r\n' in raw else '\n').encode('utf8')
    source=Path(__file__).resolve().parents[1]/'modules/onebot_stt.js'
    if '--check' in sys.argv:
        ok=raw==data and (LIB/'voice-fallback.js').exists() and (LIB/'voice-fallback.js').read_bytes()==source.read_bytes()
        print('voice recognition: '+('OK' if ok else 'OUT OF SYNC')); return 0 if ok else 1
    path.write_bytes(data); (LIB/'voice-fallback.js').write_bytes(source.read_bytes()); print('voice recognition installed');return 0
if __name__=='__main__': raise SystemExit(main())
