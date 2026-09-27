The pending-memory drain retains each staged row under its row id as the Hindsight document id, so when a failed delete leaves a row pending, the next fire's repeat retain finds no changed chunk, keeps the facts already extracted and relabels them with its tags and metadata, leaving one copy of the fact.

The `evolution_events` payload records the Observer phases that failed after their retries (`failedPhases`), so a failed phase reads differently from one that found nothing; `/learned` and the web cockpit's evolution table show them. Older rows lack the field and render as before.
