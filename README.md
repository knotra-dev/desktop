# Knotra desktop

Tauri/React app for editing pipelines, inspecting runs, answering human requests and managing
artifacts through the [engine API](https://github.com/knotra-dev/engine/blob/main/docs/api/desktop-v1.md).
The desktop app connects to an engine; it does not launch one. Guided demo mode works offline.

## Development

Use Make, Bun 1.3.10, Rust from `rust-toolchain.toml` and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
make install
make desktop
```

For browser preview, use `make dev` and open `http://127.0.0.1:1420`. Run one development mode at a
time; browser and native development share that port. Run `make` to see all commands.

## Connect an engine

Follow the [engine running guide](https://github.com/knotra-dev/engine/blob/main/docs/running.md),
then save its address in Settings (`http://127.0.0.1:8787` by default). Browser preview requires the
engine flag `--cors-origin http://127.0.0.1:1420`; remote engines require HTTPS and a token. Model
credentials stay in engine profiles, separate from exported drafts.

## Checks and build

Use `make check` for frontend checks and build, `make native-check` for Rust, and `make e2e` for
browser tests after `make e2e-install`. Individual lint, format, test and build targets are listed by
`make help`.

See [Contributing](CONTRIBUTING.md) for native builds, live-engine tests, translations and the bundled
contract snapshot, or the [user guide](https://knotra-dev.github.io/docs/) for app workflows.
