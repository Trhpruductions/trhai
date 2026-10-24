"use client";

import { useEffect, useRef } from "react";
import { getStatus } from "../lib/musicVideo";
import { useNav } from "../os/state/nav";
import { useNotify } from "../os/state/notify";

// Says so when a music video that was being made is finished, or could not be,
// wherever in the app you are - a video takes minutes, and nobody watches the
// screen it is made on. It only speaks of a video it saw being made: opening
// the app to an old result is not news. And not on the music video screen
// itself, which is showing the result. Renders nothing.

export function MusicVideoWatcher() {
  const { notify } = useNotify();
  const { go, view } = useNav();
  const saw = useRef<string | null>(null);
  const told = useRef<string | null>(null);
  const onScreen = useRef(false);
  useEffect(() => { onScreen.current = view === "music"; }, [view]);

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const look = async () => {
      const result = await getStatus();
      if (stopped) return;
      let again = 15_000;
      if (result.ok) {
        const job = result.data.job;
        if (job.status === "running") {
          saw.current = job.id;
          again = 3_000;
        } else if (job.status !== "idle" && saw.current === job.id && told.current !== job.id) {
          told.current = job.id;
          const open = { label: "Open", run: () => go("music") };
          if (onScreen.current) {
            // The screen is open and shows it.
          } else if (job.status === "done") {
            notify({
              level: "success", source: "Music video", sticky: true, action: { label: "Watch it", run: () => go("music") },
              title: job.result.preview ? "Your preview is ready" : `"${job.result.title}" is ready`,
              body: job.result.warnings.length > 0 ? "It has a note or two to read before you share it." : "The video is in the music-videos folder of TRH AI's workspace."
            });
          } else if (job.status === "failed") {
            notify({ level: "error", source: "Music video", title: "The music video could not be made", body: job.reason, sticky: true, action: open });
          }
        }
      }
      timer = window.setTimeout(() => void look(), again);
    };
    void look();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [notify, go]);

  return null;
}
