import { recognizeOrangeCat } from "./cat-recognizer.js";

const imagePath = process.argv[2];
if (!imagePath) {
  throw new Error("Usage: node src/test-recognizer.js <image path>");
}

console.log(JSON.stringify(await recognizeOrangeCat(imagePath)));
