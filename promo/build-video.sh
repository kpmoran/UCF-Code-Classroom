#!/bin/bash
#
# Encodes promo/scenes/*.png into the promo video.
#
# Runs from anywhere: it changes to its own directory first, because the ffmpeg
# inputs are relative and an earlier version silently failed when invoked from the
# repository root.
#
# Each scene gets a slow push in (zoompan) and the scenes are joined with crossfades.
# The scenes are rendered at 3840x2160 and the output is 1080p, so the zoom crops into
# real pixels instead of upscaling.
#
# If a music file is present it is mixed in, trimmed to the video, faded at both
# ends and levelled to about -16 LUFS. Set MUSIC= to build a silent version.
#
#   TITLE=4 SCENE=5 OUTRO=4.5 FADE=0.7 bash promo/build-video.sh
#   MUSIC= bash promo/build-video.sh            # no audio
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

TITLE="${TITLE:-4.0}"   # seconds on the opening card
SCENE="${SCENE:-5.0}"   # seconds on each walk-through scene
OUTRO="${OUTRO:-4.5}"   # seconds on the closing card
FADE="${FADE:-0.7}"     # crossfade length
OUT="${OUT:-ucf-code-classroom-promo.mp4}"
MUSIC="${MUSIC-dopamine-by-kv.mp3}"   # unset MUSIC (not empty) keeps the default
AUDIO_FADE_OUT="${AUDIO_FADE_OUT:-3.5}"

command -v ffmpeg >/dev/null || { echo "ffmpeg not found" >&2; exit 1; }
shopt -s nullglob
scenes=(scenes/scene-*.png)
[ "${#scenes[@]}" -ge 3 ] || {
  echo "expected at least 3 rendered scenes in promo/scenes — run promo/capture.mjs first" >&2
  exit 1
}

TITLE="$TITLE" SCENE="$SCENE" OUTRO="$OUTRO" FADE="$FADE" OUT="$OUT" python3 - "${scenes[@]}" <<'PY'
import os, subprocess, sys

scenes = sys.argv[1:]
title, mid, outro = float(os.environ['TITLE']), float(os.environ['SCENE']), float(os.environ['OUTRO'])
fade, out = float(os.environ['FADE']), os.environ['OUT']

dur = [title] + [mid] * (len(scenes) - 2) + [outro]

args, filters, labels = [], [], []
for i, (path, d) in enumerate(zip(scenes, dur)):
    args += ['-loop', '1', '-t', str(d), '-i', path]
    # d=1 gives one output frame per input frame, so `zoom` accumulates across the
    # clip. Leaving it at the frame count instead expands *every* input frame and
    # the video comes out minutes long.
    filters.append(
        f'[{i}:v]fps=30,'
        f"zoompan=z='min(zoom+0.00040,1.05)':d=1:"
        f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080,"
        f'setsar=1,format=yuv420p[v{i}]'
    )
    labels.append(f'[v{i}]')

# Each xfade starts `fade` before the running total, and consumes `fade` of the
# incoming clip, so the offsets accumulate rather than being multiples of anything.
chain, prev, acc = [], labels[0], dur[0]
for i in range(1, len(scenes)):
    offset = round(acc - fade, 3)
    label = '[vout]' if i == len(scenes) - 1 else f'[x{i}]'
    chain.append(f'{prev}{labels[i]}xfade=transition=fade:duration={fade}:offset={offset}{label}')
    prev, acc = label, round(offset + dur[i], 3)

cmd = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', *args,
       '-filter_complex', ';'.join(filters + chain),
       '-map', '[vout]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '19',
       '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-r', '30', out]

print(f'  {len(scenes)} scenes, expecting {acc:.1f}s')
subprocess.run(cmd, check=True)
PY

# Music, if there is any. Encoded as a separate pass so a re-run without MUSIC
# produces the silent master again rather than something half-mixed.
if [ -n "$MUSIC" ] && [ -f "$MUSIC" ]; then
  seconds="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")"
  fade_at="$(python3 -c "import sys; print(max(0, float(sys.argv[1]) - float(sys.argv[2])))" \
    "$seconds" "$AUDIO_FADE_OUT")"

  # -map 1:a:0 is deliberate: the mp3 carries embedded cover art as an mjpeg
  # stream, and letting ffmpeg choose picks that up as a second video stream.
  #
  # loudnorm rather than a fixed volume, so swapping the track does not silently
  # change how loud the video is. -shortest is not enough on its own here, because
  # the track is longer than the video and would pad the last frame.
  ffmpeg -y -hide_banner -loglevel error \
    -i "$OUT" -i "$MUSIC" \
    -map 0:v:0 -map 1:a:0 \
    -af "atrim=0:${seconds},asetpts=N/SR/TB,afade=t=in:st=0:d=0.6,afade=t=out:st=${fade_at}:d=${AUDIO_FADE_OUT},loudnorm=I=-16:TP=-1.5:LRA=11" \
    -c:v copy -c:a aac -b:a 192k -ar 48000 -movflags +faststart \
    "${OUT%.mp4}-scored.mp4"
  mv "${OUT%.mp4}-scored.mp4" "$OUT"
  printf '  mixed in %s, faded out over the last %ss\n' "$MUSIC" "$AUDIO_FADE_OUT"
else
  printf '  no music file — leaving the video silent\n'
fi

# A 720p copy for email, and the opening frame as a poster.
ffmpeg -y -hide_banner -loglevel error -i "$OUT" -vf scale=1280:720 \
  -c:v libx264 -preset slow -crf 21 -pix_fmt yuv420p -c:a copy -movflags +faststart \
  "${OUT%.mp4}-720p.mp4"
cp scenes/scene-00.png poster.png

printf '  wrote %s (%s) and the 720p copy\n' \
  "$OUT" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" | cut -c1-5)s"
