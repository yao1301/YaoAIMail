import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const env = process.platform === "win32" && existsSync("D:\\tools\\mingw64\\bin")
  ? { ...process.env, PATH: `D:\\tools\\mingw64\\bin;${process.env.PATH ?? ""}` }
  : process.env;

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("pnpm", ["exec", "tsc", "--noEmit"]);
run("cargo", ["check", "--manifest-path", "src-tauri/Cargo.toml", "--quiet"]);
