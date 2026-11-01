/** Native singing runs on demand, outside the chat turn, with no speech fallback. */
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

let ROOT=dirname(fileURLToPath(import.meta.url));
while(!existsSync(join(ROOT,'bot-home')) && dirname(ROOT)!==ROOT)ROOT=dirname(ROOT);
const RUNTIME=join(ROOT,'bot-home/singing-runtime');
const runtimes=new WeakMap();
const TIMEOUT=10*60_000;
const hash=value=>createHash('sha256').update(value).digest('hex');
function waveDuration(audio){
    if(audio.length<44 || audio.toString('ascii',0,4)!=='RIFF' || audio.toString('ascii',8,12)!=='WAVE')throw new Error('singing_waveform_invalid');
    let format=false,duration=0;
    for(let at=12;at+8<=audio.length;){const kind=audio.toString('ascii',at,at+4),size=audio.readUInt32LE(at+4);at+=8;
        if(at+size>audio.length)throw new Error('singing_waveform_truncated');
        if(kind==='fmt '){format=size>=16 && audio.readUInt16LE(at)===1 && audio.readUInt16LE(at+2)===1 && audio.readUInt32LE(at+4)===24000 && audio.readUInt16LE(at+14)===16;}
        if(kind==='data')duration=size/48000;at+=size+(size%2);
    }
    if(!format || duration<1 || duration>45)throw new Error('singing_waveform_invalid');return duration;
}
export function singingRequest(args){
    const lyrics=String(args?.lyrics??'').trim();const style=args?.style??'gentle';
    if(!lyrics || [...lyrics].length>120 || /[<>\x00]/.test(lyrics))throw new Error('请给一句或一小段歌词，最多120字');
    if(!['gentle','expressive'].includes(style))throw new Error('singing_style_invalid');
    return{lyrics,style};
}
export async function terminateWorker(child){
    if(!child.pid || child.exitCode!==null)return;
    if(process.platform!=='win32'){child.kill('SIGKILL');return;}
    // Windows venv redirectors spawn the actual interpreter as a child.
    await new Promise(resolveKill=>{
        const killer=spawn(join(process.env.SystemRoot??'C:\\Windows','System32/taskkill.exe'),
            ['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        killer.once('error',()=>{child.kill();resolveKill();});killer.once('close',resolveKill);
    });
}
async function readiness(){
    try{
        const [voice,model,ready]=await Promise.all([
            readFile(join(ROOT,'bot-home/media/onebot/tts-voice.json'),'utf8').then(JSON.parse),
            readFile(join(RUNTIME,'model-manifest.json'),'utf8').then(JSON.parse),
            readFile(join(RUNTIME,'ready.json'),'utf8').then(JSON.parse)]);
        if(voice.voiceLocked!==true || voice.mode!=='reference' || ready.backend!=='vevo2_native'
            || ready.voiceSha256!==voice.reference.sha256 || ready.modelRevision!==model.revision)
            throw new Error('singing_not_verified');
        const reference=resolve(ROOT,voice.reference.path);
        if(hash(await readFile(reference))!==voice.reference.sha256)throw new Error('singing_voice_changed');
        const folder=dirname(reference);
        const [audition,approval]=await Promise.all([readFile(join(folder,'approved-audition.wav')),
            readFile(join(folder,'approval.json'),'utf8').then(JSON.parse)]);
        const speechTimbreSha256=hash(audition);
        if(approval.status!=='active' || approval.referenceSha256!==voice.reference.sha256
            || approval.selectedSampleSha256!==speechTimbreSha256 || ready.speechTimbreSha256!==speechTimbreSha256)
            throw new Error('singing_spoken_timbre_unverified');
        return{voiceSha256:voice.reference.sha256,modelRevision:model.revision,speechTimbreSha256};
    }catch{throw new Error('唱歌的声线还在调整，这次先不能唱；不要换声线、用朗读替代或说已经唱了');}
}
export function runSinging(request,{signal,onStage=()=>{}}={}){
    return new Promise((resolveJob,reject)=>{
        const child=spawn(join(RUNTIME,'.venv/Scripts/python.exe'),['-u',join(ROOT,'qq-persona/p1/tools/ops/singing_worker.py')],
            {cwd:ROOT,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,CUDA_VISIBLE_DEVICES:'-1',PYTHONUTF8:'1',WHALE_SINGING_PARENT_PID:String(process.pid)}});
        let buffer='';let result;let settled=false;
        const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
            error?reject(error):resolveJob(result);};
        const terminate=error=>{void terminateWorker(child).finally(()=>finish(error));};
        const cancel=()=>terminate(new Error('singing_cancelled'));
        const timer=setTimeout(()=>terminate(new Error('singing_timeout')),TIMEOUT);
        signal?.addEventListener('abort',cancel,{once:true});
        child.stdout.on('data',chunk=>{
            buffer+=chunk.toString();if(buffer.length>65536)return terminate(new Error('singing_output_invalid'));
            let end;while((end=buffer.indexOf('\n'))>=0){
                const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
                try{const row=JSON.parse(line);if(row.event==='singing-result')result=row;
                    if(row.event==='singing-stage')onStage(row.stage);}catch{/* Upstream progress only. */}
            }
        });
        child.stderr.resume(); // No upstream paths or private lyrics in chat logs.
        child.on('error',()=>finish(new Error('singing_worker_unavailable')));
        child.on('close',code=>finish(code!==0 || !result?new Error('singing_generation_failed'):null));
        child.stdin.on('error',()=>{});
        if(signal?.aborted)return cancel();
        child.stdin.end(JSON.stringify(request));
    });
}
export class SingingJobs{
    constructor(bridge,{runner=runSinging,ready=readiness}={}){this.bridge=bridge;this.runner=runner;this.ready=ready;this.jobs=new Map();this.active=null;this.stopped=false;}
    view(job){return{jobId:job.id,status:job.status,sent:job.status==='sent',messageId:job.messageId??null};}
    lookup(chatId,id){const job=id?this.jobs.get(id):[...this.jobs.values()].reverse().find(j=>j.chatId===chatId);
        if(!job || job.chatId!==chatId)throw new Error('这个会话没有对应的清唱任务');return job;}
    cancel(chatId,id,actor){const job=this.lookup(chatId,id);
        if(actor?.role!=='admin' && actor?.userId!==job.actor?.userId)throw new Error('这段是别人约的，先让她唱完吧');
        if(['queued','generating'].includes(job.status)){job.status='cancelled';job.controller.abort();}return this.view(job);}
    async create(chatId,args,actor){
        if(this.stopped || this.bridge.stopping || this.bridge.deps.config.inject?.intercepting)throw new Error('singing_unavailable');
        if(this.bridge.__voiceCallActive)throw new Error('现在正在通话，等电话结束再唱');
        const request=singingRequest(args);const key=hash(JSON.stringify([chatId,actor?.sequence,request]));
        const duplicate=[...this.jobs.values()].find(j=>j.key===key);if(duplicate)return this.view(duplicate);
        if(this.active)throw new Error('已经有一段清唱在准备，先等这一段');
        // Reserve before the first await: overlapping tool calls cannot launch two models.
        this.active='checking';
        let identity;try{identity=await this.ready();}catch(error){this.active=null;throw error;}
        if(this.stopped || this.bridge.stopping){this.active=null;throw new Error('singing_cancelled');}
        if(this.bridge.__voiceCallActive){this.active=null;throw new Error('现在正在通话，等电话结束再唱');}
        const id=randomUUID(),out=join(this.bridge.deps.config.mediaDir,'music',`singing-${id}.wav`);
        const job={id,key,chatId,actor,status:'queued',controller:new AbortController(),out,identity};
        this.jobs.set(id,job);this.active=id;
        while(this.jobs.size>30){const first=this.jobs.keys().next().value;this.jobs.delete(first);}
        job.completion=this.perform(job,{...request,...identity,out});
        return this.view(job);
    }
    async perform(job,request){
        try{
            await mkdir(dirname(job.out),{recursive:true});
            if(job.controller.signal.aborted)throw new Error('singing_cancelled');
            job.status='generating';
            const result=await this.runner(request,{signal:job.controller.signal});
            if(job.controller.signal.aborted || this.stopped || this.bridge.stopping)return;
            if(resolve(result.path)!==resolve(job.out) || result.backend!=='vevo2_native' || result.acappella!==true
                || result.voiceSha256!==job.identity.voiceSha256 || result.modelRevision!==job.identity.modelRevision
                || result.speechTimbreSha256!==job.identity.speechTimbreSha256
                || !(result.durationSeconds>=1 && result.durationSeconds<=45))throw new Error('singing_result_rejected');
            // Recheck the voice after a long job; never send stale output after a voice change.
            const current=await this.ready();if(current.voiceSha256!==job.identity.voiceSha256 || current.speechTimbreSha256!==job.identity.speechTimbreSha256)throw new Error('singing_voice_changed');
            const audio=await readFile(job.out);
            if(audio.length>24000*2*46 || Math.abs(waveDuration(audio)-result.durationSeconds)>.02)
                throw new Error('singing_waveform_invalid');
            if(job.controller.signal.aborted || this.stopped || this.bridge.stopping)return;
            job.status='sending';
            const id=await this.bridge.sendSegments(job.chatId,[{type:'record',data:{file:job.out}}]);
            if(!id)throw new Error('singing_delivery_unconfirmed');
            job.messageId=id;job.status='sent';
        }catch(error){
            if(job.status==='cancelled' || this.stopped || this.bridge.stopping)return;
            job.status='failed';
            this.bridge.deps.log?.('warn','singing job failed: '+String(error.message).replace(/[^a-z_]/g,'').slice(0,60));
            // Only failure needs a natural followup; successful audio adds no model round.
            const actor=job.actor;
            if(actor && this.bridge.chatForSession(actor.sessionId)===job.chatId && !this.bridge.stopping){
                await this.bridge.dispatchFollowup?.(job.chatId,
                    '[清唱任务结果]刚才的清唱没有成功送达。请自然地告诉对方这次没唱成，不假称已发送，不自动重试，不提权限或内部路径。',
                    actor.role,undefined,undefined,actor.userId).catch(()=>{});
            }
        }finally{if(this.active===job.id)this.active=null;}
    }
    stop(){this.stopped=true;for(const job of this.jobs.values())if(['queued','generating'].includes(job.status)){job.status='cancelled';job.controller.abort();}}
}
export function singingFor(bridge){let jobs=runtimes.get(bridge);if(!jobs){jobs=new SingingJobs(bridge);runtimes.set(bridge,jobs);}return jobs;}
export function stopSinging(bridge){runtimes.get(bridge)?.stop();}
