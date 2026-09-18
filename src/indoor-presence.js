import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { projectRoot } from "./telegram.js";
import { recognizeAnyIndoorCat } from "./cat-recognizer.js";
import { config, numberConfig } from "./config.js";

const snapshotUrl = config("CAT_INDOOR_SNAPSHOT_URL", "http://127.0.0.1:1984/api/frame.jpeg?src=in");
const rtspUrl = config("CAT_INDOOR_RTSP_URL", "rtsp://192.168.1.108:8554/in/sd");
const captureTimeoutMs = numberConfig("CAT_INDOOR_CAPTURE_TIMEOUT_MS", 25_000, { min: 3_000, max: 60_000 });
const ffmpegPath = config("CAT_FFMPEG_PATH", "")
  || join(projectRoot, "tools", "ffmpeg", "ffmpeg-master-latest-win64-gpl-shared", "bin", "ffmpeg.exe");
const captureDirectory = join(projectRoot, "runtime", "indoor-presence");

function captureFrame(targetPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      "-hide_banner", "-loglevel", "warning", "-rtsp_transport", "tcp",
      "-i", rtspUrl, "-frames:v", "1", "-update", "1", "-q:v", "3", "-y", targetPath,
    ], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), captureTimeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit=${code}: ${stderr.trim().slice(-500)}`));
    });
  });
}

export async function captureIndoorFrame() {
  if (!snapshotUrl && !rtspUrl) return { enabled: false, observed: false };
  const now = new Date();
  const targetPath = join(captureDirectory, `inside-${now.toISOString().replace(/[:.]/g, "-")}.jpg`);
  try {
    await mkdir(captureDirectory, { recursive: true });
    if (snapshotUrl) {
      const response = await fetch(snapshotUrl, { signal: AbortSignal.timeout(captureTimeoutMs) });
      if (!response.ok) throw new Error(`indoor snapshot failed: HTTP ${response.status}`);
      await writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
    } else {
      await captureFrame(targetPath);
    }
    return { enabled: true, imagePath: targetPath };
  } catch (error) {
    return { enabled: true, observed: false, error: error.message };
  }
}

export async function recognizeIndoorFrame(imagePath) {
  try {
    const recognition = await recognizeAnyIndoorCat(imagePath);
    return { enabled: true, observed: recognition.accepted, nearDoor: recognition.nearDoor, imagePath, recognition };
  } catch (error) {
    return { enabled: true, observed: false, imagePath, error: error.message };
  }
}

export async function observeIndoorCat() {
  const captured = await captureIndoorFrame();
  if (captured.error || !captured.imagePath) return captured;
  return recognizeIndoorFrame(captured.imagePath);
}
