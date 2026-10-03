import type { Metadata } from "next";
import { themeBootScript } from "../lib/theme";
// The fonts, from files in this repo (public/fonts): Geist and Geist Mono for
// what is read at length, Orbitron and Oxanium - the system's display faces -
// for names, states and headings. Not next/font/google: that downloads them
// from Google whenever a build has no cached copy of them, so with no network,
// or on a day that download failed, the app did not build.
import "./fonts.css";
import "./globals.css";

/** The files every page needs at once: the Latin part of each face. The rest load when a page uses them. */
const preloadedFonts = ["geist-latin", "geist-mono-latin", "orbitron-latin", "oxanium-latin"];

export const metadata: Metadata = {
  title: "TRH AI",
  description: "TRH AI - a living intelligence system that runs on this PC."
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className="h-full"
      // The theme-boot script in <head> sets data-accent and data-backdrop
      // from localStorage before React hydrates, which the server has no way
      // to know in advance. Those attributes are expected to differ on first
      // paint — this is the documented pattern for exactly that, and it is
      // scoped to <html> rather than being a blanket "ignore hydration issues
      // here".
      // Nothing else in the tree relies on it: the clocks that used to
      // mismatch now render nothing until mounted instead.
      suppressHydrationWarning
    >
      <head>
        {/* Applies a saved accent before first paint so switching it does not
            flash cyan for a frame on every reload.

            dangerouslySetInnerHTML rather than next/script: passing the code
            as *children* is what React 19 objects to — "Encountered a script
            tag while rendering React component" — and it did so through
            next/script too, which was the previous attempt at avoiding it.
            Set as inner HTML in <head> it is the ordinary App Router pattern
            for this, runs before first paint, and warns about nothing.

            Reads one known-shaped localStorage key and validates it against
            the fixed accent list; see theme.ts, the only place its content is
            defined. */}
        <script id="theme-boot" dangerouslySetInnerHTML={{ __html: themeBootScript() }} />
        {preloadedFonts.map((name) => (
          <link key={name} rel="preload" href={`/fonts/${name}.woff2`} as="font" type="font/woff2" crossOrigin="anonymous" />
        ))}
      </head>
      <body className="h-full">
        <div id="trhai-root">
          {children}
        </div>
      </body>
    </html>
  );
}
