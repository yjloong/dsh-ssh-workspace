# Changelog

## 1.0.1 — 2026-10-20

- Fix permanent "client shut down" failures after the remote machine reboots or the SSH transport drops. The per-host AHP connection is now supervised: a closed connection triggers a single-flight transparent reconnect, and tool calls join the fresh attempt instead of failing forever (previously only a DSH restart recovered the workspace).
- A failed initial connection is also healed by the next call, with reconnect attempts wrapped in a diagnostic that preserves the original cause.

## 1.0.0 — 2026-10-12

Initial ahian-lee distribution, derived from Yan-Zero/dsh-remote-ssh 0.2.4.

- Adapt settings persistence to current Desktop APIs; defer removed legacy API imports.
- Implement the current shell execute/result handle while preserving sandboxed local execution.
- Keep local providers in a private service group and route remote files, subprocesses, shell and search by workspace.
- Restore the native local folder picker and integrate local/remote choices with current single-slot priorities.
- Add SSH host creation inside the workspace picker and retain Settings → Remote SSH management.
- Fix unreadable primary button colors and explain disabled empty-path creation.
- Preserve default permissions; reject remote shell requests whose restrictive policy cannot be enforced.
- Support an existing remote ripgrep binary outside PATH through remoteRgCommand.
- Rename the installable package to dsh-ssh-workspace; retain existing remote-ssh catalog paths for migration.
- Include compiled modules, source, Apache-2.0 attribution, bilingual docs and a version-free release asset.

Only the Windows Desktop / POSIX remote workspace mode is supported in this release. Retained upstream TUI and full-backend code is not advertised as compatible.
