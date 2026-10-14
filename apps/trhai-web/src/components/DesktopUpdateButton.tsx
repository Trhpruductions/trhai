"use client";

import { useEffect, useState } from "react";
import { Icon } from "../os/ui/Icon";
import { desktopUpdater, updateAction, type DesktopUpdateStatus } from "../lib/desktopUpdates";
import { openReleaseLink } from "../lib/updates";

// The one button an update needs. In the installed app it downloads the
// update, shows how far it has got, and restarts into it; anywhere else (a
// browser, the portable build, a copy run from source) it opens the release's
// download, as it always did.

export function DesktopUpdateButton({ version, downloadUrl, releaseUrl, small = false }: {
  version: string;
  downloadUrl: string | null;
  releaseUrl: string;
  small?: boolean;
}) {
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);

  useEffect(() => {
    const updater = desktopUpdater();
    if (!updater) return;
    let alive = true;
    void updater.status().then((next) => { if (alive) setStatus(next); }).catch(() => undefined);
    const stop = updater.onStatus((next) => { if (alive) setStatus(next); });
    return () => { alive = false; stop(); };
  }, []);

  const size = small ? " os-btn-sm" : "";
  const action = updateAction(status, version);

  if (action.kind === "link") {
    return (
      <button type="button" className={`os-btn os-btn-primary${size}`} onClick={() => openReleaseLink(downloadUrl ?? releaseUrl)}>
        <Icon name="external" size={small ? 14 : 15} />{downloadUrl ? `Download v${version}` : "See the release"}
      </button>
    );
  }

  const updater = desktopUpdater();
  return (
    <>
      {action.kind === "busy" ? (
        <button type="button" className={`os-btn${size}`} disabled aria-live="polite"><Icon name="down" size={small ? 14 : 15} />{action.label}</button>
      ) : action.kind === "restart" ? (
        <button type="button" className={`os-btn os-btn-primary${size}`} onClick={() => void updater?.install()}>
          <Icon name="refresh" size={small ? 14 : 15} />{action.label}
        </button>
      ) : (
        <button type="button" className={`os-btn os-btn-primary${size}`} onClick={() => void updater?.download().then(setStatus)}>
          <Icon name="down" size={small ? 14 : 15} />{action.label}
        </button>
      )}
      {action.kind === "download" && action.note ? (
        <span className="paywall-note bad" role="alert">
          {action.note}{" "}
          <button type="button" className="os-btn os-btn-ghost os-btn-sm" onClick={() => openReleaseLink(downloadUrl ?? releaseUrl)}>Download it yourself</button>
        </span>
      ) : null}
    </>
  );
}
