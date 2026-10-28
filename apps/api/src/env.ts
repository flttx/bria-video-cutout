import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import dotenv from "dotenv";

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
// A private server image may carry an explicitly selected config. Runtime env wins.
if (process.env.CUTOUT_DEPLOYMENT === "standalone" && process.env.CUTOUT_CONFIG_FILE) {
  const result = dotenv.config({ path: process.env.CUTOUT_CONFIG_FILE, quiet: true });
  if (result.error) throw new Error("PRIVATE_CONFIG_UNAVAILABLE");
}
// Existing process variables win. Paths work from the repo, workspace or dist.
for (const name of process.env.CUTOUT_DEPLOYMENT==="standalone"?[]:["apps/api/.env", ".env", ".env.development"]) {
  dotenv.config({ path: resolve(ROOT, name), quiet: true });
}
export const DATA_DIR = resolve(ROOT, process.env.DATA_DIR?.trim()||"data");
