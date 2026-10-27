import test from "node:test";
import assert from "node:assert/strict";
import { describeOpened, parseOpenRequest, playQuery } from "../src/services/openSiteRequest.js";

// What counts as a request to open a page or to play something on a service, and what the reply says about it.

test("the sentence that came back as a four-step plan opens Spotify's search for the band", () => {
  const request = parseOpenRequest("open spotify.com, and stream all the songs from the band Shadows of Ruin");
  assert.ok(request);
  assert.equal(request.url, "https://open.spotify.com/search/Shadows%20of%20Ruin");
  assert.equal(request.label, "Spotify");
  assert.deepEqual(request.play, { service: "Spotify", query: "Shadows of Ruin" });
});

test("a page named by its address opens as typed, with its www, port and path", () => {
  assert.equal(parseOpenRequest("open spotify.com")?.url, "https://spotify.com/");
  assert.equal(parseOpenRequest("take me to github.com")?.url, "https://github.com/");
  assert.equal(parseOpenRequest("Can you please open https://www.example.com/path?x=1&y=2")?.url, "https://www.example.com/path?x=1&y=2");
  assert.equal(parseOpenRequest("open https://www.example.com:8080/a/b?c=d")?.url, "https://www.example.com:8080/a/b?c=d");
  assert.equal(parseOpenRequest("visit http://example.org/")?.url, "http://example.org/", "an http address the person typed is kept");
  assert.equal(parseOpenRequest("OPEN YouTube.COM")?.url, "https://youtube.com/");
});

test("playing something on a named service is that service's search for it", () => {
  const cases: Array<[string, string]> = [
    ["play Shadows of Ruin on Spotify", "https://open.spotify.com/search/Shadows%20of%20Ruin"],
    ["stream Shadows of Ruin on spotify.com", "https://open.spotify.com/search/Shadows%20of%20Ruin"],
    ["go to youtube.com and play some metal", "https://www.youtube.com/results?search_query=metal"],
    ["play all the songs by Metallica on youtube", "https://www.youtube.com/results?search_query=Metallica"],
    ["listen to some jazz on soundcloud please", "https://soundcloud.com/search?q=jazz"],
    ["play the band Shadows of Ruin on Apple Music", "https://music.apple.com/us/search?term=Shadows%20of%20Ruin"],
    ["open youtube in my browser and play lo-fi beats", "https://www.youtube.com/results?search_query=lo-fi%20beats"],
    ["I want you to open spotify.com and play Shadows of Ruin", "https://open.spotify.com/search/Shadows%20of%20Ruin"]
  ];
  for (const [message, url] of cases) assert.equal(parseOpenRequest(message)?.url, url, message);
});

test("a service named as a place on the web opens its home page", () => {
  assert.equal(parseOpenRequest("open the Spotify website")?.url, "https://open.spotify.com/");
  assert.equal(parseOpenRequest("play some music on spotify")?.url, "https://open.spotify.com/", "nothing in particular asked for: no search");
  assert.equal(parseOpenRequest("open spotify.com and play some music")?.play?.query, "");
});

test("what to look for is what was named, without the words around it", () => {
  assert.equal(playQuery("all the songs from the band Shadows of Ruin"), "Shadows of Ruin");
  assert.equal(playQuery("some metal"), "metal");
  assert.equal(playQuery("the artist Taylor Swift"), "Taylor Swift");
  assert.equal(playQuery("music by Metallica"), "Metallica");
  assert.equal(playQuery("some music"), "", "nothing in particular");
  assert.equal(playQuery("songs"), "");
  assert.equal(playQuery("it"), null, "a pronoun names nothing");
  assert.equal(playQuery("that"), null);
  assert.equal(playQuery("x".repeat(500))?.length, 120, "kept to a length a search takes");
});

test("a message that merely resembles a request is left to the rest of the app", () => {
  const notRequests = [
    // Not a web address: a thing, a file, a folder, an app, an address that is only numbers.
    "open the door", "open notes.txt", "open app.py", "open readme.md", "open report.pdf", "open build.sh", "open it",
    "open the calculator app", "open my downloads folder", "open 192.168.1.1", "open the pod bay doors",
    // Names a service but no address or place, so it could as well mean the app.
    "open spotify",
    // Not the kind of address a browser is sent to.
    "open https://evil.com@good.com", "open javascript:alert(1)", "open file:///C:/Windows/System32/cmd.exe",
    // About opening, not an order to.
    "how do I open spotify.com in a script?", "please explain how to open google.com", "what is spotify.com?",
    // Something to play, but nowhere named, or nothing named to play.
    "play Shadows of Ruin", "play something", "play it on spotify", "play that on youtube", "play a game on steam", "open spotify.com and play it",
    // More to the request than opening it.
    "open spotify.com and then delete my files", "go to settings", "go to bed"
  ];
  for (const message of notRequests) assert.equal(parseOpenRequest(message), null, message);
});

test("only a web ending is taken for a site, never a file extension", () => {
  for (const name of ["notes.txt", "script.py", "build.sh", "readme.md", "main.pl", "lib.rs", "pack.zip", "clip.mov", "doc.docx", "data.csv"]) {
    assert.equal(parseOpenRequest(`open ${name}`), null, name);
  }
  for (const name of ["example.com", "site.org", "thing.io", "band.band", "shop.store", "tv.tv"]) {
    assert.ok(parseOpenRequest(`open ${name}`), name);
  }
});

test("an address built from words can carry nothing but the search", () => {
  const request = parseOpenRequest('play "><script>alert(1)</script> & rm -rf / on spotify');
  assert.ok(request);
  const url = new URL(request.url);
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "open.spotify.com");
  assert.doesNotMatch(request.url, /[<>"\s]/, "everything is escaped");
  assert.equal(decodeURIComponent(url.pathname.replace("/search/", "")), request.play?.query);
});

test("the reply says what was opened, and says plainly that playing is not something it can do", () => {
  const played = parseOpenRequest("open spotify.com, and stream all the songs from the band Shadows of Ruin");
  assert.ok(played);
  const text = describeOpened(played);
  assert.match(text, /Opened Spotify's search for "Shadows of Ruin" in your browser\./);
  assert.match(text, /can't press play for you/);
  assert.match(text, /no way into your Spotify account/);

  assert.equal(describeOpened(parseOpenRequest("open github.com")!), "Opened github.com in your browser.");
  assert.match(describeOpened(parseOpenRequest("open spotify.com and play some music")!), /^Opened Spotify in your browser\. I can't press play/);

  const elsewhere = parseOpenRequest("open example.com and play jazz");
  assert.ok(elsewhere);
  assert.equal(elsewhere.url, "https://example.com/", "the page is opened, nothing is searched on a site that is not known");
  assert.match(describeOpened(elsewhere), /only know how to search Spotify, YouTube Music, YouTube/);
  assert.match(describeOpened(elsewhere), /cannot press play/);
});
