# Promo video

A 30-second silent walkthrough for the front page and for sending to colleagues.

This folder holds the **sources**. The finished video is committed once, as
`public/promo.mp4`, because that is the copy the site serves — a second copy here would
be the same three megabytes in git twice, and two files that could disagree about which
is current.

| Path | What it is |
|---|---|
| `public/promo.mp4` | 1920×1080, 30s, scored — what the front page plays |
| `public/promo-poster.png` | opening frame, the player's placeholder |
| `scene.html` | the whole script: captions, annotations, positions |
| `capture.mjs` | screenshots the running app, renders the scene deck |
| `build-video.sh` | encodes, mixes the music, writes a 720p copy and the poster |
| `dopamine-by-kv.mp3` | the soundtrack — see attribution below |

`build-video.sh` also writes `ucf-code-classroom-promo.mp4`, a 720p copy and
`poster.png` into this folder; all three are gitignored as build outputs. Copy the ones
you want to keep into `public/`.

## Music and attribution

The video is scored with **Dopamine by KV**, used under its free licence, which
**requires attribution**. The credit is burned into the closing frame, because an
embedded homepage video has no description field to put it in — so the requirement is
met wherever the file ends up.

Anywhere the video has a description as well (YouTube, Vimeo, an email), paste this:

```
Music: Dopamine by KV https://youtube.com/c/KVmusicprod
Free Download / Stream: https://links.al/0jW
Music promoted by Audio Library: https://links.al/youtube
```

`build-video.sh` picks up `dopamine-by-kv.mp3` automatically, trims it to the video,
fades in over 0.6s, fades out over the final 3.5s and levels it to about -16 LUFS.
Two details there are easy to get wrong: the audio stream is mapped explicitly because
the mp3 carries embedded cover art that ffmpeg would otherwise treat as a second video
stream, and the sample rate is pinned to 48 kHz because `loudnorm` resamples to 96 kHz
if you let it.

To swap the track, drop in a new file and set `MUSIC=your-file.mp3`. **If you change
the track you must change the credit on the closing frame too** — it is the `.credit`
block in `scene.html`. For a silent build, `MUSIC= bash promo/build-video.sh`.

## Rebuilding it

The screenshots are real captures of a running instance, so this needs the app up with
presentable data — a roster, an assignment, repositories with scores.

```bash
npm run build && PORT=3100 APP_URL=https://code-classroom.com npm start   # in one shell
npx tsx scripts/dev-session.ts <instructor-login>                        # copy the token
node promo/capture.mjs http://localhost:3100 <token> <classroom-slug> <assignment-id>
bash promo/build-video.sh
```

`APP_URL` matters only because invite links are rendered from it, and a screenshot
showing `localhost:3000` undoes the effect.

Two structural notes are in `capture.mjs`, where they are easy to trip over: the scroll
is absolute rather than a relative nudge, and anchors match structure rather than loose
text. Both caused scenes whose captions did not match their picture.

## Editing the deck

`scene.html` holds the whole script — captions, annotation text and annotation
positions — in one `SCENES` array. Open it in a browser with `?s=3` to preview a single
scene at 1920×1080. Annotation `x`/`y` are percentages of the frame, and `dir` picks
which edge the little arrow comes out of.

Durations and the crossfade live at the top of `build-video.sh`.

## On the front page

`public/promo.mp4` and `public/promo-poster.png` are the copies the site serves; this
folder holds the sources. Re-running `build-video.sh` does **not** update them — copy
the new file over when you are happy with it:

```bash
cp promo/ucf-code-classroom-promo.mp4 public/promo.mp4
cp promo/poster.png public/promo-poster.png
```

It is a click-to-play player under the hero, not an autoplaying background loop: this is
a 30-second explainer with music, meant to be watched deliberately, and autoplay would
both mute the soundtrack and push three megabytes at every visitor. `preload="metadata"`
means only the poster loads until someone presses play.

One thing to know if you add other media to `public/`: the proxy's matcher in
`src/proxy.ts` lists the extensions that bypass authentication, and it covered images
only. The video came back as a 307 to `/signin` until `mp4` was added — a public asset
gated behind sign-in, with the poster loading beside it so the player looked fine until
you pressed play.
