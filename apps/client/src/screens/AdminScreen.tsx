import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  ASSIGNABLE_ROLES,
  AUDIT_ACTION_LABEL,
  BAN_LABEL,
  MOD_MAX_HOURS,
  REPORT_REASON_LABEL,
  REPORT_STATUS_LABEL,
  ROLE_LABEL,
  canRevoke,
  hasPermission,
  outranks,
  punishmentError,
  type AdminAuditEntry,
  type AdminAuditPage,
  type AdminBanView,
  type AdminMeResponse,
  type AdminOverview,
  type AdminReportDetail,
  type AdminReportView,
  type AdminUserDetail,
  type AdminUserRow,
  type BanInput,
  type BanTypeCode,
  type ReportReasonCode,
} from "@vanta/shared";
import { api } from "../api/client";
import { Button, useToast } from "../components/ui";
import { uiSound } from "../audio/ui-sound";
import { useAuth } from "../auth/AuthContext";

type Tab = "overview" | "reports" | "users" | "audit";
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR") : "—");
const STATUS_LABEL: Record<AdminUserRow["status"], string> = { ACTIVE: "Ativa", SUSPENDED: "Suspensa", BANNED: "Banida", DELETED: "Apagada" };
const DURATIONS: Array<[number, string]> = [[1, "1 hora"], [24, "1 dia"], [72, "3 dias"], [168, "7 dias"], [720, "30 dias"], [8760, "1 ano"]];

/** Painel administrativo: o que aparece depende do cargo; o servidor confere tudo de novo. */
export function AdminScreen() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("aba") as Tab) || "overview";
  const [me, setMe] = useState<AdminMeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needMfa, setNeedMfa] = useState(false);
  const [userId, setUserId] = useState<string | null>(params.get("jogador"));
  const [reportId, setReportId] = useState<string | null>(null);

  useEffect(() => {
    api.get<AdminMeResponse>("/admin/me").then(setMe).catch((e: Error & { code?: string }) => {
      setNeedMfa(e.code === "MFA_REQUIRED");
      setError(e.message);
    });
  }, []);

  const go = (t: Tab) => {
    uiSound.click();
    setUserId(null);
    setReportId(null);
    setParams({ aba: t }, { replace: true });
  };
  const openUser = (id: string) => {
    setReportId(null);
    setUserId(id);
    setParams({ aba: "users", jogador: id }, { replace: true });
  };

  if (error) return <div className="screen play-screen"><div className="play-wrap"><p className="error" data-testid="admin-denied">{error}</p><div className="row-gap">{needMfa && <Button onClick={() => navigate("/seguranca")} data-testid="admin-setup-mfa">Ligar a verificação em duas etapas</Button>}<Button variant="ghost" onClick={() => navigate("/menu")}>Voltar ao menu</Button></div></div></div>;
  if (!me) return <div className="screen play-screen"><div className="play-wrap"><p className="muted">Carregando…</p></div></div>;

  return (
    <div className="screen play-screen admin-screen" data-testid="admin-screen">
      <div className="play-wrap stagger">
        <div className="play-head"><Button variant="ghost" onClick={() => navigate("/menu")}>← Menu</Button><span className="chip panel cut cut-sm" data-testid="admin-role">{ROLE_LABEL[me.role]}</span></div>
        <h1>Painel administrativo</h1>
        <div className="tabs" role="tablist">
          {([["overview", "Visão geral"], ["reports", "Denúncias"], ["users", "Jogadores"], ["audit", "Auditoria"]] as Array<[Tab, string]>).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => go(k)} data-testid={`admin-tab-${k}`}>{l}</button>
          ))}
        </div>
        {tab === "overview" && <Overview onUser={openUser} />}
        {tab === "reports" && (reportId ? <ReportDetail me={me} id={reportId} onBack={() => setReportId(null)} onUser={openUser} /> : <Reports onOpen={setReportId} />)}
        {tab === "users" && (userId ? <UserDetail me={me} id={userId} onBack={() => { setUserId(null); setParams({ aba: "users" }, { replace: true }); }} /> : <Users onOpen={openUser} />)}
        {tab === "audit" && <Audit me={me} onUser={openUser} />}
      </div>
    </div>
  );
}

function Overview({ onUser }: { onUser: (id: string) => void }) {
  const [o, setO] = useState<AdminOverview | null>(null);
  useEffect(() => void api.get<AdminOverview>("/admin/overview").then(setO).catch(() => undefined), []);
  if (!o) return <p className="muted">Carregando…</p>;
  const tiles: Array<[string, number, string]> = [["Contas", o.users, "admin-stat-users"], ["Novas em 24 h", o.newUsers24h, "admin-stat-new"], ["Partidas em 24 h", o.matches24h, "admin-stat-matches"], ["Denúncias pendentes", o.openReports, "admin-stat-reports"], ["Punições em vigor", o.activeBans, "admin-stat-bans"]];
  return (
    <>
      <div className="admin-tiles">
        {tiles.map(([l, v, id]) => <div key={l} className="panel cut admin-tile"><span className="label">{l}</span><strong data-testid={id}>{v.toLocaleString("pt-BR")}</strong></div>)}
      </div>
      <div className="panel cut room-list-panel">
        <h3 className="label">Últimas ações</h3>
        <AuditTable entries={o.recentAudit} onUser={onUser} />
      </div>
    </>
  );
}

// ───────── Denúncias ─────────

function Reports({ onOpen }: { onOpen: (id: string) => void }) {
  const [status, setStatus] = useState("PENDING");
  const [rows, setRows] = useState<AdminReportView[] | null>(null);
  useEffect(() => {
    setRows(null);
    api.get<{ reports: AdminReportView[] }>(`/admin/reports?status=${status}`).then((r) => setRows(r.reports)).catch(() => setRows([]));
  }, [status]);
  return (
    <>
      <div className="row-gap">
        {([["PENDING", "Pendentes"], ["ACTION_TAKEN", "Ação tomada"], ["DISMISSED", "Arquivadas"]] as const).map(([k, l]) => <button key={k} className={`btn-mini ${status === k ? "" : "ghost"}`} onClick={() => setStatus(k)} data-testid={`reports-filter-${k}`}>{l}</button>)}
      </div>
      <div className="panel cut room-list-panel">
        {!rows ? <p className="muted">Carregando…</p> : rows.length === 0 ? <p className="muted" data-testid="reports-empty">Nenhuma denúncia aqui.</p> : (
          <table className="room-table" data-testid="reports-table">
            <thead><tr><th>Quando</th><th>Denunciado</th><th>Motivo</th><th>Por</th><th>Situação</th><th /></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} data-testid={`report-${r.reported.username}`}>
                <td className="small">{when(r.createdAt)}</td><td>{r.reported.username}</td><td>{REPORT_REASON_LABEL[r.reason as ReportReasonCode] ?? r.reason}</td><td className="muted">{r.reporter.username}</td>
                <td>{REPORT_STATUS_LABEL[r.status]}{r.handledBy && <span className="muted small"> · {r.handledBy}</span>}</td>
                <td><button className="btn-mini" onClick={() => onOpen(r.id)} data-testid={`report-open-${r.reported.username}`}>Abrir</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}

function ReportDetail({ me, id, onBack, onUser }: { me: AdminMeResponse; id: string; onBack: () => void; onUser: (id: string) => void }) {
  const toast = useToast();
  const [r, setR] = useState<AdminReportDetail | null>(null);
  const [resolution, setResolution] = useState("");
  const [punish, setPunish] = useState<BanInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api.get<AdminReportDetail>(`/admin/reports/${id}`).then(setR).catch((e: Error) => setErr(e.message)), [id]);
  useEffect(() => void load(), [load]);
  if (!r) return <p className="muted">{err ?? "Carregando…"}</p>;
  const closed = r.status === "ACTION_TAKEN" || r.status === "DISMISSED";
  const canAct = hasPermission(me.role, "reports.handle") && outranks(me.role, r.reported.role);

  const resolve = async (status: "IN_REVIEW" | "ACTION_TAKEN" | "DISMISSED") => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/admin/reports/${id}/resolve`, { status, resolution: resolution || undefined, ban: status === "ACTION_TAKEN" && punish ? punish : undefined });
      uiSound.success();
      toast("Denúncia atualizada", status === "IN_REVIEW" ? "Marcada como em análise." : REPORT_STATUS_LABEL[status] ?? status);
      if (status === "IN_REVIEW") void load();
      else onBack();
    } catch (e) {
      setErr((e as Error).message);
      uiSound.error();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-detail" data-testid="report-detail">
      <Button variant="ghost" onClick={onBack}>← Denúncias</Button>
      <div className="panel cut room-list-panel">
        <h2>{REPORT_REASON_LABEL[r.reason as ReportReasonCode] ?? r.reason} · <button className="link-btn" onClick={() => onUser(r.reported.id)} data-testid="report-reported">{r.reported.username}</button></h2>
        <p className="muted small">Denunciado por {r.reporter.username} em {when(r.createdAt)} · {REPORT_STATUS_LABEL[r.status]}{r.handledBy ? ` por ${r.handledBy}` : ""}</p>
        {r.description && <blockquote className="admin-quote">“{r.description}”</blockquote>}
        <p className="small">Denúncias anteriores contra este jogador: <b data-testid="report-prior">{r.priorReports}</b>{r.activeBans.length > 0 && <> · Em vigor: {r.activeBans.map((b) => BAN_LABEL[b.type]).join(", ")}</>}</p>
        {r.matchId && (
          <>
            <h3 className="label">Chat do denunciado na partida (gravado pelo servidor)</h3>
            {r.chat.length === 0 ? <p className="muted small">Ele não escreveu nada nessa partida.</p> : (
              <ul className="admin-chat" data-testid="report-chat">{r.chat.map((c, i) => <li key={i}><span className="muted small">R{c.round} · {c.channel === "team" ? "equipe" : "todos"}</span> {c.text}</li>)}</ul>
            )}
          </>
        )}
        {r.resolution && <p className="small">Resolução: {r.resolution}</p>}
      </div>
      {!closed && canAct && (
        <div className="panel cut room-list-panel">
          <h3 className="label">Tratar</h3>
          <textarea className="input" rows={2} maxLength={500} placeholder="Resolução (o que foi verificado e decidido)" value={resolution} onChange={(e) => setResolution(e.target.value)} data-testid="report-resolution" />
          <label className="row-gap small"><input type="checkbox" checked={!!punish} onChange={(e) => setPunish(e.target.checked ? { type: "CHAT_MUTE", reason: resolution || "", hours: 24 } : null)} data-testid="report-punish" /> Aplicar punição junto</label>
          {punish && <PunishFields me={me} value={punish} onChange={setPunish} />}
          {err && <p className="error" data-testid="report-error">{err}</p>}
          <div className="row-gap">
            <Button loading={busy} onClick={() => resolve("ACTION_TAKEN")} data-testid="report-action">Ação tomada</Button>
            <Button variant="ghost" loading={busy} onClick={() => resolve("DISMISSED")} data-testid="report-dismiss">Arquivar</Button>
            {r.status === "OPEN" && <Button variant="ghost" loading={busy} onClick={() => resolve("IN_REVIEW")} data-testid="report-review">Em análise</Button>}
          </div>
        </div>
      )}
      {!closed && !canAct && <p className="muted small">Você não pode tratar denúncias contra contas do mesmo cargo ou acima.</p>}
    </div>
  );
}

/** Tipo, prazo e motivo, só com as opções que o cargo pode usar. */
function PunishFields({ me, value, onChange }: { me: AdminMeResponse; value: BanInput; onChange: (b: BanInput) => void }) {
  const types = (Object.keys(BAN_LABEL) as BanTypeCode[]).filter((t) => punishmentError(me.role, t, t === "PERMANENT" ? null : 1) === null);
  const durations = DURATIONS.filter(([h]) => me.role !== "MODERATOR" || h <= (MOD_MAX_HOURS[value.type] ?? Infinity));
  const err = punishmentError(me.role, value.type, value.hours);
  return (
    <div className="punish-fields">
      <select className="input" value={value.type} onChange={(e) => { const type = e.target.value as BanTypeCode; onChange({ ...value, type, hours: type === "PERMANENT" ? null : value.hours ?? 24 }); }} data-testid="punish-type">
        {types.map((t) => <option key={t} value={t}>{BAN_LABEL[t]}</option>)}
      </select>
      {value.type !== "PERMANENT" && (
        <select className="input" value={value.hours ?? 24} onChange={(e) => onChange({ ...value, hours: Number(e.target.value) })} data-testid="punish-hours">
          {durations.map(([h, l]) => <option key={h} value={h}>{l}</option>)}
        </select>
      )}
      <input className="input" maxLength={300} placeholder="Motivo (o jogador vê este texto)" value={value.reason} onChange={(e) => onChange({ ...value, reason: e.target.value })} data-testid="punish-reason" />
      {err && <p className="error small">{err}</p>}
    </div>
  );
}

// ───────── Jogadores ─────────

function Users({ onOpen }: { onOpen: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("ALL");
  const [rows, setRows] = useState<AdminUserRow[] | null>(null);
  const search = useCallback(() => {
    api.get<{ users: AdminUserRow[] }>(`/admin/users?q=${encodeURIComponent(q)}&status=${status}`).then((r) => setRows(r.users)).catch(() => setRows([]));
  }, [q, status]);
  useEffect(() => { search(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <form className="row-gap" onSubmit={(e) => { e.preventDefault(); search(); }}>
        <input className="input" placeholder="Nome do jogador (admin: também e-mail)" value={q} onChange={(e) => setQ(e.target.value)} data-testid="users-search" />
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)} data-testid="users-status">
          <option value="ALL">Todas</option><option value="ACTIVE">Ativas</option><option value="SUSPENDED">Suspensas</option><option value="BANNED">Banidas</option>
        </select>
        <Button type="submit" data-testid="users-search-btn">Buscar</Button>
      </form>
      <div className="panel cut room-list-panel">
        {!rows ? <p className="muted">Carregando…</p> : rows.length === 0 ? <p className="muted">Ninguém encontrado.</p> : (
          <table className="room-table" data-testid="users-table">
            <thead><tr><th>Jogador</th><th>Cargo</th><th>Conta</th><th>Nível</th><th>Denúncias</th><th>Visto</th><th /></tr></thead>
            <tbody>{rows.map((u) => (
              <tr key={u.id} data-testid={`user-row-${u.username}`}>
                <td>{u.username}</td><td>{ROLE_LABEL[u.role]}</td><td className={u.status === "ACTIVE" ? "" : "error"}>{STATUS_LABEL[u.status]}</td><td>{u.level}</td>
                <td>{u.openReports || "—"}</td><td className="small muted">{when(u.lastSeenAt)}</td>
                <td><button className="btn-mini" onClick={() => onOpen(u.id)} data-testid={`user-open-${u.username}`}>Ficha</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}

function UserDetail({ me, id, onBack }: { me: AdminMeResponse; id: string; onBack: () => void }) {
  const toast = useToast();
  const { me: self } = useAuth();
  const [u, setU] = useState<AdminUserDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [punish, setPunish] = useState<BanInput>({ type: "CHAT_MUTE", reason: "", hours: 24 });
  const [role, setRole] = useState<string>("");
  const [roleReason, setRoleReason] = useState("");
  const [items, setItems] = useState<Array<{ id: string; name: string; type: string }>>([]);
  const [grant, setGrant] = useState({ storeItemId: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const [mfaReason, setMfaReason] = useState("");
  const [revokeFor, setRevokeFor] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const load = useCallback(() => api.get<AdminUserDetail>(`/admin/users/${id}`).then((d) => { setU(d); setRole(d.role); }).catch((e: Error) => setErr(e.message)), [id]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (hasPermission(me.role, "items.grant")) void api.get<{ items: Array<{ id: string; name: string; type: string }> }>("/admin/items").then((r) => setItems(r.items)).catch(() => undefined);
  }, [me.role]);
  if (!u) return <p className="muted">{err ?? "Carregando…"}</p>;
  const isSelf = self?.user.id === u.id;
  const canTouch = !isSelf && outranks(me.role, u.role);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      uiSound.success();
      toast("Feito", ok);
      await load();
    } catch (e) {
      setErr((e as Error).message);
      uiSound.error();
    } finally {
      setBusy(false);
    }
  };
  const revoke = (b: AdminBanView) => {
    void act(() => api.post(`/admin/bans/${b.id}/revoke`, { reason: revokeReason }), `${BAN_LABEL[b.type]} revogada.`).then(() => { setRevokeFor(null); setRevokeReason(""); });
  };

  return (
    <div className="admin-detail" data-testid="user-detail">
      <Button variant="ghost" onClick={onBack}>← Jogadores</Button>
      <div className="panel cut room-list-panel">
        <h2 data-testid="user-name">{u.username} <span className="muted small">{ROLE_LABEL[u.role]} · nível {u.level}</span></h2>
        <p className="small">Conta: <b className={u.status === "ACTIVE" ? "" : "error"} data-testid="user-status">{STATUS_LABEL[u.status]}</b> · E-mail: <span data-testid="user-email">{u.email}</span> {u.emailVerified ? "(verificado)" : "(não verificado)"} · Verificação em duas etapas: <b data-testid="user-mfa">{u.mfaEnabled ? "ligada" : "desligada"}</b></p>
        {u.mfaEnabled && canTouch && hasPermission(me.role, "roles.manage") && (
          <span className="row-gap">
            <input className="input" placeholder="Motivo (identidade confirmada como?)" value={mfaReason} onChange={(e) => setMfaReason(e.target.value)} data-testid="mfa-reset-reason" />
            <button className="btn-mini ghost" disabled={busy || mfaReason.trim().length < 5} onClick={() => void act(() => api.post(`/admin/users/${u.id}/mfa/reset`, { reason: mfaReason }), "Verificação desligada; a pessoa entra só com a senha e pode ligar de novo.").then(() => setMfaReason(""))} data-testid="mfa-reset">Desligar verificação (perdeu o celular)</button>
          </span>
        )}
        <p className="small muted">Criada em {when(u.createdAt)} · vista em {when(u.lastSeenAt)} · saldo {u.balance.toLocaleString("pt-BR")} VC · {u.stats.matchesPlayed} partidas ({u.stats.wins}V/{u.stats.losses}D) · {u.stats.kills}/{u.stats.deaths} K/D</p>
        <Link to={`/jogador/${encodeURIComponent(u.username)}`} className="small">Ver perfil público</Link>
      </div>

      <div className="panel cut room-list-panel">
        <h3 className="label">Punições</h3>
        {u.bans.length === 0 ? <p className="muted small">Nenhuma.</p> : (
          <table className="room-table" data-testid="user-bans">
            <thead><tr><th>Tipo</th><th>Motivo</th><th>Por</th><th>Até</th><th /></tr></thead>
            <tbody>{u.bans.map((b) => (
              <tr key={b.id} className={b.active ? "" : "muted"} data-testid={`ban-${b.type}`}>
                <td>{BAN_LABEL[b.type]}</td><td>{b.reason}</td><td>{b.issuedBy ?? "—"}</td>
                <td className="small">{b.revokedAt ? `revogada ${when(b.revokedAt)}` : b.endsAt ? when(b.endsAt) : "permanente"}</td>
                <td>{b.active && canTouch && canRevoke(me.role, b.type) && (revokeFor === b.id ? (
                  <span className="row-gap">
                    <input className="input" placeholder="Motivo da revogação" value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)} data-testid="revoke-reason" />
                    <button className="btn-mini" disabled={busy || revokeReason.trim().length < 5} onClick={() => revoke(b)} data-testid="revoke-confirm">Confirmar</button>
                  </span>
                ) : <button className="btn-mini ghost" disabled={busy} onClick={() => setRevokeFor(b.id)} data-testid={`ban-revoke-${b.type}`}>Revogar</button>)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
        {canTouch ? (
          <>
            <PunishFields me={me} value={punish} onChange={setPunish} />
            {err && <p className="error" data-testid="user-error">{err}</p>}
            <Button loading={busy} onClick={() => act(() => api.post(`/admin/users/${u.id}/bans`, punish), `${BAN_LABEL[punish.type]} aplicada.`)} data-testid="punish-apply">Aplicar punição</Button>
          </>
        ) : <p className="muted small">{isSelf ? "Esta é a sua conta." : "Conta de cargo igual ou maior que o seu: só quem está acima pode agir."}</p>}
      </div>

      {u.reports.length > 0 && (
        <div className="panel cut room-list-panel">
          <h3 className="label">Denúncias contra</h3>
          <table className="room-table"><tbody>{u.reports.map((r) => <tr key={r.id}><td className="small">{when(r.createdAt)}</td><td>{REPORT_REASON_LABEL[r.reason as ReportReasonCode] ?? r.reason}</td><td className="muted">{r.reporter.username}</td><td>{REPORT_STATUS_LABEL[r.status]}</td></tr>)}</tbody></table>
        </div>
      )}

      {hasPermission(me.role, "roles.manage") && canTouch && (
        <div className="panel cut room-list-panel">
          <h3 className="label">Cargo</h3>
          <div className="row-gap">
            <select className="input" value={role} onChange={(e) => setRole(e.target.value)} data-testid="role-select">{ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select>
            <input className="input" placeholder="Motivo" value={roleReason} onChange={(e) => setRoleReason(e.target.value)} data-testid="role-reason" />
            <Button disabled={role === u.role} loading={busy} onClick={() => act(() => api.put(`/admin/users/${u.id}/role`, { role, reason: roleReason }), `Agora é ${ROLE_LABEL[role as keyof typeof ROLE_LABEL]}.`)} data-testid="role-save">Salvar cargo</Button>
          </div>
        </div>
      )}

      {hasPermission(me.role, "items.grant") && u.status !== "DELETED" && (
        <div className="panel cut room-list-panel">
          <h3 className="label">Conceder item (compensação)</h3>
          <div className="row-gap">
            <select className="input" value={grant.storeItemId} onChange={(e) => setGrant({ ...grant, storeItemId: e.target.value })} data-testid="grant-item"><option value="">Escolha um item</option>{items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
            <input className="input" placeholder="Motivo" value={grant.reason} onChange={(e) => setGrant({ ...grant, reason: e.target.value })} data-testid="grant-reason" />
            <Button disabled={!grant.storeItemId} loading={busy} onClick={() => act(() => api.post(`/admin/users/${u.id}/grant`, grant), "Item concedido.")} data-testid="grant-save">Conceder</Button>
          </div>
        </div>
      )}

      {u.recentMatches.length > 0 && (
        <div className="panel cut room-list-panel">
          <h3 className="label">Últimas partidas</h3>
          <table className="room-table"><tbody>{u.recentMatches.map((m) => <tr key={m.matchId}><td className="small">{when(m.endedAt)}</td><td>{m.mode}</td><td>{m.type}</td><td>{m.result ?? "—"}</td><td>{m.kills}/{m.deaths}</td></tr>)}</tbody></table>
        </div>
      )}
    </div>
  );
}

// ───────── Auditoria ─────────

function Audit({ me, onUser }: { me: AdminMeResponse; onUser: (id: string) => void }) {
  const [action, setAction] = useState("");
  const [entries, setEntries] = useState<AdminAuditEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const load = useCallback(async (more = false) => {
    const qs = new URLSearchParams({ limit: "30" });
    if (action) qs.set("action", action);
    if (more && cursor) qs.set("cursor", cursor);
    const page = await api.get<AdminAuditPage>(`/admin/audit?${qs}`);
    setEntries((prev) => (more && prev ? [...prev, ...page.entries] : page.entries));
    setCursor(page.nextCursor);
  }, [action, cursor]);
  useEffect(() => { void load(); }, [action]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="row-gap">
        <select className="input" value={action} onChange={(e) => setAction(e.target.value)} data-testid="audit-action">
          <option value="">Todas as ações</option>
          {Object.entries(AUDIT_ACTION_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {!hasPermission(me.role, "audit.viewAll") && <span className="muted small">Moderador vê só as próprias ações.</span>}
      </div>
      <div className="panel cut room-list-panel">
        <p className="muted small">O registro só aceita novas linhas: o banco recusa alterar ou apagar.</p>
        {!entries ? <p className="muted">Carregando…</p> : <AuditTable entries={entries} onUser={onUser} />}
        {cursor && <Button variant="ghost" onClick={() => void load(true)} data-testid="audit-more">Carregar mais</Button>}
      </div>
    </>
  );
}

function summary(e: AdminAuditEntry): string {
  const a = (e.after ?? {}) as Record<string, unknown>;
  const b = (e.before ?? {}) as Record<string, unknown>;
  switch (e.action) {
    case "ban.create": return `${BAN_LABEL[a.type as BanTypeCode] ?? a.type}${a.hours ? ` · ${a.hours} h` : a.type === "PERMANENT" ? "" : ""} · ${a.reason ?? ""}`;
    case "ban.revoke": return `${BAN_LABEL[b.type as BanTypeCode] ?? b.type} · ${a.reason ?? ""}`;
    case "report.resolve": return `${REPORT_STATUS_LABEL[a.status as string] ?? a.status}${a.resolution ? ` · ${a.resolution}` : ""}`;
    case "role.set": return `${ROLE_LABEL[b.role as keyof typeof ROLE_LABEL] ?? b.role} → ${ROLE_LABEL[a.role as keyof typeof ROLE_LABEL] ?? a.role} · ${a.reason ?? ""}`;
    case "wallet.adjust": return `${Number(a.amount) > 0 ? "+" : ""}${a.amount} VC · ${a.reason ?? ""}`;
    case "item.grant": return `${a.item ?? ""} · ${a.reason ?? ""}`;
    default: return "";
  }
}

function AuditTable({ entries, onUser }: { entries: AdminAuditEntry[]; onUser: (id: string) => void }) {
  if (entries.length === 0) return <p className="muted small" data-testid="audit-empty">Nenhuma ação registrada.</p>;
  return (
    <table className="room-table" data-testid="audit-table">
      <thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Alvo</th><th>Detalhes</th></tr></thead>
      <tbody>{entries.map((e) => (
        <tr key={e.id} data-testid={`audit-${e.action}`}>
          <td className="small">{when(e.createdAt)}</td>
          <td>{e.actor.username} <span className="muted small">{ROLE_LABEL[e.actor.role]}</span></td>
          <td>{AUDIT_ACTION_LABEL[e.action] ?? e.action}</td>
          <td>{e.targetType === "User" && e.targetId ? <button className="link-btn" onClick={() => onUser(e.targetId!)}>{e.targetLabel ?? e.targetId}</button> : <span className="muted small">{e.targetType}</span>}</td>
          <td className="small">{summary(e)}{e.ip && <span className="muted"> · {e.ip}</span>}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}
