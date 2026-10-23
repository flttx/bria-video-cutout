import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import dotenv from "dotenv";

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
// Existing process variables win. Paths work from the repo, workspace or dist.
for (const name of ["apps/api/.env", ".env", ".env.development"]) {
  dotenv.config({ path: resolve(ROOT, name), quiet: true });
}
export const DATA_DIR = resolve(ROOT, "data");
