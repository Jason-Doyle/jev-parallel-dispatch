import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApplication } from "../server/app";
import { createCrisisSnapshot } from "../src/shared/crisis";

const cleanupDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        }),
    ),
  );
  await Promise.all(
    cleanupDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("HTTP API", () => {
  it("returns a capacity-safe local dispatch plan", async () => {
    const { rootDirectory, baseUrl } = await startTestApplication();
    cleanupDirectories.push(rootDirectory);
    const snapshot = createCrisisSnapshot(16, 444);
    const response = await fetch(`${baseUrl}/api/dispatch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        snapshot,
        doctrine: "Protect civilians and preserve specialist capacity.",
        mode: "local",
      }),
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      questionCount: number;
      decisions: Array<{ assignedTaskId: string }>;
    };
    expect(result.questionCount).toBe(19);
    expect(result.decisions).toHaveLength(16);

    for (const incident of snapshot.incidents) {
      expect(
        result.decisions.filter((decision) => decision.assignedTaskId === incident.id).length,
      ).toBeLessThanOrEqual(incident.capacity);
    }
  });

  it("serves retained fan-out evidence", async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "jev-evidence-test-"));
    cleanupDirectories.push(rootDirectory);
    const evidenceDirectory = path.join(rootDirectory, "evidence");
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(
      path.join(evidenceDirectory, "fanout-benchmark.json"),
      JSON.stringify({
        model: "jev-1.13.0",
        summary: [{ units: 32, questions: 35 }],
      }),
      "utf8",
    );
    const { baseUrl } = await startTestApplication(rootDirectory);

    const response = await fetch(`${baseUrl}/api/evidence/fanout`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      summary: Array<{ units: number; questions: number }>;
    };
    expect(body.summary[0]).toEqual({
      units: 32,
      questions: 35,
    });
  });

  it("rate limits dispatch requests", async () => {
    const { rootDirectory, baseUrl } = await startTestApplication();
    cleanupDirectories.push(rootDirectory);
    const snapshot = createCrisisSnapshot(4, 445);
    const request = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        snapshot,
        doctrine: "Protect civilians.",
        mode: "local",
      }),
    };

    for (let index = 0; index < 20; index += 1) {
      const response = await fetch(`${baseUrl}/api/dispatch`, request);
      expect(response.status).toBe(200);
    }

    const limited = await fetch(`${baseUrl}/api/dispatch`, request);
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({
      error: "Dispatch request limit exceeded. Try again shortly.",
    });
  });
});

async function startTestApplication(
  existingRootDirectory?: string,
): Promise<{ rootDirectory: string; baseUrl: string }> {
  const rootDirectory =
    existingRootDirectory ?? (await mkdtemp(path.join(os.tmpdir(), "jev-command-test-")));
  const app = createApplication({ rootDirectory });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose a TCP port.");
  }

  return {
    rootDirectory,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}
