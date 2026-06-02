import type { McpServerSummary, Profile, SkillListEntry } from "@cogmo/contracts";
import { api } from "../orpc.js";
import {
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

/** AGENT — profiles, models, MCP servers, and the skills library (read-only). */
export function AgentScreen() {
  return (
    <Screen title="Agent">
      <ProfilesPanel />
      <ModelsPanel />
      <McpPanel />
      <SkillsPanel />
    </Screen>
  );
}

function ProfilesPanel() {
  const state = useResource(() => api.profiles.list(), []);
  return (
    <PanelResource title="Profiles" state={state}>
      {(profiles) => (
        <table className={table}>
          <thead>
            <tr>
              <th className={th}>Name</th>
              <th className={th}>Scope</th>
              <th className={th}>Model</th>
              <th className={th}>Auto-recall</th>
              <th className={th}>Voice</th>
              <th className={th}>Tools</th>
              <th className={th}>Class</th>
            </tr>
          </thead>
          <tbody>
            {profiles.length === 0 ? <EmptyRow colSpan={7} label="No profiles." /> : null}
            {profiles.map((p: Profile) => (
              <tr key={p.id} className={trHover}>
                <td className={td}>{p.name}</td>
                <td className={td}>
                  <Pill tone={p.userId === null ? "muted" : "ok"}>
                    {p.userId === null ? "org" : "user"}
                  </Pill>
                </td>
                <td className={tdMono}>{p.model}</td>
                <td className={tdMono}>{p.autoRecall}</td>
                <td className={tdMono}>{p.voiceMode}</td>
                <td className={tdMono}>{p.toolSet.length}</td>
                <td className={tdMono}>{p.profileClass ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PanelResource>
  );
}

function ModelsPanel() {
  const state = useResource(() => api.models.list(), []);
  return (
    <PanelResource title="Models" state={state}>
      {(models) =>
        models.length === 0 ? (
          <p className="text-sm text-muted">No selectable models.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {models.map((m) => (
              <span
                key={m}
                className="rounded border border-line bg-sunk px-2 py-1 font-mono text-xs text-muted"
              >
                {m}
              </span>
            ))}
          </div>
        )
      }
    </PanelResource>
  );
}

const MCP_APPROVAL_TONE = {
  approved: "ok",
  pending: "warn",
  needs_reapproval: "bad",
} as const;

function McpPanel() {
  const state = useResource(() => api.mcp.listServers(), []);
  return (
    <PanelResource title="MCP servers" state={state}>
      {(servers) => (
        <table className={table}>
          <thead>
            <tr>
              <th className={th}>Name</th>
              <th className={th}>Transport</th>
              <th className={th}>Status</th>
              <th className={th}>Tools</th>
              <th className={th}>Last connected</th>
              <th className={th}>Last error</th>
            </tr>
          </thead>
          <tbody>
            {servers.length === 0 ? <EmptyRow colSpan={6} label="No MCP servers." /> : null}
            {servers.map((s: McpServerSummary) => (
              <tr key={s.id} className={trHover}>
                <td className={td}>{s.name}</td>
                <td className={tdMono}>{s.transport}</td>
                <td className={td}>
                  <span className="flex items-center gap-1.5">
                    <Pill tone={MCP_APPROVAL_TONE[s.approvalStatus]}>{s.approvalStatus}</Pill>
                    {!s.enabled ? <Pill tone="muted">disabled</Pill> : null}
                  </span>
                </td>
                <td className={tdMono}>
                  {s.approvedToolCount}/{s.toolCount}
                </td>
                <td className={tdMono}>{fmtDateTime(s.lastConnectedAt)}</td>
                <td className={tdMono}>{s.lastError ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PanelResource>
  );
}

const SKILL_RISK_TONE = { auto: "ok", notify: "warn", approve: "bad" } as const;

function SkillsPanel() {
  const state = useResource(() => api.skills.list(), []);
  return (
    <PanelResource title="Skills" state={state}>
      {(skills) => (
        <table className={table}>
          <thead>
            <tr>
              <th className={th}>Name</th>
              <th className={th}>Tier</th>
              <th className={th}>Risk</th>
              <th className={th}>Status</th>
              <th className={th}>Commit</th>
            </tr>
          </thead>
          <tbody>
            {skills.length === 0 ? <EmptyRow colSpan={5} label="No skills." /> : null}
            {skills.map((s: SkillListEntry) => (
              <tr key={s.name} className={trHover}>
                <td className={td}>{s.name}</td>
                <td className={tdMono}>{s.tier}</td>
                <td className={td}>
                  <Pill tone={SKILL_RISK_TONE[s.riskTier]}>{s.riskTier}</Pill>
                </td>
                <td className={td}>
                  {s.disabled ? <Pill tone="muted">disabled</Pill> : <Pill tone="ok">enabled</Pill>}
                </td>
                <td className={tdMono}>{s.gitSha.slice(0, 8)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PanelResource>
  );
}
