import type { EvolutionEventEntry, ScheduledTaskSummary } from "@cogmo/contracts";
import { useState } from "react";
import { api } from "../orpc.js";
import {
  Drawer,
  EmptyRow,
  fmtDateTime,
  PanelResource,
  Pill,
  Screen,
  table,
  td,
  tdMono,
  th,
  trHover,
} from "./screen-kit.js";
import { useResource } from "./use-resource.js";

/** SYSTEM — scheduled tasks and the "what it learned" evolution audit (read-only). */
export function SystemScreen() {
  const [selected, setSelected] = useState<EvolutionEventEntry | null>(null);
  return (
    <Screen title="System">
      <SchedulingPanel />
      <EvolutionPanel onSelect={setSelected} />
      {selected ? (
        <Drawer title={`event ${selected.id.slice(0, 8)}`} onClose={() => setSelected(null)}>
          <EvolutionDetail event={selected} />
        </Drawer>
      ) : null}
    </Screen>
  );
}

function SchedulingPanel() {
  const state = useResource(() => api.scheduling.list(), []);
  return (
    <PanelResource title="Scheduled tasks" state={state}>
      {(tasks) => (
        <table className={table}>
          <thead>
            <tr>
              <th className={th}>Kind</th>
              <th className={th}>Schedule</th>
              <th className={th}>Prompt</th>
              <th className={th}>Timezone</th>
              <th className={th}>Next run</th>
              <th className={th}>Last run</th>
              <th className={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 ? <EmptyRow colSpan={7} label="No scheduled tasks." /> : null}
            {tasks.map((t: ScheduledTaskSummary) => (
              <tr key={t.id} className={trHover}>
                <td className={tdMono}>{t.kind}</td>
                <td className={tdMono}>{t.cron ?? "one-off"}</td>
                <td className={`${td} max-w-sm truncate`} title={t.prompt}>
                  {t.prompt}
                </td>
                <td className={tdMono}>{t.timezone}</td>
                <td className={tdMono}>{fmtDateTime(t.nextRunAt)}</td>
                <td className={tdMono}>{fmtDateTime(t.lastRunAt)}</td>
                <td className={td}>
                  {t.enabled ? <Pill tone="ok">enabled</Pill> : <Pill tone="muted">paused</Pill>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PanelResource>
  );
}

function EvolutionPanel({ onSelect }: { onSelect: (event: EvolutionEventEntry) => void }) {
  const state = useResource(() => api.evolution.listEvents(), []);
  return (
    <PanelResource title="Evolution audit" state={state}>
      {(events) => (
        <table className={table}>
          <thead>
            <tr>
              <th className={th}>When</th>
              <th className={th}>Trigger</th>
              <th className={th}>Rules ±</th>
              <th className={th}>Memories</th>
              <th className={th}>Messages</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 ? <EmptyRow colSpan={5} label="No evolution events yet." /> : null}
            {events.map((e: EvolutionEventEntry) => (
              <tr key={e.id} className={`${trHover} cursor-pointer`} onClick={() => onSelect(e)}>
                <td className={tdMono}>{fmtDateTime(e.createdAt)}</td>
                <td className={tdMono}>{e.triggeredBy}</td>
                <td className={tdMono}>
                  +{e.payload.corrections.extracted} / ↻{e.payload.corrections.reinforced} / ↑
                  {e.payload.corrections.promoted}
                </td>
                <td className={tdMono}>{e.payload.memories.extracted}</td>
                <td className={tdMono}>{e.payload.messageCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PanelResource>
  );
}

function EvolutionDetail({ event }: { event: EvolutionEventEntry }) {
  const { corrections: c, consolidation, memories, drained } = event.payload;
  return (
    <dl className="flex flex-col gap-4 font-mono text-xs">
      <Field label="conversation" value={event.conversationId} />
      <Field label="profile" value={event.payload.profileId} />
      <Field label="created" value={fmtDateTime(event.createdAt)} />
      {event.payload.durationMs !== undefined ? (
        <Field label="duration" value={`${event.payload.durationMs} ms`} />
      ) : null}
      <Group title="corrections">
        <Field label="extracted" value={c.extracted} />
        <Field label="reinforced" value={c.reinforced} />
        <Field label="contradictions" value={c.contradictions} />
        <Field label="promoted" value={c.promoted} />
        <Field label="out-of-scope skipped" value={c.outOfScopeReinforcementsSkipped} />
        <Field label="unknown-rule skipped" value={c.unknownRuleReinforcementsSkipped} />
        <Field label="consolidation needed" value={String(c.consolidationNeeded)} />
      </Group>
      {consolidation ? (
        <Group title="consolidation">
          <Field label="merged groups" value={consolidation.mergedGroups} />
          <Field label="rules removed" value={consolidation.rulesRemoved} />
        </Group>
      ) : null}
      <Group title="memories">
        <Field label="extracted" value={memories.extracted} />
        <NetworkField byNetwork={memories.byNetwork} />
      </Group>
      <Group title="drained">
        <Field label="drained" value={drained.drained} />
        <NetworkField byNetwork={drained.byNetwork} />
      </Group>
    </dl>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-line pt-3">
      <div className="text-[10px] uppercase tracking-[0.12em] text-faint">{title}</div>
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="truncate text-ink">{value}</dd>
    </div>
  );
}

function NetworkField({ byNetwork }: { byNetwork: Record<string, number> }) {
  const entries = Object.entries(byNetwork);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([net, n]) => (
        <span key={net} className="rounded bg-sunk px-1.5 py-0.5 text-faint">
          {net}: {n}
        </span>
      ))}
    </div>
  );
}
