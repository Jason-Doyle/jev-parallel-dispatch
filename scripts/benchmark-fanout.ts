import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { dispatchResponders } from "../server/dispatcher";
import { JevClient } from "../server/jev";
import { compareDispatchPolicies, createCrisisSnapshot } from "../src/shared/crisis";

const apiKey = process.env.TYPESAFE_API_KEY?.trim();
if (!apiKey) {
  throw new Error("TYPESAFE_API_KEY is required for the fan-out benchmark.");
}

const model = process.env.TYPESAFE_MODEL ?? "jev-1.13.0";
const inputCostPerMillion = Number(process.env.TYPESAFE_INPUT_COST_PER_MILLION ?? 0.042);
const client = new JevClient({
  apiKey,
  model,
});
const unitCounts = parseUnitCounts(argumentValue("--units") ?? "8,16,32,48");
const repetitions = boundedInteger(argumentValue("--repetitions") ?? "3", 1, 20);
const doctrine =
  "Protect civilians first. Match specialists to incidents, avoid overcommitting, and preserve tired teams for later emergencies.";
const rawRuns: Array<{
  units: number;
  repetition: number;
  result: Awaited<ReturnType<typeof dispatchResponders>>;
  localResult: Awaited<ReturnType<typeof dispatchResponders>>;
  comparison: ReturnType<typeof compareDispatchPolicies>;
  capacityViolations: number;
}> = [];

for (const units of unitCounts) {
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const snapshot = createCrisisSnapshot(units, 20_260_918 + repetition * 9_973);
    const result = await dispatchResponders({
      snapshot,
      doctrine,
      mode: "jev",
      jevClient: client,
      inputCostPerMillionTokens: inputCostPerMillion,
    });
    const localResult = await dispatchResponders({
      snapshot,
      doctrine,
      mode: "local",
      inputCostPerMillionTokens: inputCostPerMillion,
    });
    const comparison = compareDispatchPolicies(
      snapshot,
      result.decisions.map((decision) => ({
        unitId: decision.unitId,
        taskId: decision.assignedTaskId,
      })),
      localResult.decisions.map((decision) => ({
        unitId: decision.unitId,
        taskId: decision.assignedTaskId,
      })),
      20,
    );
    const capacityViolations = countCapacityViolations(snapshot, result);
    rawRuns.push({
      units,
      repetition: repetition + 1,
      result,
      localResult,
      comparison,
      capacityViolations,
    });
    console.log(
      `${units} teams run ${repetition + 1}: ${result.latencyMs.toFixed(1)} ms, ` +
        `${result.usage.inputTokens} input tokens, ${capacityViolations} capacity violations, ` +
        `20s branch ${comparison.preferredPolicy}`,
    );
  }
}

const summary = unitCounts.map((units) => {
  const runs = rawRuns.filter((run) => run.units === units);
  return {
    units,
    questions: runs[0]?.result.questionCount ?? 0,
    repetitions: runs.length,
    medianLatencyMs: median(runs.map((run) => run.result.latencyMs)),
    medianDecisionsPerSecond: median(runs.map((run) => run.result.decisionsPerSecond)),
    medianInputTokens: median(runs.map((run) => run.result.usage.inputTokens)),
    totalEstimatedCostUsd: roundCost(
      runs.reduce((sum, run) => sum + run.result.usage.estimatedInputCostUsd, 0),
    ),
    totalCapacityViolations: runs.reduce((sum, run) => sum + run.capacityViolations, 0),
    jevPreferredBranches: runs.filter((run) => run.comparison.preferredPolicy === "jev").length,
    localPreferredBranches: runs.filter((run) => run.comparison.preferredPolicy === "local").length,
    tiedBranches: runs.filter((run) => run.comparison.preferredPolicy === "tie").length,
    medianSeverityExposureDelta: median(
      runs.map(
        (run) => run.comparison.jev.severityExposure - run.comparison.local.severityExposure,
      ),
    ),
    medianResolvedIncidentDelta: median(
      runs.map((run) => run.comparison.jev.resolvedDelta - run.comparison.local.resolvedDelta),
    ),
  };
});

const evidence = {
  generatedAt: new Date().toISOString(),
  model,
  doctrine,
  repetitions,
  unitCounts,
  summary,
  rawRuns,
};
const evidenceDirectory = path.join(process.cwd(), "evidence");
await mkdir(evidenceDirectory, { recursive: true });
const evidencePath = path.join(evidenceDirectory, "fanout-benchmark.json");
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(`Wrote ${evidencePath}`);

function countCapacityViolations(
  snapshot: ReturnType<typeof createCrisisSnapshot>,
  result: Awaited<ReturnType<typeof dispatchResponders>>,
): number {
  return snapshot.incidents.filter((incident) => {
    const assigned = result.decisions.filter(
      (decision) => decision.assignedTaskId === incident.id,
    ).length;
    return assigned > incident.capacity;
  }).length;
}

function parseUnitCounts(value: string): number[] {
  const parsed = value
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isInteger(entry) && entry >= 4 && entry <= 48);

  if (parsed.length === 0) {
    throw new Error("--units must contain at least one integer from 4 to 48.");
  }
  return [...new Set(parsed)];
}

function boundedInteger(value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer from ${minimum} to ${maximum}, received ${value}.`);
  }
  return parsed;
}

function argumentValue(name: string): string | undefined {
  const direct = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (direct) {
    return direct.slice(name.length + 1);
  }

  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function median(values: number[]): number {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return round(sorted[middle] ?? 0);
  }
  return round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function roundCost(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}
