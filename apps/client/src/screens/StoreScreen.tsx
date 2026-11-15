import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  RARITY_COLOR,
  RARITY_LABEL,
  weaponStatsFromRow,
  type CoinPackagesResponse,
  type PaymentOrderView,
  type StoreCatalogResponse,
  type StoreItemView,
  type WalletResponse,
  type WeaponStats,
} from "@vanta/shared";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Button, useToast } from "../components/ui";
import { CosmeticPreview, swatchBackground } from "../three/CosmeticPreview";
import { uiSound } from "../audio/ui-sound";

type Tab = "weapons" | "operators" | "coins";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "weapons", label: "Skins de arma" },
  { key: "operators", label: "Operadores" },
  { key: "coins", label: "VANTA COINS" },
];

const brl = (cents: number, currency: string) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency });
const vc = (n: number) => n.toLocaleString("pt-BR");

/** Loja: cosméticos (só aparência) com VANTA COINS e compra de VC pela Stripe. */
export function StoreScreen() {
  const navigate = useNavigate();
  const toast = useToast();
  const { reloadMe } = useAuth();
  const [params, setParams] = useSearchParams();
  const orderId = params.get("pedido");
  const [tab, setTab] = useState<Tab>(() => (orderId || params.get("aba") === "vc" ? "coins" : "weapons"));
  const [catalog, setCatalog] = useState<StoreCatalogResponse | null>(null);
  const [weapons, setWeapons] = useState<Map<string, WeaponStats> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.get<StoreCatalogResponse>("/store/catalog").then(setCatalog).catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
    api.get<Array<Record<string, unknown>>>("/content/weapons").then((rows) => setWeapons(new Map(rows.map((r) => { const w = weaponStatsFromRow(r); return [w.code, w]; })))).catch(() => setWeapons(new Map()));
  }, []);

  const items = useMemo(() => (catalog?.items ?? []).filter((i) => (tab === "weapons" ? i.type === "WEAPON_SKIN" : i.type === "CHARACTER_SKIN")), [catalog, tab]);
  const item = catalog?.items.find((i) => i.id === selected) ?? (tab !== "coins" ? items[0] ?? null : null);
  const balance = catalog?.balance ?? 0;

  const buy = async () => {
    if (!item || item.priceVc === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/store/purchase", { itemId: item.id });
      uiSound.success();
      toast("Compra concluída", `${item.name} está no seu inventário.`);
      setConfirming(false);
      await Promise.all([load(), reloadMe()]);
    } catch (e) {
      uiSound.error();
      setError((e as Error).message);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const equip = async (it: StoreItemView) => {
    setBusy(true);
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
          <div className="chip panel cut-sm cut" title="VANTA COINS">
            <span className="vc-icon">VC</span>
            <strong data-testid="store-balance">{vc(balance)}</strong>
          </div>
        </div>
        <h1>Loja</h1>
        <p className="muted store-note">Tudo na loja é só aparência: nenhum item muda dano, recuo, velocidade ou hitbox. Não há caixas aleatórias: você sempre vê o que está comprando.</p>

        <div className="queue-type" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} className={`queue-tab ${tab === t.key ? "on" : ""}`} onClick={() => { uiSound.click(); setTab(t.key); setSelected(null); setError(null); }} data-testid={`store-tab-${t.key}`}>
              <strong>{t.label}</strong>
            </button>
          ))}
        </div>
        {error && <div className="alert error" data-testid="store-error">{error}</div>}

        {tab === "coins" ? (
          <CoinsTab orderId={orderId} onOrderSeen={() => { setParams({}, { replace: true }); void load(); void reloadMe(); }} />
        ) : (
          <div className="store-grid">
            <div className="item-grid" data-testid="item-grid">
              {!catalog ? <span className="muted">Carregando…</span> : items.map((i) => (
                <button key={i.id} className={`item-card panel cut ${item?.id === i.id ? "on" : ""}`} onClick={() => { uiSound.click(); setSelected(i.id); setConfirming(false); }} data-testid={`item-${i.code}`}>
                  <span className="swatch" style={{ background: swatchBackground(i) }} />
                  <span className="rarity" style={{ color: RARITY_COLOR[i.rarity] }}>{RARITY_LABEL[i.rarity]}</span>
                  <strong>{i.name}</strong>
                  <span className="price">{i.owned ? (i.equipped ? "Equipado" : "Possui") : <><span className="vc-icon sm">VC</span>{vc(i.priceVc!)}</>}</span>
                </button>
              ))}
            </div>
            {item && (
              <aside className="item-detail panel cut" data-testid="item-detail">
                <CosmeticPreview item={item} weapons={weapons} />
                <span className="rarity" style={{ color: RARITY_COLOR[item.rarity] }}>{RARITY_LABEL[item.rarity]} · {item.target?.kind === "weapon" ? "Skin de arma" : "Skin de operador"}</span>
                <h2>{item.name}</h2>
                <span className="muted">{item.description}</span>
                <span className="muted">Aplica-se a: <b>{item.target?.name}</b>{item.target?.kind === "character" ? " (aparece no menu e para os outros jogadores na partida)" : " (aparece na sua arma em primeira pessoa)"}</span>
                {item.owned ? (
                  <Button onClick={() => void equip(item)} loading={busy} data-testid="equip-item">{item.equipped ? "Desequipar" : "Equipar"}</Button>
                ) : confirming ? (
                  <div className="confirm-box" data-testid="confirm-purchase">
                    <span>Comprar por <b>{vc(item.priceVc!)} VC</b>? Saldo depois: {vc(balance - item.priceVc!)} VC.</span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>Cancelar</Button>
                      <Button onClick={() => void buy()} loading={busy} data-testid="confirm-buy">Confirmar compra</Button>
                    </div>
                  </div>
                ) : balance < item.priceVc! ? (
                  <>
                    <Button disabled data-testid="buy-item">Saldo insuficiente</Button>
                    <Button variant="ghost" onClick={() => setTab("coins")}>Ver pacotes de VANTA COINS</Button>
                  </>
                ) : (
                  <Button onClick={() => { uiSound.click(); setConfirming(true); }} data-testid="buy-item">Comprar · {vc(item.priceVc!)} VC</Button>
                )}
              </aside>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const ORDER_STATUS: Record<PaymentOrderView["status"], string> = {
  PENDING: "Aguardando a confirmação do pagamento pela Stripe…",
  PAID: "Pagamento confirmado. As moedas já estão na sua carteira.",
  FAILED: "O pagamento não foi aprovado. Nada foi cobrado em VANTA COINS.",
  EXPIRED: "A sessão de pagamento expirou sem pagamento.",
  REFUNDED: "Pagamento estornado.",
  PARTIALLY_REFUNDED: "Pagamento estornado parcialmente.",
  DISPUTED: "Pagamento em contestação.",
};

function CoinsTab({ orderId, onOrderSeen }: { orderId: string | null; onOrderSeen: () => void }) {
  const [pkgs, setPkgs] = useState<CoinPackagesResponse | null>(null);
  const [wallet, setWallet] = useState<WalletResponse | null>(null);
  const [order, setOrder] = useState<PaymentOrderView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [params] = useSearchParams();
  const canceled = params.get("cancelado") === "1";

  const loadWallet = () => api.get<WalletResponse>("/wallet?limit=15").then(setWallet).catch(() => setWallet(null));
  useEffect(() => {
    api.get<CoinPackagesResponse>("/store/coin-packages").then(setPkgs).catch((e: Error) => setError(e.message));
    void loadWallet();
  }, []);

  // Volta do Checkout: só o webhook credita; aqui apenas acompanhamos o pedido até o servidor confirmar.
  useEffect(() => {
    if (!orderId) return;
    let stop = false;
    let tries = 0;
    const poll = async () => {
      try {
        const o = await api.get<PaymentOrderView>(`/payments/orders/${orderId}`);
        if (stop) return;
        setOrder(o);
        if (o.status !== "PENDING" || canceled || ++tries > 40) {
          void loadWallet();
          if (o.status === "PAID") onOrderSeen();
          return;
        }
      } catch (e) {
        setError((e as Error).message);
        return;
      }
      setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => {
      stop = true;
    };
  }, [orderId]); // eslint-disable-line react-hooks/exhaustive-deps

  const checkout = async (packageId: string) => {
    setBusy(packageId);
    setError(null);
    try {
      const r = await api.post<{ orderId: string; url: string }>("/payments/checkout", { packageId, requestId: crypto.randomUUID() });
      window.location.assign(r.url); // página de pagamento da Stripe: o cartão nunca passa pelo jogo
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  return (
    <div className="coins-tab">
      {order && (
        <div className={`alert ${order.status === "PAID" ? "ok" : order.status === "PENDING" && !canceled ? "info" : "error"}`} data-testid="order-status">
          Pedido de {vc(order.coins)} VC ({brl(order.priceCents, order.currency)}): {canceled && order.status === "PENDING" ? "pagamento cancelado na Stripe." : ORDER_STATUS[order.status]}
        </div>
      )}
      {error && <div className="alert error">{error}</div>}
      {pkgs && !pkgs.paymentsEnabled && (
        <div className="alert info" data-testid="payments-disabled">A compra de VANTA COINS ainda não está ativa neste servidor (pagamentos não configurados). Nenhuma compra é simulada: você ainda pode ganhar moedas com as recompensas de temporada.</div>
      )}
      <div className="coin-grid">
        {(pkgs?.packages ?? []).map((p) => (
          <div key={p.id} className="coin-card panel cut" data-testid={`pkg-${p.code}`}>
            <span className="vc-icon lg">VC</span>
            <strong>{vc(p.coins + p.bonusCoins)}</strong>
            {p.bonusCoins > 0 && <span className="muted">{vc(p.coins)} + {vc(p.bonusCoins)} de bônus</span>}
            <span className="coin-price">{brl(p.priceCents, p.currency)}</span>
            <Button onClick={() => void checkout(p.id)} disabled={!pkgs?.paymentsEnabled || !!busy} loading={busy === p.id}>Comprar</Button>
          </div>
        ))}
      </div>
      <p className="muted store-note">O pagamento é feito na página segura da Stripe; o jogo não vê nem guarda dados do seu cartão. As moedas entram quando a Stripe confirma o pagamento. É preciso ter o e-mail confirmado.</p>

      <section className="panel cut wallet-history">
        <div className="side-head"><span className="label">Histórico da carteira</span></div>
        {!wallet ? <span className="muted">Carregando…</span> : wallet.transactions.length === 0 ? <span className="muted">Nenhuma movimentação ainda.</span> : (
          <table className="sb-table" data-testid="wallet-history">
            <thead><tr><th>Movimentação</th><th>Data</th><th>VC</th><th>Saldo</th></tr></thead>
            <tbody>
              {wallet.transactions.map((t) => (
                <tr key={t.id}>
                  <td>{t.description}</td>
                  <td>{new Date(t.createdAt).toLocaleDateString("pt-BR")}</td>
                  <td className={t.amount > 0 ? "up" : "down"}>{t.amount > 0 ? "+" : ""}{vc(t.amount)}</td>
                  <td>{vc(t.balanceAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
