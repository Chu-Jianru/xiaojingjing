"""Resolve a song title to available audio, then create a verified SoulX cover.

Only public provider responses are used. No login cookies, paywall bypass,
training, original-song fallback, QQ sending or voice-approval changes.
"""
import argparse
import hashlib
import html
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid

from singing_worker import ROOT, RUNTIME, watch_parent, reference_profile, spoken_timbre_profile


class SongError(ValueError):
    def __init__(self, reason, candidates=()):
        super().__init__(reason)
        self.reason = reason
        self.candidates = list(candidates)[:4]


def norm(value):
    value = unicodedata.normalize('NFKC', str(value)).lower()
    if os.name == 'nt':
        # LCMAP_SIMPLIFIED_CHINESE keeps exact title matching across scripts.
        import ctypes
        buf = ctypes.create_unicode_buffer(len(value) * 2 + 2)
        if ctypes.windll.kernel32.LCMapStringW(0x804, 0x02000000, value, len(value), buf, len(buf)):
            value = buf.value
    return re.sub(r'[^\w\u3400-\u9fff]', '', value)


def public_url(url):
    parsed = urllib.parse.urlsplit(url)
    host = (parsed.hostname or '').lower()
    allowed = ('music.163.com', 'music.126.net', 'mzstatic.com', 'itunes.apple.com', 'music.apple.com')
    if (parsed.scheme not in ('https', 'http') or parsed.username or parsed.password or parsed.port not in (None, 80, 443)
            or not any(host == base or host.endswith('.' + base) for base in allowed)):
        raise SongError('source_url_rejected')
    return urllib.parse.urlunsplit(('https', parsed.netloc, parsed.path, parsed.query, ''))


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return super().redirect_request(req, fp, code, msg, headers, public_url(newurl))


def fetch(url, limit=3 * 1024 ** 2):
    url = public_url(url)
    request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://music.163.com/'})
    opener = urllib.request.build_opener(SafeRedirect())
    with opener.open(request, timeout=15) as response:
        data = response.read(limit + 1)
        if len(data) > limit:
            raise SongError('source_too_large')
        return data


def get_json(url):
    return json.loads(fetch(url))


def title_parts(title):
    # Keep explicit version labels. A studio request must not choose a DJ,
    # instrumental, sped-up, cover or live version solely because it ranks first.
    return norm(title)


def artist_key(singer):
    key = norm(singer).replace('_', '')
    path = RUNTIME / 'song-preferences.json'
    if path.exists():
        preferences = json.loads(path.read_text(encoding='utf8'))
        for group in preferences.get('artistAliases', []):
            if key in [norm(a).replace('_', '') for a in group]:
                return norm(group[0]).replace('_', '')
    return key


def artist_members(singer):
    # Only explicit credits delimit members; a longer name is not an alias.
    return {artist_key(part) for part in re.split(r'\s*(?:[、/&，,;；×]|\bfeat\.?\s|\bft\.?\s|\bfeaturing\s)\s*', unicodedata.normalize('NFKC', singer), flags=re.I) if artist_key(part)}


def artist_matches(actual, requested):
    wanted = artist_members(requested)
    return bool(wanted) and wanted.issubset(artist_members(actual))


def select_matches(rows, title, singer=''):
    if singer and not artist_members(singer):
        raise SongError('invalid_singer')
    exact = [r for r in rows if artist_key(r['singer']) and title_parts(r['title']) == title_parts(title)
             and (not singer or artist_matches(r['singer'], singer))]
    if not exact and singer:
        # An explicitly requested singer can have only a live release of this
        # title. Never broaden to a different artist, DJ or instrumental version.
        exact = [r for r in rows if artist_key(r['singer']) and norm(re.sub(r'\s*[（(](?:live|现场版?|現場版?)[)）]\s*$', '', r['title'], flags=re.I)) == norm(title)
                 and artist_matches(r['singer'], singer)]
    if not exact:return []
    artists = {artist_key(r['singer']) for r in exact}
    if not singer and len(artists) > 1:
        raise SongError('ambiguous', [dict(song=r['title'], singer=r['singer']) for r in exact])
    return exact


def search(title, singer='', *, runtime=RUNTIME, query=get_json):
    cache = runtime / 'song-search'
    cache.mkdir(exist_ok=True)
    key = hashlib.sha256(json.dumps([title, singer], ensure_ascii=False).encode()).hexdigest()
    path = cache / (key + '.json')
    if path.exists() and time.time() - path.stat().st_mtime < 21600:
        rows = json.loads(path.read_text(encoding='utf8'))
        return select_matches(rows, title, singer)
    rows = []
    term = title + (' ' + singer if singer else '')
    try:
        data = query('https://music.163.com/api/search/get?' + urllib.parse.urlencode(dict(s=term, type=1, limit=20)))
        for r in data.get('result', {}).get('songs', []):
            rows.append(dict(provider='netease', id=str(int(r['id'])), title=r['name'],
                             singer='、'.join(a['name'] for a in r.get('artists', []))))
    except (OSError, ValueError, KeyError):
        pass
    # Search Apple only if the primary catalogue cannot resolve a unique version.
    try:
        chosen = select_matches(rows, title, singer)
    except SongError:
        raise
    if not chosen:
        for country in ('tw', 'us'):
            try:
                data = query('https://itunes.apple.com/search?' + urllib.parse.urlencode(
                    dict(term=term, country=country, entity='song', limit=20)))
                for r in data.get('results', []):
                    if r.get('kind') == 'song':
                        rows.append(dict(provider='itunes', id=str(int(r['trackId'])), title=r['trackName'],
                                         singer=r['artistName'], preview=r.get('previewUrl'), page=r.get('trackViewUrl')))
                chosen = select_matches(rows, title, singer)
                if chosen:
                    break
            except (OSError, ValueError, KeyError) as error:
                if isinstance(error, SongError) and error.reason == 'ambiguous':
                    raise
    temp = path.with_suffix('.' + uuid.uuid4().hex + '.tmp')
    temp.write_text(json.dumps(rows, ensure_ascii=False), encoding='utf8')
    os.replace(temp, path)
    return select_matches(rows, title, singer)


def audio_sources(track, *, query=get_json, read=fetch):
    if track['provider'] == 'netease':
        try:
            data = query('https://music.163.com/api/song/enhance/player/url?' + urllib.parse.urlencode(
                dict(ids=json.dumps([int(track['id'])]), br=128000)))
            for row in data.get('data', []):
                if row.get('url') and not row.get('freeTrialInfo'):
                    yield public_url(row['url']), 'available-provider-audio'
        except (OSError, ValueError, KeyError):
            pass
        # The public title catalogue can resolve a song whose audio is unavailable.
        # A matching public preview is a short excerpt, never a full-song claim.
        for region in ('tw', 'us'):
            try:
                data = query('https://itunes.apple.com/search?' + urllib.parse.urlencode(dict(
                    term=track['title'] + ' ' + track['singer'], country=region, entity='song', limit=20)))
                matches = select_matches([dict(provider='itunes', id=str(r['trackId']), title=r['trackName'],
                    singer=r['artistName'], preview=r.get('previewUrl'), page=r.get('trackViewUrl'))
                    for r in data.get('results', []) if r.get('kind') == 'song'], track['title'], track['singer'])
                if matches:
                    yield from audio_sources(matches[0], query=query, read=read)
                    return
            except (OSError, ValueError, KeyError):
                pass
    else:
        # Prefer the explicitly published longer preview when available, without
        # inventing a URL or fetching a protected full track.
        if track.get('page'):
            try:
                page = html.unescape(read(track['page'], 8 * 1024 ** 2).decode('utf8')).replace('\\/', '/')
                links = re.findall(r'https://[^\s"<>\\]+\.ep\.m4a(?:\?[^\s"<>\\]*)?', page)
                if links:
                    yield public_url(links[0]), 'public-preview'
            except (OSError, ValueError):
                pass
        if track.get('preview'):
            yield public_url(track['preview']), 'public-preview'


def transcript_ok(text):
    chars = re.findall(r'[\w\u3400-\u9fff]', text)
    return len(chars) >= 8 and len(set(chars)) >= 5


def transcribe(path):
    # Reuse the existing local ASR worker. No extra chat-model inference.
    token = (ROOT / 'bot-home/media/onebot/calls/control.token').read_text().strip()
    req = urllib.request.Request('http://127.0.0.1:8401/transcribe',
        data=json.dumps(dict(path=str(path))).encode(), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=60) as response:
        result = json.load(response)
    return result.get('text', result.get('data', {}).get('text', ''))


def recover_dead_lock(path):
    """Only reclaim a previous worker's lock after proving its PID has exited."""
    if not path.exists():
        return
    text = path.read_text(encoding='utf8').strip()
    if not text.isdecimal() or int(text) <= 0:
        return
    pid = int(text)
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        api = ctypes.WinDLL('kernel32', use_last_error=True)
        api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        api.OpenProcess.restype = wintypes.HANDLE
        api.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        api.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = api.OpenProcess(0x100000, False, pid)
        if handle:
            dead = api.WaitForSingleObject(handle, 0) == 0
            api.CloseHandle(handle)
        else:
            dead = ctypes.get_last_error() == 87  # ERROR_INVALID_PARAMETER: PID absent
    else:
        try:
            os.kill(pid, 0)
            dead = False
        except ProcessLookupError:
            dead = True
        except PermissionError:
            dead = False
    if dead and path.read_text(encoding='utf8').strip() == text:
        path.unlink()


def prepare_reference(track, *, read=fetch):
    import shutil
    from separate_singing_reference import run as separate
    flags = {'creationflags': 0x08000000} if os.name == 'nt' else {}
    folder = RUNTIME / 'song-reference' / (track['provider'] + '-' + track['id'])
    folder.mkdir(parents=True, exist_ok=True)
    ready = folder / 'reference.json'
    if ready.exists():
        entry = json.loads(ready.read_text(encoding='utf8'))
        path = folder / entry['file']
        if path.resolve().parent == folder.resolve() and hashlib.sha256(path.read_bytes()).hexdigest() == entry['sha256']:
            return path
        raise SongError('source_changed')
    for url, kind in audio_sources(track):
        try:
            data = read(url, 25 * 1024 ** 2)
            if data[:100].lstrip().lower().startswith((b'<', b'{')):
                continue
            source = folder / ('source-' + hashlib.sha256(data).hexdigest()[:12] + '.m4a')
            if not source.exists():
                source.write_bytes(data)
            info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_format', '-of', 'json', str(source)], timeout=20, **flags))
            duration = float(info['format']['duration'])
            if not math.isfinite(duration) or duration < 8:
                continue
            # Avoid spending the whole conversion on an instrumental opening.
            windows = sorted(set([0, min(max(0, duration / 2 - 10), max(0, duration - 20)), max(0, duration - 20)]))
            for start in windows[:3]:
                part = folder / ('clip-' + source.stem + '-' + str(round(start * 1000)))
                part.mkdir(exist_ok=True)
                clip = part / 'source.wav'
                seconds = min(20, duration - start - .05)
                if not clip.exists():
                    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-i', str(source), '-ss', str(start), '-t', str(seconds),
                        '-ar', '44100', '-ac', '2', str(clip)], check=True, timeout=25, **flags)
                vocals = part / 'vocals.wav'
                if not vocals.exists():
                    separate(clip, 0, seconds)
                diag = ROOT / 'bot-home/media/onebot/music/.diagnostics/auto-reference'
                diag.mkdir(parents=True, exist_ok=True)
                analysis = diag / (uuid.uuid4().hex + '.wav')
                try:
                    shutil.copyfile(vocals, analysis)
                    words = transcribe(analysis)
                finally:
                    analysis.unlink(missing_ok=True)
                if not transcript_ok(words):
                    continue
                target = folder / ('verified-' + hashlib.sha256(vocals.read_bytes()).hexdigest()[:12] + '.wav')
                if not target.exists():
                    shutil.copyfile(vocals, target)
                record = dict(file=target.name, sha256=hashlib.sha256(target.read_bytes()).hexdigest(),
                    provider=track['provider'], trackId=track['id'], title=track['title'], singer=track['singer'],
                    sourceUrl=url, sourceSha256=hashlib.sha256(data).hexdigest(), sourceKind=kind,
                    startSeconds=start, durationSeconds=seconds, transcript=words, subjectiveQualityApproved=False,
                    separationMetadata=(vocals.with_suffix('.separation.json')).relative_to(folder).as_posix(),
                    separationMetadataSha256=hashlib.sha256(vocals.with_suffix('.separation.json').read_bytes()).hexdigest())
                ready.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf8')
                return target
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            continue
    raise SongError('source_unavailable')


def check_identity(args):
    path, voice = reference_profile()
    _, speech = spoken_timbre_profile(voice, path)
    manifest = json.loads((RUNTIME / 'svc-model-manifest.json').read_text(encoding='utf8'))
    if voice != args.voice_sha256 or speech != args.speech_sha256 or manifest['revision'] != args.model_revision:
        raise SongError('voice_changed')


def main():
    sys.stdout.reconfigure(encoding='utf8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--song', required=True)
    parser.add_argument('--singer', default='')
    parser.add_argument('--out', required=True)
    parser.add_argument('--voice-sha256', required=True)
    parser.add_argument('--speech-sha256', required=True)
    parser.add_argument('--model-revision', required=True)
    args = parser.parse_args()
    watch_parent(int(os.environ.get('WHALE_SINGING_PARENT_PID', os.getppid())))
    lock = RUNTIME / 'auto-song.lock'
    recover_dead_lock(lock)
    with lock.open('x', encoding='utf8') as handle:
        handle.write(str(os.getpid()))
    print(json.dumps(dict(event='singing-stage', stage='auto-song-started', pid=os.getpid())), flush=True)
    try:
        check_identity(args)
        from prepare_singing_song import register
        from performance_singing_audition import generate, validate_paths
        catalog = json.loads((RUNTIME / 'songbook.json').read_text(encoding='utf8'))
        chosen = catalog['tracks'].get(args.song)
        if chosen and chosen.get('pendingReference'):
            song_id, title, singer = args.song, chosen['title'], chosen.get('singer', '')
            source = ROOT / chosen['sourcePath']
            if hashlib.sha256(source.read_bytes()).hexdigest() != chosen['sourceSha256']:
                raise SongError('source_changed')
            aliases = chosen.get('aliases', [])
        else:
            rows = search(args.song, args.singer)
            if not rows:
                raise SongError('not_found')
            track = rows[0]
            song_id = track['provider'] + '-' + track['id']
            title, singer = track['title'], track['singer']
            if song_id in catalog['tracks'] and not catalog['tracks'][song_id].get('pendingReference'):
                print(json.dumps(dict(event='auto-song-result', song=song_id, title=title, singer=singer, reused=True)), flush=True)
                return
            source = prepare_reference(track)
            aliases = [args.song] if args.song != title else []
        source, out = validate_paths(source, args.out)
        if out.exists() or out.with_suffix('.json').exists():
            raise SongError('output_exists')
        print(json.dumps(dict(event='singing-stage', stage='converting-song', song=song_id, title=title, singer=singer)), flush=True)
        report = generate(source, out, backend='soulx')
        check_identity(args)
        if not report.get('outputSha256'):
            raise SongError('pitch_failed')
        recover_dead_lock(RUNTIME / 'songbook.lock')
        register(song_id, title, source, out, singer=singer, aliases=aliases, excerpt='约20秒自动点唱片段')
        print(json.dumps(dict(event='auto-song-result', song=song_id, title=title, singer=singer)), flush=True)
    except Exception as error:
        print(json.dumps(dict(event='auto-song-error', reason=error.reason if isinstance(error, SongError) else 'preparation_failed',
                             candidates=getattr(error, 'candidates', [])), ensure_ascii=False), flush=True)
        raise SystemExit(1)
    finally:
        lock.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
