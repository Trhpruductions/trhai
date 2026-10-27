// A song picked in the chat, or dropped anywhere in the app.
//
// The chat's paperclip and the drop target only ever took pictures, so a song
// given to either was ignored without a word - and "attach an mp3 to make a
// video" is the first thing anyone tries. A song is not a message attachment:
// the music video maker has its own place for one. This sorts what was given and
// hands the song over, so the first thing that happens is the maker opening with
// the song already loaded.

import { hasExtension } from "./musicVideo";

/** What the music video maker can read. One list: the maker's own picker and the chat's both use it. */
export const songExtensions = [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".aiff"];

/** For a file input's `accept`: a browser's own idea of audio, and the extensions it does not always recognise (.flac, .opus). */
export const acceptedSongTypes = `audio/*,${songExtensions.join(",")}`;

type Named = { name: string; type: string };

/** A file that looks like a song, by what it is called or what the browser says it is. */
export function looksLikeSong(file: Named): boolean {
  return file.type.startsWith("audio/") || hasExtension(file.name, songExtensions);
}

/**
 * Why a song cannot be used, in the maker's own words, or null when it can.
 * `extensions` is what the service reports it can read; the usual list until it has answered.
 */
export function refuseSong(file: Pick<Named, "name">, extensions: readonly string[] = songExtensions): string | null {
  return hasExtension(file.name, [...extensions])
    ? null
    : `That is not a song file this can read. It can read ${extensions.join(", ")}.`;
}

/** Files given to the chat, sorted by what is to be done with each. Order within each kind is kept. */
export function sortGiven<T extends Named>(files: readonly T[]): { images: T[]; songs: T[]; other: T[] } {
  const images: T[] = [];
  const songs: T[] = [];
  const other: T[] = [];
  for (const file of files) {
    if (file.type.startsWith("image/")) images.push(file);
    else if (looksLikeSong(file)) songs.push(file);
    else other.push(file);
  }
  return { images, songs, other };
}

/** What to tell someone about a file that is neither a picture nor a song, or null when there is none. */
export function strayNote(other: readonly Pick<Named, "name">[]): string | null {
  const stray = other[0];
  return stray ? `"${stray.name || "That file"}" is not a picture or a song TRH AI can use here.` : null;
}

// ------------------------------------------------------------ the hand-over
//
// The chat uploads the song and moves to the maker; the maker may not be on
// screen yet, or may already be. So the song waits here, and the maker takes it
// when it opens or - if it is open - when told.

export type HandedSong = { name: string; bytes: number; path: string };

let waiting: HandedSong | null = null;
const listeners = new Set<() => void>();

export function handSongOver(song: HandedSong): void {
  waiting = song;
  for (const listener of [...listeners]) listener();
}

/** The song waiting for the maker, once: taking it empties the place it waits. */
export function takeHandedSong(): HandedSong | null {
  const song = waiting;
  waiting = null;
  return song;
}

/** Called when a song is handed over; returns the way to stop listening. */
export function onSongHandedOver(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
