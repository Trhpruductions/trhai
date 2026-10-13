"use client";

import { useEffect, useState } from "react";
import { Icon } from "../os/ui/Icon";
import { describeLicense, licenseEvent, readLicense, type LicenseStatus } from "../lib/license";
import { BuyButton, LicenseKeyForm } from "./BillingPanel";
import "./paywall.css";

// What stands in front of the app once the trial or the license has run out.
//
// It appears on its own when the API reports the copy locked - read on start,
// every hour, and whenever the window comes back into focus, so a window left
// open past the end of the trial still shows it - and the moment
// a request is refused with 402. Everything underneath stays as it was - the
// conversations, memory and documents are still there to read - but nothing
// new happens until a key is entered. Dismissing it only hides it until the
// next refused request, which keeps the screen honest: it is the state of the
// app, not a nag.

export function PaywallScreen() {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let alive = true;
    const read = (detail?: unknown) => {
      void readLicense().then((next) => {
        if (!alive || !next) return;
        setStatus(next);
        // A refused request brings it back even after "Not now".
        if (detail === "locked") setHidden(false);
      });
    };
    read();
    const onEvent = (event: Event) => read((event as CustomEvent).detail);
    const onFocus = () => read();
    const timer = window.setInterval(read, 60 * 60 * 1000);
    window.addEventListener(licenseEvent, onEvent);
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener(licenseEvent, onEvent);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (!status || !status.locked || hidden) return null;

  const expiredLicense = status.state === "license_expired";
  return (
    <div className="paywall-scrim" role="presentation">
      <section className="paywall" role="dialog" aria-modal="true" aria-labelledby="paywall-title">
        <span className="os-label">{expiredLicense ? "License expired" : "Trial ended"}</span>
        <h2 id="paywall-title">{expiredLicense ? "Your TRH AI license has run out." : "Your free trial of TRH AI has ended."}</h2>
        <p className="paywall-lead">{describeLicense(status)}</p>
        <p>
          Everything TRH AI holds for you is still here to read. To keep talking to it, building with it and running what it
          built, this PC needs a license key.
        </p>
        <ul className="paywall-points">
          <li><Icon name="ok" size={15} />Runs entirely on this PC. No account, no cloud, nothing of yours leaves it.</li>
          <li><Icon name="ok" size={15} />One key unlocks this PC for good on a plan without an end date.</li>
          <li><Icon name="ok" size={15} />Paying happens in your browser; TRH AI never handles the card.</li>
        </ul>
        <div className="os-view-actions">
          <BuyButton status={status} />
          <button type="button" className="os-btn os-btn-ghost" onClick={() => setHidden(true)}>Not now</button>
        </div>
        <LicenseKeyForm autoFocus onActivated={() => setHidden(false)} />
      </section>
    </div>
  );
}
