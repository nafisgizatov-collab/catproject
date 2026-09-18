import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = join(projectRoot, "config.ini");
const environmentPath = join(projectRoot, ".env");
const values = new Map();
const environmentValues = new Map();

if (existsSync(configPath)) {
  let section = "";
  for (const rawLine of readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) { section = sectionMatch[1]; continue; }
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    values.set(key, value);
    values.set(`${section}.${key}`, value);
  }
}

// The service is launched by Task Scheduler, which does not import .env into
// the Node process. Parse it locally so secret-only configuration can remain
// in .env without being copied into config.ini or command lines.
if (existsSync(environmentPath)) {
  for (const rawLine of readFileSync(environmentPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    environmentValues.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
}

export function config(key, fallback) {
  // Environment variables remain an emergency one-run override. config.ini is
  // the normal persistent configuration surface.
  return process.env[key] ?? environmentValues.get(key) ?? values.get(key) ?? fallback;
}

export function numberConfig(key, fallback, { min, max } = {}) {
  const value = Number(config(key, fallback));
  if (!Number.isFinite(value) || (min !== undefined && value < min) || (max !== undefined && value > max)) {
    throw new Error(`Invalid ${key} in config.ini: ${config(key, fallback)}`);
  }
  return value;
}

export function booleanConfig(key, fallback = false) {
  const value = String(config(key, fallback)).toLowerCase();
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  throw new Error(`Invalid ${key} in config.ini: ${value}`);
}

export { configPath };
