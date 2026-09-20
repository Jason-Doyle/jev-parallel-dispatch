import { describe, expect, it } from "vitest";
import {
  CrisisSimulation,
  compareDispatchPolicies,
  createCrisisSnapshot,
  type ResponderRole,
} from "../src/shared/crisis";

describe("crisis simulation", () => {
  it("creates the requested number of teams with balanced roles", () => {
    const snapshot = createCrisisSnapshot(32, 123);
    const counts = new Map<ResponderRole, number>();

    for (const unit of snapshot.units) {
      counts.set(unit.role, (counts.get(unit.role) ?? 0) + 1);
    }

    expect(snapshot.units).toHaveLength(32);
    expect(snapshot.incidents).toHaveLength(6);
    expect(counts).toEqual(
      new Map<ResponderRole, number>([
        ["medic", 8],
        ["engineer", 8],
        ["firefighter", 8],
        ["scout", 8],
      ]),
    );
  });

  it("replays deterministically from the same seed and assignments", () => {
    const first = new CrisisSimulation(16, 98_765);
    const second = new CrisisSimulation(16, 98_765);
    const assignments = first.state.units.map((unit, index) => ({
      unitId: unit.id,
      taskId: first.state.incidents[index % first.state.incidents.length]?.id ?? "hold",
    }));

    first.applyAssignments(assignments);
    second.applyAssignments(assignments);
    for (let step = 0; step < 900; step += 1) {
      first.step(1 / 30);
      second.step(1 / 30);
    }

    expect(second.state).toEqual(first.state);
    expect(first.state.resolvedIncidents).toBeGreaterThan(0);
  });

  it("branches identical snapshots and ranks predeclared outcomes", () => {
    const snapshot = createCrisisSnapshot(16, 1_234);
    const active = snapshot.units.map((unit, index) => ({
      unitId: unit.id,
      taskId: snapshot.incidents[index % snapshot.incidents.length]?.id ?? "hold",
    }));
    const hold = snapshot.units.map((unit) => ({
      unitId: unit.id,
      taskId: "hold",
    }));

    const first = compareDispatchPolicies(snapshot, active, hold, 20);
    const second = compareDispatchPolicies(snapshot, active, hold, 20);
    const tied = compareDispatchPolicies(snapshot, active, active, 20);

    expect(second).toEqual(first);
    expect(first.preferredPolicy).toBe("jev");
    expect(first.decidingMetric).toBe("resolvedIncidents");
    expect(first.jev.resolvedDelta).toBeGreaterThan(first.local.resolvedDelta);
    expect(tied.preferredPolicy).toBe("tie");
    expect(tied.jev).toEqual(tied.local);
  });
});
