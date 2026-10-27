// "open spotify.com", "go to youtube.com and play some metal", "play Shadows of Ruin on Spotify":
// a request to open a web page, or a music service's search for something, read from the words alone.
//
// No model is asked and none is needed. The address is built here from what the person typed - a domain
// they named, or a search on a service they named - so nothing a page or a model says can send the
// browser somewhere the person did not ask for. Only a message that names the place outright is read as
// a request: "open the door", "open notes.txt" and "play it" are not, and go on to the rest of the app.
//
// What it cannot do is press play. TRH AI has no way into anyone's Spotify or YouTube account, so a
// request to play something opens the service's search for it, and the reply says that is as far as it went.

export type OpenRequest = {
  /** The page to open: always an http or https address, built here. */
  url: string;
  /** What to call it in the reply: "spotify.com", "Spotify". */
  label: string;
  /** Set when the person asked for something to be played. */
  play?: {
    /** The service it was searched on, when it is one this knows how to search; null for any other site. */
    service: string | null;
    /** What to look for; empty when they asked for no one in particular ("play some music"). */
    query: string;
  };
};

type Service = {
  name: string;
  /** How people write it. */
  names: string[];
  /** The domains that are it. */
  domains: string[];
  home: string;
  search: (query: string) => string;
};

const q = encodeURIComponent;

/** The services whose search page can be built from a name. Kept short and real: each address was read off the service's own site. */
const services: Service[] = [
  { name: "Spotify", names: ["spotify"], domains: ["spotify.com", "open.spotify.com"], home: "https://open.spotify.com/", search: (s) => `https://open.spotify.com/search/${q(s)}` },
  { name: "YouTube Music", names: ["youtube music", "yt music"], domains: ["music.youtube.com"], home: "https://music.youtube.com/", search: (s) => `https://music.youtube.com/search?q=${q(s)}` },
  { name: "YouTube", names: ["youtube", "you tube"], domains: ["youtube.com", "youtu.be"], home: "https://www.youtube.com/", search: (s) => `https://www.youtube.com/results?search_query=${q(s)}` },
  { name: "Apple Music", names: ["apple music"], domains: ["music.apple.com"], home: "https://music.apple.com/", search: (s) => `https://music.apple.com/us/search?term=${q(s)}` },
  { name: "SoundCloud", names: ["soundcloud", "sound cloud"], domains: ["soundcloud.com"], home: "https://soundcloud.com/", search: (s) => `https://soundcloud.com/search?q=${q(s)}` },
  { name: "Bandcamp", names: ["bandcamp"], domains: ["bandcamp.com"], home: "https://bandcamp.com/", search: (s) => `https://bandcamp.com/search?q=${q(s)}` },
  { name: "Deezer", names: ["deezer"], domains: ["deezer.com"], home: "https://www.deezer.com/", search: (s) => `https://www.deezer.com/search/${q(s)}` },
  { name: "Tidal", names: ["tidal"], domains: ["tidal.com", "listen.tidal.com"], home: "https://listen.tidal.com/", search: (s) => `https://listen.tidal.com/search?q=${q(s)}` },
  { name: "Amazon Music", names: ["amazon music"], domains: ["music.amazon.com"], home: "https://music.amazon.com/", search: (s) => `https://music.amazon.com/search/${q(s)}` }
];

/**
 * The endings a web address can have, for the ones people actually type. Not every ending: a file
 * name is one dot and a few letters too, and "notes.txt", "app.py", "build.sh", "readme.md" and
 * "report.pdf" must never be taken for a site, so an ending that is also a common file extension
 * (py, sh, md, pl, rs, zip, mov, ...) is left out on purpose.
 */
const webEndings = new Set([
  "com", "org", "net", "edu", "gov", "mil", "int", "io", "co", "tv", "fm", "me", "app", "dev", "ai", "gg", "xyz", "info", "biz",
  "us", "uk", "ca", "au", "nz", "ie", "de", "fr", "es", "it", "nl", "be", "ch", "at", "se", "no", "dk", "fi", "pt", "gr", "cz",
  "jp", "kr", "cn", "in", "br", "mx", "ar", "za", "ru", "ua", "eu", "online", "site", "store", "shop", "blog", "live", "music", "band"
]);

const openVerb = String.raw`(?:open(?:\s+up)?|launch|visit|browse\s+to|navigate\s+to|go\s+to|head\s+to|take\s+me\s+to|pull\s+up|bring\s+up)`;
const politeness = String.raw`(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:i\s+(?:want|need|would\s+like)\s+(?:you\s+)?to\s+)?(?:please\s+)?`;
const playVerb = String.raw`(?:play|stream|listen\s+to|put\s+on|start\s+playing|queue\s+up|blast)`;
// Groups: scheme, host (as typed, www. and all), port, path.
const site = String.raw`(?:the\s+(?:web\s*)?(?:site|page)\s+(?:at\s+)?)?(?:(https?):\/\/)?((?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?::(\d{2,5}))?((?:\/[^\s,;]*)?)`;
const afterTarget = String.raw`(?=$|[\s,;.!?])`;

const openPattern = new RegExp(`^${politeness}${openVerb}\\s+${site}${afterTarget}[\\s,;.!?]*(.*)$`, "i");
// "open the Spotify website" / "open youtube in my browser": a service by name, said as a place on the web.
const openNamedPattern = new RegExp(`^${politeness}${openVerb}\\s+(?:the\\s+)?(.+?)\\s+(?:web\\s*site|website|site|web\\s*player|in\\s+(?:my\\s+|the\\s+)?browser)${afterTarget}[\\s,;.!?]*(.*)$`, "i");
const playOnPattern = new RegExp(`^${politeness}${playVerb}\\s+(.+?)\\s+(?:on|in|with|using|through|from)\\s+(?:the\\s+)?(.+?)(?:\\s+please)?[\\s.!?]*$`, "i");
const playAfterPattern = new RegExp(`^(?:(?:and|then|also)\\s+)?${playVerb}\\s+(.+?)(?:\\s+(?:please|for\\s+me|now))?[\\s.!?]*$`, "i");

function serviceNamed(text: string): Service | null {
  const wanted = text.trim().toLowerCase().replace(/^the\s+/, "").replace(/\s+(?:music\s+)?(?:app|web\s*player|website|site)$/, "").replace(/\.com$/, "").replace(/\s+/g, " ");
  return services.find((service) => service.names.includes(wanted) || service.domains.includes(wanted)) ?? null;
}

function serviceAt(host: string): Service | null {
  const bare = host.toLowerCase().replace(/^www\./, "");
  return services.find((service) => service.domains.includes(bare)) ?? null;
}

const genericThings = new Set(["music", "some music", "songs", "some songs", "something", "anything", "tunes", "some tunes", "stuff", "a song", "a playlist"]);
const pronouns = new Set(["it", "that", "this", "them", "those", "these", "one", "him", "her"]);

/**
 * What to look for, out of how it was asked: "all the songs from the band Shadows of Ruin" is
 * "Shadows of Ruin", "some metal" is "metal". Empty when nothing in particular was asked for
 * ("play some music"), and null when what was named is a pronoun ("play it"), which names nothing
 * and so is not a request this can act on.
 */
export function playQuery(phrase: string): string | null {
  let text = phrase.trim().replace(/[\s.!?,;]+$/, "");
  const leading = [
    /^all(?:\s+of)?\s+(?:the\s+)?/i,
    /^(?:some|any|a\s+bit\s+of|a\s+few)\s+/i,
    /^me\s+(?:some\s+)?/i,
    /^(?:the\s+)?(?:songs?|music|tracks?|albums?|tunes?|stuff|hits|catalog(?:ue)?)\s+(?:by|from|of)\s+/i,
    /^(?:the\s+)?(?:band|artist|group|singer|rapper|duo)\s+/i
  ];
  for (let pass = 0; pass < 6; pass += 1) {
    const before = text;
    for (const pattern of leading) text = text.replace(pattern, "");
    if (text === before) break;
  }
  text = text.trim();
  const lowered = text.toLowerCase();
  if (pronouns.has(lowered)) return null;
  if (!text || genericThings.has(lowered)) return "";
  return text.slice(0, 120);
}

function safeUrl(text: string): URL | null {
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (!/^[a-z0-9.-]+$/.test(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

/** What follows an "open ..." clause: a request to play something, null when it is not one, undefined when there is nothing after. */
function playFrom(rest: string, service: Service | null): OpenRequest["play"] | null | undefined {
  if (!rest.trim()) return undefined;
  const match = playAfterPattern.exec(rest.trim());
  if (!match) return null;
  const query = playQuery(match[1]);
  return query === null ? null : { service: service?.name ?? null, query };
}

/**
 * The page a message asks to be opened, or null when it asks no such thing.
 * Conservative on purpose: a message that only resembles a request goes to the rest of the app.
 */
export function parseOpenRequest(message: string): OpenRequest | null {
  const text = message.trim();
  if (text.length === 0 || text.length > 400 || /[\r\n]/.test(text)) return null;

  // "play X on Spotify": the service is named, the address is its search.
  const playOn = playOnPattern.exec(text);
  if (playOn) {
    const service = serviceNamed(playOn[2]);
    const query = playQuery(playOn[1]);
    if (!service || query === null) return null;
    return {
      url: query ? service.search(query) : service.home,
      label: service.name,
      play: { service: service.name, query }
    };
  }

  // "open spotify.com ...", with or without a request to play something after it.
  const named = openPattern.exec(text);
  if (named) {
    const [, scheme, typedHost, port, path = "", rest = ""] = named;
    const host = typedHost.toLowerCase();
    if (!webEndings.has(host.slice(host.lastIndexOf(".") + 1))) return null;
    const service = serviceAt(host);
    const play = playFrom(rest, service);
    if (play === null) return null;
    if (play && service && play.query) {
      return { url: service.search(play.query), label: service.name, play };
    }
    const url = safeUrl(`${scheme ? scheme.toLowerCase() : "https"}://${host}${port ? `:${port}` : ""}${path}`);
    if (!url) return null;
    return { url: url.toString(), label: host + (port ? `:${port}` : "") + (path && path !== "/" ? path : ""), ...(play ? { play } : {}) };
  }

  // "open the Spotify website", "open youtube in my browser", and then maybe "and play ...".
  const byName = openNamedPattern.exec(text);
  if (byName) {
    const service = serviceNamed(byName[1]);
    if (!service) return null;
    const play = playFrom(byName[2] ?? "", service);
    if (play === null) return null;
    return { url: play?.query ? service.search(play.query) : service.home, label: service.name, ...(play ? { play } : {}) };
  }
  return null;
}

/** What the reply says: what was opened, and - honestly - that playing it is not something this can do. */
export function describeOpened(request: OpenRequest): string {
  const { play } = request;
  if (!play) return `Opened ${request.label} in your browser.`;
  if (!play.service) {
    return `Opened ${request.label} in your browser. I only know how to search ${serviceList()}, so I did not look for anything there - `
      + "and I cannot press play for you in any case.";
  }
  const cannot = `I can't press play for you - TRH AI has no way into your ${play.service} account - so choose it from the results and press Play there.`;
  return play.query
    ? `Opened ${play.service}'s search for "${play.query}" in your browser. ${cannot}`
    : `Opened ${play.service} in your browser. ${cannot}`;
}

function serviceList(): string {
  const names = services.map((service) => service.name);
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
