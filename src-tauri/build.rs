use std::path::Path;

/// Written when `bun run build:bridge` has not run, so `cargo check` and
/// `cargo test` work on a fresh clone (the bundle resource must exist).
const BRIDGE_STUB: &str = r#"// Stub written by build.rs. Run `bun run build:bridge` for the real bridge.
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let id = null;
  try { id = JSON.parse(line).id ?? null; } catch {}
  process.stdout.write(JSON.stringify({ id, error: { message: "The Claude Code bridge was not built. Run `bun run build:bridge`.", code: "notFound" } }) + "\n");
});
"#;

fn main() {
    let bridge = Path::new("resources/claude-bridge.mjs");
    if !bridge.exists() {
        std::fs::create_dir_all("resources").expect("create resources/");
        std::fs::write(bridge, BRIDGE_STUB).expect("write the bridge stub");
    }
    println!("cargo:rerun-if-changed=resources/claude-bridge.mjs");
    println!("cargo:rerun-if-changed=build.rs");
    tauri_build::build()
}
