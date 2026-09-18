import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { recognizeOrangeCat } from "./cat-recognizer.js";
import { config, numberConfig } from "./config.js";
import { captureIndoorFrame, observeIndoorCat, recognizeIndoorFrame } from "./indoor-presence.js";
import {
  sendMessageToSubscribers,
  sendPhotoToSubscribers,
  projectRoot,
  statePath,
  syncSubscribers,
} from "./telegram.js";

const alertCooldownMs = numberConfig("CAT_ALERT_COOLDOWN_MS", 5 * 60_000, { min: 0, max: 3_600_000 });
const exitSuppressionMs = numberConfig("CAT_EXIT_SUPPRESSION_MS", 5 * 60_000, { min: 0, max: 3_600_000 });
const arrivalPendingMs = numberConfig("CAT_ARRIVAL_PENDING_MS", 15 * 60_000, { min: 10_000, max: 3_600_000 });
const yandexScenarioId = config("YANDEX_CAT_ARRIVED_SCENARIO_ID", "");
const yandexCabinetLightId = config("YANDEX_CABINET_LIGHT_ID", "");
const yandexApiRoot = "https://api.iot.yandex.net/v1.0";
const envPath = new URL("../.env", import.meta.url);
const telegramReferenceDirectory = join(projectRoot, "data", "reference", "our-cat", "telegram-arrivals");
const telegramReferenceManifestPath = join(telegramReferenceDirectory, "manifest.json");

function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).filter((line) => line && !line.startsWith("#")).map((line) => {
    const separator = line.indexOf("=");
    return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
  }));
}
async function chatState() {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (!state.chatId) throw new Error("Telegram chat ID is not configured");
  return state;
}

async function refreshSubscribers(state, record) {
  try {
    const added = await syncSubscribers(state);
    if (added.length) await record(`Telegram subscribers added: ${added.length}`);
  } catch (error) {
    // A temporary Telegram polling failure must not prevent a known recipient
    // from receiving the alert.
    await record(`Telegram subscriber sync failed error=${error.message}`);
  }
}

async function archiveTelegramArrival(imagePath, record) {
  await mkdir(telegramReferenceDirectory, { recursive: true });
  const sourceName = basename(imagePath);
  const extension = extname(sourceName) || ".jpg";
  const targetName = `telegram-${sourceName.replace(extname(sourceName), "")}${extension}`;
  const targetPath = join(telegramReferenceDirectory, targetName);
  try {
    await copyFile(imagePath, targetPath, 1); // COPYFILE_EXCL: the same alert is stored once.
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  let manifest = [];
  try {
    manifest = JSON.parse(await readFile(telegramReferenceManifestPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!manifest.some((entry) => entry.file === targetName)) {
    manifest.push({
      file: targetName,
      expected: "our-cat",
      status: "provisional",
      source: "successful-telegram-arrival",
      recordedAt: new Date().toISOString(),
    });
    await writeFile(telegramReferenceManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  await record(`Telegram arrival frame archived for regression: ${targetName}`);
}

async function announceOnSpeaker(record) {
  const env = parseEnv(await readFile(envPath, "utf8"));
  if (!env.YANDEX_OAUTH_TOKEN) throw new Error("YANDEX_OAUTH_TOKEN is missing");
  const response = await fetch(`${yandexApiRoot}/scenarios/${encodeURIComponent(yandexScenarioId)}/actions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.YANDEX_OAUTH_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Yandex scenario failed: HTTP ${response.status}`);
  await record("Yandex cat-arrived scenario started");
}

export async function announceCatArrivalOnSpeaker(record) {
  await announceOnSpeaker(record);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function yandexToken() {
  const env = parseEnv(await readFile(envPath, "utf8"));
  if (!env.YANDEX_OAUTH_TOKEN) throw new Error("YANDEX_OAUTH_TOKEN is missing");
  return env.YANDEX_OAUTH_TOKEN;
}

function lightIsOn(device) {
  const capability = (device?.capabilities ?? []).find(
    (item) => item?.type === "devices.capabilities.on_off" && item?.state?.instance === "on",
  );
  return typeof capability?.state?.value === "boolean" ? capability.state.value : null;
}

async function setCabinetLight(token, value) {
  const response = await fetch(`${yandexApiRoot}/devices/actions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      devices: [{
        id: yandexCabinetLightId,
        actions: [{
          type: "devices.capabilities.on_off",
          state: { instance: "on", value },
        }],
      }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Yandex cabinet light failed: HTTP ${response.status}`);
}

async function flashCabinetLight(record) {
  const token = await yandexToken();
  const response = await fetch(`${yandexApiRoot}/devices/${encodeURIComponent(yandexCabinetLightId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Yandex cabinet light state failed: HTTP ${response.status}`);
  const payload = await response.json();
  const originalState = lightIsOn(payload?.device ?? payload?.payload?.device ?? payload);
  if (originalState === null) throw new Error("Yandex cabinet light on/off state is unavailable");
  await setCabinetLight(token, !originalState);
  await wait(1_000);
  await setCabinetLight(token, originalState);
  await record(`cabinet light flashed and restored state=${originalState ? "on" : "off"}`);
}

async function confirmCatIsHome(state, record, suffix = "") {
  const wasOutside = state.catOutside === true;
  state.catArrivalPendingUntil = 0;
  state.catOutside = false;
  state.catOutUntil = 0;
  state.wantOutPendingAt = 0;
  state.wantOutDoorAt = 0;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  if (!wasOutside) {
    await record(`cat-home state unchanged${suffix}: Telegram status message suppressed`);
    return;
  }
  await refreshSubscribers(state, record);
  await sendMessageToSubscribers(state, "Котик дома");
  await record(`cat entry confirmed${suffix}: Telegram home message sent`);
  try {
    await announceOnSpeaker(record);
  } catch (error) {
    await record(`speaker notification failed error=${error.message}`);
  }
}

async function announceArrival(state, imagePath, record) {
  await refreshSubscribers(state, record);
  await sendPhotoToSubscribers(state, imagePath, "Котик пришел!");
  await archiveTelegramArrival(imagePath, record);
  state.lastAlertAt = Date.now();
  state.catArrivalPendingUntil = Date.now() + arrivalPendingMs;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await record("Telegram alert sent");
  try {
    await flashCabinetLight(record);
  } catch (error) {
    await record(`cabinet light flash failed error=${error.message}`);
  }
  try {
    await announceOnSpeaker(record);
  } catch (error) {
    await record(`speaker notification failed error=${error.message}`);
  }
}

async function announceExit(state, record) {
  const now = Date.now();
  const wasOutside = state.catOutside === true;
  state.catOutUntil = now + exitSuppressionMs;
  state.catOutside = true;
  state.catArrivalPendingUntil = 0;
  state.wantOutPendingAt = 0;
  state.wantOutDoorAt = 0;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  if (wasOutside) {
    await record("cat-outside state unchanged: Telegram exit message suppressed");
    return;
  }
  await refreshSubscribers(state, record);
  await sendMessageToSubscribers(state, "Котик вышел");
  await record(`cat exit detected: Telegram exit message sent; alerts suppressed for ${exitSuppressionMs / 1000}s`);
}

// The contact sensor fires while the door is only beginning to move.  A cat
// already waiting at the inside threshold is the household's explicit signal
// that this opening is an exit, so commit the state before he can cross the
// exterior camera's field of view.
export async function processDoorOpeningFromIndoorCamera(record) {
  const indoor = await observeIndoorCat();
  if (indoor.error) {
    await record(`indoor opening snapshot skipped error=${indoor.error}`);
    return { observed: false, error: indoor.error };
  }
  if (!indoor.nearDoor) {
    await record("indoor opening snapshot: no cat at the door");
    return indoor;
  }
  const state = await chatState();
  await record(`indoor opening snapshot: cat at door, exit confirmed details=${JSON.stringify(indoor.recognition)}`);
  await announceExit(state, record);
  return indoor;
}

// The closed contact gives us a stable end-of-crossing moment. Both cameras
// are sampled once and only direct evidence changes the state.
export async function reconcileAfterDoorClosed(outdoorImagePath, record) {
  // Capture both views at the closing edge, then keep their expensive local
  // recognition sequential to avoid the earlier CPU and memory spikes.
  const indoorCapture = await captureIndoorFrame();
  const outdoor = await recognizeOrangeCat(outdoorImagePath, { allowDoorOrangeContour: true });
  const indoor = indoorCapture.error
    ? indoorCapture
    : await recognizeIndoorFrame(indoorCapture.imagePath);
  await record(`door-close reconciliation outdoor=${JSON.stringify(outdoor)} indoor=${JSON.stringify(indoor.recognition ?? { error: indoor.error })}`);
  const state = await chatState();
  if (outdoor.accepted && ["orange-cat", "orange-door-contour"].includes(outdoor.reason) && outdoor.direction === "street") {
    await announceExit(state, record);
    return { status: "outside", outdoor, indoor };
  }
  if (!indoor.error && indoor.observed) {
    await confirmCatIsHome(state, record, " confirmed by door-close indoor snapshot");
    return { status: "home", outdoor, indoor };
  }
  await record("door-close reconciliation: status unchanged; neither camera had conclusive evidence");
  return { status: "unchanged", outdoor, indoor };
}

async function processConfirmedDoorOpening(result, imagePath, record, now) {
  const state = await chatState();
  if (now < (state.catOutUntil ?? 0)) {
    await record(`door contact event suppressed: cat is in the ${exitSuppressionMs / 1000}s post-exit period`);
    return result;
  }

  // A recent "Котик хочет на улицу" is evidence from the indoor camera that
  // the cat was home and waiting at this very door. It overrides stale outdoor
  // state: after this door opening, seeing a cat outdoors means an exit.
  const wantsOut = Boolean(state.wantOutPendingAt);
  if (wantsOut) {
    state.wantOutPendingAt = 0;
    state.wantOutDoorAt = 0;
    if (result.accepted) {
      // The indoor observation is newer and more trustworthy than an old
      // outside flag, so turn this into an actual home → outside transition.
      state.catOutside = false;
      state.catOutUntil = 0;
      await record("indoor want-out context + confirmed door opening: cat outside is an exit");
      await announceExit(state, record);
      return result;
    }
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    await record("indoor want-out context cleared by door opening; no cat was seen outside");
  }

  // State can be stale after an earlier false alert.  With a confirmed contact
  // opening, the orange cat facing the street is direct evidence of an exit;
  // it must win over that stale state.  This also clears any pending arrival,
  // so a later empty frame cannot produce a false "Котик дома".
  if (result.accepted && ["orange-cat", "orange-door-contour"].includes(result.reason) && result.direction === "street") {
    await announceExit(state, record);
    return result;
  }

  // The indoor camera is optional. A confident cat detection there is direct
  // evidence that the only household cat is inside, even if the outdoor view
  // missed the crossing. A camera outage must never affect the door workflow.
  if (!result.accepted) {
    const indoor = await observeIndoorCat();
    if (indoor.error) {
      await record(`indoor camera skipped error=${indoor.error}`);
    } else if (indoor.observed) {
      await record(`indoor camera confirmed cat is home details=${JSON.stringify(indoor.recognition)}`);
      if (state.catOutside === true || now < (state.catArrivalPendingUntil ?? 0)) {
        await confirmCatIsHome(state, record, " confirmed by indoor camera");
      } else {
        state.catOutside = false;
        state.catOutUntil = 0;
        state.indoorCatLastSeenAt = now;
        await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
      }
      return result;
    } else if (indoor.enabled) {
      await record("indoor camera frame has no confident cat");
    }
  }

  if (state.catOutside === true) {
    // The cat was known to be outside before this real door opening. Seeing
    // him now means arrival, never exit. Once he disappears after this sighting
    // the same confirmed door event safely produces "Котик дома".
    if (result.accepted) {
      if (now < (state.catArrivalPendingUntil ?? 0)) {
        await record("cat arrival already announced; waiting for the cat to enter");
      } else {
        // Under IR the orange coat is invisible, but a probable cat at a real
        // door opening is enough when this same state already says our cat is
        // outside. The next empty frame will confirm that he entered.
        await announceArrival(state, imagePath, record);
      }
    } else if (now < (state.catArrivalPendingUntil ?? 0)) {
      await confirmCatIsHome(state, record, " after confirmed door opening");
    } else {
      await record("confirmed door opening while cat is outside, but no cat was seen: no message");
    }
    return result;
  }

  // The cat was home before a trustworthy opening. A confirmed sighting at
  // the doorstep is an exit. A grey neighbour or a person never reaches here.
  if (result.accepted) {
    if (!["orange-cat", "orange-door-contour"].includes(result.reason)) {
      await record("unconfirmed night silhouette near confirmed door opening is not enough to declare an exit");
    } else {
      await announceExit(state, record);
    }
  } else {
    await record("confirmed door opening with no home cat visible: no message");
  }
  return result;
}

export async function processMotionEvent(
  imagePath,
  record,
  { doorOpenedRecently = false, doorOpenedInExitWindow = false, doorContactOpenedRecently = false, forceFullAnalysis = false, allowEmptyFast = false } = {},
) {
  const result = await recognizeOrangeCat(imagePath, {
    allowDoorOrangeContour: doorContactOpenedRecently || doorOpenedInExitWindow,
    analysisMode: forceFullAnalysis ? "full" : "adaptive",
    allowEmptyFast,
  });
  await record(`recognition analysis=${result.analysis} accepted=${result.accepted} reason=${result.reason ?? "none"} details=${JSON.stringify(result)}`);
  const now = Date.now();

  // A panoptic-only night contour is useful only as evidence that the known
  // outdoor cat crossed a confirmed door opening. It must never create an
  // arrival alert on an ordinary frame.
  if (result.reason === "night-door-probable-home-cat" && !doorContactOpenedRecently) {
    await record("night cat contour retained for a real door-contact event only");
    return result;
  }

  if (doorContactOpenedRecently) {
    return processConfirmedDoorOpening(result, imagePath, record, now);
  }

  if (doorOpenedRecently) {
    const state = await chatState();
    // Door panels and a person closing the door can produce several movement
    // events. The first confirmed exit owns the entire five-minute period.
    if (now < (state.catOutUntil ?? 0)) {
      await record(`Telegram exit suppressed: cat is in the ${exitSuppressionMs / 1000}s post-exit period`);
      return result;
    }
    if (result.accepted && result.reason !== "orange-cat") {
      await record("Telegram exit suppressed: unconfirmed night silhouette");
      return result;
    }
    if (now < (state.catArrivalPendingUntil ?? 0)) {
      if (!result.accepted) {
        // Do not announce immediately while the door is still moving. The
        // cat may simply be crossing the threshold out of view.
        await record("expected cat temporarily out of view; waiting for the door to settle");
      } else {
        await record("door opened for an expected cat; waiting until the cat leaves the camera");
      }
      return result;
    }

    if (result.accepted) {
      await announceExit(state, record);
    } else {
      await record("Telegram alert suppressed: the door moved within the previous 10 seconds");
    }
    return result;
  }

  if (!result.accepted) {
    // An empty outdoor frame is not evidence that the cat entered: he may
    // have walked out of view, or the crossing may have happened between
    // frames. Home state is confirmed only by a confident indoor observation
    // within the contact-sensor window.
    return result;
  }

  const state = await chatState();
  // Infrared makes fur colour disappear. A generic night-time cat detection
  // alone cannot distinguish the grey-and-white neighbour from our cat. It
  // becomes actionable only when our cat is already known to be outdoors.
  if (result.reason !== "orange-cat" && state.catOutside !== true) {
    await record("Telegram alert suppressed: unconfirmed night cat while our cat is not known to be outside");
    return result;
  }
  if (now < (state.catOutUntil ?? 0)) {
    await record(`Telegram alert suppressed: cat is in the ${exitSuppressionMs / 1000}s post-exit period`);
    return result;
  }

  if (now < (state.catArrivalPendingUntil ?? 0) && doorOpenedInExitWindow) {
    await record("expected cat remains visible after the door opened; waiting for an empty frame");
    return result;
  }

  // If the first clear frame arrived late, recover the same decision from its
  // direction and the recent door opening rather than sending an arrival alert.
  if (doorOpenedInExitWindow && result.direction === "street") {
    await announceExit(state, record);
    return result;
  }

  if (now - (state.lastAlertAt ?? 0) < alertCooldownMs) {
    await record(`Telegram alert suppressed by ${alertCooldownMs / 1000}s cooldown`);
    return result;
  }

  await announceArrival(state, imagePath, record);
  return result;
}
