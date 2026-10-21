# Knotra desktop

Tauri/React app for editing pipelines, inspecting runs, answering human requests and managing
artifacts through the [engine API](https://github.com/knotra-dev/engine/blob/main/docs/api/desktop-v1.md).
An interactive tour opens on first launch and can be restarted from Settings. New workspaces start
empty; the tour creates one learning pipeline for editing, adding blocks and connecting them.
Model setup is optional during the tour. Desktop can start its bundled engine after you choose a
model connection, or connect to an existing engine in Settings.

## Control Knotra with MCP

Open **Settings → Control Knotra with MCP**, copy the client configuration, and add it to your
assistant. Keep Knotra open while connected. The server exposes pipeline editing, model and MCP
source management, engine operations, runs, human responses, and artifacts. Changes use the same
workspace and appear in the app. Read the included `knotra://guide` and `knotra://schema/v1`
resources before authoring pipelines.

Pipeline edits require the current revision and preserve unfinished app edits. Mutation request IDs
deduplicate calls within the current app session; after restarting Knotra, read and reconcile its
state before retrying an uncertain change. Engine operation IDs remain durable across restarts.

## Documentation

Detailed guides live in the [Wiki](https://github.com/knotra-dev/desktop/wiki):
[development](https://github.com/knotra-dev/desktop/wiki/Development),
[engine connection](https://github.com/knotra-dev/desktop/wiki/Engine-connection) and
[contributing](https://github.com/knotra-dev/desktop/wiki/Contributing).
See the [user guide](https://knotra-dev.github.io/docs/) for app workflows.

## Checks and build

See [checks and build](https://github.com/knotra-dev/desktop/wiki/Checks-and-build) in the Wiki.
