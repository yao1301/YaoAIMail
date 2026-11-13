# Rebuilding YaoAIMail 1.1.43

This archive is the complete modified application source corresponding to the accompanying Windows binaries, including uncommitted application modules, regression tests and build configuration. It is supplied under GNU AGPL-3.0; see LICENSE. No Git history, developer profile, mailbox, API credential or input-method cache is included. SOURCE-MANIFEST.json records the source file hashes.

Use Node.js with the package manager/lockfile in this tree, the Rust toolchain in rust-toolchain.toml, and the desktop dependencies required by Tauri. On Windows this release uses x86_64-pc-windows-gnu, MinGW-w64 and LLVM lld. Put their binaries on PATH. The GNU linker flags are also documented in .cargo/config.toml.

The public policy-page files required by the regression tests are included. Website deployment account settings and promotional screenshots are not application build inputs and are excluded. This is the application source archive, not a website deployment bundle.

1. Install JavaScript dependencies from the supplied lockfile (`pnpm install --frozen-lockfile`).
2. Run `pnpm test`, `pnpm exec tsc --noEmit`, and `cargo test -p pebble-websearch --lib`.
3. Run `pnpm exec tsc`, then build the frontend into a new directory: `pnpm exec vite build --outDir .release-frontend-1.1.43`.
4. Build and bundle Windows binaries: `pnpm build:windows --config release-config.example.json`.

The Windows script first runs `tauri build --no-bundle`, locates and validates the x64 WebView2Loader.dll produced by the SDK, stages it in a versioned ignored directory, then runs `tauri bundle` with release-bundle.example.json. Both the installer and portable application require this DLL beside the executable; do not assume that installing the WebView2 runtime supplies the SDK loader in the app folder. For an already-built release, `pnpm build:windows --bundle-only --config release-config.example.json` only regenerates the installer and does not recompile Rust. Use the same CARGO_TARGET_DIR, target and features as the original build. The generic Windows build entry uses the same pipeline.

Use the maintained pnpm-lock.yaml, not an ignored local package-lock.json from an older version. The archive intentionally omits that stale npm lock. Do not add an extra standalone `--` after pnpm script names; the shown flags are passed directly to the script.

Use a separate CARGO_TARGET_DIR when a private development instance is running, and do not run two instances against the same user profile. Production builds do not implicitly read a local .env file. Publisher OAuth client settings, if required, must be deliberately provided through the build environment; do not include personal credentials in a distributed build.

The shipped build uses Rust path remapping for the builder's home and workspace, plus the GNU static-runtime/lld flags. When setting RUSTFLAGS, preserve all four link arguments rather than accidentally overriding .cargo/config.toml: `-C link-arg=-fuse-ld=lld -C link-arg=-static-libgcc -C link-arg=-static-libstdc++ -C link-arg=-static`. Add `--remap-path-prefix=<builder-home>=C:\Build` and `--remap-path-prefix=<workspace-parent>=D:\Source` for your own paths. Scan the finished assets and binaries for private data before distributing.

The release frontend is production-built, not a Dev server. Its relative directory in release-config.example.json avoids embedding a builder's absolute frontend path. The normal dist directory can also be used with the default Tauri configuration after a clean frontend build.

The six-file binary ZIP and this exact-version source ZIP must be supplied together when sharing this release. The upstream repository and other branches are not a substitute for these exact modified sources. No remote upload or tag creation is performed by these instructions.
