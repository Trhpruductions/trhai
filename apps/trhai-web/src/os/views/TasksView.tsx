"use client";

import { TaskList, type TaskItem } from "../../components/TaskList";
import { ActiveTasks } from "../../components/CommandPanels";
import { ExecutionTrace } from "../../components/ExecutionTrace";
import { ViewFrame } from "../ui/ViewFrame";
import { useSystem } from "../state/system";
import { useAssistantState } from "../state/assistant";
import { apiDelete, apiPatch, apiPost, sessionId } from "../../lib/api";
import "./views.css";

export function TasksView() {
  const { tasks, setTasks, agentTasks } = useSystem();
  const { executionEvents } = useAssistantState();
  return (
    <ViewFrame id="tasks">
      <div className="os-grid os-split">
        <TaskList
          tasks={tasks}
          onAdd={(title) => void (async () => {
            const result = await apiPost<{ task: TaskItem }>("/v1/tasks", { sessionId: sessionId(), title });
            if (result.ok) setTasks((prior) => [...(prior ?? []), result.data.task]);
          })()}
          onToggle={(id, done) => void (async () => {
            const result = await apiPatch<{ task: TaskItem }>(`/v1/tasks/${id}`, { sessionId: sessionId(), done });
            if (result.ok) setTasks((prior) => prior?.map((task) => (task.id === id ? result.data.task : task)) ?? null);
          })()}
          onRemove={(id) => void (async () => {
            const result = await apiDelete(`/v1/tasks/${id}?sessionId=${encodeURIComponent(sessionId())}`);
            if (result.ok) setTasks((prior) => prior?.filter((task) => task.id !== id) ?? null);
          })()}
        />
        <ActiveTasks tasks={agentTasks} />
      </div>
      <ExecutionTrace events={executionEvents} />
    </ViewFrame>
  );
}
