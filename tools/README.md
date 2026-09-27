# High-quality charts

The site can find drums and vocals by itself, but guessing from a full mix only goes so far
(roughly 88% of drum-chart notes and 60% of vocal-chart notes land on the real thing). This tool
does it properly on your own computer and saves the result, so the site can use it instead
(about 96% and 91%).

For each song it:
- splits the song into drums / bass / vocals / other with **Demucs**
- finds every drum hit in the clean drum track
- transcribes the clean vocal track into notes with **Basic Pitch**
- tracks the beats with **librosa**

and writes `charts/<song>.js`. When you load that song (same file name) in the trainer or the
Arcade, the chart is used automatically: you'll see "★ High-quality chart" in the song info.

## Setup (once)

```sh
tools/setup.sh
```

Needs [uv](https://docs.astral.sh/uv/). Installs into `~/.local/share/rhythm-trainer-tools`, outside
the project, so the multi-GB libraries never end up in git. Uses an NVIDIA GPU if there is one
(about 5 s per song); it works without one, just slower.

## Making charts

```sh
tools/make-charts ~/Music            # a whole folder (skips songs that already have a chart)
tools/make-charts "some song.mp3"    # specific files
tools/make-charts --force ~/Music    # redo everything
```

The `charts` folder is small and safe to commit, so other computers get the charts with `git pull`
without running the tool.
