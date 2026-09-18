import { mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import { booleanConfig, config, numberConfig } from "./config.js";
import { checkIndoorCamera } from "./indoor-door-watcher.js";
import { startDoorEventIngress } from "./door-event-ingress.js";
import {
  processMotionEvent,
  processDoorOpeningFromIndoorCamera,
  reconcileAfterDoorClosed,
} from "./alert-dispatcher.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const eventDirectory = join(projectRoot, "runtime", "events");
const logPath = join(projectRoot, "runtime", "motion-trigger.log");
// The Yandex poller remains the fallback source. The ESP bridge writes a
// separate file so neither source can erase the other's transition record.
const externalDoorEventPaths = [
  join(projectRoot, "runtime", "relay-door-event.json"),
  join(projectRoot, "runtime", "yandex-door-event.json"),
];

const settings = {
  snapshotUrl: config("CAT_SNAPSHOT_URL", "http://127.0.0.1:1984/api/frame.jpeg?src=door"),
  pollIntervalMs: numberConfig("CAT_POLL_INTERVAL_MS", 1000, { min: 500, max: 10_000 }),
  // Keep evidence during movement often enough to catch a cat crossing the
  // threshold. The detector remains sequential; this does not create workers.
  cooldownMs: numberConfig("CAT_MOTION_COOLDOWN_MS", 5_000, { min: 1_000, max: 60_000 }),
  reconnectIntervalMs: numberConfig("CAT_RECONNECT_INTERVAL_MS", 30_000, { min: 1_000, max: 300_000 }),
  // The door mat and threshold: excludes the grass on the left of the image.
  roi: {
    x: numberConfig("CAT_OUTDOOR_ROI_X", 0.28, { min: 0, max: 1 }),
    y: numberConfig("CAT_OUTDOOR_ROI_Y", 0.08, { min: 0, max: 1 }),
    width: numberConfig("CAT_OUTDOOR_ROI_WIDTH", 0.72, { min: 0.01, max: 1 }),
    height: numberConfig("CAT_OUTDOOR_ROI_HEIGHT", 0.83, { min: 0.01, max: 1 }),
  },
  // Upper-middle part of the door in the raised camera angle. It contains the
  // moving door panel but excludes the lower mat and its changing shadows.
  doorRoi: {
    x: numberConfig("CAT_DOOR_ROI_X", 0.72, { min: 0, max: 1 }),
    y: numberConfig("CAT_DOOR_ROI_Y", 0.1, { min: 0, max: 1 }),
    width: numberConfig("CAT_DOOR_ROI_WIDTH", 0.18, { min: 0.01, max: 1 }),
    height: numberConfig("CAT_DOOR_ROI_HEIGHT", 0.28, { min: 0.01, max: 1 }),
  },
  sampleStep: numberConfig("CAT_MOTION_SAMPLE_STEP", 8, { min: 1, max: 64 }),
  motionThreshold: numberConfig("CAT_MOTION_THRESHOLD", 7, { min: 1, max: 255 }),
  doorMotionThreshold: numberConfig("CAT_DOOR_MOTION_THRESHOLD", 15, { min: 1, max: 255 }),
  // A strong change of the whole door panel is required to confirm a new
  // opening for the "cat is home" state transition.
  doorOpenThreshold: numberConfig("CAT_DOOR_OPEN_THRESHOLD", 20, { min: 1, max: 255 }),
  // The door may finish closing before the cat reaches a clear part of the
  // porch. Keep the post-opening window long enough to observe that exit.
  doorQuietPeriodMs: numberConfig("CAT_DOOR_QUIET_PERIOD_MS", 30_000, { min: 5_000, max: 120_000 }),
  doorExitWindowMs: numberConfig("CAT_DOOR_EXIT_WINDOW_MS", 5 * 60_000, { min: 30_000, max: 900_000 }),
  presenceCheckIntervalMs: numberConfig("CAT_PRESENCE_CHECK_INTERVAL_MS", 20_000, { min: 5_000, max: 300_000 }),
  // A cat crosses the threshold much faster than the normal 20-second
  // presence poll.  For the brief window after a real contact-sensor event,
  // inspect the available frames much more often. Inference is sequential, so
  // this cannot create parallel model processes.
  contactScanIntervalMs: numberConfig("CAT_CONTACT_SCAN_INTERVAL_MS", 2_000, { min: 1_000, max: 30_000 }),
  // The Xiaomi contact sensor is the authoritative source. Video-based door
  // inference can be manually re-enabled only if that sensor is unavailable.
  videoDoorFallbackEnabled: booleanConfig("CAT_VIDEO_DOOR_FALLBACK", false),
};

let previousSample;
let previousDoorSample;
let lastEventAt = 0;
let lastDoorMotionAt = 0;
let lastDoorOpenAt = 0;
let lastPresenceCheckAt = 0;
let lastExternalDoorOpenedAt = 0;
let lastExternalDoorClosedAt = 0;
let lastContactDoorOpenAt = 0;
let lastAppliedExternalDoorState = null;
// A real contact event owns exactly one expensive outdoor confirmation.
let pendingDoorConfirmation = false;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replace(".", "_");
}

function sampleArea(image, roi) {
  const { width, height, data } = image;
  const startX = Math.floor(width * roi.x);
  const startY = Math.floor(height * roi.y);
  const endX = Math.min(width, Math.floor(width * (roi.x + roi.width)));
  const endY = Math.min(height, Math.floor(height * (roi.y + roi.height)));
  const values = [];

  for (let y = startY; y < endY; y += settings.sampleStep) {
    for (let x = startX; x < endX; x += settings.sampleStep) {
      const offset = (y * width + x) * 4;
      values.push(Math.round(data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114));
    }
  }
  return values;
}

function motionScore(current, previous) {
  if (current.length !== previous.length) return Number.POSITIVE_INFINITY;
  const currentMean = current.reduce((sum, value) => sum + value, 0) / current.length;
  const previousMean = previous.reduce((sum, value) => sum + value, 0) / previous.length;
  const brightnessShift = currentMean - previousMean;
  const totalDifference = current.reduce(
    (sum, value, index) => sum + Math.abs(value - brightnessShift - previous[index]),
    0,
  );
  return totalDifference / current.length;
}

async function record(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stdout.write(line);
  await appendFile(logPath, line);
}

async function readSnapshot() {
  const response = await fetch(settings.snapshotUrl, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`snapshot request failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function applyExternalDoorEvent(now, jpegData) {
  for (const externalDoorEventPath of externalDoorEventPaths) {
    try {
      const event = JSON.parse(await readFile(externalDoorEventPath, "utf8"));
    const openedAt = Number(event?.lastOpenedAt ?? (event?.type === "opened" ? event.at : 0)) || 0;
    const closedAt = Number(event?.lastClosedAt ?? (event?.type === "closed" ? event.at : 0)) || 0;
    if (openedAt > lastExternalDoorOpenedAt) {
      lastExternalDoorOpenedAt = openedAt;
      if (now - openedAt > settings.doorQuietPeriodMs) {
        await record("stale Yandex door opening ignored after restart");
        if (event.state === "opened") lastAppliedExternalDoorState = "opened";
      } else if (lastAppliedExternalDoorState === "opened") {
        await record(`duplicate door opening from ${event.source ?? "external sensor"} ignored`);
      } else {
      lastAppliedExternalDoorState = "opened";
      lastDoorMotionAt = openedAt;
      lastDoorOpenAt = openedAt;
      lastContactDoorOpenAt = openedAt;
      pendingDoorConfirmation = true;
      await record(`door opening confirmed by ${event.source ?? "external sensor"}; one full outdoor confirmation queued`);
      try {
        await processDoorOpeningFromIndoorCamera(record, event.indoorOpeningImagePath ?? null);
      } catch (error) {
        await record(`indoor opening snapshot failed error=${error.message}`);
      }
      }
    }
    if (closedAt > lastExternalDoorClosedAt) {
      lastExternalDoorClosedAt = closedAt;
      if (now - closedAt > settings.doorQuietPeriodMs) {
        await record("stale Yandex door closing ignored after restart");
        if (event.state === "closed") lastAppliedExternalDoorState = "closed";
      } else if (lastAppliedExternalDoorState === "closed") {
        await record(`duplicate door closing from ${event.source ?? "external sensor"} ignored`);
      } else {
        lastAppliedExternalDoorState = "closed";
        const eventName = `door-closed-${timestamp()}.jpg`;
        const eventPath = join(eventDirectory, eventName);
        await writeFile(eventPath, jpegData);
        pendingDoorConfirmation = false;
        await record(`door closing confirmed by ${event.source ?? "external sensor"}; exterior image=${eventName}`);
        try {
          await reconcileAfterDoorClosed(eventPath, record);
        } catch (error) {
          await record(`door-close reconciliation failed error=${error.message}`);
        }
      }
    }
    } catch (error) {
      if (error.code !== "ENOENT") await record(`external door event skipped error=${error.message}`);
    }
  }
}

async function poll() {
  const jpegData = await readSnapshot();
  const image = jpeg.decode(jpegData, { useTArray: true });
  const currentSample = sampleArea(image, settings.roi);
  const currentDoorSample = sampleArea(image, settings.doorRoi);
  const now = Date.now();

  await applyExternalDoorEvent(now, jpegData);
  const inContactWindow = now - lastContactDoorOpenAt <= settings.doorQuietPeriodMs;

  if (settings.videoDoorFallbackEnabled && previousDoorSample) {
    const doorScore = motionScore(currentDoorSample, previousDoorSample);
    if (doorScore >= settings.doorMotionThreshold) {
      lastDoorMotionAt = now;
      await record(`door movement score=${doorScore.toFixed(2)}`);
      if (doorScore >= settings.doorOpenThreshold) {
        lastDoorOpenAt = now;
        await record(`door opening confirmed score=${doorScore.toFixed(2)}`);
      }
    }
  }

  if (previousSample) {
    const score = motionScore(currentSample, previousSample);
    const eventCooldown = inContactWindow ? settings.contactScanIntervalMs : settings.cooldownMs;
    if (score >= settings.motionThreshold && now - lastEventAt >= eventCooldown) {
      const eventName = `motion-${timestamp()}-score-${score.toFixed(1)}.jpg`;
      const eventPath = join(eventDirectory, eventName);
      await writeFile(eventPath, jpegData);
      await record(`motion score=${score.toFixed(2)} image=${eventName}`);
      lastEventAt = now;
      try {
        await processMotionEvent(eventPath, record, {
          doorOpenedRecently: now - lastDoorMotionAt <= settings.doorQuietPeriodMs,
          doorOpenedInExitWindow: now - lastDoorOpenAt <= settings.doorExitWindowMs,
          doorContactOpenedRecently: now - lastContactDoorOpenAt <= settings.doorQuietPeriodMs,
          forceFullAnalysis: pendingDoorConfirmation,
          allowEmptyFast: false,
        });
        if (pendingDoorConfirmation) {
          pendingDoorConfirmation = false;
          await record("door opening full outdoor confirmation completed");
        }
        lastPresenceCheckAt = Date.now();
        lastEventAt = lastPresenceCheckAt;
      } catch (error) {
        // A recognition or Telegram failure must never stop camera reconnects.
        await record(`event processing failed error=${error.message}`);
      }
    }
  }

  // A waiting cat may stop moving before another motion event occurs.
  const presenceInterval = inContactWindow ? settings.contactScanIntervalMs : settings.presenceCheckIntervalMs;
  if (now - lastPresenceCheckAt >= presenceInterval) {
    const eventName = `presence-${timestamp()}.jpg`;
    const eventPath = join(eventDirectory, eventName);
    await writeFile(eventPath, jpegData);
    await record(`presence check image=${eventName}`);
    try {
      await processMotionEvent(eventPath, record, {
          doorOpenedRecently: now - lastDoorMotionAt <= settings.doorQuietPeriodMs,
          doorOpenedInExitWindow: now - lastDoorOpenAt <= settings.doorExitWindowMs,
          doorContactOpenedRecently: now - lastContactDoorOpenAt <= settings.doorQuietPeriodMs,
          forceFullAnalysis: pendingDoorConfirmation,
          allowEmptyFast: !inContactWindow && !pendingDoorConfirmation,
      });
      if (pendingDoorConfirmation) {
        pendingDoorConfirmation = false;
        await record("door opening full outdoor confirmation completed");
      }
    } catch (error) {
      await record(`presence processing failed error=${error.message}`);
    }
    lastPresenceCheckAt = Date.now();
  }

  previousSample = currentSample;
  previousDoorSample = currentDoorSample;
}

await mkdir(eventDirectory, { recursive: true });
await startDoorEventIngress();
await record(
  `started interval=${settings.pollIntervalMs}ms threshold=${settings.motionThreshold} cooldown=${settings.cooldownMs}ms door-quiet=${settings.doorQuietPeriodMs}ms presence-check=${settings.presenceCheckIntervalMs}ms`,
);

let resourceLoggedAt = 0;
let previousCpu = process.cpuUsage();
let previousCpuAt = performance.now();

while (true) {
  // One process, one shared pair of models; never run camera inference in parallel.
  await checkIndoorCamera();
  try {
    await poll();
  } catch (error) {
    await record(
      `camera unavailable error=${error.message}; retrying in ${settings.reconnectIntervalMs / 1000}s`,
    );
    await wait(settings.reconnectIntervalMs);
    continue;
  }
  if (Date.now() - resourceLoggedAt >= 60_000) {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const sampledAt = performance.now();
    const cpuCorePercent = 100 * (cpu.user + cpu.system - previousCpu.user - previousCpu.system)
      / ((sampledAt - previousCpuAt) * 1000);
    await record(`resources pid=${process.pid} rssMiB=${Math.round(memory.rss / 1048576)} heapMiB=${Math.round(memory.heapUsed / 1048576)} cpuOneCorePercent=${cpuCorePercent.toFixed(1)} models=fp32 threads=2 arena=off`);
    previousCpu = cpu;
    previousCpuAt = sampledAt;
    resourceLoggedAt = Date.now();
  }
  await wait(settings.pollIntervalMs);
}
