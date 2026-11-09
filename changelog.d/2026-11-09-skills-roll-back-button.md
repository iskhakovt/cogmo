A live skill's deploy message carries ↩️ Roll back when the deploy was an edit (design/skills.md → Notifications and undo).

- The tap restores the version the deploy replaced through the forward rollback, with the tapper and the chat's conversation as its origin, like an approval.
- A deploy that a later deploy or rollback has replaced is refused with `skill_deploy_superseded`, checked again inside the rollback's transaction, so a stale message cannot undo newer code; when the live version is a rollback to that same version, as after a second tap, the tap reports it as already rolled back. A refused rollback is `skill_rollback_failed` with its reason, and keeps the buttons.
