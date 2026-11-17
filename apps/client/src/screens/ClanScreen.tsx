import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CLAN_COLORS, CLAN_MAX_MEMBERS, CLAN_ROLE_LABEL, CLAN_SHAPES, canManage, type ClanSummary, type ClanView, type MyClanResponse } from "@vanta/shared";
import { api, ApiError } from "../api/client";
import { Button, useToast } from "../components/ui";
import { ClanLogo } from "../components/Identity";
import { mapName } from "./RoomsScreen";
import { uiSound } from "../audio/ui-sound";
import { useAuth } from "../auth/AuthContext";

const RESULT = { WIN: "Vitória", LOSS: "Derrota", DRAW: "Empate" } as const;

function LogoPicker({ value, onChange, tag }: { value: string; onChange: (v: string) => void; tag: string }) {
  const [shape, color] = value.split(":");
  return (
    <div className="logo-picker">
      <ClanLogo logoKey={value} tag={tag || "TAG"} size={72} />
      <div>
        <div className="chips-row">{CLAN_SHAPES.map((s) => <button type="button" key={s} className={`btn-mini ghost ${s === shape ? "on" : ""}`} onClick={() => onChange(`${s}:${color}`)} data-testid={`logo-shape-${s}`}><ClanLogo logoKey={`${s}:${color}`} tag="" size={22} /></button>)}</div>
        <div className="chips-row">{Object.entries(CLAN_COLORS).map(([k, c]) => <button type="button" key={k} className={`swatch ${k === color ? "on" : ""}`} style={{ background: c }} aria-label={`Cor ${k}`} onClick={() => onChange(`${shape}:${k}`)} data-testid={`logo-color-${k}`} />)}</div>
      </div>
    </div>
  );
}

/** Clã do jogador (/cla) ou página pública de um clã (/cla/:tag). Permissões conferidas no servidor. */
export function ClanScreen() {
  const { tag } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { me } = useAuth();
  const [mine, setMine] = useState<MyClanResponse | null>(null);
  const [pub, setPub] = useState<ClanView | null>(null);
  const [list, setList] = useState<ClanSummary[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", tag: "", description: "", logoKey: "shield:blue", isOpen: true });
  const [inviteName, setInviteName] = useState("");
  const [desc, setDesc] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      if (tag) setPub(await api.get<ClanView>(`/clans/tag/${encodeURIComponent(tag)}`));
      else {
        const m = await api.get<MyClanResponse>("/clans/me");
        setMine(m);
        if (!m.clan) setList(await api.get<ClanSummary[]>("/clans"));
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [tag]);
  useEffect(() => void load(), [load]);

  const act = async <T,>(fn: () => Promise<T>, ok?: string) => {
    setBusy(true);
    try {
      const r = await fn();
      uiSound.success();
      if (ok) toast("Clã", ok);
      await load();
      return r;
    } catch (e) {
      uiSound.error();
      toast("Não deu certo", e instanceof ApiError ? e.message : "Tente de novo.");
    } finally {
      setBusy(false);
    }
  };

  const clan = tag ? pub : mine?.clan ?? null;
  const myRole = clan?.myRole ?? null;
  const myId = me?.user.id;

  const runSearch = async () => setList(await api.get<ClanSummary[]>(`/clans?q=${encodeURIComponent(search)}`).catch(() => []));

  return (
    <div className="screen play-screen">
      <div className="play-wrap stagger">
        <div className="play-head">
          <Button variant="ghost" onClick={() => (tag ? navigate(-1) : navigate("/menu"))}>← {tag ? "Voltar" : "Menu"}</Button>
          <Button variant="ghost" onClick={() => navigate("/ranking?aba=clans")}>Ranking de clãs</Button>
        </div>
        {error && <p className="error">{error}</p>}

        {!tag && mine && !mine.clan && (
          <>
            <h1>Clã</h1>
            {mine.invites.length > 0 && (
              <section className="panel cut clan-box" data-testid="clan-invites">
                <span className="label">Convites</span>
                {mine.invites.map((i) => (
                  <div key={i.id} className="clan-row" data-testid={`clan-invite-${i.clan.tag}`}>
                    <ClanLogo logoKey={i.clan.logoKey} tag={i.clan.tag} size={36} />
                    <div className="who"><strong>[{i.clan.tag}] {i.clan.name}</strong><span className="muted small">convite de {i.invitedBy} · {i.clan.members}/{CLAN_MAX_MEMBERS} membros</span></div>
                    <button className="btn-mini" disabled={busy} onClick={() => void act(() => api.post(`/clans/invites/${i.id}/accept`), `Bem-vindo ao [${i.clan.tag}]!`)} data-testid={`accept-clan-${i.clan.tag}`}>Aceitar</button>
                    <button className="btn-mini ghost" disabled={busy} onClick={() => void act(() => api.post(`/clans/invites/${i.id}/decline`))}>Recusar</button>
                  </div>
                ))}
              </section>
            )}
            <div className="clan-split">
              <form className="panel cut clan-create clan-box" onSubmit={(e) => { e.preventDefault(); void act(() => api.post("/clans", { ...form, description: form.description || undefined }), "Clã criado."); }} data-testid="clan-create">
                <span className="label">Criar clã</span>
                <label className="field"><span className="label">Nome</span><input className="input" value={form.name} maxLength={24} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="clan-name" /></label>
                <label className="field"><span className="label">Tag (2 a 5)</span><input className="input" value={form.tag} maxLength={5} onChange={(e) => setForm({ ...form, tag: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} data-testid="clan-tag" /></label>
                <label className="field"><span className="label">Descrição</span><textarea className="input" rows={2} maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
                <LogoPicker value={form.logoKey} tag={form.tag} onChange={(logoKey) => setForm({ ...form, logoKey })} />
                <label className="check"><input type="checkbox" checked={form.isOpen} onChange={(e) => setForm({ ...form, isOpen: e.target.checked })} data-testid="clan-open" /> Aberto (qualquer um entra; desmarcado, só por convite)</label>
                <Button type="submit" loading={busy} data-testid="clan-submit">Criar clã</Button>
              </form>
              <section className="panel cut clan-box">
                <span className="label">Procurar clãs</span>
                <form className="row-gap" onSubmit={(e) => { e.preventDefault(); void runSearch(); }}>
                  <input className="input" placeholder="Nome ou tag" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="clan-search" />
                  <button className="btn-mini" type="submit">Buscar</button>
                </form>
                {list.length === 0 ? <p className="muted small">Nenhum clã encontrado.</p> : list.map((c) => (
                  <div key={c.id} className="clan-row" data-testid={`clan-result-${c.tag}`}>
                    <ClanLogo logoKey={c.logoKey} tag={c.tag} size={36} />
                    <div className="who"><Link to={`/cla/${c.tag}`}><strong>[{c.tag}] {c.name}</strong></Link><span className="muted small">{c.points} pts · {c.members}/{CLAN_MAX_MEMBERS} · {c.isOpen ? "aberto" : "só convite"}</span></div>
                    {c.isOpen && <button className="btn-mini" disabled={busy || c.members >= CLAN_MAX_MEMBERS} onClick={() => void act(() => api.post(`/clans/${c.id}/join`), `Você entrou no [${c.tag}].`)} data-testid={`join-clan-${c.tag}`}>Entrar</button>}
                  </div>
                ))}
              </section>
            </div>
          </>
        )}

        {clan && (
          <>
            <div className="panel cut clan-head" data-testid="clan-head">
              <ClanLogo logoKey={clan.logoKey} tag={clan.tag} size={84} />
              <div className="clan-head-main">
                <span className="label">Clã · {clan.isOpen ? "aberto" : "só convite"}</span>
                <h1 data-testid="clan-title">[{clan.tag}] {clan.name}</h1>
                <span className="muted">{clan.points} pontos · #{clan.position} no ranking · {clan.wins} V · {clan.losses} D · {clan.members.length}/{CLAN_MAX_MEMBERS} membros</span>
              </div>
              {tag && !myRole && clan.isOpen && !mine?.clan && <Button loading={busy} onClick={() => void act(() => api.post(`/clans/${clan.id}/join`), `Você entrou no [${clan.tag}].`)}>Entrar no clã</Button>}
            </div>

            {(myRole === "LEADER" || myRole === "OFFICER") && desc !== null ? (
              <div className="row-gap">
                <textarea className="input" rows={2} maxLength={500} value={desc} onChange={(e) => setDesc(e.target.value)} data-testid="clan-desc-input" />
                <button className="btn-mini" onClick={() => void act(() => api.patch("/clans/me", { description: desc }), "Descrição salva.").then(() => setDesc(null))} data-testid="clan-desc-save">Salvar</button>
              </div>
            ) : (
              <p className="clan-desc">{clan.description || <span className="muted">Sem descrição.</span>} {(myRole === "LEADER" || myRole === "OFFICER") && <button className="btn-mini ghost" onClick={() => setDesc(clan.description ?? "")} data-testid="clan-desc-edit">Editar</button>}</p>
            )}

            {(myRole === "LEADER" || myRole === "OFFICER") && (
              <form className="row-gap" onSubmit={(e) => { e.preventDefault(); void act(() => api.post("/clans/me/invites", { username: inviteName }), `Convite enviado para ${inviteName}.`).then(() => setInviteName("")); }}>
                <input className="input" placeholder="Convidar jogador (nome de usuário)" value={inviteName} onChange={(e) => setInviteName(e.target.value)} data-testid="clan-invite-input" />
                <button className="btn-mini" type="submit" disabled={!inviteName.trim() || busy} data-testid="clan-invite-send">Convidar</button>
                {myRole === "LEADER" && <button type="button" className="btn-mini ghost" onClick={() => void act(() => api.patch("/clans/me", { isOpen: !clan.isOpen }), clan.isOpen ? "Agora só entra por convite." : "Clã aberto.")} data-testid="clan-toggle-open">{clan.isOpen ? "Fechar para convite" : "Abrir clã"}</button>}
              </form>
            )}

            <section className="panel cut room-list-panel">
              <span className="label">Membros</span>
              <table className="room-table" data-testid="clan-members">
                <thead><tr><th>Jogador</th><th>Cargo</th><th>Nível</th><th>Desde</th><th /></tr></thead>
                <tbody>
                  {clan.members.map((m) => (
                    <tr key={m.userId} data-testid={`clan-member-${m.username}`}>
                      <td><Link to={`/jogador/${encodeURIComponent(m.username)}`}>{m.username}</Link>{m.title ? <span className="muted small"> · {m.title}</span> : null}</td>
                      <td>{CLAN_ROLE_LABEL[m.role]}</td>
                      <td>{m.level}</td>
                      <td>{new Date(m.joinedAt).toLocaleDateString("pt-BR")}</td>
                      <td className="row-end">
                        {myRole === "LEADER" && m.role !== "LEADER" && (
                          <>
                            <button className="btn-mini ghost" onClick={() => void act(() => api.post("/clans/me/role", { userId: m.userId, role: m.role === "OFFICER" ? "MEMBER" : "OFFICER" }))} data-testid={`clan-role-${m.username}`}>{m.role === "OFFICER" ? "Rebaixar" : "Promover"}</button>
                            <button className="btn-mini ghost" onClick={() => void act(() => api.post("/clans/me/transfer", { userId: m.userId }), `${m.username} agora é o líder.`)} data-testid={`clan-transfer-${m.username}`}>Passar liderança</button>
                          </>
                        )}
                        {myRole && m.userId !== myId && canManage(myRole, m.role) && <button className="btn-mini ghost danger" onClick={() => void act(() => api.post("/clans/me/kick", { userId: m.userId }), `${m.username} foi removido.`)} data-testid={`clan-kick-${m.username}`}>Remover</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="panel cut room-list-panel">
              <span className="label">Histórico de partidas do clã</span>
              {clan.history.length === 0 ? <p className="muted small">Partidas da fila com 2 ou mais membros no mesmo time aparecem aqui e valem pontos (+20 vitória, −15 derrota). Salas não contam.</p> : (
                <table className="room-table" data-testid="clan-history">
                  <thead><tr><th>Quando</th><th>Modo</th><th>Mapa</th><th>Placar</th><th>Resultado</th><th>Pontos</th><th>Membros</th></tr></thead>
                  <tbody>
                    {clan.history.map((h) => (
                      <tr key={h.matchId}>
                        <td>{new Date(h.at).toLocaleString("pt-BR")}</td><td>{h.mode}</td><td>{mapName(h.map)}</td><td>{h.score[0]} × {h.score[1]}</td>
                        <td className={h.result === "WIN" ? "win" : h.result === "LOSS" ? "loss" : ""}>{RESULT[h.result]}</td>
                        <td>{h.pointsDelta > 0 ? `+${h.pointsDelta}` : h.pointsDelta}</td><td className="small">{h.members.join(", ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            {myRole && !tag && (
              <div className="row-end">
                <Button variant="ghost" onClick={() => void act(() => api.post("/clans/me/leave"), "Você saiu do clã.")} data-testid="clan-leave">Sair do clã</Button>
                {myRole === "LEADER" && (confirming
                  ? <><Button variant="ghost" onClick={() => setConfirming(false)}>Cancelar</Button><Button onClick={() => void act(() => api.del("/clans/me"), "Clã desfeito.").then(() => setConfirming(false))} data-testid="clan-disband-confirm">Confirmar: apagar clã e histórico</Button></>
                  : <Button variant="ghost" onClick={() => setConfirming(true)} data-testid="clan-disband">Desfazer clã</Button>)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
