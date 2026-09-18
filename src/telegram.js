import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(projectRoot, ".env");
const statePath = join(projectRoot, "runtime", "telegram-state.json");

function parseEnv(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

async function token() {
  const value = parseEnv(await readFile(envPath, "utf8")).TELEGRAM_BOT_TOKEN;
  if (!value) throw new Error("TELEGRAM_BOT_TOKEN is missing in .env");
  return value;
}

async function call(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${await token()}/${method}`, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`Telegram ${method}: ${payload.description}`);
  return payload.result;
}

export async function getBotProfile() {
  return call("getMe");
}

export async function findLatestChatId() {
  const updates = await call("getUpdates", new URLSearchParams({ timeout: "0", allowed_updates: '["message"]' }));
  const messages = updates
    .map((update) => update.message)
    .filter(Boolean)
    .sort((a, b) => b.date - a.date);
  return messages[0]?.chat?.id ?? null;
}

export function subscriberChatIds(state) {
  return [...new Set([
    state.chatId,
    ...(Array.isArray(state.chatIds) ? state.chatIds : []),
  ].filter((chatId) => Number.isFinite(Number(chatId))))];
}

// Telegram only permits a bot to write to a person after that person has
// started a chat with it. A /start message is an explicit subscription.
export async function syncSubscribers(state) {
  const updates = await call("getUpdates", new URLSearchParams({
    timeout: "0",
    allowed_updates: '["message"]',
  }));
  const current = subscriberChatIds(state);
  const subscribers = new Set(current.map(String));
  for (const update of updates) {
    const message = update?.message;
    if (message?.chat?.type !== "private" || !/^\/start(?:\s|$)/.test(message.text ?? "")) continue;
    subscribers.add(String(message.chat.id));
  }
  const chatIds = [...subscribers].map(Number);
  const added = chatIds.filter((chatId) => !current.some((existing) => Number(existing) === chatId));
  state.chatIds = chatIds;
  return added;
}

export async function sendMessageToSubscribers(state, text) {
  return Promise.all(subscriberChatIds(state).map((chatId) => sendMessage(chatId, text)));
}

export async function sendPhotoToSubscribers(state, imagePath, caption) {
  return Promise.all(subscriberChatIds(state).map((chatId) => sendPhoto(chatId, imagePath, caption)));
}

export async function sendPhoto(chatId, imagePath, caption) {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("caption", caption);
  form.set("photo", new Blob([await readFile(imagePath)], { type: "image/jpeg" }), "door.jpg");
  return call("sendPhoto", form);
}

export async function sendMessage(chatId, text) {
  return call("sendMessage", new URLSearchParams({ chat_id: String(chatId), text }));
}

export { projectRoot, statePath };
