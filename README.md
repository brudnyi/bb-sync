# Sync

Two-way sync of BB themes, keyboard shortcuts, plugins, and selected interface preferences through a **private GitHub repository**. No Git checkout, external database, or additional service.

Requires BB 0.49.0 or newer and plugin SDK 0.6.132 or newer. Each independent BB server needs its own installation. Clients of the same BB server already share these server settings.

## Install

```sh
bb plugin install git:https://github.com/brudnyi/bb-sync.git@main
```

Open **Settings → Installed plugins → Sync**. The **Sync** sidebar page shows status, conflicts, and the last local snapshot.

## Connect your laptops

Open **Sync** from the sidebar. All everyday setup happens on this page; no token copying, terminal commands, or manual repository creation is needed when GitHub CLI is already installed.

1. Click **Подключить GitHub**. BB reuses the GitHub CLI account already signed in on the computer running the BB server. If sign-in is needed, the plugin shows a one-time code and a button to open GitHub on your viewing device. Confirm in the browser; the wizard continues automatically. An expired CLI credential starts a fresh sign-in.
2. Choose the recommended **username/bb-sync-settings**, or choose another writable private repository from the list. The recommended repository is created privately and initialized automatically if absent. Existing empty repositories are checked and initialized with a README before use. Choose which preference groups to transfer.
3. Review the first transfer. On the first laptop, click **Начать синхронизацию**. On the next laptop, click **Использовать настройки из GitHub**, or **Сравнить и выбрать** to review individual fields. Replacing GitHub settings with this laptop's settings is an explicit secondary action.
4. Automatic sync turns on only after a successful confirmed transfer. The page has pause/resume, scope and frequency controls, recovery, and a copyable instruction for the next laptop.

[GitHub CLI](https://cli.github.com/) must be installed on the computer running the BB server for guided sign-in. If absent, the wizard explains where to install it and offers a retry. Device sign-in uses the GitHub CLI OAuth application and its normal permissions and credential-storage behavior. BB stores its own credential copy in its native secret setting. No authentication credential is returned by plugin RPC, put in command arguments, or included in the settings file. Automation-only GH_TOKEN/GITHUB_TOKEN environment variables are not used by guided sign-in.

Existing configured installations keep their credentials, repository, baseline, and automatic-sync preference when upgrading. The native plugin configuration page remains available for explicit advanced configuration, including a repository-limited fine-grained token with Contents read/write access. Failed guided sign-in never silently switches to this method.

The settings repository must be private and separate from this source-code repository. Only GitHub.com is supported. Select the same repository, branch, and file on every laptop. The wizard uses the selected repository's default branch and `bb-sync.json`; advanced settings can change them. For an already selected repository, existing advanced branch/file choices are preserved.

Local edits are detected every three seconds and must be stable across two observations. GitHub is checked every 60 seconds by default (configurable from 30 to 3600 seconds). Changes made while BB is closed are detected at startup. Changing the selected groups or preparing a new repository pauses auto-sync and requires a new preview/confirmation.

## What travels

- Selected theme ID and favicon color. Custom theme files do not travel. With the Plugins group enabled, missing Git/npm plugins are installed before their themes, shortcuts and interface selections are applied.
- Keyboard overrides, including disabled bindings, reset-to-default changes, and separate macOS/Windows/Linux overrides. Each command/platform pair merges independently.
- Keyboard hints, archive confirmation, Enter-to-steer behavior, command summaries, terminal copy-on-select, and streamer mode.
- Navigation/thread-list/composer provider selection; sidebar destination and footer order/visibility; collapsed Info sections and the pinned context card. A provider must be installed on the receiving server or included in the selected Plugins group.

Window sizes, split layouts, zoom, browser-local state, thread-list grouping/filter preferences owned by the Thread list plugin, projects, thread history, credentials and arbitrary plugin settings are outside this version's scope. Navigation order is a list and merges as one field.

## Plugin synchronization

Enable **Плагины** in Sync’s group controls, review the transfer, and confirm. The group is off on upgrade until selected; other groups and polling frequency stay as configured. On another laptop, install Sync itself, connect the same private repository, and enable the group there too. Review lists the plugin sources before confirmation. Plugin installation grants the same access as an ordinary BB installation.

- Missing plugins from HTTPS Git sources and npm are installed through BB’s background installation jobs. Git sources are pinned to an activated commit, npm to an exact version; monorepo subdirectories are preserved. Sources containing credentials are excluded. Local filesystem paths are excluded unless a portable Git/npm source is explicitly registered for that local plugin. Private plugin sources need their own access on each server.
- Enabled/disabled state travels for portable and bundled plugins. Sync itself is excluded so it cannot disable its own synchronization. An unavailable bundled plugin requires upgrading BB before applying the transfer.
- Installed plugins keep their current source and version. Sync does not update, downgrade or replace them. The first recorded installation source remains the source for new laptops; updates are managed in BB.
- Inventories combine additively. Removing a plugin never removes it elsewhere. A device remembers its own removals and does not reinstall them automatically; reinstall manually in BB to include that plugin locally again. New devices still receive the shared inventory. Extra local plugins are retained. An unregistered local-path installation with the same ID is left untouched. Explicit source registration keeps the original local installation and shares only its verified portable source and enabled state.
- Plugin settings, API keys, OAuth sessions, secrets and plugin data never travel. Newly installed plugins may ask for their own setup. Installation and activation failures keep a durable journal for retry; closing the page does not cancel the transfer. After a restart, in-progress BB jobs are resumed rather than duplicated.

Restoring a settings snapshot can restore plugin enablement, but never uninstalls an added plugin. This protects its local settings and secrets.

## Merge and recovery

The plugin keeps the last shared settings locally. If one laptop changes the theme and another changes a shortcut, both changes survive. Different edits to the same field pause application and show both values. There is no timestamp-based winner. Stale conflict choices are rejected and must be reviewed again.

GitHub updates use the previous file SHA. Concurrent writes are refetched and merged, with at most three attempts per run. Network errors retain the local edits and the last shared baseline. Automatic remote retries back off up to 15 minutes. Deleting a previously synchronized file is an error; restore it from GitHub history instead of using deletion as a reset.

Before applying settings locally, Sync saves the original values and a durable journal. A restart resumes unfinished application; a third local edit is never silently overwritten during recovery. The last snapshot can be restored locally; restoration pauses automatic sync and leaves GitHub untouched. Re-enabling sync can publish the restored values as deliberate edits.

BB has no transaction spanning all its settings APIs. Sync preflights the target, checks for local edits between writes, verifies the result, and keeps the journal on partial failure. A network request that succeeds but loses its response is reconciled on the next attempt.

Unknown fields and fields from disabled groups remain in GitHub and appear in status without being applied locally. The plugin does not serialize BB's entire configuration or validate it against a frozen copy of BB's general-settings schema. The versioned file format is intentionally strict. Settings documents are limited to 96 KiB / 1500 fields.

## Commands

```sh
bb sync status --json
bb sync now --json
bb sync restore --json
```

`restore` pauses automatic sync first. Conflict resolution and first-transfer preview are available in the page. CLI exits nonzero when unconfigured, conflicted, in recovery, or failed. The commands never print the token.

## Development

```sh
npm ci
npm run lint
npm run typecheck
npm test
bb plugin build
```

Build using BB 0.49.0 or newer. Run `bb plugin types --check` against the target BB before release. Install the local directory with `bb plugin install .` for a live check. Production Git installs need only Zod; React, the SDK, and UI primitives are supplied by BB. No background agent turns are used.

### Local personal plugins

Local plugins need their code on an accessible Git/npm source before another laptop can install them. Keep personal plugin sources private if they are not intended for public distribution. Build and validate the published package first. An authenticated `register_plugin_sources` RPC accepts `{ sources: { "plugin-id": { source: "git:https://github.com/owner/repository.git@<40-character-commit>", subdirectory: "plugins/plugin-id", enabled: true } } }`. Only already-installed local plugin IDs can be registered; Sync's own ID and builtin sources are rejected. The exported enabled state is always read from the local plugin, not the request. This registration never replaces or removes the existing local installation. Another laptop installs the published source through its normal BB installation jobs and needs independent repository access.
