import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function findPersonalPortableDataDir(releaseRoot = path.resolve(repoRoot, "..", "release")) {
  if (!existsSync(releaseRoot)) return null;

  const candidates = readdirSync(releaseRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes("-个人移动版"))
    .map((entry) => {
      const directory = path.join(releaseRoot, entry.name);
      const dataDir = path.join(directory, "data");
      return {
        dataDir,
        modifiedAt: existsSync(dataDir) ? statSync(dataDir).mtimeMs : 0,
      };
    })
    .filter((candidate) => existsSync(candidate.dataDir))
    .sort((left, right) => right.modifiedAt - left.modifiedAt);

  return candidates[0]?.dataDir ?? null;
}

function isEntrypoint() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

// The Tauri CLI is a devDependency, so pnpm and npx run the same
// `node_modules/.bin/tauri`. Fall back to npx when pnpm is not installed
// instead of failing the dev start outright.
function hasCommand(command) {
  const probe = spawnSync(command, ["--version"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  return probe.status === 0;
}

if (isEntrypoint()) {
  const portableDataDir = findPersonalPortableDataDir();
  const env = {
    ...process.env,
    ...(portableDataDir ? { PEBBLE_PROFILE_DIR: portableDataDir } : {}),
    ...(process.platform === "win32" && existsSync("D:\\Tools\\mingw64\\bin")
      ? { PATH: `D:\\Tools\\mingw64\\bin;${process.env.PATH ?? ""}` }
      : {}),
  };

  if (portableDataDir) {
    console.log(`[dev] Using personal portable data: ${portableDataDir}`);
  } else {
    console.warn("[dev] No personal portable data folder found; using the normal profile resolution.");
  }

  const runner = hasCommand("pnpm") ? "pnpm" : "npx";
  if (runner === "npx") {
    console.warn("[dev] pnpm not found; using npx with the local Tauri CLI instead.");
  }

  const result = spawnSync(runner, ["tauri", "dev", ...process.argv.slice(2)], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env,
  });

  process.exit(result.status ?? 1);
}
