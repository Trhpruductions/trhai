// Updates: what is new in the version running, and whether a newer one is out.
//
// The notes travel inside the app (packages/shared/src/releaseNotes.ts), so
// the "What's new" notice needs nothing from the network. The check for a
// newer version reads the public releases of Trhpruductions/trhai on GitHub:
// one unauthenticated request, no key, nothing about the user sent beyond
// what any download sends. The repo is public, so this works from any PC.
// TRHAI_UPDATE_FEED_URL points it elsewhere (anything answering in GitHub's
// release shape); TRHAI_UPDATE_CHECK=off stops the network check entirely,
// and the notes still show.
//
// The answer is cached for six hours. Checking is cheap, but a popup that
// re-appears every time the app is opened is not.

import { compareVersions, isRequiredReleaseText, notesUpTo, releaseNotes, type ReleaseNote } from "@ascend/shared";
import { getBuildInfo } from "./buildInfo.js";

export type LatestRelease = {
  version: string;
  /** The release page. */
  url: string;
  /** The Windows installer attached to the release, when there is one. */
  downloadUrl: string | null;
  publishedAt: string | null;
  /** The release's own notes, as written on GitHub. */
  notes: string;
  /**
   * The release page carries the required-update line (`requiredUpdateLine` in
   * releaseNotes.ts): an installed copy older than it downloads it by itself
   * and restarts into it, where it would otherwise only offer it.
   */
  required: boolean;
};

export type UpdateCheck = {
  currentVersion: string;
  /** Notes for the running version and the ones before it, newest first. */
  notes: ReleaseNote[];
  latest: LatestRelease | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  /** Why the check did not happen or failed, in a sentence; null when it went fine. */
  checkError: string | null;
  checkDisabled: boolean;
};

const defaultFeedUrl = "https://api.github.com/repos/Trhpruductions/trhai/releases/latest";
const cacheMs = 6 * 60 * 60 * 1000;
const timeoutMs = 8000;

type Cached = { latest: LatestRelease | null; checkedAt: string; error: string | null };
let cached: Cached | null = null;
let inFlight: Promise<Cached> | null = null;

/** The product version: the installer's when installed, the desktop app's package.json from a checkout. */
export function currentVersion(): string {
  const fromEnv = process.env.TRHAI_VERSION?.trim();
  if (fromEnv) return fromEnv;
  const desktop = getBuildInfo().desktopVersion;
  return desktop && desktop !== "unknown" ? desktop : "0.0.0";
}

function checkDisabled(): boolean {
  return process.env.TRHAI_UPDATE_CHECK === "off";
}

type GitHubRelease = {
  tag_name?: unknown;
  name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  body?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: Array<{ name?: unknown; browser_download_url?: unknown }>;
};

/** Reads GitHub's release shape into ours; null when it is not a usable release. */
export function parseRelease(value: unknown): LatestRelease | null {
  const release = value as GitHubRelease | null;
  if (!release || typeof release !== "object") return null;
  if (release.draft === true) return null;
  const tag = typeof release.tag_name === "string" ? release.tag_name.trim() : "";
  const version = tag.replace(/^v/i, "");
  if (!/^\d+(\.\d+)*/.test(version)) return null;
  const url = typeof release.html_url === "string" ? release.html_url : "";
  if (!/^https:\/\//.test(url)) return null;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const installer = assets.find((asset) => typeof asset?.name === "string" && /setup.*\.exe$/i.test(asset.name))
    ?? assets.find((asset) => typeof asset?.name === "string" && /\.exe$/i.test(asset.name));
  const downloadUrl = installer && typeof installer.browser_download_url === "string" && /^https:\/\//.test(installer.browser_download_url)
    ? installer.browser_download_url
    : null;
  const body = typeof release.body === "string" ? release.body : "";
  return {
    version,
    url,
    downloadUrl,
    publishedAt: typeof release.published_at === "string" ? release.published_at : null,
    notes: body.trim().slice(0, 4000),
    // Read from the whole page, not the part that is kept.
    required: isRequiredReleaseText(body)
  };
}

async function fetchLatest(fetcher: typeof fetch): Promise<Cached> {
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(process.env.TRHAI_UPDATE_FEED_URL?.trim() || defaultFeedUrl, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `TRH-AI/${currentVersion()}` },
      signal: controller.signal
    });
    if (response.status === 404) return { latest: null, checkedAt, error: "No release has been published yet." };
    if (!response.ok) return { latest: null, checkedAt, error: `The release feed answered ${response.status}.` };
    const latest = parseRelease(await response.json());
    return latest
      ? { latest, checkedAt, error: null }
      : { latest: null, checkedAt, error: "The release feed did not describe a release." };
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError" ? "took too long to answer" : "could not be reached";
    return { latest: null, checkedAt, error: `The release feed ${reason}. TRH AI will try again later.` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the Updates section and the popups show. `refresh` ignores the cache,
 * for a "Check now" button. The fetcher is a parameter so the tests never
 * touch the network.
 */
export async function checkForUpdates(options: { refresh?: boolean; fetcher?: typeof fetch; now?: Date } = {}): Promise<UpdateCheck> {
  const version = currentVersion();
  const notes = notesUpTo(version, 5, releaseNotes);
  const base = { currentVersion: version, notes, checkDisabled: checkDisabled() };
  if (base.checkDisabled) {
    return { ...base, latest: null, updateAvailable: false, checkedAt: null, checkError: "Checking for updates is switched off (TRHAI_UPDATE_CHECK=off)." };
  }
  const now = options.now ?? new Date();
  const fresh = cached && now.getTime() - Date.parse(cached.checkedAt) < cacheMs;
  if (!fresh || options.refresh) {
    inFlight ??= fetchLatest(options.fetcher ?? fetch).then((result) => {
      cached = result;
      inFlight = null;
      return result;
    });
    await inFlight;
  }
  const result = cached as Cached;
  const updateAvailable = Boolean(result.latest && compareVersions(result.latest.version, version) > 0);
  return { ...base, latest: result.latest, updateAvailable, checkedAt: result.checkedAt, checkError: result.error };
}

/** Forget the cached answer, so a test can start clean. */
export function resetUpdatesForTests(): void {
  cached = null;
  inFlight = null;
}
