---

name: bb-sync
description: Inspect or run bb-sync preference synchronization through a private GitHub repository.
---

Use `bb sync status --json` to inspect configuration, sync state, conflicts, unsupported fields, and snapshot availability. `bb sync now --json` performs one two-way synchronization even when automatic sync is off.

Conflicts require the user's choice in the bb-sync page; never choose a winning computer without instructions. Do not clear the baseline or delete the remote file to bypass a conflict.

`bb sync restore --json` restores the last local snapshot and pauses automatic sync. Use only when the user requests restoring settings. It does not change GitHub.

Configure repository, branch, file, scope, and interval under Settings → Installed plugins → bb-sync. Enter tokens only in BB's native secret settings form. Never read, print, or embed the token in shell arguments, exported JSON, or chat. The preferences repository must be private and separate from the plugin's source repository.
