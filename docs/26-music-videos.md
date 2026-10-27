# Music videos

A song in, a finished music video out - made on this PC, from the **Music video**
workspace or by asking the assistant. No account, no key, nothing leaves the
machine, and nothing runs on the graphics card.

## What you get

A 16:9 H.264/AAC `video.mp4` the length of the song:

- a **ring of spectrum bars** around a dark disc that follows the music (64 bands,
  automatic gain, so a quiet song moves as much as a loud one), over a dark
  gradient with slowly drifting dust;
- a **glow that flashes on the beat** (the beat is found from the song itself) and
  a colour that turns a little at each change of section, so the loud parts do
  not look like the quiet ones;
- the **title and artist inside the disc** - or, when the song has cover art, the
  cover cut to a circle in the disc and blurred behind, with the title small in
  the corner;
- the **lyrics along the bottom, lit word by word as they are sung** (karaoke
  style), when there are lyrics;
- a fade up from black and out to it; the whole file checked before it is kept.

Five looks (Neon, Ember, Ice, Sunset, Mono), or "let the song choose": fast and
loud songs are warm, slow ones cool. 1080p, or 720p which draws faster. Drawing
runs faster than the song plays (measured on the PC it was built on, with its
processor and no graphics card: about 1.5 times as fast at 1080p, twice at 720p), so
a four-minute song takes about three minutes at 1080p, plus a little to listen for
words.

## The words

- **Pasted lyrics** (best): each word is lined up with the same word in what
  whisper.cpp hears, so a word it misheard or missed moves nothing else.
  Headings such as `[Chorus]` or `Verse 2:` are left out.
- **No lyrics pasted**: whisper.cpp's own words are shown if they read as words
  (not the "Thank you." a recogniser invents over a quiet part), and the person
  is told they were worked out by listening and will have mistakes. Singing over
  a band is hard to hear.
- **Listening not installed** (Settings, Engine and models): pasted lyrics are
  spread evenly over the song and the video says they are only approximate.
- **No words** is a choice too.

whisper.cpp runs on the processor with its attention-based word times (`-dtw`,
which needs `-nfa`): its ordinary word times are stretched across the quiet
between lines, so a line sung at 8 s came back as starting at 0 s.

## Where things are

Everything is under the workspace's `music-videos` folder:

```
music-videos/<title>/video.mp4
                     thumbnail.jpg
                     song.mp3        the song, kept so the video can be made again
                     lyrics.json     what was shown, with times
                     info.json       title, artist, look, size, notes
music-videos/<title>-preview/        the 20-second preview, replaced each time
music-videos/_uploads/               a song waits here until a video is made from it
```

A video gets a folder of its own (`<title>-2` for a second one); a preview is made
over the same folder each time. "Change and remake" loads a video's song and
lyrics back into the form to fix them and make it again over the old one.

## How it works

`audioAnalysis.ts` finds the beat (an onset curve from a mel spectrogram, a tempo
from its autocorrelation, then Ellis-style dynamic programming; it returns **no
beat** rather than inventing one for noise), the loudness and the sections, and
makes the bars and the glow for every frame. `lyricTiming.ts` / `lyricTranscribe.ts`
do the words. `musicVideoLook.ts` makes the stills (the maps that bend a row of bars
into a ring, the disc, the dust) as PNGs from the numbers, `musicVideoCaptions.ts`
writes the subtitle file, and `musicVideoGraph.ts` builds the ffmpeg command.

ffmpeg is given the song, the spectrum as a **control video** piped to its stdin
(64x228 gray: a column of bar height per band, then rows of glow), and those
stills; it draws the rest in a filter graph. Things that were found by trying it,
and are kept as tests:

- every blend is followed by `format=gbrp`: left to negotiate, ffmpeg blends
  "screen" and "multiply" on YUV chroma planes and the whole picture turns a
  colour;
- the final conversion names range and matrix (`out_range=tv`,
  `out_color_matrix=bt709`) and the frames are tagged BT.709: left to default the
  file came out `yuvj420p` with a matrix that players read as "this is RGB";
- gradients have fixed seeds (without one every run draws a different picture);
- ffmpeg runs from inside the work folder and the graph names its files without a
  path, so there is no Windows drive letter to escape in a filter.

`musicVideo.ts` runs the steps, one video at a time (`musicVideoJob.ts`), at below-normal
priority so the PC stays usable, and **checks what comes out** before keeping it:
length within a fraction of a second, an h264 `yuv420p` picture of the size asked for,
sound, and that the last stretch decodes. A video that fails the check is not kept.

## Using it

- **Music video** in the sidebar (Work): drop a song, optionally paste the lyrics,
  pick a look and a size, "Try 20 seconds" or "Make the video". Progress shows
  as it goes; leaving the screen is fine, and the app says when it is done.
- **From the chat**: the paperclip takes a song as well as a picture, and a song
  dropped anywhere in the app does the same. Either opens the Music video screen
  with the song already loaded (a song is not a message attachment: the chat has
  no use for one). A file that is neither a picture nor a song is named and left
  alone, and one song is taken at a time.
- **Ask the assistant**: "make a music video from songs/neon.mp3". The assistant
  starts it and says it has *started*, not that it is made; `music_video_status`
  tells it how it is getting on.
- **API**: `GET /v1/music-video` (status, what is ready), `GET /v1/music-video/library`,
  `POST /v1/music-video/audio?name=` (the song as the body, `audio/*`),
  `POST /v1/music-video` (JSON; 202, or 409 while another is being made),
  `POST /v1/music-video/cancel`. Everything that changes something needs the
  trial or a license (the paywall), and a JSON or audio content type, so a page
  on another site cannot start one.

## Limits

Songs up to 15 minutes and 400 MB. Needs ffmpeg with `remap`, `gradients`,
`subtitles` (libass) and libx264 - the one TRH AI installs has them; the app says
which is missing if a different one does not. English lyrics only for timing
(the listening model that ships is English).

## Tests

Pure parts are tested without ffmpeg (analysis on synthetic drum tracks at known
tempos, lyric timing against real whisper output kept as fixtures, the filter
graph's rules, captions, the job state machine, the routes, the assistant tool).
`music-video-render.test.ts` makes real videos with the real ffmpeg and is skipped
where there is none.
