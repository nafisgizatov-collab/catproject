import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot, sendPhoto, statePath } from "./telegram.js";

const eventsDirectory = join(projectRoot, "runtime", "events");
const { chatId } = JSON.parse(await readFile(statePath, "utf8"));
// Allow a small grace period: a motion frame can be written while this short-lived
// debugger process is starting.
const startedAt = Date.now() - 15_000;
const deadline = startedAt + 60_000;

while (Date.now() < deadline) {
  const entries = await readdir(eventsDirectory, { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith("motion-") && entry.name.endsWith(".jpg"))
      .map(async (entry) => {
        const path = join(eventsDirectory, entry.name);
        const { mtimeMs } = await (await import("node:fs/promises")).stat(path);
        return { path, mtimeMs };
      }),
  );
  const motion = candidates
    .filter((candidate) => candidate.mtimeMs >= startedAt)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];

  if (motion) {
    await sendPhoto(chatId, motion.path, "Отладка: зафиксировано движение у двери.");
    console.log(`Motion photo sent: ${motion.path}`);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

console.log("Debug window ended without motion.");
