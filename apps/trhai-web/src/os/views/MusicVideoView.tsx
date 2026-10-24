"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import {
  formatClock, formatSize, getLibrary, getStatus, guessTitle, hasExtension, lyricsNote, mediaUrl, previewSeconds, remainingText, requestFrom,
  stageWords, startVideo, stopVideo, uploadSong, whyNot, type Job, type LibraryEntry, type Ready, type Result
} from "../../lib/musicVideo";
import { Icon } from "../ui/Icon";
import { ViewFrame } from "../ui/ViewFrame";
import { useNav } from "../state/nav";
import "./views.css";

// A song in, a finished music video out. The song is loaded into TRH AI's
// workspace, the video is drawn on this PC's processor (no graphics card, no
// account, nothing sent anywhere), and the result is played here and kept in
// the workspace's music-videos folder. While one is being made the screen only
// watches: the work is done by the local service, which carries on if this
// screen is closed and tells the rest of the app when it is done.

const defaultTypes = [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".aiff"];

type Shown = {
  video: string;
  thumbnail: string | null;
  title: string;
  artist: string;
  seconds: number;
  bytes: number;
  height: number;
  folder: string;
  preview: boolean;
  warnings: string[];
};

const shownFromResult = (result: Result): Shown => ({
  video: result.video, thumbnail: result.thumbnail, title: result.title, artist: result.artist, seconds: result.seconds, bytes: result.bytes,
  height: result.height, folder: result.folder, preview: result.preview, warnings: result.warnings
});
const shownFromEntry = (entry: LibraryEntry): Shown => ({
  video: entry.video, thumbnail: entry.thumbnail, title: entry.title, artist: entry.artist, seconds: entry.seconds, bytes: entry.bytes,
  height: entry.height, folder: entry.folder, preview: entry.preview, warnings: entry.warnings
});

function madeWhen(iso: string, now: Date): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const minutes = Math.round((now.getTime() - then.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return then.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function MusicVideoView() {
  const { go } = useNav();
  const formTop = useRef<HTMLElement>(null);
  const [ready, setReady] = useState<Ready | null>(null);
  const [job, setJob] = useState<Job>({ status: "idle" });
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [shown, setShown] = useState<Shown | null>(null);

  const [song, setSong] = useState<{ name: string; bytes: number | null; path: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [noWords, setNoWords] = useState(false);
  const [palette, setPalette] = useState("auto");
  const [height, setHeight] = useState<720 | 1080>(1080);
  const [cover, setCover] = useState(true);
  const [replace, setReplace] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  const running = job.status === "running";

  const refresh = useCallback(async () => {
    const result = await getStatus();
    if (!result.ok) return;
    setReady(result.data.ready);
    setJob(result.data.job);
  }, []);

  const loadLibrary = useCallback(async () => {
    const result = await getLibrary();
    if (result.ok) setLibrary(result.data.videos);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- both set state only after their requests return
    void refresh();
    void loadLibrary();
  }, [refresh, loadLibrary]);

  // Quickly while a video is being made; slowly otherwise, to notice one started from the chat.
  useEffect(() => {
    const timer = window.setInterval(() => { void refresh(); setNow(new Date()); }, running ? 1000 : 5000);
    return () => window.clearInterval(timer);
  }, [running, refresh]);

  // When a video finishes with this screen open, show it and add it to the list.
  const finished = useRef<string | null>(null);
  useEffect(() => {
    if (job.status !== "done" || finished.current === job.id) return;
    finished.current = job.id;
    setShown(shownFromResult(job.result));
    void loadLibrary();
  }, [job, loadLibrary]);

  const choose = useCallback(async (file: File | undefined) => {
    if (!file) return;
    const types = ready?.extensions ?? defaultTypes;
    if (!hasExtension(file.name, types)) {
      setProblem(`That is not a song file this can read. It can read ${types.join(", ")}.`);
      return;
    }
    setProblem(null);
    setUploading(true);
    setSong(null);
    const result = await uploadSong(file);
    setUploading(false);
    if (!result.ok) { setProblem(result.reason); return; }
    setSong({ name: file.name, bytes: result.data.bytes, path: result.data.path });
    setReplace(null);
    // A new song starts a new video; the title is left to the song's own tags unless the box was already filled in.
    setTitle("");
    setArtist("");
  }, [ready]);

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    void choose(event.dataTransfer.files[0]);
  };

  const hindrance = whyNot(ready, { uploading, song: song !== null, busy: running });

  const make = async (preview: boolean) => {
    if (!song || hindrance) return;
    setProblem(null);
    const result = await startVideo(requestFrom({ audio: song.path, title, artist, lyrics, noWords, palette, height, cover, preview, replace }));
    if (!result.ok) { setProblem(result.reason); return; }
    setJob(result.data.job);
    setShown(null);
  };

  const stop = async () => {
    const result = await stopVideo();
    if (result.ok) setJob(result.data.job);
  };

  const again = (entry: LibraryEntry) => {
    setSong({ name: entry.song, bytes: null, path: `${entry.folder}/${entry.song}` });
    setTitle(entry.title);
    setArtist(entry.artist);
    setLyrics(entry.lyrics);
    setNoWords(false);
    setPalette(entry.palette);
    setHeight(entry.height === 720 ? 720 : 1080);
    setCover(entry.cover);
    setReplace(entry.preview ? null : entry.folder);
    setProblem(null);
    formTop.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const hasLyrics = lyrics.trim().length > 0;
  const shownEntry = shown ?? (job.status === "done" ? shownFromResult(job.result) : null);

  return (
    <ViewFrame id="music">
      <div className="os-mv">
        <section className="os-panel os-mv-form" ref={formTop} aria-label="Your song">
          <div className="os-panel-head">
            <h2 className="os-panel-title">Your song</h2>
            {replace ? <span className="os-chip violet" title={`The video in ${replace} will be replaced`}>Making it again</span> : null}
          </div>
          <div className="os-panel-body os-mv-body">
            {ready && !ready.ffmpeg ? (
              <div className="os-mv-notice warn" role="status">
                <Icon name="alert" size={16} />
                <p>Music videos need ffmpeg, which is not installed yet. It is a one-time download of about 100 MB.</p>
                <button type="button" className="os-btn os-btn-sm" onClick={() => go("settings")}>Open Settings</button>
              </div>
            ) : null}

            <label
              className={`os-mv-drop${dragging ? " over" : ""}${song ? " has-song" : ""}`}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <input
                type="file"
                accept={`audio/*,${(ready?.extensions ?? defaultTypes).join(",")}`}
                disabled={running}
                onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ""; }}
              />
              <Icon path="M9 17V6l10-2v11M9 17a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM19 15a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z" size={26} />
              {uploading ? <strong>Loading the song...</strong> : song ? (
                <>
                  <strong>{song.name}</strong>
                  <span className="os-faint">{song.bytes !== null ? `${formatSize(song.bytes)} - ` : ""}drop another song here, or click, to change it</span>
                </>
              ) : (
                <>
                  <strong>Drop a song here, or click to choose one</strong>
                  <span className="os-faint">MP3, WAV, M4A, FLAC and more - up to {Math.round((ready?.longestSeconds ?? 900) / 60)} minutes</span>
                </>
              )}
            </label>

            <div className="os-mv-two">
              <label className="os-field">
                <span className="os-label">Title</span>
                <input className="os-input" value={title} maxLength={200} placeholder={song ? guessTitle(song.name) : "From the song's tags, or its file name"} onChange={(event) => setTitle(event.target.value)} />
              </label>
              <label className="os-field">
                <span className="os-label">Artist</span>
                <input className="os-input" value={artist} maxLength={200} placeholder="From the song's tags" onChange={(event) => setArtist(event.target.value)} />
              </label>
            </div>

            <div className="os-field">
              <div className="os-mv-lyrics-head">
                <label htmlFor="mv-lyrics" className="os-label">Lyrics</label>
                <label className="os-mv-check">
                  <input type="checkbox" checked={noWords} onChange={(event) => setNoWords(event.target.checked)} />
                  <span>No words on the video</span>
                </label>
              </div>
              <textarea
                id="mv-lyrics"
                className="os-input os-mv-lyrics"
                rows={6}
                value={lyrics}
                disabled={noWords}
                maxLength={60000}
                placeholder={"Paste the lyrics, one line to a line.\nHeadings like [Chorus] are left out."}
                onChange={(event) => setLyrics(event.target.value)}
              />
              <p className="os-mv-note os-faint">{ready ? lyricsNote(ready, hasLyrics, noWords) : ""}</p>
            </div>

            <div className="os-field">
              <span className="os-label">Look</span>
              <div className="os-mv-palettes" role="radiogroup" aria-label="Look">
                <button type="button" role="radio" aria-checked={palette === "auto"} className={`os-mv-palette${palette === "auto" ? " on" : ""}`} onClick={() => setPalette("auto")} title="Chosen to suit the song: fast and loud is warm, slow is cool">
                  <span className="os-mv-swatch auto" aria-hidden="true" />Let the song choose
                </button>
                {(ready?.palettes ?? []).map((entry) => (
                  <button key={entry.id} type="button" role="radio" aria-checked={palette === entry.id} className={`os-mv-palette${palette === entry.id ? " on" : ""}`} onClick={() => setPalette(entry.id)}>
                    <span className="os-mv-swatch" style={{ background: `linear-gradient(135deg, ${entry.top}, ${entry.bottom})` }} aria-hidden="true" />{entry.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="os-mv-two">
              <div className="os-field">
                <span className="os-label">Size</span>
                <div className="os-mv-seg" role="radiogroup" aria-label="Size">
                  <button type="button" role="radio" aria-checked={height === 1080} className={height === 1080 ? "on" : ""} onClick={() => setHeight(1080)}>1080p</button>
                  <button type="button" role="radio" aria-checked={height === 720} className={height === 720 ? "on" : ""} onClick={() => setHeight(720)}>720p, quicker</button>
                </div>
              </div>
              <label className="os-mv-check os-mv-cover">
                <input type="checkbox" checked={cover} onChange={(event) => setCover(event.target.checked)} />
                <span>Show the song&apos;s cover art in the middle, if it has some</span>
              </label>
            </div>

            {problem ? <p className="os-mv-problem" role="alert">{problem}</p> : null}

            <div className="os-mv-actions">
              <button type="button" className="os-btn" disabled={hindrance !== null} onClick={() => void make(true)} title={`Make the first ${previewSeconds} seconds, to try the look`}>
                <Icon name="play" size={16} />Try {previewSeconds} seconds
              </button>
              <button type="button" className="os-btn os-btn-primary" disabled={hindrance !== null} onClick={() => void make(false)}>
                <Icon name="bolt" size={16} />{replace ? "Make it again" : "Make the video"}
              </button>
            </div>
            {hindrance && song ? <p className="os-mv-note os-faint">{hindrance}</p> : null}
          </div>
        </section>

        <section className="os-panel os-mv-stage" aria-label="The video" aria-live="polite">
          <div className="os-panel-head">
            <h2 className="os-panel-title">{running ? "Being made" : shownEntry ? "Your video" : "The video"}</h2>
            {running ? <button type="button" className="os-btn os-btn-sm os-btn-danger" disabled={job.cancelling} onClick={() => void stop()}><Icon name="stop" size={14} />{job.cancelling ? "Stopping" : "Stop"}</button> : null}
          </div>
          <div className="os-panel-body os-mv-body">
            {job.status === "running" ? <Progress job={job} /> : null}
            {job.status === "failed" ? (
              <div className="os-mv-notice danger" role="alert">
                <Icon name="alert" size={16} />
                <p><strong>The video could not be made.</strong> {job.reason}</p>
              </div>
            ) : null}
            {job.status === "cancelled" && !shownEntry ? (
              <div className="os-mv-notice" role="status"><Icon name="info" size={16} /><p>Stopped. Nothing was kept.</p></div>
            ) : null}

            {!running && shownEntry ? (
              <div className="os-mv-result">
                <video key={shownEntry.video} className="os-mv-player" controls preload="metadata" poster={shownEntry.thumbnail ? mediaUrl(shownEntry.thumbnail) : undefined} src={mediaUrl(shownEntry.video)} />
                <div className="os-mv-meta">
                  <div>
                    <strong>{shownEntry.title}</strong>
                    {shownEntry.artist ? <span className="os-dim"> - {shownEntry.artist}</span> : null}
                    {shownEntry.preview ? <span className="os-chip accent os-mv-tag">Preview</span> : null}
                  </div>
                  <span className="os-mono os-faint">{formatClock(shownEntry.seconds)} - {shownEntry.height}p - {formatSize(shownEntry.bytes)}</span>
                </div>
                {shownEntry.warnings.length > 0 ? (
                  <ul className="os-mv-warnings">
                    {shownEntry.warnings.map((warning) => <li key={warning}><Icon name="info" size={14} />{warning}</li>)}
                  </ul>
                ) : null}
                <div className="os-mv-actions">
                  <button type="button" className="os-btn" onClick={() => go("files", shownEntry.folder)}><Icon name="external" size={15} />Show in Files</button>
                  {shownEntry.preview && song && !hindrance ? <button type="button" className="os-btn os-btn-primary" onClick={() => void make(false)}><Icon name="bolt" size={16} />Make the whole video</button> : null}
                </div>
              </div>
            ) : null}

            {!running && !shownEntry && job.status !== "failed" && job.status !== "cancelled" ? (
              <div className="os-empty os-mv-empty">
                <Icon path="M4 6h11v12H4zM15 10l5-3v10l-5-3" size={30} />
                <strong>Your video will play here</strong>
                <p>A ring of bars that moves with the song, its title in the middle, and the words lit as they are sung. It takes a minute or two for each minute of music, and the PC stays usable while it is made.</p>
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <section className="os-panel os-mv-library" aria-label="Videos already made">
        <div className="os-panel-head">
          <h2 className="os-panel-title">Made so far</h2>
          <span className="os-faint os-mono">{library.length}</span>
        </div>
        <div className="os-panel-body">
          {library.length === 0 ? (
            <div className="os-empty"><strong>Nothing yet</strong><p>The videos you make are kept here, in the music-videos folder of TRH AI&apos;s workspace, with the song, so that any of them can be made again with the lyrics fixed.</p></div>
          ) : (
            <ul className="os-mv-cards">
              {library.map((entry) => (
                <li key={entry.folder} className="os-mv-card">
                  <button type="button" className="os-mv-thumb" onClick={() => { setShown(shownFromEntry(entry)); formTop.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }} aria-label={`Play ${entry.title}`}>
                    {entry.thumbnail
                      // eslint-disable-next-line @next/next/no-img-element -- a picture from this PC's disk, served by the local API: nothing for Next to optimise
                      ? <img src={mediaUrl(entry.thumbnail)} alt="" loading="lazy" />
                      : <span className="os-mv-nothumb" />}
                    <span className="os-mv-time os-mono">{formatClock(entry.seconds)}</span>
                  </button>
                  <div className="os-mv-card-text">
                    <strong>{entry.title}</strong>
                    <span className="os-faint">{entry.artist || "No artist"}{entry.preview ? " - preview" : ""} - {madeWhen(entry.madeAt, now)}</span>
                  </div>
                  <div className="os-mv-card-actions">
                    <button type="button" className="os-btn os-btn-sm" onClick={() => again(entry)} title="Load its song and lyrics into the form, to change them and make it again"><Icon name="pencil" size={13} />Change and remake</button>
                    <button type="button" className="os-btn os-btn-sm os-btn-ghost" onClick={() => go("files", entry.folder)}><Icon name="external" size={13} />Files</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </ViewFrame>
  );
}

function Progress({ job }: { job: Extract<Job, { status: "running" }> }) {
  const left = remainingText(job.elapsedSeconds, job.fraction);
  return (
    <div className="os-mv-progress">
      <div className="os-mv-progress-head">
        <span className="os-chip accent">{job.preview ? "Preview - " : ""}{stageWords[job.stage]}</span>
        <span className="os-mono os-faint">{formatClock(job.elapsedSeconds)}{left ? ` - ${left}` : ""}</span>
      </div>
      <div className="os-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.fraction * 100)}><span style={{ width: `${Math.max(2, Math.round(job.fraction * 100))}%` }} /></div>
      <p className="os-mv-note">{job.message}</p>
      <p className="os-mv-note os-faint">&ldquo;{job.title}&rdquo; is being drawn on this PC&apos;s processor, at low priority, so TRH AI and everything else stay usable. You can leave this screen: it carries on, and you will be told when it is done.</p>
    </div>
  );
}
