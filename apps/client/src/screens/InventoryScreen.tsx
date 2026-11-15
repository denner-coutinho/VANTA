import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RARITY_COLOR, RARITY_LABEL, weaponStatsFromRow, type StoreItemView, type WeaponStats } from "@vanta/shared";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Button } from "../components/ui";
import { CosmeticPreview, swatchBackground } from "../three/CosmeticPreview";
import { uiSound } from "../audio/ui-sound";

const GROUPS: Array<{ type: StoreItemView["type"]; label: string }> = [
  { type: "CHARACTER_SKIN", label: "Skins de operador" },
  { type: "WEAPON_SKIN", label: "Skins de arma" },
  { type: "EMBLEM", label: "Emblemas" },
];
const SOURCE: Record<NonNullable<StoreItemView["source"]>, string> = {
  PURCHASE: "Comprado na loja",
  REWARD: "Recompensa",
  SEASON_REWARD: "Recompensa de temporada",
  EVENT: "Evento",
  ADMIN_GRANT: "Concedido pela equipe",
  DEFAULT: "Padrão",
};

/** Inventário: itens possuídos (registrados no servidor) e o que está equipado. */
export function InventoryScreen() {
  const navigate = useNavigate();
  const { reloadMe } = useAuth();
  const [items, setItems] = useState<StoreItemView[] | null>(null);
  const [weapons, setWeapons] = useState<Map<string, WeaponStats> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.get<{ items: StoreItemView[] }>("/inventory").then((r) => setItems(r.items)).catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
    api.get<Array<Record<string, unknown>>>("/content/weapons").then((rows) => setWeapons(new Map(rows.map((r) => { const w = weaponStatsFromRow(r); return [w.code, w]; })))).catch(() => setWeapons(new Map()));
  }, []);

  const item = useMemo(() => items?.find((i) => i.id === selected) ?? items?.[0] ?? null, [items, selected]);

  const equip = async (it: StoreItemView) => {
    setBusy(true);
    setError(null);
    try {
      await api.post("/inventory/equip", { itemId: it.id, equip: !it.equipped });
      uiSound.click();
      await Promise.all([load(), reloadMe()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen play-screen store-screen">
      <div className="play-wrap stagger">
        <div className="play-head">
          <Button variant="ghost" onClick={() => navigate("/menu")}>← Menu</Button>
          <Button variant="ghost" onClick={() => navigate("/loja")}>Ir para a loja</Button>
        </div>
        <h1>Inventário</h1>
        {error && <div className="alert error">{error}</div>}
        {items && items.length === 0 ? (
          <div className="panel cut" style={{ padding: 24 }} data-testid="inventory-empty">
            <strong>Seu inventário está vazio.</strong>
            <p className="muted">Skins compradas na loja e recompensas de temporada aparecem aqui.</p>
            <Button onClick={() => navigate("/loja")}>Abrir a loja</Button>
          </div>
        ) : (
          <div className="store-grid">
            <div>
              {!items ? <span className="muted">Carregando…</span> : GROUPS.map((g) => {
                const list = items.filter((i) => i.type === g.type);
                if (!list.length) return null;
                return (
                  <section key={g.type} className="inv-group">
                    <span className="label">{g.label} · {list.length}</span>
                    <div className="item-grid" data-testid={`inv-${g.type}`}>
                      {list.map((i) => (
                        <button key={i.id} className={`item-card panel cut ${item?.id === i.id ? "on" : ""}`} onClick={() => { uiSound.click(); setSelected(i.id); }} data-testid={`inv-item-${i.code}`}>
                          {i.type === "EMBLEM" ? <SeasonEmblem name={i.name} /> : <span className="swatch" style={{ background: swatchBackground(i) }} />}
                          <span className="rarity" style={{ color: RARITY_COLOR[i.rarity] }}>{RARITY_LABEL[i.rarity]}</span>
                          <strong>{i.name}</strong>
                          <span className="price">{i.equipped ? "Equipado" : i.type === "EMBLEM" ? "Coleção" : "—"}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
            {item && (
              <aside className="item-detail panel cut" data-testid="inv-detail">
                {item.type === "EMBLEM" ? <div className="cosmetic-preview emblem-preview"><SeasonEmblem name={item.name} big /></div> : <CosmeticPreview item={item} weapons={weapons} />}
                <span className="rarity" style={{ color: RARITY_COLOR[item.rarity] }}>{RARITY_LABEL[item.rarity]}</span>
                <h2>{item.name}</h2>
                <span className="muted">{item.description}</span>
                <span className="muted">{item.source ? SOURCE[item.source] : ""}{item.acquiredAt ? ` em ${new Date(item.acquiredAt).toLocaleDateString("pt-BR")}` : ""}</span>
                {item.type === "EMBLEM" ? (
                  <span className="muted">Emblemas são troféus de coleção.</span>
                ) : (
                  <Button onClick={() => void equip(item)} loading={busy} data-testid="inv-equip">{item.equipped ? "Desequipar" : `Equipar em ${item.target?.name}`}</Button>
                )}
              </aside>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SeasonEmblem({ name, big = false }: { name: string; big?: boolean }) {
  const n = name.match(/\d+/)?.[0] ?? "?";
  const s = big ? 140 : 56;
  return (
    <svg width={s} height={s} viewBox="0 0 64 64" role="img" aria-label={name} className="season-emblem">
      <defs>
        <linearGradient id="se-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#FFB3C6" /><stop offset="1" stopColor="#FF2E63" /></linearGradient>
      </defs>
      <path d="M32 4 L56 16 V36 C56 48 44 56 32 60 C20 56 8 48 8 36 V16 Z" fill="#0D111C" stroke="url(#se-g)" strokeWidth="2.5" />
      <path d="M20 22 L32 16 L44 22" fill="none" stroke="url(#se-g)" strokeWidth="2" />
      <text x="32" y="42" textAnchor="middle" fontFamily="Rajdhani, sans-serif" fontWeight="700" fontSize="18" fill="#FFB3C6">T{n}</text>
    </svg>
  );
}
