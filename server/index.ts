import "dotenv/config";
import { createApplication } from "./app";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const inputCostPerMillionTokens = Number(process.env.TYPESAFE_INPUT_COST_PER_MILLION ?? 0.042);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid PORT value: ${process.env.PORT}`);
}

const app = createApplication({
  apiKey: process.env.TYPESAFE_API_KEY,
  model: process.env.TYPESAFE_MODEL ?? "jev-1.13.0",
  inputCostPerMillionTokens,
});

app.listen(port, host, () => {
  console.log(`Jev parallel dispatch server listening at http://${host}:${port}`);
  if (!process.env.TYPESAFE_API_KEY) {
    console.log("TYPESAFE_API_KEY is not set. Local deterministic dispatch remains available.");
  }
});
