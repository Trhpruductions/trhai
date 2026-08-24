import type { Metadata } from "next";
import { Geist, Geist_Mono, Orbitron } from "next/font/google";
import Script from "next/script";
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
      // The beforeInteractive script below sets data-accent from localStorage
      // before React hydrates, which the server has no way to know in
      // advance. That one attribute is expected to differ on first paint —
      // this is the documented pattern for exactly that, not a blanket
      // "ignore hydration issues here".
      suppressHydrationWarning
    >
      <body className="h-full">
        {/* Applies a saved accent before first paint so switching it does not
            flash cyan for a frame on every reload. beforeInteractive is the
            framework's own mechanism for exactly this — a script that must run
            ahead of hydration — rather than a raw <script> tag, which React 19
            refuses to execute when it appears inside a rendered component.
            Reads one known-shaped localStorage key and validates it against the
            fixed accent list; see theme.ts for the only place its content is
            defined. */}
        <Script id="theme-boot" strategy="beforeInteractive">{themeBootScript()}</Script>
        <div id="trhai-root">
          <AppShell>{children}</AppShell>
        </div>
      </body>
    </html>
  );
}
