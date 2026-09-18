import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const envText = await readFile(join(root, ".env"), "utf8");
const token = envText.split(/\r?\n/)
  .find((line) => line.startsWith("YANDEX_OAUTH_TOKEN="))
  ?.slice("YANDEX_OAUTH_TOKEN=".length);
if (!token) throw new Error("YANDEX_OAUTH_TOKEN is missing");

const response = await fetch("https://api.iot.yandex.net/v1.0/user/info", {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) throw new Error(`Yandex API HTTP ${response.status}`);
const payload = await response.json();
const devices = payload.devices ?? payload.payload?.devices ?? [];
const requestedId = process.argv[2];
if (requestedId) {
  const detailResponse = await fetch(`https://api.iot.yandex.net/v1.0/devices/${encodeURIComponent(requestedId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!detailResponse.ok) throw new Error(`Yandex device API HTTP ${detailResponse.status}`);
  const detail = await detailResponse.json();
  const device = detail.device ?? detail.payload?.device ?? detail;
  console.log(JSON.stringify({
    id: device.id, name: device.name, type: device.type, external_id: device.external_id,
    skill_id: device.skill_id, household_id: device.household_id, room: device.room,
    capabilities: device.capabilities, properties: device.properties,
  }, null, 2));
  process.exit(0);
}
for (const device of devices) {
  const capabilities = (device.capabilities ?? []).map((item) => item.type).join(", ") || "—";
  const properties = (device.properties ?? []).map((item) => `${item.type}:${item.state?.instance ?? item.parameters?.instance ?? "?"}`).join(", ") || "—";
  console.log(JSON.stringify({ id: device.id, name: device.name, type: device.type, skill_id: device.skill_id, capabilities, properties }));
}
