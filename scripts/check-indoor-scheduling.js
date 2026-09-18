import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Run the real scheduler with in-memory camera/state adapters. No model,
// camera connection, background process or Telegram message is created.
const source = (await readFile(new URL('../src/indoor-door-watcher.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export async function checkIndoorCamera', 'async function checkIndoorCamera');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function scenario(outside, captureAge, recognitionAge) {
  const now = Date.now();
  let saved = { lastEntranceCheckAt: now - captureAge, lastRecognitionAt: now - recognitionAge,
    lastDoorOpenedAt: now - 3_600_000, lastChairCheckAt: 0 };
  let captures = 0; let recognitions = 0;
  const frame = { width: 96, height: 96, data: new Uint8Array(96 * 96 * 4) };
  for (let i = 0; i < frame.data.length; i += 4) frame.data.set([140, 90, 50, 255], i);
  const capture = async () => { captures++; return { imagePath: 'frame' }; };
  const recognize = async () => { recognitions++; return { observed: false, nearDoor: false, recognition: {} }; };
  const fail = async () => { throw new Error('Unexpected external action'); };
  const run = await new AsyncFunction('mkdir', 'readFile', 'writeFile', 'join', 'jpeg',
    'captureIndoorFrame', 'observeIndoorCat', 'recognizeIndoorFrame', 'announceCatArrivalOnSpeaker',
    'projectRoot', 'sendMessageToSubscribers', 'sendPhotoToSubscribers', 'statePath', 'syncSubscribers',
    'numberConfig',
    source + '\nreturn checkIndoorCamera;')(
    async () => {}, async path => path === 'telegram' ? JSON.stringify({ catOutside: outside })
      : path.endsWith('watcher-state.json') ? JSON.stringify(saved)
      : path.endsWith('door-event.json') ? 'null' : Buffer.alloc(0),
    async (path, value) => { if (path.endsWith('watcher-state.json')) saved = JSON.parse(value); },
    (...parts) => parts.join('/'), { decode: () => frame }, capture,
    async () => { await capture(); return recognize(); }, recognize, fail,
    'project', fail, fail, 'telegram', fail, (_key, fallback) => fallback);
  await run();
  return { captures, recognitions };
}
assert.deepEqual(await scenario(true, 10_000, 70_000), { captures: 0, recognitions: 0 });
assert.deepEqual(await scenario(false, 6_000, 10_000), { captures: 1, recognitions: 0 });
assert.deepEqual(await scenario(true, 61_000, 61_000), { captures: 1, recognitions: 1 });
assert.deepEqual(await scenario(false, 6_000, 21_000), { captures: 1, recognitions: 1 });
console.log('4 scheduler cases passed: outside throttle, idle skip, minute fallback, static fallback');
