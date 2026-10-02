import type { Metadata } from "next";
import { Geist, Geist_Mono, Orbitron, Oxanium } from "next/font/google";
import { themeBootScript } from "../lib/theme";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const orbitron = Orbitron({ variable: "--font-orbitron", subsets: ["latin"], weight: ["500", "700"] });
// The system's display face: names, states and headings. Technical without
// shouting; Geist carries everything that is read at length.
const oxanium = Oxanium({ variable: "--font-oxanium", subsets: ["latin"], weight: ["400", "500", "600", "700"] });

export const metadata: Metadata = {
  title: "TRH AI",
  description: "TRH AI - a living intelligence system that runs on this PC."
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${orbitron.variable} ${oxanium.variable} h-full`}
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
      </head>
      <body className="h-full">
        <div id="trhai-root">
          {children}
        </div>
      </body>
    </html>
  );
}
