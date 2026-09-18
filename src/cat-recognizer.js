import { readFile } from "node:fs/promises";
import { pipeline, RawImage, env } from "@huggingface/transformers";
import jpeg from "jpeg-js";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { config, booleanConfig, numberConfig } from "./config.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
env.cacheDir = join(projectRoot, "runtime", "models");
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = false;

const CAT_SCORE_MINIMUM = numberConfig("CAT_SCORE_MINIMUM", 0.65, { min: 0, max: 1 });
const STRONG_ORANGE_CAT_SCORE_MINIMUM = numberConfig("CAT_STRONG_ORANGE_SCORE_MINIMUM", 0.45, { min: 0, max: 1 });
const STRONG_ORANGE_RATIO_MINIMUM = numberConfig("CAT_STRONG_ORANGE_RATIO_MINIMUM", 0.2, { min: 0, max: 1 });
const DETECTION_SCORE_MINIMUM = numberConfig("CAT_DETECTION_SCORE_MINIMUM", 0.05, { min: 0, max: 1 });
// A grey neighbour beside the brown top railing reached 0.172 because the
// railing entered its detection box. The home cat in the current camera angle
// remains at 0.27 or above, so 0.20 rejects that background-colour false hit.
const ORANGE_RATIO_MINIMUM = numberConfig("CAT_ORANGE_RATIO_MINIMUM", 0.2, { min: 0, max: 1 });
const NIGHT_CAT_SCORE_MINIMUM = numberConfig("CAT_NIGHT_SCORE_MINIMUM", 0.5, { min: 0, max: 1 });
const DETECTOR_DEVICE = config("CAT_DETECTOR_DEVICE", "cpu");
const SEGMENTER_DEVICE = config("CAT_SEGMENTER_DEVICE", "cpu");
const GPU_INPUT_WIDTH = numberConfig("CAT_GPU_INPUT_WIDTH", 1333, { min: 64, max: 4096 });
const GPU_INPUT_HEIGHT = numberConfig("CAT_GPU_INPUT_HEIGHT", 800, { min: 64, max: 4096 });
let detectorPromise;
let segmenterPromise;

// Camera shapes differ. ONNX's default arenas retain peak intermediate
// allocations for both networks, and its default worker pools use all cores.
// Keep the same weights and image resolution, but bound CPU parallelism and
// release intermediate buffers instead of retaining peak-size memory arenas.
function modelOptions(device) {
  return {
    device,
    dtype: config("CAT_MODEL_DTYPE", "fp32"),
    session_options: {
      intraOpNumThreads: numberConfig("CAT_ONNX_INTRA_OP_THREADS", 2, { min: 1, max: 16 }),
      interOpNumThreads: numberConfig("CAT_ONNX_INTER_OP_THREADS", 1, { min: 1, max: 4 }),
      executionMode: "sequential",
      enableCpuMemArena: booleanConfig("CAT_ONNX_CPU_MEM_ARENA", false),
      enableMemPattern: booleanConfig("CAT_ONNX_MEM_PATTERN", false),
    },
  };
}

function fixedGpuImage(image, device) {
  if (device !== "dml") {
    return { image, offsetX: 0, offsetY: 0, sourceScale: 1, originalWidth: image.width, originalHeight: image.height };
  }
  // DirectML needs a stable tensor shape. Letterbox instead of stretching: a
  // cat keeps its natural silhouette and black padding cannot resemble it.
  const data = new Uint8Array(GPU_INPUT_WIDTH * GPU_INPUT_HEIGHT * image.channels);
  const sourceScale = Math.min(GPU_INPUT_WIDTH / image.width, GPU_INPUT_HEIGHT / image.height);
  const drawnWidth = Math.max(1, Math.round(image.width * sourceScale));
  const drawnHeight = Math.max(1, Math.round(image.height * sourceScale));
  const offsetX = Math.floor((GPU_INPUT_WIDTH - drawnWidth) / 2);
  const offsetY = Math.floor((GPU_INPUT_HEIGHT - drawnHeight) / 2);
  for (let y = 0; y < drawnHeight; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor(y / sourceScale));
    for (let x = 0; x < drawnWidth; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor(x / sourceScale));
      const source = (sourceY * image.width + sourceX) * image.channels;
      const target = ((y + offsetY) * GPU_INPUT_WIDTH + x + offsetX) * image.channels;
      for (let channel = 0; channel < image.channels; channel += 1) data[target + channel] = image.data[source + channel];
    }
  }
  return {
    image: new RawImage(data, GPU_INPUT_WIDTH, GPU_INPUT_HEIGHT, image.channels),
    offsetX,
    offsetY,
    sourceScale,
    originalWidth: image.width,
    originalHeight: image.height,
  };
}

function originalBox(box, transform) {
  if (transform.sourceScale === 1) return box;
  const toOriginalX = (x) => Math.max(0, Math.min(transform.originalWidth, (x - transform.offsetX) / transform.sourceScale));
  const toOriginalY = (y) => Math.max(0, Math.min(transform.originalHeight, (y - transform.offsetY) / transform.sourceScale));
  return {
    xmin: toOriginalX(box.xmin),
    ymin: toOriginalY(box.ymin),
    xmax: toOriginalX(box.xmax),
    ymax: toOriginalY(box.ymax),
  };
}

function restoreDetections(detections, transform) {
  return detections.map((detection) => ({ ...detection, box: originalBox(detection.box, transform) }));
}

function rgbToHsv(red, green, blue) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const delta = maximum - minimum;
  let hue = 0;

  if (delta !== 0) {
    if (maximum === r) hue = 60 * (((g - b) / delta) % 6);
    else if (maximum === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return { hue, saturation: maximum === 0 ? 0 : delta / maximum, value: maximum };
}

function orangeChairContour(image) {
  // The grey armchair is fixed in the lower-right of the indoor view.  The
  // cat's curled coat produces a large connected orange silhouette there;
  // a rectangle by itself is deliberately never considered evidence.
  const left = Math.floor(image.width * 0.62);
  const top = Math.floor(image.height * 0.57);
  const width = image.width - left;
  const height = image.height - top;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = ((top + y) * image.width + left + x) * image.channels;
      const { hue, saturation, value } = rgbToHsv(
        image.data[offset], image.data[offset + 1], image.data[offset + 2],
      );
      if (hue >= 12 && hue <= 48 && saturation >= 0.25 && value >= 0.18) mask[y * width + x] = 1;
    }
  }

  const visited = new Uint8Array(mask.length);
  let best = null;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    const queue = [start];
    visited[start] = 1;
    let pixels = 0;
    let xmin = width; let ymin = height; let xmax = -1; let ymax = -1;
    for (let index = 0; index < queue.length; index += 1) {
      const point = queue[index];
      const x = point % width;
      const y = Math.floor(point / width);
      pixels += 1;
      xmin = Math.min(xmin, x); xmax = Math.max(xmax, x);
      ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nextX = x + dx; const nextY = y + dy;
          if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
          const next = nextY * width + nextX;
          if (mask[next] && !visited[next]) { visited[next] = 1; queue.push(next); }
        }
      }
    }
    if (!best || pixels > best.pixels) best = { pixels, xmin, ymin, xmax, ymax };
  }
  if (!best) return null;
  const contourWidth = best.xmax - best.xmin + 1;
  const contourHeight = best.ymax - best.ymin + 1;
  // Small orange objects and isolated reflections are rejected.  The sleeping
  // cat reference has a broad, continuous contour far above these limits.
  if (best.pixels < 900 || contourWidth < 40 || contourHeight < 35) return null;
  return {
    source: "chair-orange-contour",
    score: 1,
    pixels: best.pixels,
    box: {
      xmin: left + best.xmin,
      ymin: top + best.ymin,
      xmax: left + best.xmax + 1,
      ymax: top + best.ymax + 1,
    },
  };
}

function orangeDoorContour(image) {
  // The central part of the outdoor mat excludes the yellow wall, lawn and
  // bottom corner pads. A connected orange region here is a useful fallback
  // when IR/detector labels a moving cat as a small person.
  const left = Math.floor(image.width * 0.16);
  const top = Math.floor(image.height * 0.10);
  const right = Math.floor(image.width * 0.74);
  const bottom = Math.floor(image.height * 0.75);
  const width = right - left;
  const height = bottom - top;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = ((top + y) * image.width + left + x) * image.channels;
    const { hue, saturation, value } = rgbToHsv(image.data[offset], image.data[offset + 1], image.data[offset + 2]);
    if (hue >= 12 && hue <= 48 && saturation >= 0.25 && value >= 0.18) mask[y * width + x] = 1;
  }
  const visited = new Uint8Array(mask.length);
  let best = null;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    const queue = [start]; visited[start] = 1;
    let xmin = width; let ymin = height; let xmax = -1; let ymax = -1;
    for (let i = 0; i < queue.length; i += 1) {
      const point = queue[i]; const x = point % width; const y = Math.floor(point / width);
      xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const nextX = x + dx; const nextY = y + dy;
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
        const next = nextY * width + nextX;
        if (mask[next] && !visited[next]) { visited[next] = 1; queue.push(next); }
      }
    }
    if (!best || queue.length > best.pixels) best = { pixels: queue.length, xmin, ymin, xmax, ymax };
  }
  if (!best) return null;
  const contourWidth = best.xmax - best.xmin + 1;
  const contourHeight = best.ymax - best.ymin + 1;
  if (best.pixels < 450 || contourWidth < 28 || contourHeight < 20) return null;
  return { pixels: best.pixels, box: { xmin: left + best.xmin, ymin: top + best.ymin, xmax: left + best.xmax + 1, ymax: top + best.ymax + 1 } };
}

function isMasked(mask, x, y) {
  if (!mask || x < 0 || y < 0 || x >= mask.width || y >= mask.height) return false;
  return mask.data[(y * mask.width + x) * mask.channels] > 0;
}

function orangeRatio(image, box, mask) {
  const left = Math.max(0, Math.floor(box.xmin));
  const top = Math.max(0, Math.floor(box.ymin));
  const right = Math.min(image.width, Math.ceil(box.xmax));
  const bottom = Math.min(image.height, Math.ceil(box.ymax));
  let orange = 0;
  let sampledPixels = 0;

  for (let y = top; y < bottom; y += 2) {
    for (let x = left; x < right; x += 2) {
      if (!isMasked(mask, x, y)) continue;
      const offset = (y * image.width + x) * image.channels;
      const { hue, saturation, value } = rgbToHsv(
        image.data[offset],
        image.data[offset + 1],
        image.data[offset + 2],
      );
      sampledPixels += 1;
      if (saturation >= 0.18 && value >= 0.18) {
        if (hue >= 12 && hue <= 48 && saturation >= 0.25) orange += 1;
      }
    }
  }
  return sampledPixels === 0 ? 0 : orange / sampledPixels;
}

function silhouetteColourProfile(image, box, mask) {
  const left = Math.max(0, Math.floor(box.xmin));
  const top = Math.max(0, Math.floor(box.ymin));
  const right = Math.min(image.width, Math.ceil(box.xmax));
  const bottom = Math.min(image.height, Math.ceil(box.ymax));
  let samples = 0;
  let neutralDark = 0;
  let neutralBright = 0;

  // The segmentation mask is the cat contour. The detector rectangle is used
  // only to associate this contour with the detected cat.
  for (let y = top; y < bottom; y += 2) {
    for (let x = left; x < right; x += 2) {
      if (!isMasked(mask, x, y)) continue;
      const offset = (y * image.width + x) * image.channels;
      const { saturation, value } = rgbToHsv(image.data[offset], image.data[offset + 1], image.data[offset + 2]);
      samples += 1;
      if (saturation <= 0.2 && value >= 0.15 && value <= 0.55) neutralDark += 1;
      if (saturation <= 0.2 && value >= 0.72) neutralBright += 1;
    }
  }
  return {
    neutralDarkRatio: samples === 0 ? 0 : neutralDark / samples,
    neutralBrightRatio: samples === 0 ? 0 : neutralBright / samples,
  };
}

function cropToPorch(image) {
  // Preserve the lower-left handrail: the cat often waits there. This still
  // excludes the broad lawn while including the narrow approach beside it.
  const left = Math.floor(image.width * 0.05);
  const top = Math.floor(image.height * 0.03);
  const width = image.width - left;
  const height = Math.floor(image.height * 0.9) - top;
  const data = new Uint8Array(width * height * image.channels);

  for (let y = 0; y < height; y += 1) {
    const sourceStart = ((top + y) * image.width + left) * image.channels;
    const targetStart = y * width * image.channels;
    data.set(image.data.subarray(sourceStart, sourceStart + width * image.channels), targetStart);
  }

  return new RawImage(data, width, height, image.channels);
}

function porchColourMetrics(image) {
  // The central part of the mat. It intentionally excludes the yellow brick wall
  // on the right, which otherwise resembles orange fur.
  const startX = Math.floor(image.width * 0.08);
  const endX = Math.floor(image.width * 0.74);
  const startY = Math.floor(image.height * 0.1);
  const endY = Math.floor(image.height * 0.86);
  let samples = 0;
  let coloured = 0;
  let orange = 0;

  for (let y = startY; y < endY; y += 3) {
    for (let x = startX; x < endX; x += 3) {
      const offset = (y * image.width + x) * image.channels;
      const { hue, saturation, value } = rgbToHsv(
        image.data[offset], image.data[offset + 1], image.data[offset + 2],
      );
      samples += 1;
      if (saturation >= 0.18 && value >= 0.18) {
        coloured += 1;
        if (hue >= 12 && hue <= 48 && saturation >= 0.25) orange += 1;
      }
    }
  }

  return {
    colouredRatio: samples === 0 ? 0 : coloured / samples,
    orangeRatio: samples === 0 ? 0 : orange / samples,
  };
}

function nightProfile(image, box, mask) {
  const left = Math.max(0, Math.floor(box.xmin));
  const top = Math.max(0, Math.floor(box.ymin));
  const right = Math.min(image.width, Math.ceil(box.xmax));
  const bottom = Math.min(image.height, Math.ceil(box.ymax));
  let samples = 0;
  let sum = 0;
  let dark = 0;
  let bright = 0;

  for (let y = top; y < bottom; y += 2) {
    for (let x = left; x < right; x += 2) {
      if (!isMasked(mask, x, y)) continue;
      const offset = (y * image.width + x) * image.channels;
      const value = Math.round(
        image.data[offset] * 0.299 + image.data[offset + 1] * 0.587 + image.data[offset + 2] * 0.114,
      );
      samples += 1;
      sum += value;
      if (value < 80) dark += 1;
      if (value > 160) bright += 1;
    }
  }

  return {
    mean: samples === 0 ? 0 : sum / samples,
    darkRatio: samples === 0 ? 0 : dark / samples,
    brightRatio: samples === 0 ? 0 : bright / samples,
  };
}

function orangeOrientation(image, box, mask) {
  const left = Math.max(0, Math.floor(box.xmin));
  const top = Math.max(0, Math.floor(box.ymin));
  const right = Math.min(image.width, Math.ceil(box.xmax));
  const bottom = Math.min(image.height, Math.ceil(box.ymax));
  const points = [];

  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      if (!isMasked(mask, x, y)) continue;
      const offset = (y * image.width + x) * image.channels;
      const { hue, saturation, value } = rgbToHsv(
        image.data[offset], image.data[offset + 1], image.data[offset + 2],
      );
      if (hue >= 12 && hue <= 48 && saturation >= 0.25 && value >= 0.18) points.push({ x, y });
    }
  }
  if (points.length < 80) return null;

  const centre = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  centre.x /= points.length;
  centre.y /= points.length;
  const covariance = points.reduce((sum, point) => {
    const dx = point.x - centre.x;
    const dy = point.y - centre.y;
    return { xx: sum.xx + dx * dx, yy: sum.yy + dy * dy, xy: sum.xy + dx * dy };
  }, { xx: 0, yy: 0, xy: 0 });
  const angle = 0.5 * Math.atan2(2 * covariance.xy, covariance.xx - covariance.yy);
  const axis = { x: Math.cos(angle), y: Math.sin(angle) };
  const projected = points.map((point) => ({
    ...point,
    t: (point.x - centre.x) * axis.x + (point.y - centre.y) * axis.y,
    u: -(point.x - centre.x) * axis.y + (point.y - centre.y) * axis.x,
  }));
  const minT = Math.min(...projected.map((point) => point.t));
  const maxT = Math.max(...projected.map((point) => point.t));
  const band = (maxT - minT) * 0.25;
  if (band < 8) return null;
  const low = projected.filter((point) => point.t <= minT + band);
  const high = projected.filter((point) => point.t >= maxT - band);
  const spread = (group) => {
    const average = group.reduce((sum, point) => sum + point.u, 0) / group.length;
    return Math.sqrt(group.reduce((sum, point) => sum + (point.u - average) ** 2, 0) / group.length);
  };
  const lowSpread = spread(low);
  const highSpread = spread(high);
  // In a crouched top-down view the thin tail end has a broader projection
  // because it curves across the body; the compact head is the narrower end.
  const head = lowSpread <= highSpread ? low : high;
  const tail = lowSpread <= highSpread ? high : low;
  const pointAverage = (group, key) => group.reduce((sum, point) => sum + point[key], 0) / group.length;
  const headX = pointAverage(head, "x");
  const tailX = pointAverage(tail, "x");
  const headY = pointAverage(head, "y");
  const tailY = pointAverage(tail, "y");
  const separation = Math.hypot(headX - tailX, headY - tailY);
  const horizontal = (tailX - headX) / separation;
  const spreadRatio = Math.max(lowSpread, highSpread) / Math.max(1, Math.min(lowSpread, highSpread));
  const confidence = Math.min(1, Math.max(0, (spreadRatio - 1) / 0.8)) * Math.max(0, horizontal);

  return {
    facesStreet: confidence >= 0.12 && headX < tailX,
    confidence,
    head: { x: headX, y: headY },
    tail: { x: tailX, y: tailY },
  };
}

async function detector() {
  detectorPromise ??= pipeline("object-detection", config("CAT_DETECTOR_MODEL", "Xenova/detr-resnet-50"), modelOptions(DETECTOR_DEVICE));
  return detectorPromise;
}

async function segmenter() {
  segmenterPromise ??= pipeline("image-segmentation", config("CAT_SEGMENTER_MODEL", "Xenova/detr-resnet-50-panoptic"), modelOptions(SEGMENTER_DEVICE));
  return segmenterPromise;
}

function matchingMask(masks, box) {
  let bestMask = null;
  let bestPixels = 0;
  const left = Math.max(0, Math.floor(box.xmin));
  const top = Math.max(0, Math.floor(box.ymin));
  const right = Math.min(masks[0]?.width ?? 0, Math.ceil(box.xmax));
  const bottom = Math.min(masks[0]?.height ?? 0, Math.ceil(box.ymax));
  for (const mask of masks) {
    let pixels = 0;
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) if (isMasked(mask, x, y)) pixels += 1;
    }
    if (pixels > bestPixels) {
      bestPixels = pixels;
      bestMask = mask;
    }
  }
  return { mask: bestMask, pixels: bestPixels };
}

function maskBoundingBox(mask) {
  let xmin = mask.width;
  let ymin = mask.height;
  let xmax = -1;
  let ymax = -1;
  let pixels = 0;
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (!isMasked(mask, x, y)) continue;
      pixels += 1;
      xmin = Math.min(xmin, x);
      ymin = Math.min(ymin, y);
      xmax = Math.max(xmax, x);
      ymax = Math.max(ymax, y);
    }
  }
  return pixels === 0 ? null : { box: { xmin, ymin, xmax: xmax + 1, ymax: ymax + 1 }, pixels };
}

function boxesOverlap(first, second) {
  const left = Math.max(first.xmin, second.xmin);
  const top = Math.max(first.ymin, second.ymin);
  const right = Math.min(first.xmax, second.xmax);
  const bottom = Math.min(first.ymax, second.ymax);
  if (right <= left || bottom <= top) return false;
  const intersection = (right - left) * (bottom - top);
  const firstArea = (first.xmax - first.xmin) * (first.ymax - first.ymin);
  const secondArea = (second.xmax - second.xmin) * (second.ymax - second.ymin);
  return intersection / Math.min(firstArea, secondArea) >= 0.5;
}

export async function recognizeOrangeCat(imagePath, { allowDoorOrangeContour = false } = {}) {
  const decoded = jpeg.decode(await readFile(imagePath), { useTArray: true });
  const image = new RawImage(decoded.data, decoded.width, decoded.height, 4);
  const porch = cropToPorch(image);
  const porchColours = porchColourMetrics(porch);
  const doorOrangeContour = allowDoorOrangeContour ? orangeDoorContour(porch) : null;
  const porchInference = fixedGpuImage(porch, DETECTOR_DEVICE);
  const detect = await detector();
  // Keep weak candidates for calibration. The higher acceptance threshold below
  // still decides whether an alert is allowed.
  const detections = restoreDetections(
    await detect(porchInference.image, { threshold: DETECTION_SCORE_MINIMUM }),
    porchInference,
  );
  const detectedCats = detections
    .filter((detection) => detection.label.toLowerCase() === "cat")
  // Do not make segmentation depend on the first object detector. At night it
  // can miss a small, illuminated cat entirely, while the panoptic model still
  // recognises the cat contour reliably.
  const catSegments = (await (await segmenter())(porch))
    .filter((segment) => segment.label.toLowerCase() === "cat")
    .map((segment) => ({ ...segment, bounds: maskBoundingBox(segment.mask) }))
    .filter((segment) => segment.bounds);
  const masks = catSegments.map((segment) => segment.mask);
  const detectedCatProfiles = detectedCats.map((detection) => {
    const match = matchingMask(masks, detection.box);
    return {
      ...detection,
      maskPixels: match.pixels,
      orangeRatio: orangeRatio(porch, detection.box, match.mask),
      silhouette: silhouetteColourProfile(porch, detection.box, match.mask),
      night: nightProfile(porch, detection.box, match.mask),
      orientation: orangeOrientation(porch, detection.box, match.mask),
    };
  });
  const segmentationOnlyProfiles = catSegments
    .filter((segment) => !detectedCats.some((detection) => boxesOverlap(detection.box, segment.bounds.box)))
    .map((segment) => ({
      score: segment.score,
      label: "cat",
      box: segment.bounds.box,
      maskPixels: segment.bounds.pixels,
      orangeRatio: orangeRatio(porch, segment.bounds.box, segment.mask),
      silhouette: silhouetteColourProfile(porch, segment.bounds.box, segment.mask),
      night: nightProfile(porch, segment.bounds.box, segment.mask),
      orientation: orangeOrientation(porch, segment.bounds.box, segment.mask),
      source: "segmentation",
    }));
  const cats = [...detectedCatProfiles, ...segmentationOnlyProfiles];
  const people = detections
    .filter((detection) => detection.label.toLowerCase() === "person" && detection.score >= 0.6)
    .map((person) => Number(person.score.toFixed(3)));
  // In the camera's infrared image the orange coat becomes almost grey. DETR
  // occasionally calls a crouched cat a small "person". Keep this diagnostic
  // separate from ordinary person detection: the dispatcher may use it only
  // together with a real door-contact event and the known "cat outside" state.
  const nightDoorCandidates = detections.filter((detection) => {
    if (detection.label.toLowerCase() !== "person" || detection.score < 0.65) return false;
    const width = detection.box.xmax - detection.box.xmin;
    const height = detection.box.ymax - detection.box.ymin;
    const centreX = (detection.box.xmin + detection.box.xmax) / 2;
    return width >= 35 && width <= 125
      && height >= 30 && height <= 120
      && centreX >= porch.width * 0.42;
  });
  const orangeCat = cats.find((cat) => (
    cat.maskPixels >= 50 && (
      (cat.score >= CAT_SCORE_MINIMUM && cat.orangeRatio >= ORANGE_RATIO_MINIMUM)
    // A moving cat can get a weak object-detection score. A dense orange coat
    // is sufficiently distinctive to retain this candidate, while the known
    // grey-and-white neighbour has an orange ratio below 0.1.
      || (cat.score >= STRONG_ORANGE_CAT_SCORE_MINIMUM && cat.orangeRatio >= STRONG_ORANGE_RATIO_MINIMUM)
    )
  ));
  const nightCat = porchColours.colouredRatio < 0.12
    && cats.find(
      (cat) => cat.maskPixels >= 50 && cat.score >= NIGHT_CAT_SCORE_MINIMUM
        && cat.night.mean >= 115
        && cat.night.darkRatio <= 0.35,
    );
  const nightDoorCat = (porchColours.colouredRatio < 0.4 && nightDoorCandidates[0])
    // The neighbour's grey-and-white IR silhouette is almost entirely neutral
    // dark (0.874 in the reference). The illuminated home cat is distinctly
    // lighter (0.555). This keeps panoptic-only night detection useful without
    // letting the neighbour through a real door event.
    || cats.find((cat) => cat.score >= 0.9 && cat.silhouette.neutralDarkRatio <= 0.7);
  const reason = orangeCat ? "orange-cat"
    : doorOrangeContour ? "orange-door-contour"
    : nightCat ? "night-probable-home-cat"
      : nightDoorCat ? "night-door-probable-home-cat"
      : null;

  return {
    accepted: Boolean(reason),
    reason,
    direction: (orangeCat?.orientation?.facesStreet || doorOrangeContour) ? "street" : "door",
    porchColours: Object.fromEntries(
      Object.entries(porchColours).map(([key, value]) => [key, Number(value.toFixed(3))]),
    ),
    cats: [...cats, ...(doorOrangeContour ? [{
      score: 1,
      maskPixels: doorOrangeContour.pixels,
      orangeRatio: 1,
      night: { mean: 0, darkRatio: 0, brightRatio: 0 },
      orientation: null,
      silhouette: { neutralDarkRatio: 0, neutralBrightRatio: 0 },
      box: doorOrangeContour.box,
      source: "door-orange-contour",
    }] : [])].map((cat) => ({
      score: Number(cat.score.toFixed(3)),
      maskPixels: cat.maskPixels,
      orangeRatio: Number(cat.orangeRatio.toFixed(3)),
      night: Object.fromEntries(
        Object.entries(cat.night).map(([key, value]) => [key, Number(value.toFixed(3))]),
      ),
      orientation: cat.orientation && {
        facesStreet: cat.orientation.facesStreet,
        confidence: Number(cat.orientation.confidence.toFixed(3)),
      },
      silhouette: Object.fromEntries(
        Object.entries(cat.silhouette).map(([key, value]) => [key, Number(value.toFixed(3))]),
      ),
      box: cat.box,
    })),
    nightDoorCandidates: nightDoorCandidates.map((candidate) => ({
      score: Number(candidate.score.toFixed(3)),
      box: candidate.box,
    })),
    people,
  };
}

// The indoor camera is a different environment: there are no other cats in
// the house, so colour and outdoor direction must not be used as a gate. Keep
// the threshold deliberately high: this is evidence for "cat is home", never
// a trigger by itself.
export async function recognizeAnyIndoorCat(imagePath) {
  const decoded = jpeg.decode(await readFile(imagePath), { useTArray: true });
  const image = new RawImage(decoded.data, decoded.width, decoded.height, 4);
  // Transformers preprocessing may reuse the image buffer, so preserve this
  // colour-contour measurement before handing the image to either model.
  const chairContour = orangeChairContour(image);
  const indoorInference = fixedGpuImage(image, DETECTOR_DEVICE);
  const detect = await detector();
  const detections = restoreDetections(
    await detect(indoorInference.image, { threshold: DETECTION_SCORE_MINIMUM }),
    indoorInference,
  );
  const detectedCats = detections
    .filter((detection) => detection.label.toLowerCase() === "cat")
    .map((detection) => ({ source: "detector", score: detection.score, box: detection.box }));
  const confidentDetections = detectedCats.filter((cat) => cat.score >= 0.8);

  // The hallway reference frames yield a 0.99 detector score.  Running the
  // panoptic model as well for every 30-second poll doubled both memory and
  // CPU for no added certainty.  Keep the contour model as a fallback for an
  // ambiguous frame, where it actually provides independent evidence.
  let segments = [];
  if (confidentDetections.length === 0) {
    segments = await (await segmenter())(image);
    segments = segments
      .filter((segment) => segment.label.toLowerCase() === "cat")
      .map((segment) => {
        const bounds = maskBoundingBox(segment.mask);
        return {
          source: "segmentation",
          score: segment.score,
          pixels: bounds?.pixels ?? 0,
          box: bounds?.box,
        };
      });
  }
  const confident = [
    ...confidentDetections,
    ...segments.filter((cat) => cat.score >= 0.92 && cat.pixels >= 100),
  ];
  if (chairContour) confident.push(chairContour);
  const chairCats = confident.filter((cat) => {
    if (!cat.box) return false;
    const centreX = (cat.box.xmin + cat.box.xmax) / 2;
    const centreY = (cat.box.ymin + cat.box.ymax) / 2;
    // Grey chair in the lower-right corner of the indoor camera.
    return centreX >= image.width * 0.68 && centreY >= image.height * 0.65;
  });
  const nearDoorCats = confident.filter((cat) => {
    if (!cat.box) return false;
    const centreX = (cat.box.xmin + cat.box.xmax) / 2;
    const centreY = (cat.box.ymin + cat.box.ymax) / 2;
    // The entrance door and mat occupy the left half of the indoor frame.
    return !chairCats.includes(cat)
      && centreX <= image.width * 0.55 && centreY >= image.height * 0.3 && centreY <= image.height * 0.85;
  });
  return {
    accepted: confident.length > 0,
    nearDoor: nearDoorCats.length > 0,
    onChair: chairCats.length > 0,
    cats: confident.map((cat) => ({
      ...cat,
      score: Number(cat.score.toFixed(3)),
    })),
  };
}
