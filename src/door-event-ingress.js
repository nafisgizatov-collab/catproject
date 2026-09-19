import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, booleanConfig, numberConfig } from "./config.js";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimePath = join(projectRoot, "runtime");
const eventPath = join(runtimePath, "relay-door-event.json");
const logPath = join(runtimePath, "door-event-ingress.log");

const settings = {
  enabled: booleanConfig("CAT_DOOR_RELAY_API_ENABLED", false),
  host: config("CAT_DOOR_RELAY_API_HOST", "0.0.0.0"),
  port: numberConfig("CAT_DOOR_RELAY_API_PORT", 3105, { min: 1024, max: 65535 }),
  token: config("CAT_DOOR_RELAY_TOKEN", ""),
  debounceMs: numberConfig("CAT_DOOR_RELAY_DEBOUNCE_MS", 1_000, { min: 0, max: 60_000 }),
};

function tokenMatches(received) {
  if (!settings.token || typeof received !== "string") return false;
  const expected = Buffer.from(settings.token);
  const actual = Buffer.from(received);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stdout.write(line);
  await appendFile(logPath, line);
}

function send(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(`${JSON.stringify(body)}\n`);
}

async function bodyJson(request) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 4_096) throw new Error("request body is too large");
  }
  return JSON.parse(text || "{}");
}

export async function startDoorEventIngress() {
  if (!settings.enabled) return null;
  if (!settings.token) throw new Error("CAT_DOOR_RELAY_API_ENABLED=true requires CAT_DOOR_RELAY_TOKEN in .env");

  const { createServer } = await import("node:http");
  await mkdir(runtimePath, { recursive: true });
  let lastState = null;
  let lastEventAt = 0;
  let lastOpenedAt = 0;
  let lastClosedAt = 0;

  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/api/door-event") {
      send(response, 404, { error: "not found" });
      return;
    }
    if (!tokenMatches(request.headers["x-door-token"])) {
      send(response, 401, { error: "unauthorized" });
      return;
    }
    try {
      const payload = await bodyJson(request);
      const state = payload?.state;
      if (state !== "opened" && state !== "closed") {
        send(response, 400, { error: "state must be opened or closed" });
        return;
      }
      const now = Date.now();
      if (state === lastState && now - lastEventAt < settings.debounceMs) {
        send(response, 200, { ok: true, duplicate: true });
        return;
      }
      lastState = state;
      lastEventAt = now;
      if (state === "opened") lastOpenedAt = now;
      else lastClosedAt = now;
      const event = { source: "esp-relay", state, lastOpenedAt, lastClosedAt, updatedAt: now };
      await writeFile(eventPath, `${JSON.stringify(event, null, 2)}\n`);
      await log(`accepted state=${state} remote=${request.socket.remoteAddress ?? "unknown"}`);
      send(response, 202, { ok: true, acceptedAt: now });
    } catch (error) {
      await log(`request rejected error=${error.message}`);
      send(response, 400, { error: "invalid request" });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(settings.port, settings.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await log(`started host=${settings.host} port=${settings.port}`);
  return server;
}
