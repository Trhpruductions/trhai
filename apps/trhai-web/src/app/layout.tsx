import type { Metadata } from "next";
import { Geist, Geist_Mono, Orbitron } from "next/font/google";
import { AppShell } from "../components/AppShell";
import { themeBootScript } from "../lib/theme";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const orbitron = Orbitron({ variable: "--font-orbitron", subsets: ["latin"], weight: ["500", "700"] });

export const metadata: Metadata = {
  title: "TRHAI",
  description: "A local-first AI command centre."
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${orbitron.variable} h-full`}
      // The theme-boot script in <head> sets data-accent from localStorage
      // before React hydrates, which the server has no way to know in
      // advance. That one attribute is expected to differ on first paint —
      // this is the documented pattern for exactly that, and it is scoped to
      // <html> rather than being a blanket "ignore hydration issues here".
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
          <AppShell>{children}</AppShell>
        </div>
      </body>
    </html>
  );
}
