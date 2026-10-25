"use client";

import { useState } from "react";
import { canOpenInProgram, fileKind, parentOf } from "../../lib/files";
import { openOnThisPc, type FileAction } from "../../lib/openFile";
import { useNotify } from "../state/notify";
import { Icon } from "./Icon";

const folderIcon = "M4 7a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z";
const fileIcon = "M6 3.5h8l4 4V20.5H6zM14 3.5v4h4M9 12h6M9 15.5h6";
const pictureIcon = "M4 5h16v14H4zM4 15l4.5-4.5 4 4 2.5-2.5L20 17M15.5 8.5h.01";
const soundIcon = "M9 17V6l10-2v11M9 17a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM19 15a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z";
const videoIcon = "M4 6h11v12H4zM15 10l5-3v10l-5-3";

/**
 * Open a file in the workspace in the program it belongs to, and show it in its
 * folder: two buttons for one file. A folder gets one, to open it. The work is
 * done by the API on this PC, which refuses what is not a place in the
 * workspace or a kind of file that is safe to hand over; what it says is shown.
 */
export function FileActions({ path, folder = false }: { path: string; folder?: boolean }) {
  const { notify } = useNotify();
  const [working, setWorking] = useState<FileAction | null>(null);
  const name = path.split("/").pop() ?? path;
  const run = async (action: FileAction) => {
    setWorking(action);
    const result = await openOnThisPc(path, action);
    setWorking(null);
    if (!result.ok) {
      notify({ level: "error", title: action === "open" ? "Could not open it" : "Could not show it", body: result.reason, source: "FILES" });
    }
  };
  return (
    <>
      {folder || canOpenInProgram(name) ? (
        <button type="button" className="os-btn os-btn-sm" disabled={working !== null} onClick={() => void run("open")}>
          <Icon name="external" size={14} />{folder ? "Open folder" : "Open"}
        </button>
      ) : null}
      {folder ? null : (
        <button type="button" className="os-btn os-btn-sm" disabled={working !== null} onClick={() => void run("reveal")}>
          <Icon path={folderIcon} size={14} />Show in folder
        </button>
      )}
    </>
  );
}

function iconFor(name: string): string {
  const kind = fileKind(name);
  return kind === "image" ? pictureIcon : kind === "audio" ? soundIcon : kind === "video" ? videoIcon : fileIcon;
}

/** The files a reply made, each with the buttons to open it. */
export function MadeFiles({ files }: { files: string[] }) {
  return (
    <div className="os-made-files" role="group" aria-label="Files made for you">
      {files.map((file) => {
        const name = file.split("/").pop() ?? file;
        const where = parentOf(file);
        return (
          <div key={file} className="os-made-file">
            <Icon path={iconFor(name)} size={18} />
            <span className="os-made-file-name" title={file}>{name}</span>
            {where === "." ? null : <span className="os-made-file-where os-faint os-small os-mono" title={file}>{where}</span>}
            <span className="os-made-file-actions"><FileActions path={file} /></span>
          </div>
        );
      })}
    </div>
  );
}
