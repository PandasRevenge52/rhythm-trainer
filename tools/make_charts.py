"""High-quality charts for Rhythm Trainer.

For each song: Demucs splits it into stems, LarsNet splits the drum stem into kick / snare / toms /
hi-hat / cymbals (so each drum's hits come from its own clean track), Basic Pitch transcribes the
vocal stem and the guitar/instrument stem into notes, and librosa tracks the beats. The result is written to charts/<song>.js, which the trainer and the Arcade pick up
automatically when you load a song with the same file name.

Usage:  tools/make-charts ~/Music            (a folder, searched recursively)
        tools/make-charts song.mp3 other.mp3
        tools/make-charts --force ~/Music    (redo songs that already have a chart)
"""
import argparse, json, os, re, sys, tempfile, time, unicodedata, warnings
warnings.filterwarnings('ignore')
os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '3')
import logging; logging.disable(logging.WARNING)

import numpy as np
import librosa, soundfile as sf, torch
from demucs.pretrained import get_model
from demucs.apply import apply_model

VERSION = 2
AUDIO = ('.mp3', '.m4a', '.ogg', '.opus', '.flac', '.wav', '.aac')
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), 'charts')


def slug(name):
    """Must match chartSlug() in js/drums.js."""
    s = unicodedata.normalize('NFKD', name)
    s = ''.join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')[:80] or 'song'


def song_name(path):
    # same as the site: the file name without its extension
    return re.sub(r'\.[a-z0-9]{2,4}$', '', os.path.basename(path), flags=re.I)


def separate(model, mix, device):
    wav = torch.tensor(mix, dtype=torch.float32)
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    x = ((wav - mean) / std)[None].to(device)
    with torch.no_grad():
        out = apply_model(model, x, device=device, split=True, overlap=0.25, progress=False)[0]
    out = out * std + mean
    return {name: out[i].cpu().numpy() for i, name in enumerate(model.sources)}


def drum_hits(drums, sr):
    """Onsets in the clean drum stem, each labelled kick / snare / hat by where its energy sits."""
    y = librosa.resample(drums.mean(0), orig_sr=sr, target_sr=22050)
    hop = 128
    env = librosa.onset.onset_strength(y=y, sr=22050, hop_length=hop)
    onsets = librosa.onset.onset_detect(onset_envelope=env, sr=22050, hop_length=hop, units='frames', backtrack=False, delta=0.1, wait=3)
    S = np.abs(librosa.stft(y, n_fft=1024, hop_length=hop))
    f = librosa.fft_frequencies(sr=22050, n_fft=1024)
    band = lambda lo, hi: S[(f >= lo) & (f < hi)].sum(0)
    low, body, noise, high = band(35, 140), band(150, 400), band(1500, 5000), band(6000, 11000)
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    loud = np.percentile(rms, 95) + 1e-9
    strengths = env[onsets] if len(onsets) else np.array([1.0])
    ref = np.percentile(strengths, 90) + 1e-9
    out = {'kick': [], 'snare': [], 'hat': []}
    for k in onsets:
        a, b = k, min(len(rms) - 1, k + 6)
        if rms[a:b + 1].max() < 0.04 * loud:
            continue   # bleed or near silence
        lo_, bo_, no_, hi_ = low[a:b + 1].max(), body[a:b + 1].max(), noise[a:b + 1].max(), high[a:b + 1].max()
        tot = lo_ + bo_ + no_ + hi_ + 1e-9
        # which drum: fixed shares of where the energy sits. (A per-song clustering was tried and
        # scored no better at following the backbeat, while swinging a lot between songs.)
        kind = 'kick' if lo_ / tot > 0.45 else 'snare' if (bo_ + no_) / tot > 0.35 else 'hat'
        out[kind].append([round(float(k * hop / 22050), 3), round(float(min(2, env[k] / ref)), 3)])
    return out
    # Which hits are kicks, snares or cymbals depends a lot on the mix, so instead of fixed cut-offs
    # the song's own hits are grouped in three (k-means on "how much low end" and "how much top end",
    # both relative to the midrange): the boomiest group is the kick, the brightest the cymbals.
    X = np.array(feats)
    c = np.array([X[np.argmax(X[:, 0])], np.median(X, 0), X[np.argmax(X[:, 1])]])
    for _ in range(30):
        lab = np.argmin(((X[:, None, :] - c[None]) ** 2).sum(-1), 1)
        c = np.array([X[lab == j].mean(0) if np.any(lab == j) else c[j] for j in range(3)])
    kick_c = int(np.argmax(c[:, 0] - c[:, 1])); hat_c = int(np.argmax(c[:, 1] - c[:, 0]))
    if hat_c == kick_c:
        hat_c = -1
    for k, l in zip(hits, lab):
        kind = 'kick' if l == kick_c else 'hat' if l == hat_c else 'snare'
        out[kind].append([round(float(k * hop / 22050), 3), round(float(min(2, env[k] / ref)), 3)])
    return out


def stem_onsets(y, sr, ref_loud, delta=0.08):
    """Hits in one isolated drum track, with strengths; quiet bleed from the other drums is skipped."""
    mono = librosa.resample(y.mean(0), orig_sr=sr, target_sr=22050)
    hop = 128
    env = librosa.onset.onset_strength(y=mono, sr=22050, hop_length=hop)
    on = librosa.onset.onset_detect(onset_envelope=env, sr=22050, hop_length=hop, units='frames', backtrack=False, delta=delta, wait=3)
    rms = librosa.feature.rms(y=mono, hop_length=hop)[0]
    own = np.percentile(rms, 99) + 1e-9
    if own < 0.02 * ref_loud:
        return []   # this drum barely plays in the song
    ref = np.percentile(env[on], 90) + 1e-9 if len(on) else 1
    out = []
    for k in on:
        peak = rms[k:k + 6].max(initial=0)
        if peak < 0.12 * own or peak < 0.015 * ref_loud:
            continue
        out.append([round(float(k * hop / 22050), 3), round(float(min(2, env[k] / ref)), 3)])
    return out


_larsnet = {}   # one per device
def larsnet(device):
    """LarsNet (github.com/polimi-ispl/larsnet, weights CC BY-NC 4.0), if it's been set up."""
    if device not in _larsnet:
        home = os.path.join(os.path.dirname(sys.executable), '..', '..', 'larsnet')
        if not os.path.exists(os.path.join(home, 'pretrained_larsnet_models', 'kick')):
            _larsnet[device] = False
        else:
            import contextlib, io
            os.environ['TQDM_DISABLE'] = '1'
            sys.path.insert(0, home)
            cwd = os.getcwd(); os.chdir(home)
            try:
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    from larsnet import LarsNet
                    _larsnet[device] = LarsNet(wiener_filter=True, wiener_exponent=1.0, config='config.yaml', device=device)
            finally:
                os.chdir(cwd)
    return _larsnet[device] or None


def drum_hits_split(drums, sr, device):
    """Kick / snare / toms / hi-hat / cymbals from LarsNet's separate tracks."""
    net = larsnet(device)
    if net is None:
        return drum_hits(drums, sr)
    import contextlib, io
    x = torch.tensor(drums, dtype=torch.float32)
    if sr != net.sr:
        x = torch.tensor(librosa.resample(drums, orig_sr=sr, target_sr=net.sr), dtype=torch.float32)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        parts = net(x)
    ref_loud = np.percentile(librosa.feature.rms(y=librosa.resample(drums.mean(0), orig_sr=sr, target_sr=22050), hop_length=128)[0], 99) + 1e-9
    stems = {k: v.cpu().numpy() for k, v in parts.items()}
    cym = stem_onsets(stems['hihat'], net.sr, ref_loud) + stem_onsets(stems['cymbals'], net.sr, ref_loud, delta=0.12)
    cym.sort(key=lambda h: h[0])
    merged = []
    for h in cym:   # a hi-hat and a cymbal together are one hit
        if merged and h[0] - merged[-1][0] < 0.03:
            merged[-1][1] = max(merged[-1][1], h[1])
        else:
            merged.append(h)
    return {'kick': stem_onsets(stems['kick'], net.sr, ref_loud), 'snare': stem_onsets(stems['snare'], net.sr, ref_loud),
            'tom': stem_onsets(stems['toms'], net.sr, ref_loud), 'hat': merged}


def instrument_notes(other, sr, model_path):
    """Basic Pitch on the guitar/keys stem; a strummed chord becomes one event at its top note."""
    from basic_pitch.inference import predict
    import contextlib, io
    mono = other.mean(0)
    rms = librosa.feature.rms(y=mono, hop_length=512)[0]
    loud = np.percentile(rms, 95) + 1e-9
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
        sf.write(tmp.name, mono, sr)
        path = tmp.name
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            _, _, events = predict(path, model_path, onset_threshold=0.55, frame_threshold=0.3, minimum_note_length=60,
                                   minimum_frequency=70, maximum_frequency=2000)
    finally:
        os.unlink(path)
    ev = sorted(((float(s), float(e), int(p), float(a)) for s, e, p, a, *_ in events), key=lambda x: x[0])
    groups = []
    for s, e, p, a in ev:
        if groups and s - groups[-1]['s'] < 0.04:
            g = groups[-1]; g['e'] = max(g['e'], e); g['a'] = max(g['a'], a); g['p'] = max(g['p'], p); g['n'] += 1
        else:
            groups.append({'s': s, 'e': e, 'p': p, 'a': a, 'n': 1})
    out = []
    for g in groups:
        k = int(g['s'] * sr / 512)
        if rms[k:k + 8].max(initial=0) < 0.08 * loud:
            continue
        out.append([round(g['s'], 3), round(min(1.5, 0.4 + g['a'] + 0.05 * g['n']), 3), g['p'], round(g['e'] - g['s'], 3)])
    return out


def vocal_notes(vocals, sr, model_path):
    """Basic Pitch on the clean vocal stem, reduced to one melody line."""
    from basic_pitch.inference import predict
    mono = vocals.mean(0)
    rms = librosa.feature.rms(y=mono, hop_length=512)[0]
    loud = np.percentile(rms, 95) + 1e-9
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
        sf.write(tmp.name, mono, sr)
        path = tmp.name
    try:
        import contextlib, io
        with contextlib.redirect_stdout(io.StringIO()):
            _, _, events = predict(path, model_path, onset_threshold=0.5, frame_threshold=0.3, minimum_note_length=80,
                                   minimum_frequency=80, maximum_frequency=1100)
    finally:
        os.unlink(path)
    ev = sorted(((float(s), float(e), int(p), float(a)) for s, e, p, a, *_ in events), key=lambda x: x[0])
    mono_notes = []
    for s, e, p, a in ev:   # one voice: an overlapping, weaker note is a harmonic or a ghost
        if mono_notes and s < mono_notes[-1][1] - 0.03:
            if a > mono_notes[-1][3] and s - mono_notes[-1][0] < 0.05:
                mono_notes[-1] = [s, e, p, a]
            continue
        mono_notes.append([s, e, p, a])
    notes = []
    for s, e, p, a in mono_notes:
        k = int(s * sr / 512)
        if rms[k:k + 8].max(initial=0) < 0.06 * loud:
            continue   # a note transcribed from bleed
        notes.append([round(s, 3), round(0.5 + min(0.5, a), 3), p, round(e - s, 3)])
    return notes


def beats_of(mix, sr):
    y = librosa.resample(mix.mean(0), orig_sr=sr, target_sr=22050)
    tempo, frames = librosa.beat.beat_track(y=y, sr=22050, hop_length=256)
    beats = librosa.frames_to_time(frames, sr=22050, hop_length=256)
    bpm = float(np.atleast_1d(tempo)[0])
    if len(beats) > 4:   # the tempo from the tracked beats themselves is more precise
        bpm = 60 / float(np.median(np.diff(beats)))
    return round(bpm, 2), [round(float(t), 3) for t in beats]


def main():
    ap = argparse.ArgumentParser(description='Make high-quality Rhythm Trainer charts from your songs.')
    ap.add_argument('paths', nargs='+', help='audio files or folders')
    ap.add_argument('--force', action='store_true', help='redo songs that already have a chart')
    ap.add_argument('--out', default=OUT, help='where to write charts (default: the project charts folder)')
    args = ap.parse_args()
    files = []
    for p in args.paths:
        p = os.path.expanduser(p)
        if os.path.isdir(p):
            for root, _, names in os.walk(p):
                files += [os.path.join(root, n) for n in sorted(names) if n.lower().endswith(AUDIO)]
        elif p.lower().endswith(AUDIO):
            files.append(p)
    if not files:
        sys.exit('No audio files found.')
    os.makedirs(args.out, exist_ok=True)
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    print(f'{len(files)} songs · separating on {device.upper()}')
    model = get_model('htdemucs'); model.to(device); model.eval()
    import basic_pitch
    bp_model = os.path.join(os.path.dirname(basic_pitch.__file__), 'saved_models/icassp_2022/nmp.onnx')
    done = skipped = failed = 0
    for i, path in enumerate(files, 1):
        name = song_name(path)
        dest = os.path.join(args.out, slug(name) + '.js')
        if not args.force and os.path.exists(dest) and os.path.getmtime(dest) >= os.path.getmtime(path):
            with open(dest) as fh:
                old = fh.read(200)
            if f'"v":{VERSION},' in old:
                skipped += 1
                continue
        t0 = time.time()
        try:
            mix, sr = librosa.load(path, sr=model.samplerate, mono=False)
            if mix.ndim == 1:
                mix = np.stack([mix, mix])
            # very long songs can run out of GPU memory: then that step runs on the CPU (slower, same result)
            try:
                stems = separate(model, mix, device)
            except torch.cuda.OutOfMemoryError:
                torch.cuda.empty_cache(); print(f'[{i}/{len(files)}] {name}: GPU full, separating on the CPU instead…', flush=True)
                model.to('cpu'); stems = separate(model, mix, 'cpu'); model.to(device)
            try:
                drums = drum_hits_split(stems['drums'], sr, device)
            except torch.cuda.OutOfMemoryError:
                torch.cuda.empty_cache(); print(f'[{i}/{len(files)}] {name}: GPU full, splitting the drums on the CPU instead…', flush=True)
                drums = drum_hits_split(stems['drums'], sr, 'cpu')
            vocal = vocal_notes(stems['vocals'], sr, bp_model)
            inst = instrument_notes(stems['other'], sr, bp_model)
            bpm, beats = beats_of(mix, sr)
            chart = {'v': VERSION, 'name': name, 'file': os.path.basename(path), 'duration': round(mix.shape[1] / sr, 2),
                     'bpm': bpm, 'first': beats[0] if beats else 0, 'beats': beats, **drums, 'vocal': vocal, 'inst': inst}
            with open(dest, 'w') as fh:
                fh.write('rtChartLoaded(' + json.dumps(chart, separators=(',', ':')) + ');\n')
            done += 1
            print(f'[{i}/{len(files)}] {name}: {len(drums["kick"])} kicks, {len(drums["snare"])} snares, {len(drums.get("tom", []))} toms, '
                  f'{len(drums["hat"])} hats/cymbals, {len(vocal)} sung, {len(inst)} guitar, {bpm:.1f} BPM ({time.time() - t0:.1f}s)', flush=True)
        except Exception as e:
            failed += 1
            print(f'[{i}/{len(files)}] {name}: failed ({e})', flush=True)
    print(f'Done: {done} new, {skipped} already had charts, {failed} failed. Charts are in {args.out}')


if __name__ == '__main__':
    main()
