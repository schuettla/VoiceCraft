# Agent notes

## Rust build output (disk usage)

- Use the single default Cargo target dir (`src-tauri/target/`). Do NOT pass `--target-dir`
  or set `CARGO_TARGET_DIR` (e.g. a `target-check/` dir). A second target dir duplicates
  ~7 GB of build artifacts. If `cargo check` waits on the lock held by a running
  `tauri dev`, just wait.
- `src-tauri/target/` is regenerable; `cargo clean` is safe. Do not delete `.venv/` or
  `Cargo.lock` as a space-saving measure.
- `[profile.dev]` in `src-tauri/Cargo.toml` uses `debug = "line-tables-only"` to keep the
  debug build small. Don't revert it without a reason.
