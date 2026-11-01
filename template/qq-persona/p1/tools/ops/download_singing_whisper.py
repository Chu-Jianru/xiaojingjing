"""Download the upstream Vevo2 Whisper encoder into the isolated runtime."""
from pathlib import Path
import urllib.request, hashlib, time, concurrent.futures
ROOT=next(p for p in Path(__file__).resolve().parents if (p/'bot-home').is_dir())
DIGEST='345ae4da62f9b3d59415adc60127b97c714f32e89e936602e85993674d08dcb1'
URL=f'https://openaipublic.azureedge.net/main/whisper/models/{DIGEST}/medium.pt'
if __name__=='__main__':
    dest=ROOT/'bot-home/singing-runtime/models/whisper/medium.pt'
    dest.parent.mkdir(parents=True,exist_ok=True)
    if dest.is_file() and hashlib.file_digest(dest.open('rb'),'sha256').hexdigest()==DIGEST:
        print('Whisper encoder already verified');raise SystemExit(0)
    partial=dest.with_suffix('.download');parts=dest.parent/'medium-parts';parts.mkdir(exist_ok=True)
    size=1528008539;block=16*1024*1024
    def fetch(index):
        first=index*block;last=min(first+block,size)-1;part=parts/f'{index:03}.part'
        if part.exists() and part.stat().st_size==last-first+1:return
        # Reuse a verified-position prefix from a previous interrupted transfer.
        if partial.exists() and partial.stat().st_size>last:
            with partial.open('rb') as src:src.seek(first);data=src.read(last-first+1)
            part.write_bytes(data);return
        for attempt in range(4):
            try:
                request=urllib.request.Request(URL+f'?chunk={index}',headers={'Range':f'bytes={first}-{last}'})
                with urllib.request.urlopen(request,timeout=30) as response:
                    if response.status!=206 or response.headers.get('Content-Range')!=f'bytes {first}-{last}/{size}':
                        raise ValueError('CDN range not honored')
                    with part.open('wb') as out:
                        while data:=response.read(1024*1024):out.write(data)
                if part.stat().st_size!=last-first+1:raise ValueError('incomplete range')
                return
            except Exception:
                if attempt==3:raise
                time.sleep(2)
    count=(size+block-1)//block
    pending=list(range(count))
    for round_number in range(4):
        failed=[]
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            futures={pool.submit(fetch,index):index for index in pending}
            for done,future in enumerate(concurrent.futures.as_completed(futures),1):
                try:future.result()
                except Exception:failed.append(futures[future])
                if done%10==0:print(f'Whisper encoder chunks checked {done}/{len(pending)}, interrupted {len(failed)}',flush=True)
        if not failed:break
        pending=failed
        print(f'Resuming {len(pending)} interrupted chunks, pass {round_number+2}',flush=True)
    if failed:raise RuntimeError('Whisper encoder download incomplete; run again to resume')
    assembled=dest.with_suffix('.assembled')
    with assembled.open('wb') as out:
        for index in range(count):
            with (parts/f'{index:03}.part').open('rb') as src:
                while data:=src.read(1024*1024):out.write(data)
    with assembled.open('rb') as saved:digest=hashlib.file_digest(saved,'sha256').hexdigest()
    if digest!=DIGEST:raise ValueError('Whisper encoder checksum mismatch')
    assembled.replace(dest);print('Whisper medium encoder downloaded and verified',flush=True)
