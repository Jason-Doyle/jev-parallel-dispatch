import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { ZodError, z } from "zod";
import { CrisisSnapshotSchema } from "../src/shared/crisis";
import type { ServerStatus } from "../src/shared/decision-types";
import { dispatchResponders } from "./dispatcher";
import { JevApiError, JevClient } from "./jev";

const DispatchRequestSchema = z
  .object({
    snapshot: CrisisSnapshotSchema,
    doctrine: z.string().trim().min(3).max(1_000),
    mode: z.enum(["jev", "local"]).default("local"),
  })
  .strict();

export interface ApplicationOptions {
  rootDirectory?: string;
  apiKey?: string;
  model?: string;
  inputCostPerMillionTokens?: number;
}

export function createApplication(options: ApplicationOptions = {}): express.Express {
  const rootDirectory = options.rootDirectory ?? process.cwd();
  const fanoutEvidenceFile = path.join(rootDirectory, "evidence", "fanout-benchmark.json");
  const clientDirectory = path.join(rootDirectory, "dist");
  const apiKey = options.apiKey?.trim();
  const model = options.model ?? "jev-1.13.0";
  const jevClient = apiKey
    ? new JevClient({
        apiKey,
        model,
      })
    : undefined;
  const app = express();
  const apiRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      error: "API request limit exceeded. Try again shortly.",
    },
  });
  const dispatchRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      error: "Dispatch request limit exceeded. Try again shortly.",
    },
  });

  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use("/api", apiRateLimit);

  app.get("/api/status", (_request, response) => {
    const status: ServerStatus = {
      jevAvailable: Boolean(jevClient),
      jevModel: model,
      localModeAvailable: true,
    };
    response.json(status);
  });

  app.get("/api/evidence/fanout", async (_request, response) => {
    try {
      const contents = await readFile(fanoutEvidenceFile, "utf8");
      response.type("application/json").send(contents);
    } catch (error) {
      if (isFileNotFound(error)) {
        response.status(404).json({
          error: "Fan-out evidence has not been generated. Run npm run benchmark:fanout.",
        });
        return;
      }
      throw error;
    }
  });

  app.post("/api/dispatch", dispatchRateLimit, async (request, response) => {
    const input = DispatchRequestSchema.parse(request.body);

    if (input.mode === "jev" && !jevClient) {
      response.status(503).json({
        error: "Jev mode is unavailable because TYPESAFE_API_KEY is not configured on the server.",
      });
      return;
    }

    const result = await dispatchResponders({
      ...input,
      jevClient,
      inputCostPerMillionTokens: options.inputCostPerMillionTokens,
    });
    response.json(result);
  });

  if (existsSync(clientDirectory)) {
    app.use(express.static(clientDirectory));
    app.use((request, response, next) => {
      if (
        request.method !== "GET" ||
        request.path.startsWith("/api/") ||
        (request.path !== "/" && path.extname(request.path) !== "")
      ) {
        next();
        return;
      }
      response.sendFile(path.join(clientDirectory, "index.html"));
    });
  }

  app.use("/api", (_request, response) => {
    response.status(404).json({ error: "API route was not found." });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    console.error(error);

    if (error instanceof ZodError) {
      response.status(400).json({
        error: "Request validation failed.",
        issues: error.issues,
      });
      return;
    }

    if (error instanceof JevApiError) {
      response.status(502).json({
        error: error.message,
      });
      return;
    }

    response.status(500).json({
      error: error instanceof Error ? error.message : "Unexpected server error.",
    });
  });

  return app;
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
