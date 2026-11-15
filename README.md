# bb-sync

Two-way sync of BB themes, keyboard shortcuts, and selected interface preferences through a **private GitHub repository**. No Git checkout, external database, or additional service.

Requires BB 0.49.0 or newer and plugin SDK 0.6.132 or newer. Each independent BB server needs its own installation. Clients of the same BB server already share these server settings.

## Install

```sh
bb plugin install git:https://github.com/brudnyi/bb-sync.git@main
```

Open **Settings → Installed plugins → bb-sync**. The **bb-sync** sidebar page shows status, conflicts, and the last local snapshot.

## Connect your laptops

1. Create a separate **private** GitHub repository for personal preferences, initialized with a README so a branch exists. This source-code repository is not a preferences repository.
2. Create a fine-grained GitHub personal access token, limited to that repository, with **Contents: read and write**. Enter it in the plugin's secret **GitHub token** setting on each BB server. The token stays in BB's secret storage; it is never placed in the settings file or returned by the plugin's RPC.
3. Set the same `owner/repository`, branch (default `main`), and file (default `bb-sync.json`) on every laptop. Select the groups to sync. Using identical groups on every computer is recommended.
4. Click **Синхронизировать** on the first laptop. If the file is missing, it is created from that laptop's selected preferences. A missing/inaccessible repository or branch is an error, not an empty preset.
5. On the other laptops, sync once and resolve any initial differences. Nothing is overwritten until every conflicting field has a choice. Required fields absent from the remote file retain the local value; an absent shortcut means BB's default binding.
6. Enable **Автоматическая синхронизация** on each laptop. Local changes are detected every three seconds and must be stable across two observations. GitHub is checked every 60 seconds by default (configurable from 30 to 3600 seconds). Changes made while BB is closed are detected at startup.

Automatic sync starts **off**. Secrets are entered through BB's native settings form, not command arguments. A token with access to the code repository alone is insufficient if preferences are in a separate repository.

## What travels

- Selected theme ID and favicon color. Custom theme files and plugin installations do not travel: install the same theme on each computer first.
- Keyboard overrides, including disabled bindings, reset-to-default changes, and separate macOS/Windows/Linux overrides. Each command/platform pair merges independently.
- Keyboard hints, archive confirmation, Enter-to-steer behavior, command summaries, terminal copy-on-select, and streamer mode.
- Navigation/thread-list/composer provider selection; sidebar destination and footer order/visibility; collapsed Info sections and the pinned context card. A provider must already be installed on the receiving server.

Window sizes, split layouts, zoom, browser-local state, thread-list grouping/filter preferences owned by the Thread list plugin, projects, thread history, credentials, plugin installation, and arbitrary plugin settings are outside this version's scope. Navigation order is a list and merges as one field.

## Merge and recovery

The plugin keeps the last shared settings locally. If one laptop changes the theme and another changes a shortcut, both changes survive. Different edits to the same field pause application and show both values. There is no timestamp-based winner. Stale conflict choices are rejected and must be reviewed again.

GitHub updates use the previous file SHA. Concurrent writes are refetched and merged, with at most three attempts per run. Network errors retain the local edits and the last shared baseline. Automatic remote retries back off up to 15 minutes. Deleting a previously synchronized file is an error; restore it from GitHub history instead of using deletion as a reset.

Before applying settings locally, bb-sync saves the original values and a durable journal. A restart resumes unfinished application; a third local edit is never silently overwritten during recovery. The last snapshot can be restored locally; restoration pauses automatic sync and leaves GitHub untouched. Re-enabling sync can publish the restored values as deliberate edits.

BB has no transaction spanning all its settings APIs. bb-sync preflights the target, checks for local edits between writes, verifies the result, and keeps the journal on partial failure. A network request that succeeds but loses its response is reconciled on the next attempt.

Unknown fields and fields from disabled groups remain in GitHub and appear in status without being applied locally. The plugin does not serialize BB's entire configuration or validate it against a frozen copy of BB's general-settings schema. The versioned file format is intentionally strict. Settings documents are limited to 96 KiB / 1500 fields.

## Commands

```sh
bb sync status --json
bb sync now --json
bb sync restore --json
```

`restore` pauses automatic sync first. Conflict resolution is available in the page. CLI exits nonzero when unconfigured, conflicted, in recovery, or failed. The commands never print the token.

## Development

```sh
npm ci
npm run lint
npm run typecheck
npm test
bb plugin build
```

Build using BB 0.49.0 or newer. Run `bb plugin types --check` against the target BB before release. Install the local directory with `bb plugin install .` for a live check. Production Git installs need only Zod; React, the SDK, and UI primitives are supplied by BB. No background agent turns are used.
