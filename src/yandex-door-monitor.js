import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, numberConfig } from "./config.js";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtime = join(projectRoot, "runtime");
const envPath = join(projectRoot, ".env");
const eventPath = join(runtime, "yandex-door-event.json");
const devicePath = join(runtime, "yandex-door-device.json");
const logPath = join(runtime, "yandex-door-monitor.log");
const apiRoot = "https://api.iot.yandex.net/v1.0";

function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).filter((line) => line && !line.startsWith("#")).map((line) => {
    const separator = line.indexOf("=");
    return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

async function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stdout.write(line);
  await appendFile(logPath, line);
}

async function api(path, token) {
  const response = await fetch(`${apiRoot}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Yandex API returned HTTP ${response.status}`);
  return response.json();
}

function devicesFrom(payload) {
  return payload?.devices ?? payload?.payload?.devices ?? [];
}

function openState(device) {
  const property = (device?.properties ?? []).find((item) => item?.state?.instance === "open" || item?.parameters?.instance === "open");
  const value = property?.state?.value;
  if (value === "opened" || value === true || value === "open") return "opened";
  if (value === "closed" || value === false || value === "close") return "closed";
  return null;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readDoorState() {
  try {
    const saved = JSON.parse(await readFile(eventPath, "utf8"));
    return {
      state: saved.state ?? saved.type ?? null,
      lastOpenedAt: Number(saved.lastOpenedAt ?? (saved.type === "opened" ? saved.at : 0)) || 0,
      lastClosedAt: Number(saved.lastClosedAt ?? (saved.type === "closed" ? saved.at : 0)) || 0,
    };
  } catch (error) {
    if (error.code === "ENOENT") return { state: null, lastOpenedAt: 0, lastClosedAt: 0 };
    throw error;
  }
}

async function saveDoorState(state, lastOpenedAt, lastClosedAt) {
  await writeFile(eventPath, `${JSON.stringify({
    source: "yandex",
    state,
    lastOpenedAt,
    lastClosedAt,
    updatedAt: Date.now(),
  }, null, 2)}\n`);
}

await mkdir(runtime, { recursive: true });
const env = parseEnv(await readFile(envPath, "utf8"));
const token = env.YANDEX_OAUTH_TOKEN;
const deviceName = config("YANDEX_DOOR_DEVICE_NAME", env.YANDEX_DOOR_DEVICE_NAME ?? "входная дверь").toLocaleLowerCase("ru");
const intervalMs = numberConfig("YANDEX_DOOR_POLL_INTERVAL_MS", env.YANDEX_DOOR_POLL_INTERVAL_MS ?? 2_000, { min: 1_000, max: 60_000 });

if (!token) {
  await log("not started: YANDEX_OAUTH_TOKEN is missing");
  process.exit(0);
}

let deviceId = config("YANDEX_DOOR_DEVICE_ID", env.YANDEX_DOOR_DEVICE_ID ?? "");
if (!deviceId) {
  const info = await api("/user/info", token);
  const device = devicesFrom(info).find((item) => item?.name?.toLocaleLowerCase("ru") === deviceName);
  if (!device) throw new Error(`door device named \"${deviceName}\" was not found in Yandex Home`);
  deviceId = device.id;
  await writeFile(devicePath, `${JSON.stringify({ id: deviceId, name: device.name }, null, 2)}\n`);
  await log(`door device found name=${device.name}`);
}

const persisted = await readDoorState();
let previousState = null;
let lastOpenedAt = persisted.lastOpenedAt;
let lastClosedAt = persisted.lastClosedAt;
await log(`started interval=${intervalMs}ms`);
while (true) {
  try {
    const response = await api(`/devices/${encodeURIComponent(deviceId)}`, token);
    const device = response?.device ?? response?.payload?.device ?? response;
    const state = openState(device);
    if (!state) {
      await log("door state unavailable in API response");
    } else if (previousState === null) {
      previousState = state;
      // A process restart must not invent an opening or closing event. Keep
      // the existing transition times and record only the observed baseline.
      await saveDoorState(state, lastOpenedAt, lastClosedAt);
      await log(`initial state=${state}`);
    } else if (state !== previousState) {
      await log(`door state ${previousState} -> ${state}`);
      const changedAt = Date.now();
      if (state === "opened") lastOpenedAt = changedAt;
      else lastClosedAt = changedAt;
      await saveDoorState(state, lastOpenedAt, lastClosedAt);
      previousState = state;
    }
  } catch (error) {
    await log(`poll failed error=${error.message}`);
  }
  await sleep(intervalMs);
}
