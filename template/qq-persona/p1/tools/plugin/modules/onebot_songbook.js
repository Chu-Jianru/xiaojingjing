/** Reuse a pinned practice performance without claiming a new synthesis. */
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join,resolve,relative,isAbsolute,sep} from 'node:path';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

let ROOT=dirname(fileURLToPath(import.meta.url));
while(!existsSync(join(ROOT,'bot-home')) && dirname(ROOT)!==ROOT)ROOT=dirname(ROOT);
export const DEFAULT_PRACTICE_SONG='wo-kan-guo';
export const normalizeSong=value=>String(value??'').trim().normalize('NFKC').replace(/[《》]/g,'').toLowerCase();
export const normalizeArtist=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
function artistMembers(value,aliases){
    return String(value??'').normalize('NFKC').split(/\s*(?:[、/&，,;；×]|\bfeat\.?\s|\bft\.?\s|\bfeaturing\s)\s*/i).map(part=>{
        const key=normalizeArtist(part),group=aliases.find(group=>group.some(alias=>normalizeArtist(alias)===key));
        return group?normalizeArtist(group[0]):key;
    }).filter(Boolean);
}
async function catalogAt(root){
    const catalog=JSON.parse(await readFile(join(root,'bot-home/singing-runtime/songbook.json'),'utf8'));
    if(catalog.version!==1 || !catalog.tracks || Object.keys(catalog.tracks).length>200)throw Error('practice_song_catalog_invalid');
    return catalog;
}
export async function listPracticeSongs({root=ROOT}={}){
    const catalog=await catalogAt(root);
    return{defaultSong:DEFAULT_PRACTICE_SONG,tracks:Object.entries(catalog.tracks).map(([song,track])=>
        ({song,title:track.title,singer:track.singer??null,excerpt:track.excerpt??null,cached:track.pendingReference!==true,experimental:true}))};
}
const hash=data=>createHash('sha256').update(data).digest('hex');
function within(base,path){const rel=relative(base,path);return rel!=='' && rel!=='..' && !rel.startsWith('..'+sep) && !isAbsolute(rel);}
async function localFile(root,path,base){
    if(typeof path!=='string' || isAbsolute(path))throw Error('practice_song_path_invalid');
    const actual=await realpath(resolve(root,path));
    if(!within(await realpath(base),actual))throw Error('practice_song_path_invalid');
    return actual;
}
function duration(bytes){
    if(bytes.length<44 || bytes.toString('ascii',0,4)!=='RIFF' || bytes.toString('ascii',8,12)!=='WAVE')throw Error('practice_song_audio_invalid');
    let format=false,seconds=0;
    for(let at=12;at+8<=bytes.length;){const kind=bytes.toString('ascii',at,at+4),size=bytes.readUInt32LE(at+4);at+=8;
        if(at+size>bytes.length)throw Error('practice_song_audio_invalid');
        if(kind==='fmt ')format=size>=16 && bytes.readUInt16LE(at)===1 && bytes.readUInt16LE(at+2)===1 && bytes.readUInt32LE(at+4)===24000 && bytes.readUInt16LE(at+14)===16;
        if(kind==='data')seconds=size/48000;at+=size+(size%2);
    }
    if(!format || seconds<1 || seconds>45)throw Error('practice_song_audio_invalid');
    return seconds;
}
export async function readPracticeSong(song,identity,{root=ROOT,allowPending=false,singer=''}={}){
    const runtime=join(root,'bot-home/singing-runtime'),music=join(root,'bot-home/media/onebot/music');
    const catalog=await catalogAt(root),query=normalizeSong(song);
    if(singer && !normalizeArtist(singer))throw Error('请给出有效歌手');
    let aliases=[];
    if(singer){try{aliases=JSON.parse(await readFile(join(runtime,'song-preferences.json'),'utf8')).artistAliases??[];}
        catch(error){if(error.code!=='ENOENT')throw error;}}
    const wanted=artistMembers(singer,aliases);
    const matches=Object.entries(catalog.tracks).filter(([id,t])=>[id,t.title,...(t.aliases??[])].some(x=>normalizeSong(x)===query)
        && (!singer || (wanted.length>0 && wanted.every(key=>artistMembers(t.singer,aliases).includes(key)))));
    if(matches.length>1)throw Error('这首歌有不同版本，先确认歌手或曲库编号');
    if(!matches.length)throw Object.assign(Error('这首歌还没有对应练习片段；需要检索原曲，不改唱其他歌曲'),{code:'practice_song_unknown'});
    const [id,track]=matches[0];
    if(typeof track.title!=='string' || !track.title.trim() || track.title.length>120)throw Error('practice_song_catalog_invalid');
    if(track.pendingReference===true){
        if(!allowPending || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id))throw Error('这首歌正在等首次转换，不能直接作为练习录音播放');
        const sourcePath=await localFile(root,track.sourcePath,join(runtime,'song-reference'));
        const manifest=JSON.parse(await readFile(join(runtime,'svc-model-manifest.json'),'utf8'));
        if(hash(await readFile(sourcePath))!==track.sourceSha256 || !(track.durationSeconds>=1 && track.durationSeconds<=25)
            || (identity.modelRevision && identity.modelRevision!==manifest.revision)
            || identity.performanceSha256 || (identity.sourceSha256 && identity.sourceSha256!==track.sourceSha256))throw Error('practice_song_identity_changed');
        return{song:id,title:track.title,pending:true,sourcePath,sourceSha256:track.sourceSha256,
            singer:track.singer??'',aliases:track.aliases??[],excerpt:track.excerpt??'',
            durationSeconds:track.durationSeconds,modelRevision:manifest.revision};
    }
    const [audioPath,metadataPath,sourcePath]=await Promise.all([
        localFile(root,track.audioPath,music),localFile(root,track.metadataPath,music),
        localFile(root,track.sourcePath,join(runtime,'song-reference'))]);
    const [audio,metadataBytes,source,manifestBytes]=await Promise.all([
        readFile(audioPath),readFile(metadataPath),readFile(sourcePath),readFile(join(runtime,'svc-model-manifest.json'),'utf8')]);
    const metadata=JSON.parse(metadataBytes),manifest=JSON.parse(manifestBytes);
    const audioSha256=hash(audio);
    if(audioSha256!==track.audioSha256 || hash(metadataBytes)!==track.metadataSha256 || metadata.outputSha256!==audioSha256
        || metadata.sourceSha256!==hash(source) || metadata.backend!=='soulx_performance_svc'
        || metadata.modelRevision!==manifest.revision || metadata.modelSha256!==manifest.sha256
        || metadata.contentEncoderRevision!==manifest.contentEncoder?.revision
        || metadata.voiceSha256!==identity.voiceSha256 || metadata.speechTimbreSha256!==identity.speechTimbreSha256
        || (identity.modelRevision && identity.modelRevision!==metadata.modelRevision)
        || (identity.sourceSha256 && identity.sourceSha256!==metadata.sourceSha256)
        || (identity.performanceSha256 && identity.performanceSha256!==audioSha256))throw Error('practice_song_identity_changed');
    const seconds=duration(audio);
    if(Math.abs(seconds-metadata.durationSeconds)>.02)throw Error('practice_song_duration_invalid');
    return{audio,song:id,title:track.title,sourceSha256:metadata.sourceSha256,durationSeconds:seconds,modelRevision:metadata.modelRevision,performanceSha256:audioSha256};
}
export async function runPracticeSong(request,{signal,root=ROOT}={}){
    if(signal?.aborted)throw Error('singing_cancelled');
    const performance=await readPracticeSong(request.song,request,{root});
    const out=resolve(request.out),music=await realpath(join(root,'bot-home/media/onebot/music'));
    if(!within(music,out) || !within(music,join(await realpath(dirname(out)),'output.wav')) || !out.endsWith('.wav'))throw Error('practice_song_output_rejected');
    if(signal?.aborted)throw Error('singing_cancelled');
    await writeFile(out,performance.audio,{flag:'wx'});
    return{event:'singing-result',path:out,backend:'rehearsed_svc',acappella:true,song:performance.song,title:performance.title,
        durationSeconds:performance.durationSeconds,modelRevision:performance.modelRevision,performanceSha256:performance.performanceSha256,
        voiceSha256:request.voiceSha256,speechTimbreSha256:request.speechTimbreSha256,sourceSha256:performance.sourceSha256,reused:true,experimental:true};
}
