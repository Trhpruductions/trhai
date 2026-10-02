"use client";

import { WorkView } from "../../components/WorkView";
import { ViewFrame } from "../ui/ViewFrame";
import { useAssistantState } from "../state/assistant";
import { useNav } from "../state/nav";
import "./views.css";

export function FilesView() {
  const { busy } = useAssistantState();
  const { go } = useNav();
  return (
    <ViewFrame id="files">
      <div className="os-files-host">
        <WorkView live={busy} onClose={() => go("home")} />
      </div>
    </ViewFrame>
  );
}
