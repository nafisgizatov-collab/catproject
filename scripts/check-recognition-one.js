import { recognizeOrangeCat } from "../src/cat-recognizer.js";

const startedAt = Date.now();
try {
  const result = await recognizeOrangeCat(process.argv[2]);
  console.log(JSON.stringify({
    accepted: result.accepted,
    reason: result.reason,
    direction: result.direction,
    elapsedMs: Date.now() - startedAt,
  }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message, elapsedMs: Date.now() - startedAt }));
}
