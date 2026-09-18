import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { captureIndoorFrame, observeIndoorCat, recognizeIndoorFrame } from "./indoor-presence.js";
import { announceCatArrivalOnSpeaker } from "./alert-dispatcher.js";
import { numberConfig } from "./config.js";
import { projectRoot, sendMessageToSubscribers, sendPhotoToSubscribers, statePath, syncSubscribers } from "./telegram.js";

const runtime = join(projectRoot, "runtime");
const doorEventPath = join(runtime, "yandex-door-event.json");
const watcherStatePath = join(runtime, "indoor-door-watcher-state.json");
const logPath = join(runtime, "indoor-door-watcher.log");
const intervalMs = numberConfig("CAT_INDOOR_WATCH_INTERVAL_MS", 5_000, { min: 3_000, max: 60_000 });
const outsideCheckIntervalMs = numberConfig("CAT_INDOOR_OUTSIDE_CHECK_INTERVAL_MS", 60_000, { min: 30_000, max: 600_000 });
const staticCheckIntervalMs = numberConfig("CAT_INDOOR_STATIC_CHECK_INTERVAL_MS", 20_000, { min: 5_000, max: 300_000 });
const doorIdleMs = numberConfig("CAT_INDOOR_DOOR_IDLE_MS", 30 * 60_000, { min: 60_000, max: 86_400_000 });
const chairCheckMs = numberConfig("CAT_INDOOR_CHAIR_CHECK_INTERVAL_MS", 60_000, { min: 30_000, max: 3_600_000 });
const entryConfirmationMs = numberConfig("CAT_INDOOR_ENTRY_CONFIRMATION_MS", 30_000, { min: 5_000, max: 120_000 });
const entranceMotionThreshold = numberConfig("CAT_INDOOR_ENTRANCE_MOTION_THRESHOLD", 10, { min: 1, max: 255 });
let previousEntranceSample;
let previousSceneProfile;

async function indoorSceneProfile(imagePath) {
  const image = jpeg.decode(await readFile(imagePath), { useTArray: true });
  let luminance = 0;
  let chroma = 0;
  let count = 0;
  // A sparse full-frame sample is sufficient to notice the camera changing
  // from colour video to its monochrome IR profile; this is not ML inference.
  for (let y = 24; y < image.height - 24; y += 24) {
    for (let x = 24; x < image.width - 24; x += 24) {
      const offset = (y * image.width + x) * 4;
      const r = image.data[offset];
      const g = image.data[offset + 1];
      const b = image.data[offset + 2];
      luminance += r * 0.299 + g * 0.587 + b * 0.114;
      chroma += Math.max(r, g, b) - Math.min(r, g, b);
      count += 1;
    }
  }
  return { luminance: luminance / count, chroma: chroma / count };
}

function transitionedToIndoorNightMode(profile) {
  const previous = previousSceneProfile;
  previousSceneProfile = profile;
  if (!previous) return false;
  // IR turns this particular camera's colour image almost monochrome. Require
  // a substantial transition, rather than reacting to a person casting shade.
  return previous.chroma >= 18
    && profile.chroma <= 9
    && profile.chroma <= previous.chroma * 0.55;
}

function isIndoorNightMode(profile) {
  // This camera uses monochrome IR only after the hallway light is switched
  // off. The household rule is that this definitively means the cat is home.
  return profile.chroma <= 9;
}

async function entranceMotion(imagePath) {
  const image = jpeg.decode(await readFile(imagePath), { useTArray: true });
  const values = [];
  // Include the chair as well as the entrance: a cat moving onto it must wake inference.
  for (let y = 0; y < image.height; y += 12) {
    for (let x = 0; x < image.width; x += 12) {
      const offset = (y * image.width + x) * 4;
      values.push(Math.round(image.data[offset] * 0.299 + image.data[offset + 1] * 0.587 + image.data[offset + 2] * 0.114));
    }
  }
  const previous = previousEntranceSample;
  previousEntranceSample = values;
  if (!previous || previous.length !== values.length) return false;
  const difference = values.reduce((sum, value, index) => sum + Math.abs(value - previous[index]), 0) / values.length;
  return difference >= entranceMotionThreshold;
}

async function log(message) {
  await mkdir(runtime, { recursive: true });
  await writeFile(logPath, `${new Date().toISOString()} ${message}\n`, { flag: "a" });
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function lastDoorOpenedAt() {
  const event = await readJson(doorEventPath, null);
  // `lastOpenedAt` survives the following close transition. Support the old
  // one-event format only while upgrading an existing installation.
  return Number(event?.lastOpenedAt ?? (event?.type === "opened" ? event.at : 0)) || 0;
}

async function telegramState() {
  const telegram = await readJson(statePath, null);
  if (!telegram?.chatId) throw new Error("Telegram chat ID is not configured");
  return telegram;
}

async function announceSleepingCat(state, indoor, now) {
  const telegram = await telegramState();
  const added = await syncSubscribers(telegram);
  if (added.length) await log(`Telegram subscribers added: ${added.length}`);
  await sendPhotoToSubscribers(telegram, indoor.imagePath, "Котик спит");
  state.chairSleeping = true;
  state.chairSleepingSince = now;
  state.chairAbsentFrames = 0;
  await log(`chair-sleep notification sent details=${JSON.stringify(indoor.recognition)}`);
}

async function confirmEntryFromIndoorCamera(state, indoor, doorAt, now) {
  const telegram = await telegramState();
  const wasOutside = telegram.catOutside === true;
  const arrivalWasExpected = now < Number(telegram.catArrivalPendingUntil ?? 0);
  // A cat that was already known to be home may simply pass through the
  // hallway while a person opens the door.  Only an outside/expected cat is
  // evidence of an entry state transition.
  if (!wasOutside && !arrivalWasExpected) return false;
  telegram.catOutside = false;
  telegram.catOutUntil = 0;
  telegram.catArrivalPendingUntil = 0;
  telegram.wantOutPendingAt = 0;
  telegram.wantOutDoorAt = 0;
  telegram.indoorCatLastSeenAt = now;
  const added = await syncSubscribers(telegram);
  if (added.length) await log(`Telegram subscribers added: ${added.length}`);
  await writeFile(statePath, `${JSON.stringify(telegram, null, 2)}\n`);
  if (wasOutside) {
    await sendMessageToSubscribers(telegram, "Котик дома");
    try {
      await announceCatArrivalOnSpeaker(log);
    } catch (error) {
      await log(`speaker notification failed error=${error.message}`);
    }
  }
  state.entryConfirmedForDoorAt = doorAt;
  await log(`entry confirmed by indoor camera within 30s details=${JSON.stringify(indoor.recognition)}`);
  return true;
}

async function confirmHomeFromNightMode(state, now, profile) {
  const telegram = await telegramState();
  const wasOutside = telegram.catOutside === true;
  const arrivalWasExpected = now < Number(telegram.catArrivalPendingUntil ?? 0);
  if (!wasOutside && !arrivalWasExpected) return false;
  telegram.catOutside = false;
  telegram.catOutUntil = 0;
  telegram.catArrivalPendingUntil = 0;
  telegram.wantOutPendingAt = 0;
  telegram.wantOutDoorAt = 0;
  telegram.indoorCatLastSeenAt = now;
  const added = await syncSubscribers(telegram);
  if (added.length) await log(`Telegram subscribers added: ${added.length}`);
  await writeFile(statePath, `${JSON.stringify(telegram, null, 2)}\n`);
  if (wasOutside) {
    await sendMessageToSubscribers(telegram, "Котик дома");
    try {
      await announceCatArrivalOnSpeaker(log);
    } catch (error) {
      await log(`speaker notification failed error=${error.message}`);
    }
  }
  state.nightHomeConfirmedAt = now;
  await log(`entry confirmed by indoor night-mode transition profile=${JSON.stringify(profile)}`);
  return true;
}

async function check() {
  const now = Date.now();
  const saved = await readJson(watcherStatePath, {});
  const savedJson = JSON.stringify(saved);
  const actualDoorAt = await lastDoorOpenedAt();
  const currentTelegram = await readJson(statePath, {});
  const catIsKnownOutside = currentTelegram.catOutside === true;
  const doorIsActivelyBeingHandled = actualDoorAt
    && now >= actualDoorAt
    && now - actualDoorAt <= entryConfirmationMs;
  // Once the cat is outside, the indoor view only needs a periodic sanity
  // check. A fresh door event immediately restores the normal five-second
  // cadence so a quick return is still caught.
  const effectiveEntranceIntervalMs = catIsKnownOutside && !doorIsActivelyBeingHandled
    ? outsideCheckIntervalMs
    : intervalMs;
  // On a first ever start we do not know how long the door had been closed.
  // Start the 30-minute window now rather than send a surprise alert.
  const doorAt = actualDoorAt || saved.lastDoorOpenedAt || now;
  const state = { ...saved, lastDoorOpenedAt: doorAt };
  if (now - Number(state.lastEntranceCheckAt ?? 0) < effectiveEntranceIntervalMs) return;
  let indoor;
  let captured;
  async function observeOnce() {
    if (!indoor) {
      if (captured?.imagePath) indoor = await recognizeIndoorFrame(captured.imagePath);
      else indoor = await observeIndoorCat();
      state.lastRecognitionAt = Date.now();
    }
    return indoor;
  }

  // A five-second frame comparison is cheap.  The neural recognizer runs only
  // after real motion in the entrance zone, preventing continuous CPU load.
  if (now - Number(state.lastEntranceCheckAt ?? 0) >= effectiveEntranceIntervalMs) {
    state.lastEntranceCheckAt = now;
    captured = await captureIndoorFrame();
    if (captured.error || !captured.imagePath) {
      await log(`entrance capture skipped error=${captured.error}`);
      await writeFile(watcherStatePath, `${JSON.stringify(state, null, 2)}\n`);
      return;
    } else {
      const profile = await indoorSceneProfile(captured.imagePath);
      const nightModeStarted = transitionedToIndoorNightMode(profile);
      // A startup in night mode counts too: the user treats the camera's IR
      // state itself as definitive evidence that the cat is already home.
      if (isIndoorNightMode(profile) && !state.nightHomeConfirmedAt) {
        await confirmHomeFromNightMode(state, now, profile);
      } else if (nightModeStarted) {
        await confirmHomeFromNightMode(state, now, profile);
      }
      const moved = await entranceMotion(captured.imagePath);
      const staticDue = now - Number(state.lastRecognitionAt ?? 0) >= (catIsKnownOutside ? outsideCheckIntervalMs : staticCheckIntervalMs);
      if (!moved && !staticDue && !doorIsActivelyBeingHandled) {
        await writeFile(watcherStatePath, `${JSON.stringify(state, null, 2)}\n`);
        return;
      }
      state.lastRecognitionAt = now;
      if (moved || staticDue) {
        const entranceFrame = await observeOnce();
        if (catIsKnownOutside && entranceFrame.observed && !doorIsActivelyBeingHandled) {
          await confirmEntryFromIndoorCamera(state, entranceFrame, actualDoorAt, now);
        }
        if (entranceFrame.nearDoor) {
          state.nearDoorCatLastSeenAt = now;
          state.nearDoorCatImagePath = entranceFrame.imagePath;
          await log(`cat observed at indoor entrance details=${JSON.stringify(entranceFrame.recognition)}`);
        }
      }
    }
  }

  // A cat can cross the outside camera between two heavy recognition passes.
  // When the door contact has actually opened, use the indoor camera for the
  // next 30 seconds to confirm an entry. The outer loop itself is cheap; image
  // inference happens only during this short sensor-confirmed window.
  const entryWindowOpen = actualDoorAt
    && now >= actualDoorAt
    && now - actualDoorAt <= entryConfirmationMs
    && state.entryConfirmedForDoorAt !== actualDoorAt;
  if (entryWindowOpen) {
    const entryFrame = await observeOnce();
    if (entryFrame.error) {
      await log(`entry confirmation skipped error=${entryFrame.error}`);
    } else if (entryFrame.observed) {
      await confirmEntryFromIndoorCamera(state, entryFrame, actualDoorAt, now);
    }
  }

  // Chair monitoring is intentionally slower than the main loop.  A sleeping
  // cat does not need sub-second latency, and this avoids needlessly heating
  // the computer with an extra camera inference every iteration.
  if (now - (state.lastChairCheckAt ?? 0) >= chairCheckMs) {
    state.lastChairCheckAt = now;
    const chairFrame = await observeOnce();
    if (chairFrame.error) {
      await log(`chair check skipped error=${chairFrame.error}`);
    } else if (chairFrame.recognition?.onChair) {
      state.chairAbsentFrames = 0;
      if (!state.chairSleeping) await announceSleepingCat(state, chairFrame, now);
    } else if (state.chairSleeping) {
      // Two clear non-chair frames prevent a transient detector miss from
      // rearming the notification while the cat is still asleep.
      state.chairAbsentFrames = Number(state.chairAbsentFrames ?? 0) + 1;
      if (state.chairAbsentFrames >= 2) {
        state.chairSleeping = false;
        state.chairSleepingSince = 0;
        state.chairAbsentFrames = 0;
        await log("chair-sleep notification rearmed: cat left the chair");
      }
    }
  }
  if (actualDoorAt && actualDoorAt !== saved.lastDoorOpenedAt) {
    delete state.notifiedForDoorAt;
    await log(`door opening observed; want-out notification unlocked at=${actualDoorAt}`);
  }
  if (now - doorAt < doorIdleMs) {
    if (JSON.stringify(state) !== savedJson) {
      await writeFile(watcherStatePath, `${JSON.stringify(state, null, 2)}\n`);
    }
    return;
  }
  if (state.notifiedForDoorAt === doorAt) {
    if (JSON.stringify(state) !== savedJson) {
      await writeFile(watcherStatePath, `${JSON.stringify(state, null, 2)}\n`);
    }
    return;
  }

  const doorFrame = await observeOnce();
  if (doorFrame.error) {
    await log(`indoor camera skipped error=${doorFrame.error}`);
    return;
  }
  if (!doorFrame.nearDoor) {
    await writeFile(watcherStatePath, `${JSON.stringify(state, null, 2)}\n`);
    return;
  }

  const telegram = await telegramState();
  const wasOutside = telegram.catOutside === true;
  telegram.catOutside = false;
  telegram.catOutUntil = 0;
  telegram.catArrivalPendingUntil = 0;
  telegram.indoorCatLastSeenAt = now;
  telegram.wantOutPendingAt = now;
  telegram.wantOutDoorAt = doorAt;
  const added = await syncSubscribers(telegram);
  if (added.length) await log(`Telegram subscribers added: ${added.length}`);
  await writeFile(statePath, `${JSON.stringify(telegram, null, 2)}\n`);
  if (wasOutside) await sendMessageToSubscribers(telegram, "Котик дома");
  await sendPhotoToSubscribers(telegram, doorFrame.imagePath, "Котик хочет на улицу");
  state.notifiedForDoorAt = doorAt;
  state.notifiedAt = now;
  await writeFile(watcherStatePath, `${JSON.stringify(state, null, 2)}\n`);
  await log(`want-out notification sent; exit context recorded details=${JSON.stringify(indoor.recognition)}`);
}

export async function checkIndoorCamera() {
  try { await check(); }
  catch (error) { await log(`watcher error=${error.message}`); }
}
