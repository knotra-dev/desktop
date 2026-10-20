# Contributing to Knotra Desktop

Use Bun 1.3.10 and the Rust version in `rust-toolchain.toml`. Run the checks in
[README](README.md#checks-and-build). The engine and its runtime live in
[knotra-dev/engine](https://github.com/knotra-dev/engine); use
[knotra-dev/dev](https://github.com/knotra-dev/dev) for paired changes and real client acceptance.

Run `bun run check` before submitting changes. Biome enforces formatting, import organization and
React lint rules; `bun run format` applies formatting. Keep lint suppressions narrow and explain why
the rule does not apply.

Keep protocol values, errors, validation, credential handling and accessibility intact. The engine
owns model credentials and execution. Desktop owns authoring and observation. Update both clients
and their tests when changing the HTTP/SSE contract.

Contract assets are committed in `vendor/engine/`. Update them from an explicit engine commit:

```sh
python3 scripts/sync-engine.py ../engine ENGINE_COMMIT
python3 scripts/sync-engine.py ../engine ENGINE_COMMIT --check
```

Commit the snapshot and its manifest with the client change. Builds need no engine checkout. Never
edit the snapshot by hand; change the canonical files in engine first. In a paired change, commit
engine, sync its commit here, then update both revisions in the dev lock file.

## Interface translations

The frontend keeps English and Russian interface text in `src/locales/en.json` and
`src/locales/ru.json`. Add the same stable semantic key to both catalogs, then render it with
`t('settings.language')` from `useI18n()`. Use named parameters, for example
`t('shell.countPendingReviews', { count })`, and preserve their names in every translation. Enum
label maps refer to these keys while keeping protocol values unchanged. CodeMirror phrase lookups
retain the library's original English tokens and map them to catalog keys.

Only interface text is translated. Render user-defined names, YAML, prompts, model responses, engine
diagnostics and artifact bytes verbatim. The `message()` adapter is reserved for messages from
frontend validators; it must not translate engine or user content. Dates and sizes use the selected
interface locale.

Run frontend unit and browser tests after changing translations. They check catalog coverage,
matching placeholders, legacy workspace compatibility, persistence, accessibility, editor search and
preservation of authoring data, demo history and the engine cache during language switching.

## Pull requests

Explain the behavior changed and the checks performed. Preserve existing attribution and the
[MIT license](LICENSE). Follow the [code of conduct](CODE_OF_CONDUCT.md).

## Frontend layout and styling

`src/app/` owns startup, workspace navigation, dialogs and persistence. Product screens live in
`src/features/`: `pipelines`, `engine`, `demo` and `resources`. Shared graph/editor components live in
`src/components/`; `src/lib/` contains the client, validation and storage logic.

Use Tailwind utilities for layout and presentation. `src/styles/index.css` is the single stylesheet
entry point; `theme.css` exposes the existing dark/light palette as named Tailwind colors. Reuse the
button, icon-button, text-button, status and node-icon utilities in `primitives.css`. Keep custom CSS
beside its feature for state/descendant selectors and graph/editor integration. The base layer keeps
the current form/editor defaults, while vendor styles have their own cascade layer.
