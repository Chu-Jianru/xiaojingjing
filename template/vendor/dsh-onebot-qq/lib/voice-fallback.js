import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function nativeTranscript(value) {
    const text = typeof value === 'string' ? value : value?.text ?? value?.data?.text;
    return typeof text === 'string' ? text.trim() : '';
}
export async function transcribeVoice(path, mediaDir, { fetcher = fetch, timeout = 15_000 } = {}) {
    const token = (await readFile(join(mediaDir, 'calls/control.token'), 'utf8')).trim();
    const response = await fetcher('http://127.0.0.1:8401/transcribe', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ path }), signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error('local_voice_transcription_unavailable');
    return nativeTranscript(await response.json());
}
