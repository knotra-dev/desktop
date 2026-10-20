# Knotra desktop

Tauri/React client for editing pipelines, inspecting runs, answering human requests and managing
artifacts through the
[engine API](https://github.com/knotra-dev/engine/blob/main/docs/api/desktop-v1.md). Rust handles
native HTTP/SSE, SQLite, package dialogs and verified downloads. Browser preview uses the same API
with browser storage. The desktop app does not launch the engine.

## Development

Use Bun 1.3.10, Rust from `rust-toolchain.toml` and
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/):

```sh
bun install --frozen-lockfile
bun run desktop:dev
```

For browser preview use `bun run dev` at `http://127.0.0.1:1420`. Stop it before starting native
development; they share a Vite port.

## Connect and use

Start an engine using
[quickstart or the running guide](https://github.com/knotra-dev/engine/blob/main/docs/running.md),
then save its address in Settings (`http://127.0.0.1:8787` by default). Browser preview requires the
engine flag `--cors-origin http://127.0.0.1:1420`; remote engines require HTTPS and a token. Model
credentials stay in engine profiles, separate from exported drafts.

- **Pipelines:** edit YAML/graphs or copy one of the five
  [starters](vendor/engine/examples/starter/README.md). Select profile `local` to validate and run.
  Accepted packages are immutable.
- **Runs:** inspect nested graphs, inputs/outputs, streamed responses, agent/tool activity, timings
  and artifacts. Rewind shows saved history without repeating execution; compare highlights changes
  between runs. Truncated previews and missing observations are marked; hidden reasoning is
  excluded.
- **Inbox:** answer saved human requests. **Artifacts:** upload, preview and export verified bytes.
- **Guided demo:** explore sample data without model calls.

Runs continue after the app closes. Earlier activity loads independently of the bounded live cache.
Starter upgrades preserve edited drafts and execution history.

## Interface language

Settings → Language switches English/Russian. The initial choice follows the webview/browser
language; the saved preference is included in workspace backups. Interface text and formatting are
translated, while YAML, prompts, engine messages, model output and artifacts retain their text.
Starter text is localized when a draft is created and preserved thereafter. Catalogs are
[en.json](src/locales/en.json) and [ru.json](src/locales/ru.json); see
[translation contribution rules](CONTRIBUTING.md#interface-translations).

## Checks and build

```sh
bun run check
bun run test
bun run build
bunx playwright install chromium
bun run test:e2e
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
bun run desktop:build
```

Biome checks formatting, imports and React lint rules. Use `bun run format` to format files,
`bun run lint` for lint checks, and `bun run check` for the combined CI check.

Default browser tests use a contract fixture. Real-engine acceptance needs a development engine with
the bundled `local` profile and preview CORS enabled; tests create definitions/runs/artifacts:

```sh
KNOTRA_E2E_ENDPOINT=http://127.0.0.1:8787 bun run test:e2e
KNOTRA_E2E_ENDPOINT=http://127.0.0.1:8787 \
  cargo test --locked --manifest-path src-tauri/Cargo.toml real_engine -- --ignored
```

For literal browser and native acceptance against River/PostgreSQL and isolated Docker tools, use
`make integration` in [knotra-dev/dev](https://github.com/knotra-dev/dev). Only inference uses a
fixed HTTP provider. This is separate from live-model acceptance.

The committed `vendor/engine/` snapshot contains the schema, OpenAPI document, fixtures and starters
from the engine commit recorded in its manifest. See [CONTRIBUTING](CONTRIBUTING.md) to update it.
Desktop CI checks the frontend, browser and native clients; the dev repository checks a pinned pair.

On macOS, `bun run desktop:build -- --bundles app` creates
`src-tauri/target/release/bundle/macos/Knotra.app`. Signing/notarization are not configured;
platform builds require their native toolchain. Development rules are in
[CONTRIBUTING](CONTRIBUTING.md).
