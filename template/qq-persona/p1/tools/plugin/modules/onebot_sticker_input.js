import {mkdir,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {publicFetch} from './public-fetch.js';
const MAX = 8*1024*1024;
export function imageExtension(bytes) {
    if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return '.png';
    if (bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return '.jpg';
    if (/^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii'))) return '.gif';
    if (bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP') return '.webp';
    throw new Error('sticker_image_required');
}
export async function prepareSticker(source, mediaDir, readLocal) {
    let bytes;
    if (/^https?:\/\//i.test(source)) {
        const response = await publicFetch(source,{signal:AbortSignal.timeout(12_000)});
        if (!response.ok) throw new Error('sticker_download_http_' + response.status);
        if (Number(response.headers.get('content-length'))>MAX) { await response.body?.cancel(); throw new Error('sticker_too_large'); }
        const reader=response.body?.getReader();if(!reader)throw new Error('sticker_empty');
        const chunks=[];let size=0;
        try { while(true){ const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX)throw new Error('sticker_too_large');chunks.push(Buffer.from(value)); } }
        finally { await reader.cancel().catch(()=>{}); }
        bytes=Buffer.concat(chunks);
    } else {
        const encoded=await readLocal(source,MAX);
        if (!String(encoded).startsWith('base64://')) throw new Error('sticker_local_fence_required');
        bytes=Buffer.from(encoded.slice(9),'base64');
    }
    if (!bytes.length || bytes.length>MAX) throw new Error('sticker_too_large');
    const ext=imageExtension(bytes),digest=createHash('sha256').update(bytes).digest('hex');
    const dir=join(mediaDir,'stickers/incoming');await mkdir(dir,{recursive:true});
    const path=join(dir,digest+ext),tmp=path+'.'+randomUUID()+'.tmp';
    await writeFile(tmp,bytes);await rename(tmp,path);
    return path;
}
