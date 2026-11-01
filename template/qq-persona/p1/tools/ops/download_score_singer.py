"""Download the reviewed score-conditioned SoulX SVS model, not its SVC/ASR extras."""
from pathlib import Path
import argparse
import os,json,urllib.request,urllib.parse,subprocess
ROOT=next(p for p in Path(__file__).resolve().parents if (p/'bot-home').is_dir())
RUNTIME=ROOT/'bot-home/singing-runtime'
os.environ.update(HF_HOME=str(RUNTIME/'hf-cache'),HF_HUB_DISABLE_XET='1',HF_HUB_DOWNLOAD_TIMEOUT='45')
for scheme in ['https','http']:
    proxy=urllib.request.getproxies().get(scheme)
    if proxy:
        url=urllib.parse.urlparse(proxy)
        if url.hostname in ('127.0.0.1','localhost','::1') and not url.username and not url.password:
            os.environ[scheme.upper()+'_PROXY']=proxy
from huggingface_hub import HfApi,get_hf_file_metadata,hf_hub_url,hf_hub_download
from range_download import download_ranges
if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--svc',action='store_true',help='Download SVC plus its small Whisper-base content encoder')
    args=parser.parse_args()
    repo='Soul-AILab/SoulX-Singer'
    prior=RUNTIME/'score-model-manifest.json'
    revision=json.loads(prior.read_text(encoding='utf8'))['revision'] if args.svc and prior.exists() else None
    info=HfApi(token=False).model_info(repo,revision=revision)
    dest=RUNTIME/'models/SoulX-Singer'
    for name in ['config.yaml','README.md']:
        hf_hub_download(repo,name,revision=info.sha,local_dir=dest,token=False)
    filename='model-svc.pt' if args.svc else 'model.pt'
    meta=get_hf_file_metadata(hf_hub_url(repo,filename,revision=info.sha),token=False)
    assert len(meta.etag)==64
    print('Downloading '+filename,flush=True)
    download_ranges(meta.location,meta.size,meta.etag,dest/filename,workers=8)
    code_revision=subprocess.check_output(['git','-C',str(RUNTIME/'SoulX-Singer'),'rev-parse','HEAD'],text=True).strip()
    record={'repo':repo,'revision':info.sha,'filename':filename,
        'codeRevision':code_revision,'sha256':meta.etag,'license':'Apache-2.0','backend':'soulx_svc' if args.svc else 'soulx_score','path':str(dest)}
    if args.svc:
        whisper_repo='openai/whisper-base'
        whisper_info=HfApi(token=False).model_info(whisper_repo)
        whisper_path=RUNTIME/'models/whisper-base-content'
        for name in ['config.json','preprocessor_config.json']:
            hf_hub_download(whisper_repo,name,revision=whisper_info.sha,local_dir=whisper_path,token=False)
        whisper_meta=get_hf_file_metadata(hf_hub_url(whisper_repo,'model.safetensors',revision=whisper_info.sha),token=False)
        assert len(whisper_meta.etag)==64
        download_ranges(whisper_meta.location,whisper_meta.size,whisper_meta.etag,whisper_path/'model.safetensors',workers=6)
        record['contentEncoder']=dict(repo=whisper_repo,revision=whisper_info.sha,path=str(whisper_path),
            filename='model.safetensors',sha256=whisper_meta.etag)
    (RUNTIME/('svc-model-manifest.json' if args.svc else 'score-model-manifest.json')).write_text(json.dumps(record,indent=2),encoding='utf8')
    print('Requested singing assets SHA256 verified',flush=True)
