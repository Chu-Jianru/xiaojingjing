"""Download only Vevo2 inference assets; keep upstream license and revision locally."""
from pathlib import Path
import os,json,time,urllib.request,urllib.parse,concurrent.futures
ROOT=next(p for p in Path(__file__).resolve().parents if (p/'bot-home').is_dir())
RUNTIME=ROOT/'bot-home/singing-runtime'
os.environ['HF_HOME']=str(RUNTIME/'hf-cache')
os.environ['HF_HUB_DISABLE_XET']='1'
os.environ['HF_HUB_DISABLE_SYMLINKS_WARNING']='1'
os.environ['HF_HUB_DOWNLOAD_TIMEOUT']='30'
# requests does not inherit the Windows system proxy the way urllib does.
for scheme in ['https','http']:
    proxy=urllib.request.getproxies().get(scheme)
    if proxy:
        parsed=urllib.parse.urlparse(proxy)
        if parsed.hostname in ('127.0.0.1','localhost','::1') and not parsed.username and not parsed.password:
            os.environ.setdefault(scheme.upper()+'_PROXY',proxy)
from huggingface_hub import HfApi,snapshot_download,get_hf_file_metadata,hf_hub_url
from range_download import download_ranges

if __name__=='__main__':
    info=HfApi(token=False).model_info('RMSnow/Vevo2')
    patterns=['README.md','acoustic_modeling/fm_emilia101k_singnet7k_repa/*',
        'contentstyle_modeling/posttrained/*.json','contentstyle_modeling/posttrained/*.txt',
        'contentstyle_modeling/posttrained/model.safetensors',
        'tokenizer/contentstyle_fvq16384_12.5hz/*','tokenizer/prosody_fvq512_6.25hz/*',
        'vocoder/config.json','vocoder/model.safetensors']
    for attempt in range(4):
        try:
            path=snapshot_download('RMSnow/Vevo2',revision=info.sha,allow_patterns=patterns,ignore_patterns=['*.safetensors','**/trainer_state.json'],local_dir=RUNTIME/'models/Vevo2',max_workers=3,token=False)
            break
        except Exception as error:
            print(f'Vevo2 transfer interrupted ({type(error).__name__}); resuming local chunks, attempt {attempt+1}/4',flush=True)
            if attempt==3:raise
            time.sleep(2)
    weights=['acoustic_modeling/fm_emilia101k_singnet7k_repa/model.safetensors',
        'contentstyle_modeling/posttrained/model.safetensors','vocoder/model.safetensors',
        'tokenizer/contentstyle_fvq16384_12.5hz/model.safetensors','tokenizer/prosody_fvq512_6.25hz/model.safetensors']
    def fetch_weight(relative):
        meta=get_hf_file_metadata(hf_hub_url('RMSnow/Vevo2',relative,revision=info.sha),token=False)
        if len(meta.etag)!=64:raise ValueError('model asset lacks SHA256')
        target=RUNTIME/'models/Vevo2'/relative
        cache=RUNTIME/'models/Vevo2/.cache/huggingface/download'/str(Path(relative).parent)
        prefix=next(cache.glob('*.'+meta.etag+'.incomplete'),None)
        print('Downloading/validating '+relative,flush=True)
        download_ranges(meta.location,meta.size,meta.etag,target,prefix=prefix,workers=4)
        return relative,meta.etag
    # Two assets, four ranges each: no unbounded transfer concurrency.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        hashes=dict(pool.map(fetch_weight,weights))
    (RUNTIME/'model-manifest.json').write_text(json.dumps({'repo':'RMSnow/Vevo2','revision':info.sha,
        'license':'cc-by-nc-nd-4.0','path':str(path),'sha256':hashes,'purpose':'personal noncommercial inference; checkpoint weights unchanged'},indent=2),encoding='utf8')
    print('Vevo2 inference weights downloaded and SHA256 verified; optimizer tensors excluded',flush=True)
