"use client";

import { DocumentsPanel } from "../../components/DocumentsPanel";
import { MemoryStatus } from "../../components/CommandPanels";
import { ViewFrame } from "../ui/ViewFrame";
import { useSystem } from "../state/system";
import "./views.css";

export function MemoryView() {
  const { memories, documents, workspace, refresh } = useSystem();
  return (
    <ViewFrame id="memory">
      <div className="os-grid os-split">
        <DocumentsPanel onChange={() => void refresh()} />
        <MemoryStatus
          entries={memories?.total ?? null}
          pinned={memories?.pinned ?? null}
          documents={documents}
          workspaceBytes={workspace?.bytes ?? null}
          workspaceFiles={workspace?.files ?? null}
        />
      </div>
    </ViewFrame>
  );
}
