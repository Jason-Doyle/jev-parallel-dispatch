import { describe, expect, it, vi } from "vitest";
import { JevClient } from "../server/jev";
import type { ChoiceQuestion } from "../src/shared/decision-types";

describe("Jev API client", () => {
  it("sends the API key only in the server-side request and validates the response", async () => {
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const authorization = headers.get("Authorization");
      expect(authorization).toContain("secret-test-key");
      expect(authorization).not.toBe("secret-test-key");
      expect(headers.get("Content-Type")).toBe("application/json");

      const body = JSON.parse(String(init?.body)) as {
        model: string;
        questions: Record<string, ChoiceQuestion>;
      };
      expect(body.model).toBe("jev-1.13.0");
      expect(body.questions.layout?.type).toBe("choice");

      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            layout: {
              type: "choice",
              choice: "lanes",
              probabilities: {
                open: 0.1,
                lanes: 0.9,
              },
              confidence: 0.8,
            },
          },
          usage: {
            input_tokens: 120,
            output_tokens: 8,
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }) as typeof fetch;

    const client = new JevClient({
      apiKey: "secret-test-key",
      model: "jev-1.13.0",
      fetchImplementation,
    });
    const evaluation = await client.evaluate(
      {
        brief: "Coordinate specialist response teams.",
      },
      {
        layout: {
          type: "choice",
          instructions: "Choose a layout.",
          criteria: {
            open: "No cover.",
            lanes: "Separated routes.",
          },
        },
      },
    );

    expect(evaluation.answers.layout).toMatchObject({
      type: "choice",
      choice: "lanes",
    });
    expect(evaluation.usage.input_tokens).toBe(120);
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });
});
