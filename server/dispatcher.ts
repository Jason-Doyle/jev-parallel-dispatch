import { randomUUID } from "node:crypto";
import {
  type CrisisDispatchResult,
  type CrisisIncident,
  type CrisisSnapshot,
  CrisisSnapshotSchema,
  type CrisisUnit,
  distanceBetween,
  incidentLabel,
  roleFit,
  type UnitDispatchDecision,
} from "../src/shared/crisis";
import type { ModelEvaluation, TypedAnswer, TypedQuestion } from "../src/shared/decision-types";
import type { JevClient } from "./jev";

export interface DispatchOptions {
  snapshot: CrisisSnapshot;
  doctrine: string;
  mode: "jev" | "local";
  jevClient?: JevClient;
  inputCostPerMillionTokens?: number;
}

interface TaskSlot {
  taskId: string;
  slotIndex: number;
}

export async function dispatchResponders(options: DispatchOptions): Promise<CrisisDispatchResult> {
  const snapshot = CrisisSnapshotSchema.parse(options.snapshot);
  if (snapshot.incidents.length === 0) {
    throw new Error("At least one active incident is required for dispatch.");
  }

  const questions = createDispatchQuestions(snapshot);
  const state = createDispatchState(snapshot, options.doctrine);
  const localProbabilities = new Map(
    snapshot.units.map((unit) => [unit.id, calculateLocalProbabilities(unit, snapshot.incidents)]),
  );
  const started = performance.now();
  const evaluation =
    options.mode === "jev"
      ? await requireJevClient(options).evaluate(state, questions)
      : createLocalDispatchEvaluation(snapshot, questions, localProbabilities);
  const latencyMs = performance.now() - started;
  const assignment = optimiseAssignments(snapshot, evaluation, localProbabilities);
  const riskAnswer = evaluation.answers.overall_risk;
  const coordinationAnswer = evaluation.answers.coordination_pressure;
  const redispatchAnswer = evaluation.answers.needs_redispatch;
  const inputCostPerMillion = options.inputCostPerMillionTokens ?? 0.042;

  return {
    id: randomUUID(),
    mode: options.mode,
    model: evaluation.model,
    generatedAt: new Date().toISOString(),
    doctrine: options.doctrine,
    questionCount: Object.keys(questions).length,
    unitQuestionCount: snapshot.units.length,
    latencyMs: round(latencyMs),
    assignmentScore: round(assignment.score),
    decisionsPerSecond: round(snapshot.units.length / Math.max(0.001, latencyMs / 1_000)),
    decisions: assignment.decisions,
    global: {
      riskScore: riskAnswer?.type === "score" ? riskAnswer.score : 0,
      coordinationScore: coordinationAnswer?.type === "score" ? coordinationAnswer.score : 0,
      redispatchProbability: redispatchAnswer?.type === "noul" ? redispatchAnswer.noul : 0,
    },
    usage: {
      inputTokens: evaluation.usage.input_tokens,
      outputTokens: evaluation.usage.output_tokens,
      estimatedInputCostUsd: roundCost(
        (evaluation.usage.input_tokens / 1_000_000) * inputCostPerMillion,
      ),
    },
  };
}

function createDispatchQuestions(snapshot: CrisisSnapshot): Record<string, TypedQuestion> {
  const criteria = Object.fromEntries([
    ...snapshot.incidents.map((incident) => [
      incident.id,
      `${incidentLabel(incident.kind)} at (${Math.round(incident.x)}, ${Math.round(incident.y)}); severity ${incident.severity.toFixed(1)}/200; growth ${incident.growthPerSecond.toFixed(2)} per second; capacity ${incident.capacity}.`,
    ]),
    [
      "recover",
      "Return to headquarters to restore stamina. Choose when fatigue makes field work inefficient.",
    ],
    [
      "hold",
      "Remain available without committing to an incident. Choose when all useful incident slots should be left to better-suited teams.",
    ],
  ]);
  const questions: Record<string, TypedQuestion> = {};

  for (const unit of snapshot.units) {
    questions[`assignment_${unit.id}`] = {
      type: "choice",
      instructions:
        `Choose the best immediate assignment for ${unit.id}, a ${unit.role} team at ` +
        `(${Math.round(unit.x)}, ${Math.round(unit.y)}) with ${unit.stamina.toFixed(1)} stamina. ` +
        "Consider role suitability, distance, incident growth, severity, and the command doctrine. " +
        "Other teams are evaluated independently, so express this team's true preference distribution.",
      criteria,
    };
  }

  questions.overall_risk = {
    type: "score",
    instructions: "Rate the overall operational risk in the current world state.",
    criteria: [
      "Stable. Existing incidents are contained with ample response capacity.",
      "Manageable. Some prioritisation is required but failure is unlikely.",
      "Stressed. Several incidents can worsen before suitable teams arrive.",
      "Critical. At least one severe incident is likely to fail without immediate action.",
      "Collapse risk. Available teams cannot plausibly contain the current incident load.",
    ],
  };
  questions.coordination_pressure = {
    type: "score",
    instructions:
      "Rate how strongly the dispatcher must avoid sending too many teams to the same incident.",
    criteria: [
      "No coordination pressure. There are few teams or many open tasks.",
      "Low pressure. Minor duplication would be harmless.",
      "Moderate pressure. Capacity-aware assignment materially improves the plan.",
      "High pressure. Independent top choices are likely to produce severe over-allocation.",
    ],
  };
  questions.needs_redispatch = {
    type: "noul",
    instructions:
      "Should the world be reassessed soon because incident growth or team fatigue could invalidate this plan?",
    criteria: {
      true: "Conditions are volatile enough to justify another decision wave soon.",
      false: "The plan should remain suitable until teams have made material progress.",
    },
  };

  return questions;
}

function createDispatchState(snapshot: CrisisSnapshot, doctrine: string): unknown {
  return {
    mission:
      "Coordinate response teams to resolve incidents before severity reaches 200 while limiting civilian losses and preserving enough stamina for later incidents.",
    doctrine,
    time: {
      elapsedSeconds: round(snapshot.elapsedSeconds),
      remainingSeconds: round(snapshot.durationSeconds - snapshot.elapsedSeconds),
    },
    outcomes: {
      score: snapshot.score,
      resolvedIncidents: snapshot.resolvedIncidents,
      failedIncidents: snapshot.failedIncidents,
      civilianLosses: snapshot.civilianLosses,
    },
    incidents: snapshot.incidents.map((incident) => ({
      id: incident.id,
      kind: incident.kind,
      position: {
        x: round(incident.x),
        y: round(incident.y),
      },
      severity: round(incident.severity),
      growthPerSecond: round(incident.growthPerSecond),
      capacity: incident.capacity,
      ageSeconds: round(snapshot.elapsedSeconds - incident.createdAt),
    })),
    units: snapshot.units.map((unit) => ({
      id: unit.id,
      role: unit.role,
      position: {
        x: round(unit.x),
        y: round(unit.y),
      },
      stamina: round(unit.stamina),
      currentAssignment: unit.assignmentId,
      incidentDistances: Object.fromEntries(
        snapshot.incidents.map((incident) => [
          incident.id,
          Math.round(distanceBetween(unit, incident)),
        ]),
      ),
      roleFit: Object.fromEntries(
        snapshot.incidents.map((incident) => [incident.id, roleFit(unit.role, incident.kind)]),
      ),
    })),
    compositionRule:
      "Each assignment question is independent. A deterministic optimiser will enforce incident capacities using the full returned probability matrix.",
  };
}

function calculateLocalProbabilities(
  unit: CrisisUnit,
  incidents: CrisisIncident[],
): Record<string, number> {
  const weights: Record<string, number> = {};

  for (const incident of incidents) {
    const distance = distanceBetween(unit, incident);
    const urgency = incident.severity * (1 + incident.growthPerSecond * 0.45);
    const suitability = roleFit(unit.role, incident.kind);
    const staminaFactor = 0.35 + unit.stamina / 100;
    weights[incident.id] = (urgency * suitability * staminaFactor) / Math.max(90, distance);
  }

  weights.recover = unit.stamina < 35 ? 2.2 + (35 - unit.stamina) / 12 : 0.08;
  weights.hold = 0.06;
  return normalizeWeights(weights);
}

function createLocalDispatchEvaluation(
  snapshot: CrisisSnapshot,
  questions: Record<string, TypedQuestion>,
  probabilitiesByUnit: Map<string, Record<string, number>>,
): ModelEvaluation {
  const answers: Record<string, TypedAnswer> = {};

  for (const unit of snapshot.units) {
    const probabilities = probabilitiesByUnit.get(unit.id);
    if (!probabilities) {
      throw new Error(`Missing local probabilities for ${unit.id}.`);
    }

    const [choice] =
      Object.entries(probabilities).sort((first, second) => second[1] - first[1])[0] ?? [];
    if (!choice) {
      throw new Error(`Local policy produced no choice for ${unit.id}.`);
    }

    answers[`assignment_${unit.id}`] = {
      type: "choice",
      choice,
      probabilities,
      confidence: distributionConfidence(probabilities),
    };
  }

  const maximumSeverity = Math.max(...snapshot.incidents.map((incident) => incident.severity));
  const capacity = snapshot.incidents.reduce((sum, incident) => sum + incident.capacity, 0);
  const riskScore = Math.max(
    0,
    Math.min(
      4,
      Math.round(
        maximumSeverity / 55 + snapshot.incidents.length / 6 + snapshot.failedIncidents * 0.5,
      ),
    ),
  );
  const coordinationScore = Math.max(
    0,
    Math.min(
      3,
      Math.round((snapshot.units.length - capacity) / Math.max(1, snapshot.units.length / 4)),
    ),
  );

  answers.overall_risk = scoreAnswer(riskScore, [
    "Stable",
    "Manageable",
    "Stressed",
    "Critical",
    "Collapse risk",
  ]);
  answers.coordination_pressure = scoreAnswer(coordinationScore, [
    "No pressure",
    "Low",
    "Moderate",
    "High",
  ]);
  answers.needs_redispatch = {
    type: "noul",
    noul: Math.min(1, 0.2 + snapshot.incidents.length * 0.05 + maximumSeverity / 300),
  };

  for (const questionId of Object.keys(questions)) {
    if (!answers[questionId]) {
      throw new Error(`Local evaluation did not answer ${questionId}.`);
    }
  }

  return {
    model: "local-dispatch-v1",
    answers,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  };
}

function optimiseAssignments(
  snapshot: CrisisSnapshot,
  evaluation: ModelEvaluation,
  localProbabilities: Map<string, Record<string, number>>,
): { decisions: UnitDispatchDecision[]; score: number } {
  const slots = buildTaskSlots(snapshot);
  const weights = snapshot.units.map((unit) => {
    const answer = evaluation.answers[`assignment_${unit.id}`];
    if (answer?.type !== "choice") {
      throw new Error(`Model did not return an assignment Choice for ${unit.id}.`);
    }

    const local = localProbabilities.get(unit.id);
    if (!local) {
      throw new Error(`Missing local probabilities for ${unit.id}.`);
    }

    return slots.map((slot) => {
      const modelProbability = answer.probabilities[slot.taskId] ?? 0;
      const localProbability = local[slot.taskId] ?? 0;
      const blended =
        answer.confidence * modelProbability + (1 - answer.confidence) * localProbability;
      return Math.log(Math.max(0.000_001, blended));
    });
  });
  const assignmentColumns = maximumWeightAssignment(weights);
  let score = 0;
  const decisions = snapshot.units.map((unit, index) => {
    const answer = evaluation.answers[`assignment_${unit.id}`];
    if (answer?.type !== "choice") {
      throw new Error(`Model did not return an assignment Choice for ${unit.id}.`);
    }

    const column = assignmentColumns[index];
    const slot = column === undefined ? undefined : slots[column];
    if (!slot) {
      throw new Error(`Assignment optimiser did not assign ${unit.id}.`);
    }

    score += weights[index]?.[column] ?? 0;
    return {
      unitId: unit.id,
      role: unit.role,
      modelChoice: answer.choice,
      assignedTaskId: slot.taskId,
      confidence: answer.confidence,
      probabilities: { ...answer.probabilities },
      localProbabilities: {
        ...(localProbabilities.get(unit.id) ?? {}),
      },
      usedConfidenceBlend: answer.confidence < 0.999,
    };
  });

  return {
    decisions,
    score,
  };
}

function buildTaskSlots(snapshot: CrisisSnapshot): TaskSlot[] {
  const slots = snapshot.incidents.flatMap((incident) =>
    Array.from({ length: incident.capacity }, (_, slotIndex) => ({
      taskId: incident.id,
      slotIndex,
    })),
  );

  for (let index = 0; index < snapshot.units.length; index += 1) {
    slots.push(
      {
        taskId: "recover",
        slotIndex: index,
      },
      {
        taskId: "hold",
        slotIndex: index,
      },
    );
  }

  return slots;
}

function maximumWeightAssignment(weights: number[][]): number[] {
  const rowCount = weights.length;
  const columnCount = weights[0]?.length ?? 0;
  if (rowCount === 0 || columnCount < rowCount) {
    throw new Error("Assignment matrix must have at least as many columns as rows.");
  }

  const maximumWeight = Math.max(...weights.flat());
  const costs = weights.map((row) => row.map((weight) => maximumWeight - weight));
  const rowPotential = Array(rowCount + 1).fill(0) as number[];
  const columnPotential = Array(columnCount + 1).fill(0) as number[];
  const columnMatch = Array(columnCount + 1).fill(0) as number[];
  const predecessor = Array(columnCount + 1).fill(0) as number[];

  for (let row = 1; row <= rowCount; row += 1) {
    columnMatch[0] = row;
    let currentColumn = 0;
    const minimum = Array(columnCount + 1).fill(Number.POSITIVE_INFINITY) as number[];
    const used = Array(columnCount + 1).fill(false) as boolean[];

    do {
      used[currentColumn] = true;
      const currentRow = columnMatch[currentColumn] ?? 0;
      let delta = Number.POSITIVE_INFINITY;
      let nextColumn = 0;

      for (let column = 1; column <= columnCount; column += 1) {
        if (used[column]) {
          continue;
        }

        const cost = costs[currentRow - 1]?.[column - 1];
        if (cost === undefined) {
          throw new Error("Assignment matrix is not rectangular.");
        }

        const reducedCost = cost - (rowPotential[currentRow] ?? 0) - (columnPotential[column] ?? 0);
        if (reducedCost < (minimum[column] ?? Number.POSITIVE_INFINITY)) {
          minimum[column] = reducedCost;
          predecessor[column] = currentColumn;
        }
        if ((minimum[column] ?? Number.POSITIVE_INFINITY) < delta) {
          delta = minimum[column] ?? Number.POSITIVE_INFINITY;
          nextColumn = column;
        }
      }

      for (let column = 0; column <= columnCount; column += 1) {
        if (used[column]) {
          const matchedRow = columnMatch[column] ?? 0;
          rowPotential[matchedRow] = (rowPotential[matchedRow] ?? 0) + delta;
          columnPotential[column] = (columnPotential[column] ?? 0) - delta;
        } else {
          minimum[column] = (minimum[column] ?? 0) - delta;
        }
      }

      currentColumn = nextColumn;
    } while ((columnMatch[currentColumn] ?? 0) !== 0);

    do {
      const priorColumn = predecessor[currentColumn] ?? 0;
      columnMatch[currentColumn] = columnMatch[priorColumn] ?? 0;
      currentColumn = priorColumn;
    } while (currentColumn !== 0);
  }

  const assignment = Array(rowCount).fill(-1) as number[];
  for (let column = 1; column <= columnCount; column += 1) {
    const row = columnMatch[column] ?? 0;
    if (row > 0) {
      assignment[row - 1] = column - 1;
    }
  }

  return assignment;
}

function normalizeWeights(weights: Record<string, number>): Record<string, number> {
  const positiveEntries = Object.entries(weights).map(
    ([key, value]) => [key, Math.max(0.000_001, value)] as const,
  );
  const total = positiveEntries.reduce((sum, [, value]) => sum + value, 0);
  return Object.fromEntries(positiveEntries.map(([key, value]) => [key, value / total]));
}

function distributionConfidence(probabilities: Record<string, number>): number {
  const values = Object.values(probabilities);
  if (values.length <= 1) {
    return 1;
  }

  const entropy = -values.reduce(
    (sum, probability) => (probability <= 0 ? sum : sum + probability * Math.log(probability)),
    0,
  );
  return Math.max(0, Math.min(1, 1 - entropy / Math.log(values.length)));
}

function scoreAnswer(score: number, criteria: string[]): TypedAnswer {
  const bounded = Math.max(0, Math.min(criteria.length - 1, Math.round(score)));
  return {
    type: "score",
    score: bounded,
    confidence: 1,
    legend: Object.fromEntries(criteria.map((criterion, index) => [index, criterion])),
    probabilities: Object.fromEntries(
      criteria.map((_, index) => [index, index === bounded ? 1 : 0]),
    ),
  };
}

function requireJevClient(options: DispatchOptions): JevClient {
  if (!options.jevClient) {
    throw new Error(
      "Jev mode was requested, but TYPESAFE_API_KEY is not configured on the server.",
    );
  }
  return options.jevClient;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function roundCost(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}
