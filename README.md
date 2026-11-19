# Midterm

A compact terminal emulator built with Tauri 2 and React. Workspaces hold
tabs; a tab holds any arrangement of panes in nested splits.

## Develop

```sh
bun install
bun run tauri dev    # the app
bun run dev          # frontend only, in a browser, with a mock shell
bun run test         # frontend unit tests
```

Backend tests: `cargo test` in `src-tauri/`.

Documentation for contributors and agents is in [`docs/`](docs/architecture.md);
planned work is in [`docs/roadmap.md`](docs/roadmap.md).
