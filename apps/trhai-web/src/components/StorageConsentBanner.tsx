"use client";

import { useEffect, useState } from "react";
import { legalVersions } from "@ascend/shared";
import { useNav } from "../os/state/nav";
import { useLegal } from "./LegalDialog";
import { browserStorage, readStorageConsent, storageConsentEvent, writeStorageConsent } from "../lib/storageConsent";
import "./legal.css";

// The question asked once, the first time the app opens: may it remember your choices?
//
// TRH AI sets no cookies, so this is not a cookie banner in the usual sense; it is about
// the few settings kept in the window's storage. It does not stand in the way of anything,
// the two answers are given the same weight, and until one is given the optional settings
// are simply not kept (storageConsent.ts). The answer can be changed at any time under
// Settings, Privacy and consent.

export function StorageConsentBanner() {
  // null until mounted: the server cannot know what the window has stored.
  const [answered, setAnswered] = useState<boolean | null>(null);
  const { openLegal } = useLegal();
  const { go } = useNav();

  useEffect(() => {
    const read = () => setAnswered(readStorageConsent(browserStorage().local) !== null);
    read();
    window.addEventListener(storageConsentEvent, read);
    return () => window.removeEventListener(storageConsentEvent, read);
  }, []);

  if (answered !== false) return null;

  const answer = (decision: "all" | "essential") => {
    const { local, session } = browserStorage();
    writeStorageConsent(local, session, decision, legalVersions.storage);
    setAnswered(true);
  };

  return (
    <aside className="storage-consent" aria-labelledby="storage-consent-title">
      <div className="storage-consent-text">
        <h2 id="storage-consent-title" className="storage-consent-title">Remember your choices?</h2>
        <p>
          TRH AI sets no cookies. It can keep a few of your choices in this window&rsquo;s storage - your accent colour, the voice, how
          the screen is arranged. Nothing is sent anywhere. Until you answer, choices last for this session only.{" "}
          <button type="button" className="legal-inline-link" onClick={() => openLegal("storage")}>What is kept</button>
        </p>
      </div>
      <div className="storage-consent-actions">
        <button type="button" className="os-btn" onClick={() => answer("all")}>Yes, remember them</button>
        <button type="button" className="os-btn" onClick={() => answer("essential")}>Only what is needed</button>
        <button type="button" className="os-btn os-btn-ghost" onClick={() => go("settings", "privacy")}>Choose in Settings</button>
      </div>
    </aside>
  );
}
