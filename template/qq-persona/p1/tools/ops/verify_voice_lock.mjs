// Explicit local reference-voice audit. Never sends a QQ message.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { speechConfig } from '../plugin/modules/onebot_tts.js';
const root=join(dirname(fileURLToPath(import.meta.url)),'../../../..');
const cfg=await speechConfig();
assert.equal(cfg.mode,'reference');
const origin='http://127.0.0.1:'+cfg.port;
let health;
const until=Date.now()+120000;
do {
    health=await fetch(origin+'/health',{signal:AbortSignal.timeout(2000)}).then(r=>r.json()).catch(()=>({}));
    if(health.failed)throw new Error('Reference model loading failed; inspect local service logs');
    if(health.ready)break;
    assert.ok(Date.now()<until,'reference warmup timed out');
    await new Promise(r=>setTimeout(r,1000));
}while(true);
assert.equal(health.voiceProfileKey,cfg.voiceProfileKey);
const dir=join(root,'bot-home/media/onebot/tts/samples/fixed-reference');
await mkdir(dir,{recursive:true});
const cases=[
    ['first','老大，我在呢。今天也想陪你聊一会儿。','Serena','cute-slow'],
    ['same-text-other-voice-request','老大，我在呢。今天也想陪你聊一会儿。','Vivian','lively'],
    ['new-sentence','那你先慢慢说，小鲸鲸听着呢。','Vivian','lively'],
];
const results=[];
for(const [name,text,speaker,style] of cases){
    const start=Date.now();
    const r=await fetch(origin+'/speech',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({text,speaker,style}),signal:AbortSignal.timeout(45000)});
    assert.equal(r.status,200);
    const bytes=Buffer.from(await r.arrayBuffer());
    const path=join(dir,name+'.mp3');await writeFile(path,bytes);
    const media=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','json',path],{encoding:'utf8'}));
    const row={name,chars:[...text].length,elapsed_ms:Date.now()-start,duration_seconds:Number(media.format.duration),sha256:createHash('sha256').update(bytes).digest('hex'),path};
    results.push(row);console.log(JSON.stringify(row));
}
assert.equal(results[0].sha256,results[1].sha256,'same words must not change voice when caller changes speaker/style');
console.log('VOICE_LOCK_VERIFIED');
