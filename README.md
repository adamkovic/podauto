# PodAuto — automatic multicam podcast editing for Premiere Pro

A Premiere Pro panel that listens to each speaker's mic, figures out who is
talking, and automatically cuts between camera angles — giving you a
close-to-final edit in minutes instead of hours of multicam work. Supports up
to 8 speakers/cameras. Everything runs locally on your machine: no network
calls, no accounts, your audio never leaves your computer.

**No multicam clips needed.** PodAuto works on plain stacked tracks, and the edit
is non-destructive: it only razors and *disables* the non-active camera clips,
so you can fix any cut by hand afterwards (or reset the whole thing).

## Requirements

- Premiere Pro 2020 (14.0) or newer, macOS
- [ffmpeg](https://ffmpeg.org) for audio analysis: `brew install ffmpeg`

## Install

```sh
./install.sh
```

Then restart Premiere and open **Window → Extensions → PodAuto — Auto Podcast Editor**.

(The script symlinks the extension into `~/Library/Application Support/Adobe/CEP/extensions`
and enables `PlayerDebugMode` so Premiere loads unsigned personal extensions.
Because it's a symlink, editing files in this repo updates the installed panel —
just reopen the panel.)

## Timeline setup (once per episode)

1. Import your camera files and mic recordings.
2. Select them all → right-click → **Synchronize… → Audio** (or line them up by
   timecode). You want:
   - each **camera** on its own video track (V1, V2, V3, …)
   - each **speaker's mic** on its own audio track (A1, A2, …)
   - optionally a **wide shot** camera on its own track
3. Track order doesn't matter — you map everything in the panel.

## Usage

1. **Scan Active Sequence** — the panel lists your tracks and auto-pairs
   mic ↔ camera in order. Fix the pairing if needed, and pick your wide/group
   shot camera if you have one.
2. Tweak settings (defaults are sensible for a 2–4 person podcast):

   | Setting | What it does |
   |---|---|
   | Voice sensitivity | dB above each mic's measured noise floor that counts as speech. Lower = more sensitive. |
   | Min shot length | Never cut faster than this — prevents jarring flip-flopping. |
   | Max shot length | Long monologues get a cutaway (wide shot or a listener reaction) so the edit stays dynamic. |
   | Variation | Randomises pacing-cut timing so cuts don't land metronomically. |
   | Group shot trigger | Seconds of crosstalk before switching to the wide shot. |
   | Group shot duration | Minimum time to stay on the wide shot. |
   | Frame offset | Nudge every cut earlier (−) or later (+) by N frames. |

3. **Analyze & Preview** — decodes each mic, detects speech, and shows the shot
   plan (shot count, average shot length, first cuts). A 1-hour episode takes
   roughly a minute.
4. **Apply Edit** — razors the camera tracks at every cut and disables the
   inactive angles. Play it back; if the pacing feels off, tweak settings,
   Analyze again, and re-Apply (it recomputes from the same razor-friendly plan).
5. **Reset Edit** re-enables everything if you want to start over.

## How it works

- Each mic file is decoded to mono 8 kHz PCM via ffmpeg and reduced to a 50 ms
  RMS loudness envelope.
- Per mic, the noise floor is estimated (15th percentile) and speech is anything
  louder than floor + sensitivity, with short-gap bridging and a 300 ms hangover
  so mid-sentence pauses don't cause cuts.
- Per 50 ms frame, the loudest *speaking* person wins. A new speaker must
  dominate for ~0.35 s before a cut happens (hysteresis), and cuts respect your
  min shot length. Sustained crosstalk goes to the wide shot.
- The final segment list is frame-snapped and applied in Premiere via razor +
  clip-disable on the mapped video tracks. Audio tracks are untouched.

## Troubleshooting

- **Panel doesn't appear** — rerun `./install.sh`, fully quit and reopen Premiere.
- **"ffmpeg not found"** — `brew install ffmpeg`, or paste the full path
  (e.g. `/opt/homebrew/bin/ffmpeg`) into the ffmpeg path field.
- **Cuts feel late/early** — use Frame offset (e.g. `-3` cuts 3 frames early,
  which often feels more natural).
- **Too many cuts** — raise Min shot length and/or Voice sensitivity.
- **Missed quiet speakers** — lower Voice sensitivity (try 8).
- **Wrong angle shows after Apply** — remember stacked tracks: the *topmost
  enabled* clip wins. Make sure every camera is mapped so PodAuto manages all of
  them; unmapped video tracks above your cameras will cover everything.
