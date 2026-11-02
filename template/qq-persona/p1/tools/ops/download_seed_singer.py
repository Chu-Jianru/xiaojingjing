"""Download pinned official assets for an isolated Seed-VC singing comparison."""
import hashlib
import json
import os
from pathlib import Path
import urllib.parse
import urllib.request

ROOT=next(p for p in Path(__file__).resolve().parents if (p/'bot-home').is_dir())
RUNTIME=ROOT/'bot-home/singing-runtime'
os.environ.update(HF_HOME=str(RUNTIME/'hf-cache'),HF_HUB_DISABLE_XET='1',HF_HUB_DOWNLOAD_TIMEOUT='45')
system_proxies=urllib.request.getproxies()
for scheme in ('http','https'):
    proxy=system_proxies.get(scheme)
    if proxy:
        url=urllib.parse.urlparse(proxy)
        if url.hostname in ('127.0.0.1','localhost','::1') and not url.username and not url.password:
            os.environ[scheme.upper()+'_PROXY']=proxy

from range_download import download_ranges


def public_json(url):
    with urllib.request.urlopen(url,timeout=30) as response:return json.load(response)


def main():
    specs={
        'singing':('Plachta/Seed-VC',[
            'DiT_seed_v2_uvit_whisper_base_f0_44k_bigvgan_pruned_ft_ema_v2.pth',
            'config_dit_mel_seed_uvit_whisper_base_f0_44k.yml']),
        'pitch':('lj1995/VoiceConversionWebUI',['rmvpe.pt']),
        'speaker':('funasr/campplus',['campplus_cn_common.bin']),
        'vocoder':('nvidia/bigvgan_v2_44khz_128band_512x',['config.json','bigvgan_generator.pt']),
        'content':('openai/whisper-small',['config.json','preprocessor_config.json','model.safetensors']),
    }
    manifest_path=RUNTIME/'seed-model-manifest.json'
    manifest=json.loads(manifest_path.read_text(encoding='utf8')) if manifest_path.exists() else dict(backend='seed_vc_singing',assets={})
    for key,(repo,names) in specs.items():
        previous=manifest['assets'].get(key)
        api=f'https://huggingface.co/api/models/{repo}'+('/revision/'+previous['revision'] if previous else '')+'?blobs=true'
        info=public_json(api)
        files={item['rfilename']:item for item in info['siblings']}
        dest=RUNTIME/'models/seed-vc'/key
        record=dict(repo=repo,revision=info['sha'],path=str(dest),sha256={})
        for name in names:
            entry=files[name];size=entry['size']
            url=f"https://huggingface.co/{repo}/resolve/{info['sha']}/{name}"
            dest.mkdir(parents=True,exist_ok=True)
            print(json.dumps(dict(event='seed-asset',asset=key,file=name,bytes=size)),flush=True)
            if entry.get('lfs'):
                expected=entry['lfs']['sha256']
                cached=dest/name
                if cached.exists() and cached.stat().st_size==size:
                    with cached.open('rb') as handle:
                        if hashlib.file_digest(handle,'sha256').hexdigest()==expected:
                            record['sha256'][name]=expected
                            continue
                request=urllib.request.Request(url,headers={'Range':'bytes=0-0'})
                with urllib.request.urlopen(request,timeout=40) as response:location=response.geturl()
                download_ranges(location,size,expected,dest/name,workers=6)
            else:
                with urllib.request.urlopen(url,timeout=30) as response:data=response.read(2*1024*1024)
                if len(data)!=size:raise ValueError('config_size_mismatch')
                git_sha=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
                if git_sha!=entry['blobId']:raise ValueError('config_blob_hash_mismatch')
                (dest/name).write_bytes(data)
            with (dest/name).open('rb') as handle:
                record['sha256'][name]=hashlib.file_digest(handle,'sha256').hexdigest()
        manifest['assets'][key]=record
        manifest_path.write_text(json.dumps(manifest,indent=2),encoding='utf8')
    print('Seed singing assets downloaded and SHA256 verified',flush=True)


if __name__=='__main__':main()
