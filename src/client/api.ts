import type { CrisisDispatchResult, CrisisSnapshot } from "../shared/crisis";
import type { DecisionMode, ServerStatus } from "../shared/decision-types";

export interface DispatchRequest {
  snapshot: CrisisSnapshot;
  doctrine: string;
  mode: DecisionMode;
}

export interface FanoutBenchmarkEvidence {
  generatedAt: string;
  model: string;
  repetitions: number;
  summary: Array<{
    units: number;
    questions: number;
    repetitions: number;
    medianLatencyMs: number;
    medianDecisionsPerSecond: number;
    medianInputTokens: number;
    totalEstimatedCostUsd: number;
    totalCapacityViolations: number;
    jevPreferredBranches: number;
    localPreferredBranches: number;
    tiedBranches: number;
    medianSeverityExposureDelta: number;
    medianResolvedIncidentDelta: number;
  }>;
}

export async function getServerStatus(): Promise<ServerStatus> {
  return requestJson<ServerStatus>("/api/status");
}

export async function getFanoutEvidence(): Promise<FanoutBenchmarkEvidence> {
  return requestJson<FanoutBenchmarkEvidence>("/api/evidence/fanout");
}

export async function dispatchCrisis(request: DispatchRequest): Promise<CrisisDispatchResult> {
  return requestJson<CrisisDispatchResult>("/api/dispatch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload: unknown = await response.json();

  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `Request failed with HTTP ${response.status}.`;
    throw new Error(message);
  }

  return payload as T;
}
