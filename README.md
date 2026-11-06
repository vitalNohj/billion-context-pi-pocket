# billion-context-pi-pocket

[billion-context-pi](https://github.com/ranxianglei/billion-context-pi) in Pi Pocket, with a menu for installing the program and choosing whether each chat uses it.

The Pocket extension is small. It **does not include the whole BCP program** and does not download anything when it loads. The owner presses **Install**, **Update**, **Reinstall**, or **Repair** to obtain an exact, tested version. No separate Pi install, terminal commands, or npm installation scripts are needed.

The [Pi Pocket desktop app](https://github.com/vitalNohj/pi-pocket-gui) installs this extension automatically in the Pi Pocket it runs on that computer, and keeps it updated. Its Settings card and this menu offer the same buttons and show the same state.

## Install

### From the extension gallery

The official gallery submission is being prepared; this README does not mean the entry has already been accepted.

Once it is listed:

1. Install **billion-context-pi-pocket** from Pocket's extension gallery.
2. Turn the extension on.
3. Open **Menu → Billion context** and press **Install**.

### From this repository

1. Download this repository, or check it out.
2. Put both of these beside each other in your Pocket data folder's `extensions/` directory:
   - `billion-context-pi-pocket.ts`
   - the complete `billion-context-pi-pocket/` helper folder
3. Turn on the extension under **Menu → Extensions**.
4. Open **Menu → Billion context → Install**.

The default Pocket data folder is `~/.pi-pocket`; a desktop installation can use a different one. Use that installation's actual data folder, not the directory containing the Pocket application.

Use only one copy of the extension. If you already have it, update the existing entry rather than enabling a second entry with the same tools.

The extension uses Pocket's public extension API and packages. It does not require a Pocket fork or changes to Pocket's source code. The current minimum compatibility target is Pocket 0.27.0; tests also cover the current development installation.

## The Billion context menu

The menu is available without the BCP program installed, so you can install or repair it there.

- **Install / Update:** verify the pinned download, check that it can load with this Pocket installation, and activate it only after those checks pass.
- **Reinstall / Repair:** prepare a fresh verified copy before replacing program files. A verified cached archive can be used offline. Replaced files are retained in a private recovery folder. Repair shows when the installed program has a problem.
- **Uninstall:** asks first. It stops using the downloaded program and removes its normal cache. Chats, ACP history, chat choices, and settings remain. If program files are damaged, recovery keeps those objects in a private backup rather than following unsafe links or deleting unknown contents.
- **Check for updates:** asks GitHub for the newest commit of this repository (`api.github.com` and `raw.githubusercontent.com`; no user data is sent). It only runs when someone presses it, or when the desktop app checks. A desktop-managed installation shows **Update**, and the desktop app applies it. A gallery installation updates in **Menu → Extensions → Updates**. A hand-copied installation is replaced by hand.
- **This chat:** the on/off switch, the off behavior, and counts of the chat's saved summaries (never their text).
- **About and licenses:** the upstream and dependency attribution, including the additional acp-kernel attribution terms.

A failed download or pre-activation check does not replace a working program. Install and repair do not run npm lifecycle scripts. The program downloads from `registry.npmjs.org`; its exact version, URL, archive size, and SHA512 are recorded in [`runtime-lock.json`](billion-context-pi-pocket/runtime-lock.json). The menu shows the version and estimated space before installation.

Successful versions stay cached until Uninstall. Repairs can retain additional recovery backups. An abrupt process stop during repair can leave recovery files; they are not automatically deleted or blindly restored over newer files.

## Turn it on or off for one chat

Open **Menu → Billion context** from that chat. The **This chat** switch affects that chat only, starting with the next model request. It does not interrupt a response already streaming.

When switched off, choose:

| Off behavior | What happens |
| --- | --- |
| **Restore original history** | Stop using BCP's transformed view. Pocket receives the normal original history and follows its own compaction settings. This does not force an immediate summary or turn on compaction if you disabled it. |
| **Keep summaries** | Keep existing BCP summaries visible, but stop new compression. The agent can still retrieve existing context. |

The extension default is **Restore original history**. Change the default in the extension's Pocket settings. Each chat can override it, or select **Default** again. Turning a chat on/off alone does not create a hidden override.

If Pocket compacts the chat while BCP is off, turning BCP back on starts tracking the **current Pocket summary and retained history**. Pocket’s **New context** action also starts fresh tracking, even if you use the same opening message again. Neither operation revives the previous context’s compressed view. Old ACP files remain in the same state directory; the new tracking epoch uses a separate filename there. Old block IDs belong to their original tracking epoch.

While BCP is on, it continues to decline Pocket's native compaction, including manual `/compact`. Switch the chat off with Restore original history if you want normal Pocket compaction instead.

If the program is missing or damaged, you can still switch the chat off and choose Restore original history. Recovery must not trap you behind a disabled switch.

## Existing installations and forks

Existing `extensionName` and `stateDir` settings are preserved. Updating the program does not rename your stored extension identity, move the ACP directory, or delete checkpoints. A verified older bundled copy can continue working until you explicitly install the managed program. Uninstall records an explicit opt-out, so it does not silently reactivate that legacy copy.

Forks inherit only compression available at their fork point. Checkpoints live with the transcript; larger checkpoint data uses a content-addressed store in the existing ACP state directory. New forks and restarts can recover compressed context without copying mutable live session state. Context-boundary and saved-pass checks prevent an old checkpoint from crossing a native-compaction or New context boundary, while preserving compatible legacy state.

Re-reading the same message instances in a different order now keeps their compression, even when the first physical message changes. The proof tracks content identity, timestamps and duplicate counts, not encounter order; the actual order still goes to the model. Pocket's exact, paired `artifact_inline` → `artifact` with `inline: true` presentation migration is also recognized. Other tool renames, argument/detail edits, deletions, changed timestamps and lost duplicate occurrences are not treated as equivalent.

Compatible older markers are verified and migrated without resetting every chat. An identity repair writes a complete derived state into a fresh epoch before switching the marker and runtime cache key; original ACP files and immutable checkpoints remain intact. Set-aside state needs complete saved-pass/active-ID coverage and same-chat, same-boundary proof—not merely a similar opening, newer file or more blocks. If that cannot be proved, the extension retains the files and reports that explicit repair is required instead of silently selecting a shorter state.

**Limit:** additional message instances count as growth even if they appear among old messages. A message-only multiset cannot distinguish a genuine historical insertion from a newly appended tool result moved there by Pocket. This does not weaken deletion, replacement, timestamp, duplicate-count or native-boundary checks.

## Continuing a terminal Pi session

Install the program from **Menu → Billion context** before continuing a compressed terminal Pi session. On a Pocket version with `registerPiSessionCompanion`, the extension imports the session's `.jsonl.acp.json` sidecar when at least 90% of its compressed message IDs match the copied context. It keeps the compression refs and summaries, translates ordinary and composite message IDs, and never replaces compression already saved for the destination chat.

The source sidecar stays untouched. Continuing a session never downloads the program. Without that Pocket API, or if a sidecar does not match, billion-context-pi can replay the compression calls in the copied history instead. The installer, menu, and chat controls do not require this optional API.

## Model tools and plan mode

The model keeps the upstream tools and their argument schemas:

- `compress`
- `decompress`
- `search_context`
- `acp_status`
- `acp_cache`

An explicit `decompress({ blockId, toFile })` is **one model call**. Our extension restores the text into its own temporary working file and invokes Pocket's normal `write` tool internally. The requested destination goes through Pocket's normal file guard, plan-mode policy, approvals, cancellation, and result handling. The model does not need to remember a follow-up write call. Temporary bridge files are removed afterwards.

`decompress` can write files and is therefore **not marked read-only**. Pocket blocks it in plan mode, even when a particular call would have requested inline output. Compression, search, and status remain available there; a chat switched off still rejects new compression. This preserves the same tool interface rather than introducing a second export tool or incorrectly claiming all decompression is read-only.

BCP's own automatic decompression output can use `~/.cache/pi/acp-decompress/`. Explicit destinations retain upstream's restrictions to temporary/cache locations; they are additionally checked by Pocket's normal file tool. No decompression export uploads chat text anywhere.

## Sessions on another computer

The entry exports `remoteSessions = true`, so a Pi Pocket that has sessions on other computers (linked runners) loads it there too. Compression, search, and status work on the conversation, which stays on the server. An explicit `decompress({ toFile })` writes through Pocket's `write` tool, so the file lands on the session's computer. Older Pi Pocket versions ignore the export.

## Files and settings

An optional `billion-context-pi-pocket.json` beside the entry accepts:

```json
{
  "extensionName": "billion-context-pi",
  "stateDir": "billion-context-pi",
  "offBehavior": "restore-history"
}
```

- `extensionName`: the stored extension identity. Keep a custom value if you already use one.
- `stateDir`: an absolute directory or a path relative to Pocket's data folder. Keep the existing value on an established installation.
- `offBehavior`: `restore-history` or `keep-summaries`. Pocket's extension setting can supply the global default; a chat can override it.

The previous `billion-context-pi-pocket-adapter.json` filename remains a fallback when the new settings filename is absent. The old `billionContextPi` package-path setting is no longer used; installation must select verified pinned code, not an arbitrary directory.

The managed program and its archives live under:

```text
<Pocket data>/billion-context-pi-pocket-runtime/
  archives/
  packages/
  contexts/
    <conversation>.json   # bounded current-epoch pointer
    proofs/               # immutable content/time/count identity proofs, no message text
    epochs/               # retained per-epoch proof pointers
  selection.json
  updates.json       # the last update check, and a pending desktop update request
  .recovery-*/       # private repair backups, when needed
```

This is separate from `stateDir`, which contains ACP's saved compression and checkpoint objects. The `contexts/` records track the current history epoch; they are not a replacement location for ACP history. Program Uninstall leaves those records and your state directory intact. New format-2 markers deliberately fail closed in older releases: for a downgrade, keep matching backups of the markers, proofs and ACP state rather than deleting markers or forcing an old epoch.

The upstream self-updater is disabled with `ACP_AUTO_UPDATE=0`. Pocket forks use `PI_ACP_FORK_HOST=1`. The integration ignores upstream terminal UI commands/renderers and does not expose its late-registered delegate tools.

## Updates and gallery review

The **Refresh pins** GitHub workflow checks published npm releases every 6 hours. It verifies provenance and licenses, captures the tool contract, and runs the tests before updating this repository. It does not modify upstream's program code, mirror every upstream source commit, or publish an incompatible tool schema automatically.

A gallery installation may download only releases pinned in its reviewed extension version. Update the extension through Pocket's normal extension updates, then use its Billion context menu to update the program. The menu does not fetch an arbitrary npm “latest” or update the extension itself behind Pocket's review process.

New gallery versions still need a reviewed index PR. The repository's automated pin refresh is not a substitute for that approval.

## Development

Use a current Node version supported by Pocket. Tests use scripted models and disposable Pocket data, not real providers or the user's ACP configuration.

```sh
npm ci --ignore-scripts
npm run pins
PI_POCKET_CHECKOUT=/path/to/pi-pocket npm test
```

`npm run pins` downloads and checks the exact locked archives, generates the small lock/tool-contract/license files, and verifies the author cache used by installation tests. It does not put the program in the gallery helper folder. Generation runs in an isolated home; dependency license inspection can use a larger bounded archive-entry limit, while production installations retain the strict default limit.

On shared machines, apply the repository owner's CPU limits to builds, pin generation, and every test invocation. The test runner uses one concurrent test file.

## Credits and license

This integration is MIT-licensed; see [LICENSE](LICENSE).

It uses [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) and [acp-kernel](https://github.com/ranxianglei/acp-kernel) by ranxianglei. Related project: [billion-context](https://github.com/ranxianglei/billion-context). The downloaded program is unchanged upstream code. Upstream licenses and notices are preserved in the program archive and in [THIRD-PARTY-NOTICES.txt](billion-context-pi-pocket/THIRD-PARTY-NOTICES.txt); the menu also shows the attribution and full notices.
