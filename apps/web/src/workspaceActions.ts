export type WorkspaceActionKind = "task" | "workflow" | "insight";

export function buildWorkspaceActionPrompt(title: string, detail: string, kind: WorkspaceActionKind): string {
  const actionLabel = kind === "workflow" ? "workflow" : kind === "insight" ? "insight" : "task";
  const normalizedDetail = detail.trim().replace(/[.!?]+$/u, "");
  return `Create a ${actionLabel} for ${title}: ${normalizedDetail}. Provide a concise plan, owner, and next step.`;
}

export function buildWorkspaceActionPayload(title: string, detail: string, kind: WorkspaceActionKind) {
  const actionLabel = kind === "workflow" ? "Workflow" : kind === "insight" ? "Insight" : "Task";
  return {
    memoryTitle: `${actionLabel}: ${title}`,
    memoryBody: `${detail}\n\nIntent: create a ${kind.toLowerCase()} plan for this workspace.`,
    workflowName: `${title} Workflow`,
    workflowDefinition: {
      kind,
      title,
      detail,
      createdBy: "workspace-actions"
    }
  };
}
