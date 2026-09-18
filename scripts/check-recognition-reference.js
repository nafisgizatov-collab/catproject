import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cases = [
  ["our-cat", "runtime/recognition-test/short-tail-example.jpg"],
  ["our-cat", "runtime/recognition-test/short-tail-walking-01.jpg"],
  ["our-cat", "runtime/recognition-test/short-tail-walking-02.jpg"],
  ["our-cat", "runtime/recognition-test/with-grey-cat-01.jpg"],
  ["our-cat", "runtime/recognition-test/with-grey-cat-02.jpg"],
  ["not-our-cat", "runtime/recognition-test/black-cat-day.jpg"],
  ["not-our-cat", "runtime/recognition-test/light-cat-day.jpg"],
  ["not-our-cat", "runtime/recognition-test/grey-cat-night.jpg"],
  ["not-our-cat", "runtime/recognition-test/long-tail-cat-day.jpg"],
  ["our-cat", "data/reference/our-cat/telegram-arrivals/telegram-night-light-2026-09-16T02-02-03.jpg"],
];

function runOne(relativePath) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(root, "scripts", "check-recognition-one.js"), relativePath], {
      cwd: root,
      timeout: 90_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      const line = stdout.trim().split(/\r?\n/).at(-1);
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ error: error?.message ?? "worker did not return JSON" });
      }
    });
  });
}

const report = [];
for (const [expected, file] of cases) {
  const result = await runOne(file);
  report.push({
    file,
    expected,
    ...result,
    pass: result.error ? false : (expected === "our-cat" ? result.accepted : !result.accepted),
  });
}
await mkdir(join(root, "runtime"), { recursive: true });
await writeFile(join(root, "runtime", "recognition-regression-report.json"), `${JSON.stringify(report, null, 2)}\n`);
for (const item of report) console.log(`${item.pass ? "PASS" : "FAIL"}\t${item.expected}\t${item.file}\t${item.reason ?? item.error ?? "none"}\t${item.elapsedMs}ms`);
