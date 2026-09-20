export type DecisionMode = "jev" | "local";

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: {
    true?: string;
    false?: string;
  };
}

export type TypedQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export type TypedAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface ModelEvaluation {
  model: string;
  answers: Record<string, TypedAnswer>;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface ServerStatus {
  jevAvailable: boolean;
  jevModel: string;
  localModeAvailable: true;
}
