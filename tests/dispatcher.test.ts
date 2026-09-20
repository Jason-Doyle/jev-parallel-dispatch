import { describe, expect, it } from "vitest";
import { dispatchResponders } from "../server/dispatcher";
import type { JevClient } from "../server/jev";
import { type CrisisSnapshot, createCrisisSnapshot } from "../src/shared/crisis";
import type { ModelEvaluation, TypedAnswer, TypedQuestion } from "../src/shared/decision-types";

describe("parallel dispatcher", () => {
  it("evaluates one assignment question per team in local mode", async () => {
    const snapshot = createCrisisSnapshot(32, 1_234);
    const result = await dispatchResponders({
      snapshot,
      doctrine: "Protect civilians and use specialists efficiently.",
      mode: "local",
    });

    expect(result.decisions).toHaveLength(32);
    expect(result.unitQuestionCount).toBe(32);
    expect(result.questionCount).toBe(35);
    expect(result.usage.inputTokens).toBe(0);
    expectCapacities(snapshot, result.decisions);
  });

  it("enforces capacity when every Jev answer prefers one incident", async () => {
    const snapshot = createCrisisSnapshot(8, 5_678);
    const preferred = snapshot.incidents[0];
    if (!preferred) {
      throw new Error("Fixture did not create an incident.");
    }

    const fakeClient = {
      evaluate: async (
        _state: unknown,
        questions: Record<string, TypedQuestion>,
      ): Promise<ModelEvaluation> => {
        const answers: Record<string, TypedAnswer> = {};

        for (const [questionId, question] of Object.entries(questions)) {
          if (question.type === "choice") {
            const options = Object.keys(question.criteria);
            const choice = questionId.startsWith("assignment_")
              ? preferred.id
              : (options[0] ?? "hold");
            answers[questionId] = {
              type: "choice",
              choice,
              confidence: 0.95,
              probabilities: Object.fromEntries(
                options.map((option) => [
                  option,
                  option === choice ? 0.9 : 0.1 / Math.max(1, options.length - 1),
                ]),
              ),
            };
          } else if (question.type === "score") {
            answers[questionId] = {
              type: "score",
              score: 2,
              confidence: 0.8,
              legend: Object.fromEntries(
                question.criteria.map((criterion, index) => [index, criterion]),
              ),
              probabilities: Object.fromEntries(
                question.criteria.map((_, index) => [index, index === 2 ? 1 : 0]),
              ),
            };
          } else {
            answers[questionId] = {
              type: "noul",
              noul: 0.7,
            };
          }
        }

        return {
          model: "fake-jev",
          answers,
          usage: {
            input_tokens: 1_000,
            output_tokens: 100,
          },
        };
      },
    } as unknown as JevClient;

    const result = await dispatchResponders({
      snapshot,
      doctrine: "All teams prefer the first incident.",
      mode: "jev",
      jevClient: fakeClient,
    });
    const assignedToPreferred = result.decisions.filter(
      (decision) => decision.assignedTaskId === preferred.id,
    ).length;

    expect(assignedToPreferred).toBeLessThanOrEqual(preferred.capacity);
    expect(
      result.decisions.some((decision) => decision.modelChoice !== decision.assignedTaskId),
    ).toBe(true);
    expectCapacities(snapshot, result.decisions);
  });
});

function expectCapacities(
  snapshot: CrisisSnapshot,
  decisions: Array<{ assignedTaskId: string }>,
): void {
  for (const incident of snapshot.incidents) {
    const assigned = decisions.filter((decision) => decision.assignedTaskId === incident.id).length;
    expect(assigned).toBeLessThanOrEqual(incident.capacity);
  }
}
