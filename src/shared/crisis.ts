import { z } from "zod";
import type { DecisionMode } from "./decision-types";
import { SeededRandom } from "./random";

export const ResponderRoleSchema = z.enum(["medic", "engineer", "firefighter", "scout"]);
export const IncidentKindSchema = z.enum(["fire", "medical", "infrastructure", "search"]);

export const CrisisUnitSchema = z
  .object({
    id: z.string().regex(/^unit-\d{2}$/),
    role: ResponderRoleSchema,
    x: z.number().min(0).max(1_000),
    y: z.number().min(0).max(620),
    stamina: z.number().min(0).max(100),
    assignmentId: z.string().nullable(),
  })
  .strict();

export const CrisisIncidentSchema = z
  .object({
    id: z.string().regex(/^incident-\d{3}$/),
    kind: IncidentKindSchema,
    x: z.number().min(0).max(1_000),
    y: z.number().min(0).max(620),
    severity: z.number().min(0).max(220),
    growthPerSecond: z.number().min(0).max(10),
    capacity: z.number().int().min(1).max(6),
    createdAt: z.number().nonnegative(),
  })
  .strict();

export const CrisisSnapshotSchema = z
  .object({
    version: z.literal(1),
    seed: z.number().int().nonnegative().max(0xffff_ffff),
    width: z.literal(1_000),
    height: z.literal(620),
    elapsedSeconds: z.number().nonnegative(),
    durationSeconds: z.literal(180),
    score: z.number(),
    resolvedIncidents: z.number().int().nonnegative(),
    failedIncidents: z.number().int().nonnegative(),
    civilianLosses: z.number().int().nonnegative(),
    nextIncidentIndex: z.number().int().nonnegative(),
    nextSpawnAt: z.number().nonnegative(),
    finished: z.boolean(),
    units: z.array(CrisisUnitSchema).min(4).max(48),
    incidents: z.array(CrisisIncidentSchema).max(16),
  })
  .strict();

export type ResponderRole = z.infer<typeof ResponderRoleSchema>;
export type IncidentKind = z.infer<typeof IncidentKindSchema>;
export type CrisisUnit = z.infer<typeof CrisisUnitSchema>;
export type CrisisIncident = z.infer<typeof CrisisIncidentSchema>;
export type CrisisSnapshot = z.infer<typeof CrisisSnapshotSchema>;

export interface UnitDispatchDecision {
  unitId: string;
  role: ResponderRole;
  modelChoice: string;
  assignedTaskId: string;
  confidence: number;
  probabilities: Record<string, number>;
  localProbabilities: Record<string, number>;
  usedConfidenceBlend: boolean;
}

export interface CrisisDispatchResult {
  id: string;
  mode: DecisionMode;
  model: string;
  generatedAt: string;
  doctrine: string;
  questionCount: number;
  unitQuestionCount: number;
  latencyMs: number;
  assignmentScore: number;
  decisionsPerSecond: number;
  decisions: UnitDispatchDecision[];
  global: {
    riskScore: number;
    coordinationScore: number;
    redispatchProbability: number;
  };
  usage: {
    inputTokens: number;
    outputTokens: number;
    estimatedInputCostUsd: number;
  };
}

export interface CrisisFrameMetrics {
  activeIncidents: number;
  assignedUnits: number;
  averageStamina: number;
  averageSeverity: number;
  elapsedSeconds: number;
  timeRemaining: number;
  score: number;
  resolvedIncidents: number;
  failedIncidents: number;
  civilianLosses: number;
  finished: boolean;
}

export interface CounterfactualOutcome {
  horizonSeconds: number;
  scoreDelta: number;
  resolvedDelta: number;
  failedDelta: number;
  civilianLossesDelta: number;
  incidentsRemaining: number;
  averageSeverityEnd: number;
  averageStaminaEnd: number;
  severityExposure: number;
}

export interface CounterfactualComparison {
  horizonSeconds: number;
  jev: CounterfactualOutcome;
  local: CounterfactualOutcome;
  preferredPolicy: "jev" | "local" | "tie";
  decidingMetric:
    | "civilianLosses"
    | "failedIncidents"
    | "resolvedIncidents"
    | "score"
    | "severityExposure"
    | "stamina"
    | "tie";
}

const roles: ResponderRole[] = ["medic", "engineer", "firefighter", "scout"];

const incidentKinds: IncidentKind[] = ["fire", "medical", "infrastructure", "search"];

const roleEffectiveness: Record<IncidentKind, Record<ResponderRole, number>> = {
  fire: {
    firefighter: 1,
    engineer: 0.62,
    scout: 0.32,
    medic: 0.18,
  },
  medical: {
    medic: 1,
    scout: 0.58,
    firefighter: 0.3,
    engineer: 0.2,
  },
  infrastructure: {
    engineer: 1,
    firefighter: 0.6,
    scout: 0.42,
    medic: 0.18,
  },
  search: {
    scout: 1,
    medic: 0.67,
    firefighter: 0.42,
    engineer: 0.38,
  },
};

export class CrisisSimulation {
  public state: CrisisSnapshot;

  public constructor(unitCount = 32, seed = 20_260_918) {
    this.state = createCrisisSnapshot(unitCount, seed);
  }

  public static fromSnapshot(snapshot: CrisisSnapshot): CrisisSimulation {
    const simulation = new CrisisSimulation(snapshot.units.length, snapshot.seed);
    simulation.state = cloneCrisisSnapshot(snapshot);
    return simulation;
  }

  public reset(unitCount = this.state.units.length, seed = this.state.seed): void {
    this.state = createCrisisSnapshot(unitCount, seed);
  }

  public applyAssignments(assignments: Array<{ unitId: string; taskId: string }>): void {
    const activeIncidentIds = new Set(this.state.incidents.map((incident) => incident.id));
    const assignmentMap = new Map(
      assignments.map((assignment) => [assignment.unitId, assignment.taskId]),
    );

    for (const unit of this.state.units) {
      const taskId = assignmentMap.get(unit.id) ?? "hold";
      unit.assignmentId =
        taskId === "recover" || taskId === "hold" || activeIncidentIds.has(taskId)
          ? taskId
          : "hold";
    }
  }

  public step(deltaSeconds: number): void {
    if (this.state.finished) {
      return;
    }

    const delta = Math.max(0, Math.min(deltaSeconds, 0.1));
    this.state.elapsedSeconds += delta;

    while (
      this.state.elapsedSeconds >= this.state.nextSpawnAt &&
      this.state.elapsedSeconds < this.state.durationSeconds
    ) {
      if (this.state.incidents.length < 12) {
        this.state.incidents.push(
          createIncident(this.state.seed, this.state.nextIncidentIndex, this.state.elapsedSeconds),
        );
      }
      this.state.nextIncidentIndex += 1;
      this.state.nextSpawnAt += 8 + (this.state.nextIncidentIndex % 4) * 1.5;
    }

    const workByIncident = new Map<string, number>();
    for (const unit of this.state.units) {
      this.updateUnit(unit, delta, workByIncident);
    }

    for (let index = this.state.incidents.length - 1; index >= 0; index -= 1) {
      const incident = this.state.incidents[index];
      if (!incident) {
        continue;
      }

      const work = workByIncident.get(incident.id) ?? 0;
      incident.severity += incident.growthPerSecond * delta;
      incident.severity -= work * delta;

      if (incident.severity <= 0) {
        this.state.score += 100 + Math.round(incident.growthPerSecond * 20);
        this.state.resolvedIncidents += 1;
        this.state.incidents.splice(index, 1);
        clearAssignment(this.state.units, incident.id);
        continue;
      }

      if (incident.severity >= 200) {
        this.state.score -= 140;
        this.state.failedIncidents += 1;
        this.state.civilianLosses +=
          incident.kind === "medical" || incident.kind === "fire" ? 2 : 1;
        this.state.incidents.splice(index, 1);
        clearAssignment(this.state.units, incident.id);
      }
    }

    if (this.state.elapsedSeconds >= this.state.durationSeconds) {
      this.state.finished = true;
    }
  }

  public metrics(): CrisisFrameMetrics {
    const assignedUnits = this.state.units.filter(
      (unit) =>
        unit.assignmentId !== null &&
        unit.assignmentId !== "hold" &&
        unit.assignmentId !== "recover",
    ).length;
    const averageStamina =
      this.state.units.reduce((sum, unit) => sum + unit.stamina, 0) / this.state.units.length;
    const averageSeverity =
      this.state.incidents.length === 0
        ? 0
        : this.state.incidents.reduce((sum, incident) => sum + incident.severity, 0) /
          this.state.incidents.length;

    return {
      activeIncidents: this.state.incidents.length,
      assignedUnits,
      averageStamina: round(averageStamina),
      averageSeverity: round(averageSeverity),
      elapsedSeconds: round(this.state.elapsedSeconds),
      timeRemaining: round(Math.max(0, this.state.durationSeconds - this.state.elapsedSeconds)),
      score: this.state.score,
      resolvedIncidents: this.state.resolvedIncidents,
      failedIncidents: this.state.failedIncidents,
      civilianLosses: this.state.civilianLosses,
      finished: this.state.finished,
    };
  }

  private updateUnit(
    unit: CrisisUnit,
    deltaSeconds: number,
    workByIncident: Map<string, number>,
  ): void {
    const assignment = unit.assignmentId ?? "hold";

    if (assignment === "recover") {
      const arrived = moveToward(unit, headquarters(this.state), movementSpeed(unit), deltaSeconds);
      unit.stamina = Math.min(100, unit.stamina + (arrived ? 18 : 4) * deltaSeconds);
      return;
    }

    if (assignment === "hold") {
      unit.stamina = Math.min(100, unit.stamina + 3 * deltaSeconds);
      return;
    }

    const incident = this.state.incidents.find((candidate) => candidate.id === assignment);
    if (!incident) {
      unit.assignmentId = "hold";
      return;
    }

    const arrived = moveToward(unit, incident, movementSpeed(unit), deltaSeconds);
    unit.stamina = Math.max(0, unit.stamina - (arrived ? 1.8 : 0.55) * deltaSeconds);

    if (arrived) {
      const effectiveness = roleEffectiveness[incident.kind][unit.role];
      const staminaFactor = 0.35 + (unit.stamina / 100) * 0.65;
      const contribution = 13 * effectiveness * staminaFactor;
      workByIncident.set(incident.id, (workByIncident.get(incident.id) ?? 0) + contribution);
    }
  }
}

export function compareDispatchPolicies(
  snapshot: CrisisSnapshot,
  jevAssignments: Array<{ unitId: string; taskId: string }>,
  localAssignments: Array<{ unitId: string; taskId: string }>,
  horizonSeconds = 20,
): CounterfactualComparison {
  const boundedHorizon = Math.max(1, Math.min(60, horizonSeconds));
  const jev = simulateDispatchOutcome(snapshot, jevAssignments, boundedHorizon);
  const local = simulateDispatchOutcome(snapshot, localAssignments, boundedHorizon);
  const preference = compareOutcomes(jev, local);

  return {
    horizonSeconds: boundedHorizon,
    jev,
    local,
    ...preference,
  };
}

export function simulateDispatchOutcome(
  snapshot: CrisisSnapshot,
  assignments: Array<{ unitId: string; taskId: string }>,
  horizonSeconds = 20,
): CounterfactualOutcome {
  const simulation = CrisisSimulation.fromSnapshot(snapshot);
  simulation.applyAssignments(assignments);
  const fixedStep = 1 / 30;
  const targetTime = Math.min(
    snapshot.durationSeconds,
    snapshot.elapsedSeconds + Math.max(1, Math.min(60, horizonSeconds)),
  );
  let severityExposure = 0;

  while (simulation.state.elapsedSeconds < targetTime && !simulation.state.finished) {
    const metrics = simulation.metrics();
    severityExposure += metrics.averageSeverity * fixedStep;
    simulation.step(fixedStep);
  }

  const finalMetrics = simulation.metrics();
  return {
    horizonSeconds: round(simulation.state.elapsedSeconds - snapshot.elapsedSeconds),
    scoreDelta: simulation.state.score - snapshot.score,
    resolvedDelta: simulation.state.resolvedIncidents - snapshot.resolvedIncidents,
    failedDelta: simulation.state.failedIncidents - snapshot.failedIncidents,
    civilianLossesDelta: simulation.state.civilianLosses - snapshot.civilianLosses,
    incidentsRemaining: simulation.state.incidents.length,
    averageSeverityEnd: finalMetrics.averageSeverity,
    averageStaminaEnd: finalMetrics.averageStamina,
    severityExposure: round(severityExposure),
  };
}

export function createCrisisSnapshot(requestedUnitCount = 32, seed = 20_260_918): CrisisSnapshot {
  const unitCount = Math.max(4, Math.min(48, Math.floor(requestedUnitCount)));
  const snapshot: CrisisSnapshot = {
    version: 1,
    seed: seed >>> 0,
    width: 1_000,
    height: 620,
    elapsedSeconds: 0,
    durationSeconds: 180,
    score: 0,
    resolvedIncidents: 0,
    failedIncidents: 0,
    civilianLosses: 0,
    nextIncidentIndex: 6,
    nextSpawnAt: 9,
    finished: false,
    units: createUnits(unitCount),
    incidents: Array.from({ length: 6 }, (_, index) => createIncident(seed, index, 0)),
  };

  return CrisisSnapshotSchema.parse(snapshot);
}

export function cloneCrisisSnapshot(snapshot: CrisisSnapshot): CrisisSnapshot {
  return CrisisSnapshotSchema.parse(snapshot);
}

export function roleFit(role: ResponderRole, kind: IncidentKind): number {
  return roleEffectiveness[kind][role];
}

export function incidentLabel(kind: IncidentKind): string {
  switch (kind) {
    case "fire":
      return "Fire";
    case "medical":
      return "Medical emergency";
    case "infrastructure":
      return "Infrastructure failure";
    case "search":
      return "Search operation";
  }
}

export function distanceBetween(
  first: Pick<CrisisUnit, "x" | "y">,
  second: Pick<CrisisIncident, "x" | "y">,
): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function createUnits(count: number): CrisisUnit[] {
  const centre = headquarters({ width: 1_000, height: 620 });

  return Array.from({ length: count }, (_, index) => {
    const role = roles[index % roles.length] ?? "scout";
    const ring = Math.floor(index / roles.length);
    const angle = (index / count) * Math.PI * 2;
    const radius = 18 + ring * 4;

    return {
      id: `unit-${String(index + 1).padStart(2, "0")}`,
      role,
      x: centre.x + Math.cos(angle) * radius,
      y: centre.y + Math.sin(angle) * radius,
      stamina: 78 + ((index * 13) % 23),
      assignmentId: null,
    };
  });
}

function createIncident(seed: number, index: number, createdAt: number): CrisisIncident {
  const random = new SeededRandom((seed + index * 65_537) >>> 0);
  const kind = incidentKinds[index % incidentKinds.length] ?? "search";
  const column = index % 4;
  const row = Math.floor(index / 4) % 3;
  const x = 110 + column * 255 + random.range(-55, 55);
  const y = 90 + row * 190 + random.range(-48, 48);

  return {
    id: `incident-${String(index + 1).padStart(3, "0")}`,
    kind,
    x: Math.max(60, Math.min(940, x)),
    y: Math.max(60, Math.min(540, y)),
    severity: 62 + random.range(0, 58),
    growthPerSecond: 0.75 + random.range(0, 1.25),
    capacity: kind === "fire" || kind === "infrastructure" ? 3 : 2,
    createdAt,
  };
}

function headquarters(world: Pick<CrisisSnapshot, "width" | "height">): { x: number; y: number } {
  return {
    x: world.width / 2,
    y: world.height - 48,
  };
}

function movementSpeed(unit: CrisisUnit): number {
  const roleAdjustment = unit.role === "scout" ? 14 : unit.role === "engineer" ? -5 : 0;
  return 74 + roleAdjustment + unit.stamina * 0.18;
}

function moveToward(
  unit: CrisisUnit,
  target: { x: number; y: number },
  speed: number,
  deltaSeconds: number,
): boolean {
  const deltaX = target.x - unit.x;
  const deltaY = target.y - unit.y;
  const distance = Math.hypot(deltaX, deltaY);

  if (distance <= 24) {
    return true;
  }

  const travel = Math.min(distance, speed * deltaSeconds);
  unit.x += (deltaX / distance) * travel;
  unit.y += (deltaY / distance) * travel;
  return distance - travel <= 24;
}

function clearAssignment(units: CrisisUnit[], incidentId: string): void {
  for (const unit of units) {
    if (unit.assignmentId === incidentId) {
      unit.assignmentId = "hold";
    }
  }
}

function compareOutcomes(
  jev: CounterfactualOutcome,
  local: CounterfactualOutcome,
): Pick<CounterfactualComparison, "preferredPolicy" | "decidingMetric"> {
  const comparisons: Array<{
    metric: CounterfactualComparison["decidingMetric"];
    jevValue: number;
    localValue: number;
    lowerIsBetter: boolean;
    tolerance?: number;
  }> = [
    {
      metric: "civilianLosses",
      jevValue: jev.civilianLossesDelta,
      localValue: local.civilianLossesDelta,
      lowerIsBetter: true,
    },
    {
      metric: "failedIncidents",
      jevValue: jev.failedDelta,
      localValue: local.failedDelta,
      lowerIsBetter: true,
    },
    {
      metric: "resolvedIncidents",
      jevValue: jev.resolvedDelta,
      localValue: local.resolvedDelta,
      lowerIsBetter: false,
    },
    {
      metric: "score",
      jevValue: jev.scoreDelta,
      localValue: local.scoreDelta,
      lowerIsBetter: false,
    },
    {
      metric: "severityExposure",
      jevValue: jev.severityExposure,
      localValue: local.severityExposure,
      lowerIsBetter: true,
      tolerance: 0.01,
    },
    {
      metric: "stamina",
      jevValue: jev.averageStaminaEnd,
      localValue: local.averageStaminaEnd,
      lowerIsBetter: false,
      tolerance: 0.01,
    },
  ];

  for (const comparison of comparisons) {
    const difference = comparison.jevValue - comparison.localValue;
    if (Math.abs(difference) <= (comparison.tolerance ?? 0)) {
      continue;
    }

    const jevIsBetter = comparison.lowerIsBetter ? difference < 0 : difference > 0;
    return {
      preferredPolicy: jevIsBetter ? "jev" : "local",
      decidingMetric: comparison.metric,
    };
  }

  return {
    preferredPolicy: "tie",
    decidingMetric: "tie",
  };
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
