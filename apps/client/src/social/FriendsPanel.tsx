import { Link } from "react-router-dom";
import { useEffect, useState, type FormEvent } from "react";
import { PRESENCE_LABEL, usernameSchema, type PresenceState, type RecentPlayerView, type SocialUserView } from "@vanta/shared";
import { api } from "../api/client";
import { Button } from "../components/ui";
import { uiSound } from "../audio/ui-sound";
import { useAuth } from "../auth/AuthContext";
import { useSocial } from "./SocialContext";
import { ReportDialog } from "./ReportDialog";
import { PartyWidget } from "./PartyWidget";

type Tab = "friends" | "requests" | "add" | "recent" | "blocked";

export function PresenceDot({ state }: { state: PresenceState }) {
  return <span className={`presence-dot ${state}`} title={PRESENCE_LABEL[state]} aria-label={PRESENCE_LABEL[state]} />;
}

function Who({ u, sub }: { u: SocialUserView; sub?: React.ReactNode }) {
  return (
    <div className="who">
      <Link to={`/jogador/${encodeURIComponent(u.username)}`} className="who-link"><strong>{u.username}</strong></Link>
      <span className="muted small">Nível {u.level}{u.character ? ` · ${u.character}` : ""}{sub ? <> · {sub}</> : null}</span>
    </div>
  );
}

/** Painel lateral de amigos: lista com presença, pedidos, adicionar, jogadores recentes e bloqueados. */
export function FriendsPanel({ onClose }: { onClose: () => void }) {
  const social = useSocial();
  const { me } = useAuth();
  const ov = social.overview;
  const [tab, setTab] = useState<Tab>("friends");
  const [reporting, setReporting] = useState<{ id: string; username: string } | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const pending = ov?.incoming.length ?? 0;

  useEffect(() => {
    void social.refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const inParty = new Set(social.party?.members.map((m) => m.id) ?? []);
  const invited = new Set(social.party?.invited ?? []);
  const iLead = !social.party || social.party.leaderId === me?.user.id;

  const friends = [...(ov?.friends ?? [])].sort((a, b) => {
    const order: PresenceState[] = ["online", "queue", "room", "match", "offline"];
    return order.indexOf(social.presence.get(a.id) ?? "offline") - order.indexOf(social.presence.get(b.id) ?? "offline") || a.username.localeCompare(b.username);
  });

  return (
    <div className="overlay" onClick={onClose}>
      <section className="drawer panel friends-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Amigos" data-testid="friends-panel">
        <div className="drawer-head">
          <div>
            <span className="label">Social</span>
            <h2>Amigos</h2>
            <span className="muted">{social.onlineFriends} online · {ov?.friends.length ?? 0} no total</span>
          </div>
          <button className="icon-btn panel cut cut-sm" aria-label="Fechar" onClick={onClose}>✕</button>
        </div>

        <PartyWidget />

        <div className="tabs" role="tablist">
          {([
            ["friends", "Amigos"],
            ["requests", `Pedidos${pending ? ` (${pending})` : ""}`],
            ["add", "Adicionar"],
            ["recent", "Recentes"],
            ["blocked", "Bloqueados"],
          ] as Array<[Tab, string]>).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => { uiSound.click(); setTab(k); }} data-testid={`friends-tab-${k}`}>
              {label}
            </button>
          ))}
        </div>

        {tab === "friends" && (
          <ul className="friend-list" data-testid="friend-list">
            {!ov ? <li className="muted">Carregando…</li> : friends.length === 0 ? (
              <li className="muted empty">Você ainda não tem amigos. Use <b>Adicionar</b> ou chame alguém de <b>Recentes</b>.</li>
            ) : friends.map((f) => {
              const state = social.presence.get(f.id) ?? "offline";
              const canInvite = state !== "offline" && state !== "match" && !inParty.has(f.id) && !invited.has(f.id) && iLead;
              return (
                <li key={f.id} className="friend-row" data-testid={`friend-${f.username}`} data-presence={state}>
                  <PresenceDot state={state} />
                  <Who u={f} sub={<span className={`presence-text ${state}`}>{PRESENCE_LABEL[state]}</span>} />
                  <div className="row-actions">
                    {inParty.has(f.id) ? <span className="pill">No grupo</span> : invited.has(f.id) ? <span className="pill">Convidado</span> : (
                      <button className="btn-mini" disabled={!canInvite} onClick={() => social.inviteToParty(f.id)} title={state === "offline" ? "Offline" : state === "match" ? "Em partida" : "Convidar para o grupo"} data-testid={`invite-${f.username}`}>Convidar</button>
                    )}
                    <button className="btn-mini ghost" aria-label="Mais ações" onClick={() => setMenuFor(menuFor === f.id ? null : f.id)}>⋯</button>
                  </div>
                  {menuFor === f.id && (
                    <div className="row-menu panel cut-sm cut">
                      <button onClick={() => { setMenuFor(null); void social.mute(f.id); }}>Silenciar no chat</button>
                      <button onClick={() => { setMenuFor(null); setReporting(f); }}>Denunciar</button>
                      <button onClick={() => { setMenuFor(null); void social.removeFriend(f.id); }}>Desfazer amizade</button>
                      <button className="danger" onClick={() => { setMenuFor(null); void social.block(f.id); }}>Bloquear</button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {tab === "requests" && (
          <div className="friend-list">
            <span className="label">Recebidos</span>
            {(ov?.incoming ?? []).length === 0 && <p className="muted">Nenhum pedido recebido.</p>}
            {ov?.incoming.map((r) => (
              <div key={r.id} className="friend-row" data-testid={`request-${r.user.username}`}>
                <Who u={r.user} sub={new Date(r.createdAt).toLocaleDateString("pt-BR")} />
                <div className="row-actions">
                  <button className="btn-mini" onClick={() => void social.accept(r.id)} data-testid={`accept-${r.user.username}`}>Aceitar</button>
                  <button className="btn-mini ghost" onClick={() => void social.decline(r.id)}>Recusar</button>
                  <button className="btn-mini ghost danger" onClick={() => void social.block(r.user.id)}>Bloquear</button>
                </div>
              </div>
            ))}
            <span className="label" style={{ marginTop: 18 }}>Enviados</span>
            {(ov?.outgoing ?? []).length === 0 && <p className="muted">Nenhum pedido pendente.</p>}
            {ov?.outgoing.map((r) => (
              <div key={r.id} className="friend-row">
                <Who u={r.user} sub="aguardando" />
                <div className="row-actions"><button className="btn-mini ghost" onClick={() => void social.cancel(r.id)}>Cancelar</button></div>
              </div>
            ))}
          </div>
        )}

        {tab === "add" && <AddFriend />}
        {tab === "recent" && <RecentPlayers onReport={setReporting} />}

        {tab === "blocked" && (
          <div className="friend-list">
            <span className="label">Bloqueados</span>
            {(ov?.blocked ?? []).length === 0 && <p className="muted">Ninguém bloqueado.</p>}
            {ov?.blocked.map((u) => (
              <div key={u.id} className="friend-row"><Who u={u} /><div className="row-actions"><button className="btn-mini ghost" onClick={() => void social.unblock(u.id)}>Desbloquear</button></div></div>
            ))}
            <span className="label" style={{ marginTop: 18 }}>Silenciados no chat</span>
            {(ov?.muted ?? []).length === 0 && <p className="muted">Ninguém silenciado.</p>}
            {ov?.muted.map((u) => (
              <div key={u.id} className="friend-row"><Who u={u} /><div className="row-actions"><button className="btn-mini ghost" onClick={() => void social.unmute(u.id)}>Remover silêncio</button></div></div>
            ))}
          </div>
        )}

        <p className="muted small voice-note">Chat de voz ainda não existe. A conexão social já foi pensada para recebê-lo (veja ARCHITECTURE.md).</p>
      </section>
      {reporting && <ReportDialog user={reporting} onClose={() => setReporting(null)} />}
    </div>
  );
}

function AddFriend() {
  const social = useSocial();
  const [name, setName] = useState("");
  const [results, setResults] = useState<Array<SocialUserView & { relation: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = name.trim();
    if (q.length < 2) return setResults([]);
    const t = window.setTimeout(() => {
      api.get<{ results: Array<SocialUserView & { relation: string }> }>(`/social/search?q=${encodeURIComponent(q)}`).then((r) => setResults(r.results)).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [name]);

  async function submit(e: FormEvent, username = name) {
    e.preventDefault();
    const parsed = usernameSchema.safeParse(username);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Nome inválido.");
    setError(null);
    if (await social.addFriend(parsed.data)) setName("");
  }

  const REL: Record<string, string> = { friend: "Amigo", pending_out: "Pedido enviado", pending_in: "Quer ser seu amigo", blocked: "Bloqueado" };
  return (
    <form className="friend-list" onSubmit={(e) => void submit(e)}>
      <span className="label">Nome do jogador</span>
      <div className="add-row">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Raven_01" maxLength={16} autoFocus data-testid="add-friend-input" />
        <Button type="submit" data-testid="add-friend-submit">Enviar pedido</Button>
      </div>
      {error && <p className="error small">{error}</p>}
      {results.map((u) => (
        <div key={u.id} className="friend-row">
          <Who u={u} sub={REL[u.relation]} />
          <div className="row-actions">
            {u.relation === "none" || u.relation === "pending_in" ? <button type="button" className="btn-mini" onClick={(e) => void submit(e, u.username)}>{u.relation === "pending_in" ? "Aceitar" : "Adicionar"}</button> : null}
          </div>
        </div>
      ))}
    </form>
  );
}

function RecentPlayers({ onReport }: { onReport: (u: { id: string; username: string }) => void }) {
  const social = useSocial();
  const [list, setList] = useState<RecentPlayerView[] | null>(null);
  const load = () => api.get<{ players: RecentPlayerView[] }>("/social/recent").then((r) => setList(r.players)).catch(() => setList([]));
  useEffect(() => void load(), []);
  return (
    <div className="friend-list" data-testid="recent-list">
      <span className="label">Das suas últimas partidas</span>
      {list === null ? <p className="muted">Carregando…</p> : list.length === 0 ? <p className="muted">Jogue uma partida para ver aqui com quem você jogou.</p> : list.map((p) => (
        <div key={p.id} className="friend-row" data-testid={`recent-${p.username}`}>
          <Who u={p} sub={`${p.teammate ? "aliado" : "adversário"} · ${new Date(p.lastMatchAt).toLocaleDateString("pt-BR")}`} />
          <div className="row-actions">
            {p.relation === "none" && <button className="btn-mini" onClick={() => void social.addFriend(p.username).then(load)}>Adicionar</button>}
            {p.relation === "friend" && <span className="pill">Amigo</span>}
            {p.relation === "pending_out" && <span className="pill">Pedido enviado</span>}
            <button className="btn-mini ghost" onClick={() => onReport({ id: p.id, username: p.username })} data-testid={`report-btn-${p.username}`}>Denunciar</button>
            {p.relation !== "blocked" ? <button className="btn-mini ghost danger" onClick={() => void social.block(p.id).then(load)}>Bloquear</button> : <span className="pill">Bloqueado</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
