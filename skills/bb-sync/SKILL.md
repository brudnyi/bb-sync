---

name: bb-sync
description: Inspect or run bb-sync preference synchronization through a private GitHub repository.
---

Use `bb sync status --json` to inspect configuration, sync state, first-transfer review, conflicts, unsupported fields, and snapshot availability. `bb sync now --json` explicitly performs one two-way sync even when automatic sync is off.

For setup, direct users to the Sync sidebar page: Connect GitHub → choose/create private storage → preview and confirm the first transfer. Guided sign-in reuses the GitHub CLI account on the server computer or shows a device code. Users never need to send a token in chat. If GitHub CLI is absent, the wizard offers its installation link; no alternate auth mode is silently attempted.

RPC `setup_load`, `auth_start`, `auth_status`, `auth_cancel`, `repositories`, `setup_prepare`, `preview`, and `setup_finish` power this workflow. `setup_prepare` may create/initialize a private repository; use only for the user's requested setup. `setup_finish` requires the exact current preview ID and choices. Never resolve conflicting values without the user's instructions. Never delete a remote file or clear the baseline to bypass a conflict.

RPC `options` changes pause/resume, selected groups, and frequency. Changing groups or preparing storage pauses auto-sync until a first-transfer review is confirmed.

`bb sync restore --json` restores the last local snapshot and pauses automatic sync. Use only when requested. It does not change GitHub.

Never extract, print, or embed authentication credentials in shell arguments, exported JSON, or chat. Native secret plugin settings remain available for explicit advanced configuration. The preferences repository must be private and separate from the source repository.

The optional `plugins` group installs missing portable Git/npm plugins and synchronizes enabled state, including bundled plugins present on the server. It never removes plugins, changes already-installed versions, transfers local paths/settings/secrets, or controls Sync itself. Device-local inventory remembers manual removals so they are not reinstalled on that device. Manual reinstall opts that device back in. Installation uses persistent BB jobs and the sync journal. A failed installation can be retried with `bb sync now`; do not remove plugins or clear the journal to bypass it. Snapshot restore leaves extra plugins installed.

For a local plugin the user wants on other laptops, first publish and validate only its source files in an authorized Git/npm destination. Prefer private storage for personal code. RPC `register_plugin_sources` accepts `sources` keyed by installed local plugin ID; each value contains a pinned portable `source`, optional monorepo `subdirectory`, and `enabled` (the actual local state takes precedence). It durably maps the local installation to that portable source without replacing/removing it or exporting its settings/secrets. Registration is serialized with sync and blocked during interrupted application. Do not register an arbitrary source without checking that its package ID and contents match the local plugin. After registration, run sync and verify the remote document contains those plugin entries.
