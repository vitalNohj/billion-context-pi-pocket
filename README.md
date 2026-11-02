# billion-context-pi-pocket

Runs [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) in [Pi Pocket](https://github.com/TannerMidd/pi-pocket), with compression that survives forks.

billion-context-pi lets the model fold old parts of a long conversation into summaries (`compress`, `decompress`, `search_context`). This extension supplies the terminal extension API that it expects inside Pi Pocket.

**The published billion-context-pi runtime is included.** No separate Pi installation, `pi install`, or npm install is needed on the computer running Pocket. The extension uses Pocket's own Pi packages.

## Install

Copy **both** of these into Pi Pocket's `extensions/` folder (`~/.pi-pocket/extensions/` by default):

```text
extensions/
├── billion-context-pi-pocket.ts
└── billion-context-pi-pocket/     # the whole folder, including bundle.json
    ├── bundle.json
    ├── THIRD-PARTY-NOTICES.txt
    └── billion-context-pi-<version>/
        ├── LICENSE
        ├── package.json
        └── dist/
```

Then turn the extension on in Menu → Extensions. The helper folder is not a second extension. Do not copy this repository's development `node_modules` folder.

Read the code before turning it on: a drop-in runs inside Pi Pocket's server, with the owner's rights. Tests run against Pi Pocket **v0.27.0**; newer versions must keep compatible Pi APIs.

## Updates

A GitHub Actions workflow checks npm's latest stable billion-context-pi release every **6 hours**. It can also run manually from the Actions page.

For a newer release, it:

1. Pins the exact npm version, package integrity, and upstream source commit.
2. Copies the complete published runtime unchanged, with its source maps and bundled-dependency license notices.
3. Verifies the generated files and tests the extension in an isolated Pi Pocket app.
4. Commits the tested update directly to `main`. It stops if `main` changed during testing, rather than rebasing untested changes.

A failed refresh leaves `main` unchanged. The workflow opens or updates an issue with a link to the failed run. Changes to the extension implementation are not generated automatically.

**Updating this repository does not update an installed copy.** To update a manually installed extension, turn it off, replace the `.ts` file and its entire helper folder together, then turn it on. Keep your settings file and compression state. Runtime directories include the version, so Node cannot reuse the previous release's cached modules after reload.

The bundled BCP updater is disabled: it cannot replace its code independently under a running Pocket server. No library code is fetched at runtime. This repository does not configure gallery installation or updates.

### Upgrading from the old name

This project was previously named `billion-context-pi-pocket-adapter`. Its new name is **billion-context-pi-pocket**.

For a manual installation:

1. Turn off the old module in Menu → Extensions.
2. Replace its `.ts` file and helper folder with the new names shown above. Do not leave two enabled copies.
3. Rename `billion-context-pi-pocket-adapter.json` to `billion-context-pi-pocket.json`, if it exists. Keep its contents unchanged.
4. Turn on the new module. Keep the existing compression state and checkpoints.

The extension also reads the old settings filename when the new one is absent. If both files exist, only the new file is used. An invalid new file is an error; it does not silently fall back to the old file.

**Stored identifiers are not product names.** Keep an existing `extensionName` and `stateDir`, including custom values such as `bcp-adapter` and `bcp`. Sessions and pending work refer to these values. Renaming the project and installation files does not change them or the checkpoint format.

## Settings

All optional. Put them in `billion-context-pi-pocket.json`, next to the `.ts` file:

```json
{
  "stateDir": "billion-context-pi",
  "extensionName": "billion-context-pi"
}
```

| Setting | Default | What it is |
| --- | --- | --- |
| `stateDir` | `billion-context-pi`, in Pi Pocket's data folder | Where compression state and fork checkpoints are kept. A relative path is resolved from the data folder |
| `extensionName` | `billion-context-pi` | The extension's stored name in Pi Pocket. Sessions store it, so do not change it after you start using the extension |

An older `billionContextPi` setting is ignored; the extension always uses its included runtime. You can leave that setting in an existing file. Keep your existing `stateDir` and `extensionName` to keep using the same sessions and state.

billion-context-pi's own settings stay in `~/.pi/acp.json`, with its log in `~/.pi/acp.log`. Automatic decompression output and inline restoration keep upstream behavior. For a non-empty `toFile`, the extension restores the text into a private temporary file, then calls Pocket's normal `write` tool internally. The model still makes one `decompress` call with the same arguments; it does not need a follow-up write call. The requested destination is never written directly by BCP.

Custom destinations retain upstream's restriction to the system temporary folder, `~/.cache/opencode`, or `~/.cache/pi`. Pocket's normal write checks, wrappers, and any required approval apply. A denied, unavailable, or failed write returns a decompression error without a direct-write fallback. Temporary export files are removed after success or failure. These working files are separate from saved ACP state and fork checkpoints.

Requested file saves require Pi Durable's `executeTool` API, supplied by the tested Pocket v0.27.0. An older or incompatible Pocket fails closed instead of bypassing its file tools. An interrupted `decompress` call is not automatically replayed, because it may already have saved a file.

A settings change takes effect when the extension reloads. Save the `.ts` file, or turn the extension off and on again.

## Forks

billion-context-pi keeps its compression state in a file for each session. On its own, a fork starts without that state, so the old messages come back at full size.

After each compression, the extension saves a state checkpoint and puts its ID in the tool result. The model does not see it. A fork restores the newest checkpoint in the history it inherited:

- Later compression in the parent is not carried over.
- The parent's state is never changed.
- A fork that already has its own state keeps it.

Sessions compressed before checkpoints existed fall back to billion-context-pi's own replay of the compress calls in their history.

Checkpoints are stored in `checkpoints/` inside the state folder, one file per state. They are not deleted automatically.

## Plan mode

The extension marks `compress`, `search_context`, `acp_status`, and `acp_cache` as read-only (`annotations: { readOnlyHint: true }`), since they change only the conversation context. Compression and search remain available while Pi plans.

`decompress` keeps its existing name and arguments, including `toFile`, but is **not** marked read-only: it can save a requested file. Pocket currently checks the outer tool before any nested write, so **all `decompress` calls are blocked in plan mode**, even `inline: true`. Approve or leave plan mode before decompression. This is a permission correction, not a move or reset of ACP data. Delegate tools that start subagents also remain blocked.

## Terminal-only features

Pi Pocket has no terminal UI, so these billion-context-pi features are ignored:

- Slash commands
- Keyboard shortcuts
- The status line
- Custom message rendering

Loading the extension sets `PI_ACP_FORK_HOST=1` for operation outside Pi's terminal, and `ACP_AUTO_UPDATE=0` to disable the bundled updater. These are process-wide environment settings.

## Development and verification

Requires Node.js **22.19 or newer**, npm, and a Pi Pocket checkout with its dependencies installed. Dependencies in this repository are build/test inputs, not installation requirements for users.

```sh
npm ci --ignore-scripts
npm run verify-bundle
PI_POCKET_CHECKOUT=/path/to/pi-pocket npm test
```

Use `npm run bundle` to regenerate the checked-in runtime and notices from the pinned dependencies. Use `npm run check-upstream` to check for a new stable release, and `npm run refresh -- <version>` to refresh the pins and bundle. The exact version, npm integrity, source commit, and bundled dependency versions are recorded in `upstream.json` and the helper folder's `bundle.json`.

The tests copy the extension and bundle outside this repository. They load them through a test Pocket app's `extensions/node_modules` link. A scripted model makes no real provider requests. A temporary home folder keeps your `~/.pi`, Pi Pocket data, and live extension untouched. Tests cover registration, compression, forks, reloads, automatic and custom decompression output, unchanged tool parameters, settings compatibility, and plan-mode restrictions. They exercise Pocket's actual guard hook and approval machinery with controlled allow/block/ask verdicts, not the downloaded Lancet classifier. Tests also verify one model call, denied-write preservation, write failures, private scratch-file cleanup, and fail-closed behavior. CI rejects a missing Pocket checkout instead of silently skipping those tests.

## Licenses

This extension is [MIT](LICENSE). Included third-party code retains its own licenses. The BCP package's license is in its versioned runtime folder; full notices for code bundled into BCP are in [`THIRD-PARTY-NOTICES.txt`](billion-context-pi-pocket/THIRD-PARTY-NOTICES.txt).

`acp-kernel`'s published license includes an additional product-attribution term. Its full text is retained in the notices; the unchanged BCP runtime also retains its attribution footer. Do not assume that this extension's MIT license replaces bundled dependencies' license terms.
