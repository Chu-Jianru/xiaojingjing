/** CPU illustration and native singing; heavy singing stays outside chat turns. */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { singingFor } from './singing.js';
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
    defineTool({name:'qq_sing',description:'用固定参考音色清唱一小段原创歌词，原生歌声模型生成旋律和歌声，不使用普通朗读或变调拼字。create后台生成后自动发到当前会话，queued/generating尚未唱完或发送，不能报成功；status查看、cancel取消。暂不保证已知歌曲的原旋律，不会的歌坦诚说需要学旋律。',
        parameters:{action:{type:'string',description:'create（默认）、status、cancel'},lyrics:{type:'string',description:'一小段原创歌词，最多120字；create必填'},style:{type:'string',description:'gentle（轻柔，默认）或expressive（抒情）'},job_id:{type:'string',description:'查询/取消任务ID，省略取本会话最新'}},output,isConcurrencySafe:()=>false,
        execute:async(args,exec)=>{
            const chatId=current(exec),jobs=singingFor(bridge),chat=bridge.chats.get(chatId);
            if(!chat || !['admin','member'].includes(chat.activeTurnRole))throw new Error('creative_chat_turn_required');
            const actor={sessionId:String(exec.agent.session.id),role:chat.activeTurnRole,userId:String(chat.activeTurnUserId??''),sequence:chat.activeTurnSequence};
            switch(args?.action??'create'){
                case 'status':return jobs.view(jobs.lookup(chatId,args?.job_id));
                case 'cancel':return jobs.cancel(chatId,args?.job_id,actor);
                case 'create':return jobs.create(chatId,args,actor);
                default:throw new Error('singing_action_invalid');
            }
        }})];
}
