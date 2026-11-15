## Your preferences on every laptop

Choose your theme, keyboard shortcuts, and selected interface preferences once and keep them aligned across independent BB installations. bb-sync stores a small JSON file in your own private GitHub repository.

## Two-way sync

Independent changes merge automatically. When two computers change the same field, the bb-sync page shows both values and waits for your choice. Automatic sync is optional; you can always sync once from the page or with `bb sync now`.

Unknown settings stay in GitHub without being applied. A local snapshot and durable apply journal support recovery after a failed or interrupted update. Restoring a snapshot pauses automatic sync.

## Setup and requirements

Requires BB 0.49.0+, a GitHub account, a private repository with an existing branch, and a fine-grained token with Contents read/write permission. Enter the token in BB's secret plugin setting on each computer. No Git checkout or paid service is required.

The plugin transfers theme selection, shortcut overrides, and selected navigation/interface settings. Install any referenced theme or interface plugin on each computer yourself. Window layouts, arbitrary plugin settings, thread-list grouping, chats, and credentials are not synchronized.

See the [setup guide](https://github.com/brudnyi/bb-sync#readme) for the complete scope and recovery behavior. `bb sync status` reports state, and `bb sync restore` restores the last local snapshot.
