import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findLatestChatId, getBotProfile, projectRoot, sendPhoto, statePath } from "./telegram.js";

const bot = await getBotProfile();
const chatId = await findLatestChatId();
if (!chatId) {
  throw new Error(`Open @${bot.username} in Telegram and send /start, then run this command again.`);
}

const snapshotPath = join(projectRoot, "runtime", "door-preload-test.jpg");
await sendPhoto(chatId, snapshotPath, "Тестовое сообщение от «Телеграммы от котика» 🐈");
await writeFile(statePath, JSON.stringify({ chatId, botUsername: bot.username }, null, 2));
console.log(`Test photo sent to chat ${chatId}.`);
