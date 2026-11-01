"""Bounded public-asset range downloader with resumable parts and final SHA256."""
from pathlib import Path
import hashlib,urllib.request,concurrent.futures,time

def checksum(path):
    with Path(path).open('rb') as src:return hashlib.file_digest(src,'sha256').hexdigest()

def download_ranges(url,size,digest,dest,prefix=None,workers=6):
    dest=Path(dest);dest.parent.mkdir(parents=True,exist_ok=True)
    if dest.is_file() and dest.stat().st_size==size and checksum(dest)==digest:return
    parts=dest.parent/(dest.name+'.parts');parts.mkdir(exist_ok=True)
    block=16*1024*1024;count=(size+block-1)//block
    reused=set()
    def fetch(index):
        first=index*block;last=min(first+block,size)-1;part=parts/f'{index:04}.part'
        if part.exists() and part.stat().st_size==last-first+1:
            reused.add(index);return
        if prefix and prefix.is_file() and last<prefix.stat().st_size:
            with prefix.open('rb') as src:src.seek(first);part.write_bytes(src.read(last-first+1))
            reused.add(index);return
        for attempt in range(4):
            try:
                req=urllib.request.Request(url,headers={'Range':f'bytes={first}-{last}'})
                with urllib.request.urlopen(req,timeout=45) as response:
                    if response.status!=206 or response.headers.get('Content-Range')!=f'bytes {first}-{last}/{size}':raise ValueError('range not honored')
                    with part.open('wb') as out:
                        while data:=response.read(1024*1024):out.write(data)
                if part.stat().st_size!=last-first+1:raise ValueError('range incomplete')
                return
            except Exception:
                if attempt==3:raise
                time.sleep(2)
    pending=list(range(count))
    for pass_number in range(4):
        failed=[]
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            futures={pool.submit(fetch,index):index for index in pending}
            for done,future in enumerate(concurrent.futures.as_completed(futures),1):
                try:future.result()
                except Exception:failed.append(futures[future])
                if done%20==0:print(f'Asset chunks checked {done}/{len(pending)}; interrupted {len(failed)}',flush=True)
        if not failed:break
        pending=failed
    if failed:raise RuntimeError('asset download interrupted; rerun to resume')
    assembled=dest.with_suffix('.assembled')
    def assemble():
        with assembled.open('wb') as out:
            for index in range(count):
                with (parts/f'{index:04}.part').open('rb') as src:
                    while data:=src.read(1024*1024):out.write(data)
        return checksum(assembled)
    if assemble()!=digest:
        # Never trust an old library's unverified partial prefix over the hash.
        if not reused:raise ValueError('asset SHA256 mismatch')
        print('Old partial failed SHA256; re-fetching unverified chunks',flush=True)
        prefix=None
        for index in reused:(parts/f'{index:04}.part').replace(parts/f'{index:04}.unverified')
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:list(pool.map(fetch,reused))
        if assemble()!=digest:raise ValueError('asset SHA256 mismatch')
    assembled.replace(dest)
    print('Asset SHA256 verified',flush=True)
