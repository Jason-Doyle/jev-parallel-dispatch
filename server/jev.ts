import {
  APIError,
  choice,
  type EntryType,
  type Fetch,
  type JsonValue,
  noul,
  type Questions,
  score,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import type { ModelEvaluation, TypedAnswer, TypedQuestion } from "../src/shared/decision-types";

export class JevApiError extends Error {
  public constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "JevApiError";
  }
}

export interface JevClientOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  maximumRetries?: number;
  fetchImplementation?: Fetch;
}

export class JevClient {
  public readonly model: string;

  private readonly client: TypeSafeClient;

  public constructor(options: JevClientOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new Error("A TypeSafe API key is required.");
    }

    this.model = options.model ?? "jev-1.13.0";
    this.client = new TypeSafeClient({
      apiKey,
      defaultModel: this.model,
      timeout: options.timeoutMs ?? 20_000,
      retry: {
        maxRetries: options.maximumRetries ?? 2,
      },
      fetch: options.fetchImplementation,
    });
  }

  public async evaluate(
    state: unknown,
    questions: Record<string, TypedQuestion>,
  ): Promise<ModelEvaluation> {
    try {
      const response = await this.client.systemOne({
        state: normalizeState(state),
        model: this.model,
        questions: toSdkQuestions(questions),
      });

      const answers: Record<string, TypedAnswer> = {};
      for (const [questionId, answer] of Object.entries(response.answers)) {
        switch (answer.type) {
          case "choice":
            answers[questionId] = {
              type: "choice",
              choice: answer.choice,
              confidence: answer.confidence,
              probabilities: copyNumericRecord(answer.probabilities),
            };
            break;
          case "score":
            answers[questionId] = {
              type: "score",
              score: answer.score,
              confidence: answer.confidence,
              legend: copyStringRecord(answer.legend),
              probabilities: copyNumericRecord(answer.probabilities),
            };
            break;
          case "noul":
            answers[questionId] = {
              type: "noul",
              noul: answer.noul,
            };
            break;
        }
      }

      return {
        model: response.model,
        answers,
        usage: {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
        },
      };
    } catch (error) {
      if (error instanceof APIError) {
        throw new JevApiError(
          `TypeSafe returned HTTP ${error.status}: ${error.message}`,
          error.status,
        );
      }

      const message = error instanceof Error ? error.message : "Unknown TypeSafe request failure.";
      throw new JevApiError(`TypeSafe request failed: ${message}`);
    }
  }
}

function toSdkQuestions(questions: Record<string, TypedQuestion>): Questions {
  const converted: Questions = {};

  for (const [questionId, question] of Object.entries(questions)) {
    switch (question.type) {
      case "choice":
        converted[questionId] = choice(question.instructions, question.criteria);
        break;
      case "score": {
        const [first, second, ...remaining] = question.criteria;
        if (first === undefined || second === undefined) {
          throw new Error(`Score question ${questionId} requires at least two criteria.`);
        }
        converted[questionId] = score(question.instructions, [first, second, ...remaining]);
        break;
      }
      case "noul":
        converted[questionId] = noul(question.instructions, question.criteria);
        break;
    }
  }

  return converted;
}

function normalizeState(state: unknown): EntryType {
  const serialized = JSON.stringify(state);
  if (serialized === undefined) {
    throw new Error("TypeSafe state must be JSON serializable.");
  }

  const normalized: unknown = JSON.parse(serialized);
  if (!isEntryType(normalized)) {
    throw new Error("TypeSafe state must be a string, object, array, or null.");
  }

  return normalized;
}

function isEntryType(value: unknown): value is EntryType {
  return (
    typeof value === "string" ||
    value === null ||
    (Array.isArray(value) && value.every(isJsonValue)) ||
    (isRecord(value) && Object.values(value).every(isJsonValue))
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every(isJsonValue)) ||
    (isRecord(value) && Object.values(value).every(isJsonValue))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyNumericRecord(record: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(record));
}

function copyStringRecord(record: Readonly<Record<string, EntryType>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      if (typeof value !== "string") {
        throw new Error(`TypeSafe returned a non-string score legend for ${key}.`);
      }
      return [key, value];
    }),
  );
}
