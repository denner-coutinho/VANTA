import { useState } from "react";
import { REPORT_REASONS, REPORT_REASON_LABEL, type ReportReasonCode } from "@vanta/shared";
import { Button } from "../components/ui";
import { useSocial } from "./SocialContext";

/** Denúncia: o motivo é obrigatório; a descrição ajuda a moderação. Uma por jogador a cada 24 h. */
export function ReportDialog({ user, matchId, onClose }: { user: { id: string; username: string }; matchId?: string; onClose: () => void }) {
  const social = useSocial();
  const [reason, setReason] = useState<ReportReasonCode | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!reason) return;
    setBusy(true);
    const ok = await social.report(user.id, reason, text.trim() || undefined, matchId);
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <div className="overlay-center report-overlay" onClick={onClose}>
      <section className="panel cut report-dialog" role="dialog" aria-label={`Denunciar ${user.username}`} onClick={(e) => e.stopPropagation()} data-testid="report-dialog">
        <span className="label">Denunciar jogador</span>
        <h3>{user.username}</h3>
        <div className="report-reasons" role="radiogroup">
          {REPORT_REASONS.map((r) => (
            <button key={r} role="radio" aria-checked={reason === r} className={`chip ${reason === r ? "on" : ""}`} onClick={() => setReason(r)} data-testid={`report-${r}`}>
              {REPORT_REASON_LABEL[r]}
            </button>
          ))}
        </div>
        <textarea className="input" rows={3} maxLength={1000} placeholder="O que aconteceu? (opcional)" value={text} onChange={(e) => setText(e.target.value)} />
        <p className="muted small">Denúncias falsas também podem levar a punições. Para não ver mais este jogador, use Bloquear.</p>
        <div className="row-end">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button disabled={!reason} loading={busy} onClick={() => void submit()} data-testid="report-submit">Enviar denúncia</Button>
        </div>
      </section>
    </div>
  );
}
