"""Prepare a named, reference-melody cover and atomically register its verified cache.

No free melody generation, QQ sending, voice approval or model training.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re

from performance_singing_audition import generate, validate_paths
from singing_worker import ROOT, RUNTIME, watch_parent


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def register(song_id, title, source, out, *, singer='', aliases=(), excerpt='', root=ROOT):
    """Only register a generated SVC output; reject changed provenance and lost updates."""
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}', song_id) or not title.strip() or len(title)>120:
        raise ValueError('song_identity_invalid')
    source, out = Path(source).resolve(), Path(out).resolve()
    runtime = root / 'bot-home/singing-runtime'
    music = root / 'bot-home/media/onebot/music'
    if not source.is_relative_to((runtime/'song-reference').resolve()) or not out.is_relative_to(music.resolve()):
        raise ValueError('song_path_rejected')
    metadata_path=out.with_suffix('.json')
    meta=json.loads(metadata_path.read_text(encoding='utf8'))
    manifest=json.loads((runtime/'svc-model-manifest.json').read_text(encoding='utf8'))
    if (meta.get('backend')!='soulx_performance_svc' or meta.get('sourceSha256')!=digest(source)
            or meta.get('outputSha256')!=digest(out) or meta.get('modelRevision')!=manifest['revision']
            or meta.get('modelSha256')!=manifest['sha256']
            or meta.get('contentEncoderRevision')!=manifest['contentEncoder']['revision']
            or not meta.get('gates') or not all(g['passed'] for g in meta['gates'])
            or not 1<=meta['durationSeconds']<=25):
        raise ValueError('song_provenance_rejected')
    catalog_path=runtime/'songbook.json'
    # An exclusive lock covers read/modify/replace, so two preparations cannot
    # discard each other's new songs. A crash leaves a visible lock to inspect.
    lock=runtime/'songbook.lock'
    with lock.open('x',encoding='utf8') as handle:
        handle.write(str(os.getpid()))
    try:
        catalog=json.loads(catalog_path.read_text(encoding='utf8')) if catalog_path.exists() else {'version':1,'tracks':{}}
        previous=catalog['tracks'].get(song_id)
        pending=previous and previous.get('pendingReference') is True
        if catalog['version']!=1 or (previous and not pending):
            raise ValueError('song_already_registered')
        if not previous and len(catalog['tracks'])>=200:
            raise ValueError('song_catalog_full')
        if pending and (previous['sourceSha256']!=digest(source) or previous['sourcePath']!=source.relative_to(root).as_posix()
                or previous['title']!=title.strip()):
            raise ValueError('song_reference_changed')
        entry=dict(title=title.strip(),singer=singer,aliases=list(aliases),excerpt=excerpt,
            audioPath=out.relative_to(root).as_posix(),audioSha256=digest(out),
            metadataPath=metadata_path.relative_to(root).as_posix(),metadataSha256=digest(metadata_path),
            sourcePath=source.relative_to(root).as_posix(),experimental=True)
        def key(value):
            import unicodedata
            return unicodedata.normalize('NFKC',value.strip()).replace('《','').replace('》','').lower()
        names={key(x) for x in [song_id,entry['title'],*aliases]}
        if any(names.intersection(key(x) for x in [i,t['title'],*t.get('aliases',[])])
               and (not singer or not t.get('singer') or key(singer)==key(t['singer']))
               for i,t in catalog['tracks'].items() if i!=song_id):
            raise ValueError('song_alias_conflict')
        catalog['tracks'][song_id]=entry
        temp=catalog_path.with_suffix('.pending')
        temp.write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
        os.replace(temp,catalog_path)
        return entry
    finally:
        lock.unlink()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--song-id',required=True)
    parser.add_argument('--title',required=True)
    parser.add_argument('--singer',default='')
    parser.add_argument('--alias',action='append',default=[])
    parser.add_argument('--excerpt',default='')
    parser.add_argument('--source',required=True,help='Local real-song vocal reference under song-reference')
    parser.add_argument('--start',type=float,default=0)
    parser.add_argument('--end',type=float)
    parser.add_argument('--out',help='Optional unique cache WAV under the music directory')
    args=parser.parse_args()
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}',args.song_id):
        raise ValueError('song_identity_invalid')
    if not args.title.strip() or len(args.title)>120 or any(not a.strip() or len(a)>120 for a in args.alias):
        raise ValueError('song_identity_invalid')
    lock=RUNTIME/f'prepare-{args.song_id}.lock'
    with lock.open('x',encoding='utf8') as handle:
        handle.write(str(os.getpid()))
    try:
        watch_parent(os.getppid())
        print(json.dumps(dict(event='singing-stage',stage='prepare-song-started',pid=os.getpid())),flush=True)
        prepare(args)
    finally:
        lock.unlink()


def prepare(args):
    catalog=json.loads((RUNTIME/'songbook.json').read_text(encoding='utf8'))
    if args.song_id in catalog['tracks'] and catalog['tracks'][args.song_id].get('pendingReference') is not True:
        raise ValueError('song_already_registered')
    out=Path(args.out) if args.out else ROOT/'bot-home/media/onebot/music'/f'practice-{args.song_id}.wav'
    if out.exists() or out.with_suffix('.json').exists():
        raise ValueError('song_output_already_exists')
    source,out=validate_paths(args.source,out)
    report=generate(source,out,start=args.start,end=args.end,backend='soulx')
    if not report.get('outputSha256'):
        raise ValueError('song_pitch_gate_failed_not_registered')
    register(args.song_id,args.title,source,out,singer=args.singer,aliases=args.alias,excerpt=args.excerpt)
    print(json.dumps(dict(event='song-registered',song=args.song_id,title=args.title,
        durationSeconds=report['durationSeconds'],experimental=True),ensure_ascii=False))


if __name__=='__main__':
    main()
