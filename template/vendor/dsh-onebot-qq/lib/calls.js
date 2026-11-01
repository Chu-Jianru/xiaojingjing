/** Local voice-call transport. Existing private session/persona/memory remain authoritative. */
import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile, mkdir, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { synthesizeSpeech, speechConfig } from './tts.js';
import { computeStatus, loadSleep } from './sleep.js';
import { allowedCallers } from './companionship.js';
import { profileGet } from './profiles.js';

const instances = new WeakMap();
export function speechParts(value, limit = 100) {
    const text = String(value ?? '').replace(/\[\[(?:reply|wait):[^\]]*\]\]/g, '').trim();
    if (!text || /^(?:\[不回\]|（不回）|【不回】)$/.test(text)) return [];
    const parts = []; let rest = [...text];
    while (rest.length) {
        let size = Math.min(limit, rest.length);
        if (size < rest.length) {
            for (let i = size - 1; i >= Math.floor(limit / 2); i--) {
                if (/[。！？!?；;，,\n]/.test(rest[i])) { size = i + 1; break; }
            }
        }
        parts.push(rest.splice(0, size).join(''));
    }
    return parts;
}

export function earlySentence(text) {
    // A complete authored sentence/line, never reasoning/tool arguments or a
    // fabricated filler. Short interjections wait for their following line.
    if (/[\[<]/.test(text)) return '';
    const match = text.match(/^[\s\S]{6,40}?[。！？!?；;\n]/u);
    return match?.[0].trim() ?? '';
}

export class VoiceCalls {
    constructor(bridge, { synthesize = synthesizeSpeech, readVoiceConfig = speechConfig, now = Date.now } = {}) {
        this.bridge = bridge; this.synthesize = synthesize; this.readVoiceConfig = readVoiceConfig; this.now = now;
        this.call = null; this.server = null; this.pending = new Map(); this.mutedChat = null;
        this.compacting = false;
        const media = bridge.deps?.config?.mediaDir;
        this.dir = typeof media === 'string' ? join(media, 'calls') : null;
    }
    async start() {
        if (!this.dir) return;
        let config;
        try { config = JSON.parse(await readFile(join(this.dir, 'config.json'), 'utf8')); }
        catch { return; }
        if (config.enabled !== true || this.server) return;
        this.owner = String(this.bridge.deps.policy?.adminUsers?.[0] ?? '');
        if (!/^[1-9]\d+$/.test(this.owner)) return;
        this.token = (await readFile(join(this.dir, 'control.token'), 'utf8')).trim();
        if (this.token.length < 32) throw new Error('call control token unavailable');
        this.server = http.createServer((req, res) => void this.request(req, res));
        this.server.requestTimeout = 5000; this.server.headersTimeout = 5000;
        this.server.on('clientError', (_error, socket) => socket.destroy());
        await new Promise((ok, fail) => { this.server.once('error', fail); this.server.listen(8400, '127.0.0.1', ok); });
        this.timer = setInterval(() => { if (this.call && this.now() - this.call.heartbeat > 15000) this.end(); }, 3000);
        this.timer.unref?.();
        this.streamOff = this.bridge.deps.ctx?.on('agent/assistant-stream', value => this.onAssistantStream(value), { global: true });
    }
    valid(req) {
        const a = Buffer.from(String(req.headers.authorization ?? ''));
        const b = Buffer.from('Bearer ' + this.token);
        return a.length === b.length && timingSafeEqual(a, b);
    }
    async request(req, res) {
        const send = (code, data) => { if (!res.destroyed) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); } };
        if (!this.valid(req)) return send(401, { ok: false });
        try {
            const path = new URL(req.url, 'http://127.0.0.1:8400').pathname;
            if (req.method === 'GET' && path === '/state') {
                const awake = computeStatus(await loadSleep(this.bridge.deps.config.mediaDir), this.now()) !== 'asleep';
                return send(200, { ok: true, awake, owner: this.owner, allowedCallers: await allowedCallers(this.bridge), callId: this.call?.id ?? null });
            }
            if (req.method !== 'POST') return send(404, { ok: false });
            let bytes = 0; const chunks = [];
            for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) throw Error('oversized'); chunks.push(chunk); }
            const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
            if (path === '/begin') {
                const caller = String(body.caller);
                if (!(await allowedCallers(this.bridge)).includes(caller) || computeStatus(await loadSleep(this.bridge.deps.config.mediaDir), this.now()) === 'asleep'
                    || typeof body.id !== 'string' || !body.id || body.id.length > 80) return send(403, { ok: false });
                if (this.call?.id === body.id) { this.call.heartbeat = this.now(); return send(200, { ok: true }); }
                this.end();
                const profile = caller === this.owner ? null : await profileGet(this.bridge.deps.config.mediaDir, caller);
                this.call = { id: body.id, caller, nickname: caller === this.owner ? '老大' : (profile?.nickname || ''), chatId: 'private:' + caller, revision: 0, heartbeat: this.now(), queue: [], seen: new Map(), unadmitted: new Map() };
                this.bridge.__voiceCallActive = true;
                this.mutedChat = null;
                return send(200, { ok: true });
            }
            const call = this.call;
            if (!call || body.id !== call.id) return send(409, { ok: false, code: 'stale_call' });
            call.heartbeat = this.now();
            if (path === '/heartbeat') return send(200, { ok: true, revision: call.revision });
            if (path === '/end') { this.end(); return send(200, { ok: true }); }
            if (path === '/interrupt') { this.interrupt(); return send(200, { ok: true, revision: call.revision }); }
            if (path === '/input') {
                if (!Number.isSafeInteger(body.sequence) || body.sequence < 1 || typeof body.text !== 'string' || !body.text.trim() || [...body.text].length > 16000) return send(400, { ok: false });
                if (call.seen.has(body.sequence)) { await call.seen.get(body.sequence); return send(200, { ok: true, deduped: true }); }
                if (body.revision !== call.revision) return send(409, { ok: false, code: 'stale_utterance' });
                if (this.compacting && call.cancelAfterCompaction) return send(409, { ok: false, code: 'compaction_busy' });
                // A host turn claims inbox messages BEFORE compaction, but only
                // commits user/message afterward. Cancellation in that gap must
                // not lose the caller's earlier words or duplicate admitted ones.
                const covered = [...call.unadmitted.keys()];
                const words = body.text.trim();
                const text = [...call.unadmitted.values()].map(row => row.words).concat(words).join('\n');
                if ([...text].length > 16000) return send(413, { ok: false, code: 'pending_call_input_too_large' });
                call.unadmitted.set(body.sequence, { words, covered });
                const event = { post_type: 'message', message_type: 'private', user_id: call.caller, message_id: 'call:' + call.id + ':' + body.sequence,
                    dshVoiceCall: true, dshListeningReleased: true, dshFragmentReleased: true,
                    dshVoiceCallAlive: () => this.call === call && call.revision === body.revision,
                    raw_message: text, message: [{ type: 'text', data: { text } }], sender: { nickname: call.nickname } };
                // Preserve the same private gate, scoped recall, profiles, rules,
                // mood, auto-learning and existing model. No second chat agent.
                const job = Promise.resolve().then(() => this.bridge.handleInboundOnce(event, false));
                call.seen.set(body.sequence, job);
                if (call.seen.size > 256) call.seen.delete(call.seen.keys().next().value);
                try {
                    const handled = await job;
                    if (handled === false) { call.seen.delete(body.sequence); call.unadmitted.delete(body.sequence); return send(409, { ok: false, code: 'utterance_deferred' }); }
                } catch (error) { if (call.seen.get(body.sequence) === job) { call.seen.delete(body.sequence); call.unadmitted.delete(body.sequence); } throw error; }
                this.log('input_queued seq=' + body.sequence + ' chars=' + [...text].length);
                return send(200, { ok: true });
            }
            if (path === '/next') {
                if (call.error) return send(503, { ok: false, code: call.error });
                return send(200, { ok: true, revision: call.revision, item: call.queue.shift() ?? null });
            }
            if (path === '/prepared') {
                const prepared = call.prepared;
                if (!prepared || prepared.id !== body.preparation || !prepared.claimed || prepared.serving || prepared.revision !== call.revision)
                    return send(409, { ok: false });
                prepared.serving = true;
                res.on('close', () => prepared.controller.abort());
                const response = await prepared.response;
                if (!response || prepared.profile !== body.voiceProfileKey || this.call !== call || prepared.revision !== call.revision) {
                    prepared.controller.abort(); if (call.prepared === prepared) call.prepared = null;
                    return send(409, { ok: false });
                }
                if (res.destroyed) { prepared.controller.abort(); return; }
                this.log('tts_prepared_used chars=' + [...prepared.text].length);
                res.writeHead(200, Object.fromEntries(['Content-Type', 'X-Audio-Sample-Rate', 'X-Voice-Profile-Key', 'Cache-Control']
                    .map(name => [name, response.headers.get(name)]).filter(([, value]) => value !== null)));
                try {
                    for await (const chunk of response.body) {
                        if (this.call !== call || call.revision !== prepared.revision || res.destroyed) break;
                        if (!res.write(chunk)) await new Promise(resolve => {
                            const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
                            res.once('drain', done); res.once('close', done);
                        });
                    }
                    res.end();
                } catch { res.destroy(); }
                finally { prepared.controller.abort(); if (call.prepared === prepared) call.prepared = null; }
                return;
            }
            if (path === '/played') {
                const receipt = this.pending.get(body.receipt);
                if (!receipt || receipt.call !== call || receipt.revision !== call.revision) return send(409, { ok: false });
                receipt.finish(true); this.log('playback_started'); return send(200, { ok: true });
            }
            return send(404, { ok: false });
        } catch { send(400, { ok: false, code: 'call_request_failed' }); }
    }
    decorate(chatId, text) {
        return this.call?.chatId === chatId ? '[当前是QQ语音通话，按原来的性格自然接话；正文直接说，不加文字转语音工具或发送回执。对方的话可能有语音识别误差，不明白可自然问清。]\n' + text : text;
    }
    onRealInbound(event) {
        if (!event.dshVoiceCall && !this.call && event.message_type === 'private' && 'private:' + String(event.user_id) === this.mutedChat) this.mutedChat = null;
    }
    log(detail) { this.bridge.deps.log?.('info', 'voice call: ' + detail); }
    dropPreparation(call = this.call) {
        const prepared = call?.prepared;
        if (prepared) { clearTimeout(prepared.timer); prepared.controller.abort(); call.prepared = null; }
    }
    onAssistantStream({ agent, frame } = {}) {
        const call = this.call, chat = call && this.bridge.chats.get(call.chatId);
        if (!call || agent?.session?.id !== chat?.sessionId || call.turnRevision !== call.revision) return;
        if (frame?.type === 'start') {
            this.dropPreparation(call);
            call.stream = { id: frame.attemptId, index: 0, text: '', revision: call.revision, blocked: false };
            return;
        }
        const stream = call.stream;
        if (!stream || frame?.attemptId !== stream.id || stream.revision !== call.revision) return;
        if (frame.type === 'end') {
            if (frame.outcome?.kind !== 'committed' || frame.outcome?.eventType !== 'assistant/message') this.dropPreparation(call);
            return;
        }
        if (frame.type !== 'chunk' || stream.blocked) return;
        if (frame.index !== stream.index++) { stream.blocked = true; this.dropPreparation(call); return; }
        const chunk = frame.chunk;
        if (chunk?.type === 'tool-call-delta' || chunk?.type === 'block-start' && chunk.blockType === 'tool-call') {
            stream.blocked = true; this.dropPreparation(call); return;
        }
        if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string' || call.prepared) return;
        stream.text += chunk.text;
        if (stream.text.length > 256) { stream.blocked = true; return; }
        const prefix = earlySentence(stream.text);
        if (prefix) this.prepareSentence(call, stream, prefix);
    }
    prepareSentence(call, stream, text) {
        const prepared = { id: randomUUID(), text, revision: call.revision, controller: new AbortController(), claimed: false, started: this.now() };
        call.prepared = prepared;
        prepared.timer = setTimeout(() => { if (!prepared.claimed && call.prepared === prepared) this.dropPreparation(call); }, 6000);
        prepared.timer.unref?.();
        // No second dialogue request. Synthesis is best effort and remains
        // inaudible until a committed final reply matches this exact prefix.
        prepared.response = Promise.resolve().then(async () => {
            const voice = await this.readVoiceConfig();
            if (this.call !== call || call.prepared !== prepared || stream.blocked
                || voice?.engine !== 'qwen' || voice.mode !== 'reference' || !voice.voiceLocked
                || !Number.isInteger(voice.port) || voice.port < 1024 || voice.port > 65535) return null;
            prepared.profile = voice.voiceProfileKey;
            const response = await fetch('http://127.0.0.1:' + voice.port + '/speech-stream', {
                method: 'POST', signal: prepared.controller.signal, headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, voiceProfileKey: voice.voiceProfileKey }),
            });
            if (!response.ok || response.headers.get('Content-Type') !== 'application/x-dsh-pcm-stream'
                || response.headers.get('X-Voice-Profile-Key') !== voice.voiceProfileKey) {
                prepared.controller.abort(); return null;
            }
            this.log('tts_prepared_ready elapsed_ms=' + (this.now() - prepared.started));
            return response;
        }).catch(() => null);
        this.log('tts_preparing chars=' + [...text].length);
    }
    onSessionEvent(chatId, event) {
        if (chatId !== this.call?.chatId) return;
        if (event.type === 'compaction/start') this.compacting = true;
        if (event.type === 'compaction/end') {
            this.compacting = false;
            if (this.call?.cancelAfterCompaction) {
                this.call.cancelAfterCompaction = false;
                this.cancelTurn(this.call);
                this.log('compaction_finished pending_speech_retained=true');
            }
        }
        const call = this.call;
        if (!call) return;
        if (event.type === 'assistant/message' && (event.data?.interrupted
            || event.data?.message?.content?.some(block => block.type === 'tool-call'))) this.dropPreparation(call);
        if (event.type === 'turn/start') call.turnRevision = call.revision;
        if (event.type !== 'user/message' || event.data?.source?.kind !== 'plugin:dsh-onebot') return;
        const prefix = '[本条ID:call:' + call.id + ':';
        for (const block of event.data.content ?? []) {
            if (block.type !== 'text') continue;
            const boundary = block.text.indexOf('<user_message ');
            const index = block.text.indexOf(prefix);
            if (index < 0 || boundary < 0 || index >= boundary) continue;
            const sequence = Number(block.text.slice(index + prefix.length).split(']')[0]);
            const row = call.unadmitted.get(sequence);
            if (!row) continue;
            for (const seq of row.covered.concat(sequence)) call.unadmitted.delete(seq);
            this.log('input_admitted seq=' + sequence);
        }
    }
    cancelTurn(call) {
        const chat = this.bridge.chats.get(call.chatId);
        if (chat) { chat.loopPending = null; chat.loopBuffer = []; if (chat.agent.status === 'running') chat.agent.cancel({ kind: 'user' }); }
    }
    interrupt(force = false) {
        const call = this.call; if (!call) return;
        call.revision++; call.queue.length = 0;
        this.dropPreparation(call); call.stream = null;
        for (const row of [...this.pending.values()]) if (row.call === call) row.finish(false);
        if (this.compacting && !force) {
            call.cancelAfterCompaction = true;
            this.log('barge_in compaction_preserved=true');
        } else this.cancelTurn(call);
    }
    end() {
        if (!this.call) return;
        this.interrupt(true); this.mutedChat = this.call.chatId; this.call = null; this.bridge.__voiceCallActive = false;
    }
    routeText(chatId, text, options) {
        if (!options.modelReply) return null;
        if (this.call?.chatId === chatId) return this.speak(text);
        return this.mutedChat === chatId ? Promise.resolve([]) : null;
    }
    routeSegments(chatId, segments) {
        const record = segments.find(s => s.type === 'record');
        if (!record) return null;
        if (this.mutedChat === chatId && !this.call) return Promise.resolve('');
        if (this.call?.chatId !== chatId) return null;
        if ((this.call.turnRevision ?? this.call.revision) !== this.call.revision) return Promise.resolve('');
        const file = String(record.data?.file ?? '').replace(/^file:\/\//, '');
        const root = resolve(this.bridge.deps.config.mediaDir) + sep;
        if (!resolve(file).startsWith(root)) return Promise.reject(new Error('call audio outside media fence'));
        return this.deliver(this.call, this.call.revision, resolve(file)).then(id => id ?? '');
    }
    async speak(text) {
        const call = this.call, revision = call.turnRevision ?? call.revision; const ids = [];
        let voice;
        try { voice = await this.readVoiceConfig(); }
        catch (error) { if (this.call === call) call.error = 'fixed_voice_unavailable'; throw error; }
        const dir = join(this.dir, 'audio'); await mkdir(dir, { recursive: true });
        let parts = speechParts(text), prepared = call.prepared;
        const full = parts.join('');
        if (prepared && !prepared.claimed && prepared.revision === revision
            && (!prepared.profile || prepared.profile === voice?.voiceProfileKey) && full.startsWith(prepared.text)) {
            prepared.claimed = true; clearTimeout(prepared.timer);
            parts = [prepared.text, ...speechParts(full.slice(prepared.text.length))];
        } else { if (prepared && !prepared.claimed) this.dropPreparation(call); prepared = null; }
        for (const [index, part] of parts.entries()) {
            if (this.call !== call || call.revision !== revision) break;
            if (voice?.engine === 'qwen' && voice.mode === 'reference' && voice.voiceLocked) {
                const preparation = index === 0 && prepared ? { preparation: prepared.id, callId: call.id } : {};
                const id = await this.deliver(call, revision, { kind:'speech', text:part, port:voice.port, voiceProfileKey:voice.voiceProfileKey, ...preparation });
                if (id) ids.push(id); else break;
                continue;
            }
            const file = join(dir, randomUUID() + '.mp3');
            try {
                const started = this.now();
                await this.synthesize({ text: part, outPath: file });
                this.log('tts_ready elapsed_ms=' + (this.now() - started));
                const id = await this.deliver(call, revision, file);
                if (id) ids.push(id); else break;
            } catch (error) {
                if (this.call === call) call.error = 'fixed_voice_unavailable';
                throw error;
            } finally { await unlink(file).catch(() => {}); }
        }
        return ids;
    }
    deliver(call, revision, audio) {
        if (this.call !== call || call.revision !== revision) return Promise.resolve(null);
        return new Promise(resolve => {
            const id = randomUUID();
            const timer = setTimeout(() => finish(false), 20000);
            const finish = played => {
                clearTimeout(timer); this.pending.delete(id); call.queue = call.queue.filter(row => row.receipt !== id);
                if (!played && audio?.preparation && call.prepared?.id === audio.preparation) this.dropPreparation(call);
                resolve(played ? 'call:' + id : null);
            };
            this.pending.set(id, { call, revision, finish });
            call.queue.push({ receipt: id, ...(typeof audio === 'string' ? { file: audio } : audio), revision });
        });
    }
    async stop() {
        this.streamOff?.(); this.streamOff = null;
        this.end(); clearInterval(this.timer);
        if (this.server) { this.server.closeAllConnections(); await new Promise(ok => this.server.close(ok)); this.server = null; }
    }
}
export function callsFor(bridge) {
    let value = instances.get(bridge); if (!value) { value = new VoiceCalls(bridge); instances.set(bridge, value); }
    return value;
}
