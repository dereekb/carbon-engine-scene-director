# Git handoff: Finish auto camera shot rules on dbxpc: verify-page and floor calibration

A dbx-claude git-handoff thread: a message-only branch (never merged) carrying one queue item's work from **Michelles-MacBook-Air** to **dbxpc**. The code lands on `dbx-claude/work/finish-auto-camera-shot-rules-on-dbxpc-verify-page-and-floor-calibration`.

- **State:** sent (round 1)
- **Next:** dbxpc works the task and posts a `result`
- **Base:** `develop` @ `fe933bf`
- **On done:** parked for review

## Messages

| seq | kind | from | at |
| --- | --- | --- | --- |
| 0001 | task | Michelles-MacBook-Air | 2026-10-24T23:06:55.820Z |

## By hand

- On dbxpc: `dbx-claude run --git-handoffs` (or `dbx-claude handoff check`) claims the task, imports it into the queue and posts the result when it closes.
- On Michelles-MacBook-Air: the same pass applies the result. `dbx-claude handoff list` shows every thread; `dbx-claude handoff recall <id>` takes the work back.
- The task is `messages/0001-task.md` (a later `task` revises it); attachments sit in `messages/<seq>/`.
