// Local audition only. Never sends messages to QQ.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { synthesizeSpeech } from '../plugin/modules/onebot_tts.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const dir = join(root, 'bot-home/media/onebot/tts/samples/soft-voice');
await mkdir(dir, { recursive: true });
const text = '老大，你回来啦。嗯，我在呢，今天也想陪你聊一会儿。';
const configPath = join(dir, 'baseline-config.json');
await writeFile(configPath, JSON.stringify({ engine: 'edge', voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%', pitch: '+0Hz', volume: '+0%' }));
const before = Date.now();
await synthesizeSpeech({ text, configPath, outPath: join(dir, 'before-xiaoxiao.mp3') });
console.log(JSON.stringify({ sample: 'before-xiaoxiao', elapsed_ms: Date.now() - before }));
const samples = process.argv.includes('--slow')
    ? [['cute-slow-serena', 'Serena', 'cute-slow']]
    : process.argv.includes('--cute')
    ? [['cute-serena', 'Serena', 'cute'], ['cute-vivian', 'Vivian', 'cute']]
    : [['soft-serena', 'Serena', 'soft'], ['lively-vivian', 'Vivian', 'lively']];
for (const [name, speaker, style] of samples) {
    const started = Date.now();
    const response = await fetch('http://127.0.0.1:8398/speech', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, speaker, style }), signal: AbortSignal.timeout(60000) });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('audio/mpeg')) throw new Error(name + ': HTTP ' + response.status);
    const path = join(dir, name + '.mp3');
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=sample_rate,channels', '-of', 'json', path], { encoding: 'utf8' }));
    console.log(JSON.stringify({ sample: name, elapsed_ms: Date.now() - started,
        synthesis_ms: response.headers.get('x-tts-synthesis-ms'), duration_seconds: Number(info.format.duration), streams: info.streams, path }));
}
