"""Validate a manually transcribed score; no model or network on import."""
import json
from pathlib import Path

ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'bot-home').is_dir())
SCORE = ROOT / 'qq-persona/p1/voice/scores/wo-kan-guo-excerpt.json'
SCALE = {1: 0, 2: 2, 3: 4, 4: 5, 5: 7, 6: 9, 7: 11}


def load_score(path=SCORE):
    score = json.loads(Path(path).read_text(encoding='utf8'))
    if score['meter'] != [4, 4] or not 40 <= score['bpm'] <= 150:
        raise ValueError('score_timing_invalid')
    lyrics, previous, events, beat = '', None, [], 0.0
    for index, bar in enumerate(score['bars']):
        expected = score['pickupBeats'] if index == 0 else 4
        if abs(sum(n[2] for n in bar) - expected) > 1e-8:
            raise ValueError(f'score_bar_{index}_duration')
        for syllable, degree, duration in bar:
            if duration < .25 or duration > 4 or duration * 4 != int(duration * 4):
                raise ValueError('score_note_duration')
            if syllable == '_':
                if degree != 0:
                    raise ValueError('score_rest_pitch')
                char, midi, kind = None, 0, 1
                previous = None
            else:
                if syllable == '~':
                    if previous is None:
                        raise ValueError('score_slur_without_word')
                    char, kind = previous, 3
                else:
                    if len(syllable) != 1:
                        raise ValueError('score_single_syllable_required')
                    lyrics += syllable
                    char, kind, previous = syllable, 2, syllable
                if abs(degree) not in SCALE:
                    raise ValueError('score_degree_invalid')
                midi = score['tonicMidi'] + SCALE[abs(degree)] - (12 if degree < 0 else 0)
            events.append(dict(char=char, degree=degree, midi=midi, beats=duration,
                               startBeat=beat, noteType=kind, bar=index))
            beat += duration
    if lyrics != ''.join(score['lines']):
        raise ValueError('score_lyrics_mismatch')
    return score, events


def phrase_events(score, events):
    """Keep every note and rest, cutting only before the next lyric line."""
    starts, offset = [], 0
    syllables = [i for i, event in enumerate(events) if event['noteType'] == 2]
    for line in score['lines']:
        starts.append(syllables[offset])
        offset += len(line)
    return [events[a:b] for a, b in zip(starts, starts[1:] + [len(events)])]


def metadata(events, bpm, phone_for):
    return {
        'phoneme': ' '.join((e.get('phoneme') or phone_for(e['char'])) if e['char'] else '<SP>' for e in events),
        'duration': ' '.join(f"{e['beats'] * 60 / bpm:.8f}" for e in events),
        'note_pitch': ' '.join(str(e['midi']) for e in events),
        'note_type': ' '.join(str(e['noteType']) for e in events),
    }
