# Git handoff: Battle console EVE-data checks on dbxpc (tools-core): full verify-page, real scenario, GPU look, kill checks

A dbx-claude git-handoff thread: a message-only branch (never merged) carrying one queue item's work from **Michelles-MacBook-Air** to **dbxpc**. The code lands on `dbx-claude/work/battle-console-eve-data-checks-on-dbxpc-tools-core-full-verify-page-real-scenari`.

- **State:** sent (round 1)
- **Next:** dbxpc works the task and posts a `result`
- **Base:** `develop` @ `bff0fff`
- **On done:** parked for review

## Messages

| seq | kind | from | at |
| --- | --- | --- | --- |
| 0001 | task | Michelles-MacBook-Air | 2026-10-24T20:20:42.594Z |

## By hand

- On dbxpc: `dbx-claude run --git-handoffs` (or `dbx-claude handoff check`) claims the task, imports it into the queue and posts the result when it closes.
- On Michelles-MacBook-Air: the same pass applies the result. `dbx-claude handoff list` shows every thread; `dbx-claude handoff recall <id>` takes the work back.
- The task is `messages/0001-task.md` (a later `task` revises it); attachments sit in `messages/<seq>/`.
