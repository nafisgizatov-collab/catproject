import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot, sendPhoto, statePath } from "./telegram.js";

const eventsDirectory = join(projectRoot, "runtime", "events");
const { chatId } = JSON.parse(await readFile(statePath, "utf8"));
const files = await readdir(eventsDirectory);
const candidates = await Promise.all(
  files
    .filter((name) => name.startsWith("motion-") && name.endsWith(".jpg"))
    .map(async (name) => ({ name, ...(await stat(join(eventsDirectory, name))) })),
);
const latest = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
if (!latest) throw new Error("No motion images found.");

await sendPhoto(chatId, join(eventsDirectory, latest.name), "Отладка: зафиксировано движение у двери.");
console.log(`Motion photo sent: ${latest.name}`);
