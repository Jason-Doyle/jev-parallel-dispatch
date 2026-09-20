import {
  type CrisisDispatchResult,
  type CrisisFrameMetrics,
  CrisisSimulation,
  type CrisisSnapshot,
  cloneCrisisSnapshot,
  type IncidentKind,
  incidentLabel,
  type ResponderRole,
} from "../shared/crisis";

interface CrisisPalette {
  background: string;
  districtA: string;
  districtB: string;
  road: string;
  headquarters: string;
  text: string;
  muted: string;
}

const palette: CrisisPalette = {
  background: "#091012",
  districtA: "#111c20",
  districtB: "#142329",
  road: "#26363c",
  headquarters: "#f6bf4f",
  text: "#eef5f6",
  muted: "#8fa3aa",
};

const roleColours: Record<ResponderRole, string> = {
  medic: "#67d59c",
  engineer: "#f6bf4f",
  firefighter: "#ff6f61",
  scout: "#54b7ff",
};

const incidentColours: Record<IncidentKind, string> = {
  fire: "#ff5e4d",
  medical: "#59d791",
  infrastructure: "#f6bf4f",
  search: "#56b8ff",
};

export class CrisisView {
  private simulation: CrisisSimulation;
  private dispatch: CrisisDispatchResult | null = null;
  private decisionByUnit = new Map<string, CrisisDispatchResult["decisions"][number]>();
  private animationFrame = 0;
  private priorTimestamp = 0;
  private accumulator = 0;
  private paused = true;
  private speed = 1;
  private lastNotificationAt = 0;
  private readonly context: CanvasRenderingContext2D;

  public constructor(
    private readonly canvas: HTMLCanvasElement,
    unitCount: number,
    private readonly onMetrics: (metrics: CrisisFrameMetrics, snapshot: CrisisSnapshot) => void,
  ) {
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas 2D rendering is unavailable.");
    }

    this.context = context;
    this.simulation = new CrisisSimulation(unitCount);
    this.animationFrame = requestAnimationFrame(this.frame);
  }

  public snapshot(): CrisisSnapshot {
    return cloneCrisisSnapshot(this.simulation.state);
  }

  public reset(unitCount: number): void {
    this.simulation.reset(unitCount);
    this.dispatch = null;
    this.decisionByUnit.clear();
    this.paused = true;
    this.priorTimestamp = 0;
    this.accumulator = 0;
    this.notify();
  }

  public setSpeed(speed: number): void {
    this.speed = Math.max(0.25, Math.min(8, speed));
  }

  public togglePause(): boolean {
    this.paused = !this.paused;
    return this.paused;
  }

  public setPaused(paused: boolean): void {
    this.paused = paused;
  }

  public applyDispatch(dispatch: CrisisDispatchResult): void {
    this.dispatch = dispatch;
    this.decisionByUnit = new Map(
      dispatch.decisions.map((decision) => [decision.unitId, decision]),
    );
    this.simulation.applyAssignments(
      dispatch.decisions.map((decision) => ({
        unitId: decision.unitId,
        taskId: decision.assignedTaskId,
      })),
    );
    this.notify();
  }

  public destroy(): void {
    cancelAnimationFrame(this.animationFrame);
  }

  private readonly frame = (timestamp: number): void => {
    const elapsed =
      this.priorTimestamp === 0 ? 0 : Math.min(0.1, (timestamp - this.priorTimestamp) / 1_000);
    this.priorTimestamp = timestamp;

    if (!this.paused) {
      this.accumulator += elapsed * this.speed;
      const step = 1 / 30;

      while (this.accumulator >= step) {
        this.simulation.step(step);
        this.accumulator -= step;
      }
    }

    this.render();
    if (timestamp - this.lastNotificationAt >= 150) {
      this.notify();
      this.lastNotificationAt = timestamp;
    }
    this.animationFrame = requestAnimationFrame(this.frame);
  };

  private notify(): void {
    this.onMetrics(this.simulation.metrics(), this.snapshot());
  }

  private render(): void {
    this.context.fillStyle = palette.background;
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const transform = this.transform();

    this.context.save();
    this.context.translate(transform.offsetX, transform.offsetY);
    this.context.scale(transform.scale, transform.scale);
    this.drawDistricts();
    this.drawHeadquarters();
    this.drawAssignmentLines();
    this.drawIncidents();
    this.drawUnits();
    this.context.restore();
    this.drawHud();
  }

  private drawDistricts(): void {
    const width = this.simulation.state.width;
    const height = this.simulation.state.height;
    const columns = 4;
    const rows = 3;
    const districtWidth = width / columns;
    const districtHeight = height / rows;

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        this.context.fillStyle = (row + column) % 2 === 0 ? palette.districtA : palette.districtB;
        this.context.fillRect(
          column * districtWidth + 7,
          row * districtHeight + 7,
          districtWidth - 14,
          districtHeight - 14,
        );
      }
    }

    this.context.strokeStyle = palette.road;
    this.context.lineWidth = 9;
    for (let column = 1; column < columns; column += 1) {
      this.context.beginPath();
      this.context.moveTo(column * districtWidth, 0);
      this.context.lineTo(column * districtWidth, height);
      this.context.stroke();
    }
    for (let row = 1; row < rows; row += 1) {
      this.context.beginPath();
      this.context.moveTo(0, row * districtHeight);
      this.context.lineTo(width, row * districtHeight);
      this.context.stroke();
    }
  }

  private drawHeadquarters(): void {
    const x = this.simulation.state.width / 2;
    const y = this.simulation.state.height - 48;
    this.context.fillStyle = `${palette.headquarters}28`;
    this.context.strokeStyle = palette.headquarters;
    this.context.lineWidth = 3;
    this.context.beginPath();
    this.context.arc(x, y, 36, 0, Math.PI * 2);
    this.context.fill();
    this.context.stroke();
    this.context.fillStyle = palette.headquarters;
    this.context.font = "700 14px ui-monospace, monospace";
    this.context.textAlign = "center";
    this.context.textBaseline = "middle";
    this.context.fillText("HQ", x, y);
  }

  private drawAssignmentLines(): void {
    if (!this.dispatch) {
      return;
    }

    for (const unit of this.simulation.state.units) {
      const decision = this.decisionByUnit.get(unit.id);
      const incident = this.simulation.state.incidents.find(
        (candidate) => candidate.id === unit.assignmentId,
      );
      if (!decision || !incident) {
        continue;
      }

      this.context.strokeStyle = `${roleColours[unit.role]}${alphaHex(
        0.12 + decision.confidence * 0.35,
      )}`;
      this.context.lineWidth = 1.5;
      this.context.beginPath();
      this.context.moveTo(unit.x, unit.y);
      this.context.lineTo(incident.x, incident.y);
      this.context.stroke();
    }
  }

  private drawIncidents(): void {
    for (const incident of this.simulation.state.incidents) {
      const colour = incidentColours[incident.kind];
      const radius = 17 + Math.min(20, incident.severity / 8);
      this.context.fillStyle = `${colour}2e`;
      this.context.strokeStyle = colour;
      this.context.lineWidth = 3;
      this.context.beginPath();
      this.context.arc(incident.x, incident.y, radius, 0, Math.PI * 2);
      this.context.fill();
      this.context.stroke();

      this.context.fillStyle = palette.text;
      this.context.font = "700 11px ui-monospace, monospace";
      this.context.textAlign = "center";
      this.context.textBaseline = "middle";
      this.context.fillText(incident.kind.slice(0, 3).toUpperCase(), incident.x, incident.y - 2);
      this.context.fillStyle = palette.muted;
      this.context.font = "10px ui-monospace, monospace";
      this.context.fillText(Math.round(incident.severity).toString(), incident.x, incident.y + 12);
    }
  }

  private drawUnits(): void {
    for (const unit of this.simulation.state.units) {
      const decision = this.decisionByUnit.get(unit.id);
      const radius = 5.5 + (decision?.confidence ?? 0) * 2.5;
      this.context.fillStyle = roleColours[unit.role];
      this.context.beginPath();
      this.context.arc(unit.x, unit.y, radius, 0, Math.PI * 2);
      this.context.fill();

      if (decision && decision.modelChoice !== decision.assignedTaskId) {
        this.context.strokeStyle = "#ffffff";
        this.context.lineWidth = 1.5;
        this.context.stroke();
      }
    }
  }

  private drawHud(): void {
    const metrics = this.simulation.metrics();
    this.context.fillStyle = "#050708c4";
    this.context.fillRect(12, 12, 455, 46);
    this.context.fillStyle = palette.text;
    this.context.font = "600 16px ui-monospace, monospace";
    this.context.textAlign = "left";
    this.context.textBaseline = "middle";
    this.context.fillText(
      `TIME ${formatTime(metrics.timeRemaining)}  ACTIVE ${metrics.activeIncidents}  RESOLVED ${metrics.resolvedIncidents}  FAILED ${metrics.failedIncidents}`,
      24,
      35,
    );

    if (metrics.finished) {
      this.context.fillStyle = "#050708cc";
      this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.context.fillStyle = palette.text;
      this.context.textAlign = "center";
      this.context.font = "700 34px system-ui, sans-serif";
      this.context.fillText(
        "OPERATION COMPLETE",
        this.canvas.width / 2,
        this.canvas.height / 2 - 15,
      );
      this.context.font = "16px system-ui, sans-serif";
      this.context.fillText(
        `Score ${metrics.score} | ${metrics.civilianLosses} civilian losses`,
        this.canvas.width / 2,
        this.canvas.height / 2 + 25,
      );
    }
  }

  private transform(): { scale: number; offsetX: number; offsetY: number } {
    const scale = Math.min(
      this.canvas.width / this.simulation.state.width,
      this.canvas.height / this.simulation.state.height,
    );
    return {
      scale,
      offsetX: (this.canvas.width - this.simulation.state.width * scale) / 2,
      offsetY: (this.canvas.height - this.simulation.state.height * scale) / 2,
    };
  }
}

export function assignmentCounts(
  result: CrisisDispatchResult,
): Array<{ taskId: string; count: number }> {
  const counts = new Map<string, number>();
  for (const decision of result.decisions) {
    counts.set(decision.assignedTaskId, (counts.get(decision.assignedTaskId) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([taskId, count]) => ({ taskId, count }))
    .sort((first, second) => second.count - first.count);
}

export function incidentName(snapshot: CrisisSnapshot, taskId: string): string {
  if (taskId === "hold" || taskId === "recover") {
    return taskId;
  }

  const incident = snapshot.incidents.find((candidate) => candidate.id === taskId);
  return incident ? `${incidentLabel(incident.kind)} ${incident.id.slice(-3)}` : taskId;
}

function formatTime(seconds: number): string {
  const whole = Math.ceil(seconds);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

function alphaHex(value: number): string {
  return Math.round(Math.max(0, Math.min(1, value)) * 255)
    .toString(16)
    .padStart(2, "0");
}
