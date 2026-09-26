The pending-memory drain retains each staged row with its row id as the Hindsight document id, so a row that a failed delete left pending is replaced, not duplicated, when the next Observer fire retains it again.

The `evolution_events` payload records the Observer phases that failed after their retries (`failedPhases`), so a failed phase reads differently from one that found nothing; `/learned` and the web cockpit's evolution table show them. Older rows lack the field and render as before.
