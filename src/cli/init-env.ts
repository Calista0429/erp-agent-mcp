// Creates .env from .env.example, filling empty *_PASSWORD entries with random values.
//   npm run init-env
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");
const target = join(root, ".env");
if (existsSync(target)) {
  console.log(".env already exists; leaving it unchanged.");
  process.exit(0);
}
const content = readFileSync(join(root, ".env.example"), "utf8")
  .replace(/^(\w+_PASSWORD)=$/gm, (_, name) => `${name}=${randomBytes(18).toString("base64url")}`);
writeFileSync(target, content, { mode: 0o600 });
console.log("wrote .env with generated passwords");
