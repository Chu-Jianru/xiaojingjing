/** CPU illustration and native singing; heavy singing stays outside chat turns. */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { singingFor } from './singing.js';
import { listPracticeSongs } from './songbook.js';
import { requireOpportunity, turnActor } from './companionship.js';
let ROOT=dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(ROOT,'bot-home')) && dirname(ROOT)!==ROOT) ROOT=dirname(ROOT);

export function drawingSvg(elements) {
    const source=String(elements??'').trim();
    if (!source || source.length>18000 || /<!|<\/?(?:script|foreignObject|image|iframe|object|embed|svg)\b|\bon[a-z]+\s*=|\b(?:href|src)\s*=|@import|url\s*\(\s*(?!#)/i.test(source))
        throw new Error('drawing_requires_self_contained_vector_shapes');
    return '<svg xmlns="http://www.w3.org/2000/svg" width="768" height="768" viewBox="0 0 768 768">'+source+'</svg>';
}
export async function draw(elements,mediaDir) {
    const svg=drawingSvg(elements);
    const require=createRequire(join(ROOT,'bot-home/creative-runtime/package.json'));
    const {Resvg}=require('@resvg/resvg-js');
    const image=new Resvg(svg,{font:{loadSystemFonts:true,defaultFontFamily:'Microsoft YaHei'}}).render().asPng();
    const dir=join(mediaDir,'drawings');await mkdir(dir,{recursive:true});
    const path=join(dir,'drawing-'+randomUUID()+'.png');await writeFile(path,image);
    return path;
}
export function creativeTools(defineTool,bridge) {
    const output={schema:{type:'json'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]};
    const current=exec=>{const chatId=bridge.chatForSession(exec.agent?.session.id);if(!chatId)throw new Error('creative_chat_required');return chatId;};
    return [defineTool({name:'qq_draw',description:'自己画一张小插画、涂鸦或简单图示并真正发到当前QQ会话。用768×768坐标构图，elements写SVG图形元素（path、circle、rect、text等），可自己决定创作或回应绘图请求；不找旧图冒充新画，不写外链、脚本、完整svg外壳。适合简洁卡通插画，不能假称写实照片。',
        parameters:{elements:{type:'string',required:true},caption:{type:'string'}},output,isConcurrencySafe:()=>false,
        execute:async(args,exec)=>{
            const chatId=current(exec);const path=await draw(args?.elements,bridge.deps.config.mediaDir);
            const segments=[...(args?.caption?[{type:'text',data:{text:String(args.caption).slice(0,400)}}]:[]),{type:'image',data:{file:path}}];
            const id=await bridge.sendSegments(chatId,segments);return{sent:Boolean(id),textSent:Boolean(args?.caption),messageId:id??null,path};
        }}),
    defineTool({name:'qq_sing',description:'按歌名点唱真实歌曲的短清唱片段。直接create并保留song；已有缓存直接使用，新歌后台自动检索版本、获取可用音源、分离人声并用固定声线转换，首次可能数分钟，完成后缓存。无需先list或逐首训练；未指定才默认我看过前四句约15秒。可提供singer确定歌手；同名歧义会询问，音源不可用或转换失败会如实告知。不能保证所有歌曲均可获取，当前是约20秒片段而非整首。list仅查询已缓存/准备的曲库，不是可点歌范围。朋友按熟悉/好感/心情考虑，老大无亲密度门槛。queued/generating未发送，status查看、cancel取消；不假称已发，不用自编曲、朗读、别的歌或原唱音频冒充。reused=true才说复用已有练习录音，false表示本次后台准备，不称训练。',
        parameters:{action:{type:'string',description:'create（默认）、list（查缓存曲库）、status、cancel'},song:{type:'string',description:'对方指定的真实歌名，或list返回的曲库编号；新歌也直接create，省略才默认我看过'},singer:{type:'string',description:'对方指定的歌手/版本，准确保留；不确定可省略'},job_id:{type:'string',description:'查询/取消任务ID，省略取本会话最新'}},output,isConcurrencySafe:()=>false,
        execute:async(args,exec)=>{
            const chatId=current(exec),jobs=singingFor(bridge),chat=bridge.chats.get(chatId);
            if(!chat || !['admin','member'].includes(chat.activeTurnRole))throw new Error('creative_chat_turn_required');
            const sessionId=String(exec.agent.session.id),sender=turnActor(bridge,sessionId);
            if(!sender)throw new Error('这轮还无法确认是谁想听我唱，先问清楚，不冒认老大');
            const actor={sessionId,role:sender.admin?'admin':'member',userId:sender.userId,sequence:chat.activeTurnSequence};
            switch(args?.action??'create'){
                case 'list':return listPracticeSongs();
                case 'status':return jobs.view(jobs.lookup(chatId,args?.job_id));
                case 'cancel':return jobs.cancel(chatId,args?.job_id,actor);
                case 'create':
                    await requireOpportunity(bridge,sessionId,'sing');
                    return jobs.create(chatId,args,actor);
                default:throw new Error('singing_action_invalid');
            }
        }})];
}
