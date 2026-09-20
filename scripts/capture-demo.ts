import "dotenv/config";
import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const apiKey = process.env.TYPESAFE_API_KEY?.trim();
if (!apiKey) {
  throw new Error("TYPESAFE_API_KEY is required to capture the live Jev demo.");
}

const root = process.cwd();
const port = 8_791;
const baseUrl = `http://127.0.0.1:${port}`;
const mediaDirectory = path.join(root, "media");
const temporaryDirectory = path.join(root, ".capture");
const screenshotPath = path.join(mediaDirectory, "jev-parallel-dispatch.png");
const webmPath = path.join(mediaDirectory, "jev-parallel-dispatch-demo.webm");
const mp4Path = path.join(mediaDirectory, "jev-parallel-dispatch-demo.mp4");

await mkdir(mediaDirectory, { recursive: true });
await rm(temporaryDirectory, { recursive: true, force: true });
await mkdir(temporaryDirectory, { recursive: true });

const server = spawn(process.execPath, ["dist-server/index.js"], {
  cwd: root,
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (chunk) => process.stdout.write(chunk));
server.stderr.on("data", (chunk) => process.stderr.write(chunk));

try {
  await waitForServer(`${baseUrl}/api/status`, 20_000);
  const browser = await chromium.launch({
    headless: true,
  });
  const context = await browser.newContext({
    viewport: {
      width: 1_600,
      height: 1_100,
    },
    recordVideo: {
      dir: temporaryDirectory,
      size: {
        width: 1_600,
        height: 1_100,
      },
    },
  });
  const page = await context.newPage();
  const video = page.video();

  await page.goto(`${baseUrl}/?teams=48&speed=2`, {
    waitUntil: "networkidle",
  });
  await page.locator("#operation-message").waitFor({
    state: "visible",
    timeout: 60_000,
  });
  await page.waitForFunction(
    () =>
      document
        .querySelector("#operation-message")
        ?.textContent?.includes("48 team decisions returned"),
    undefined,
    {
      timeout: 60_000,
    },
  );
  await page.screenshot({
    path: screenshotPath,
    fullPage: false,
  });

  await page.waitForTimeout(4_000);
  await page.locator("#call-metrics").scrollIntoViewIfNeeded();
  await page.waitForTimeout(5_000);
  await page.locator("#counterfactual-grid").scrollIntoViewIfNeeded();
  await page.waitForTimeout(5_000);
  await page.locator("#decision-rows").scrollIntoViewIfNeeded();
  await page.waitForTimeout(7_000);
  await page.locator("#benchmark-rows").scrollIntoViewIfNeeded();
  await page.waitForTimeout(6_000);

  await context.close();
  await browser.close();

  if (!video) {
    throw new Error("Playwright did not create a video.");
  }
  await copyFile(await video.path(), webmPath);

  const conversion = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-i",
      webmPath,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "22",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      mp4Path,
    ],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  if (conversion.status !== 0) {
    throw new Error(`ffmpeg exited with status ${conversion.status}.`);
  }
  await rm(webmPath, { force: true });

  console.log(`Screenshot: ${screenshotPath}`);
  console.log(`Recording: ${mp4Path}`);
} finally {
  server.kill();
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // The server has not started accepting connections yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Server did not become ready within ${timeoutMs} ms.`);
}
