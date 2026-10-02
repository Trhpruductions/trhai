"use client";

import { CoreStatus, SystemGauges } from "../../components/CorePanels";
import { SystemOverview } from "../../components/CommandPanels";
import { ViewFrame } from "../ui/ViewFrame";
import { VitalsWidget } from "../home/widgets";
import { useSystem } from "../state/system";
import { useAssistantState } from "../state/assistant";
import { useHealth } from "../state/health";
import "../home/home.css";
import "./views.css";

export function SystemView() {
  const { telemetry } = useSystem();
  const { label } = useAssistantState();
  const { rows, health } = useHealth();
  return (
    <ViewFrame id="system">
      <div className="os-grid os-split">
        <section className="os-panel">
          <header className="os-panel-head"><h3 className="os-panel-title">Live vitals</h3></header>
          <div className="os-panel-body"><VitalsWidget expanded /></div>
        </section>
        <div className="os-grid">
          <CoreStatus
            temperatureC={telemetry?.gpu.temperatureC ?? null}
            uptimeSeconds={telemetry?.uptimeSeconds ?? null}
            load={label}
            clockMhz={telemetry?.cpu.speedMhz ?? null}
            cpuModel={telemetry?.cpu.model ?? null}
          />
          <SystemGauges vram={telemetry?.gpu.vram ?? null} disk={telemetry?.disk ?? null} network={telemetry?.network ?? null} health={health} />
          <SystemOverview rows={rows} />
        </div>
      </div>
    </ViewFrame>
  );
}
