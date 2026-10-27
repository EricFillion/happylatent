import { spawnSync } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--project", join(root, "tsconfig.json")], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await mkdir(join(root, "web"), { recursive: true });
await copyFile(join(root, "frontend", "styles.css"), join(root, "web", "styles.css"));
await rm(join(root, "web", "index.html"), { force: true });
console.log("Built the embedded HappyLatentVideo node editor in web/.");
