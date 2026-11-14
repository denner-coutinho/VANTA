import type { ReactNode } from "react";
import { Logo } from "../components/Logo";
import { Backdrop } from "../components/ui";
import { RankEmblem } from "../components/RankEmblem";

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="screen auth">
      <Backdrop />
      <aside className="auth-hero">
        <Logo size="md" />
        <div className="auth-hero-copy stagger">
          <div className="label" style={{ color: "var(--c-blue-hi)" }}>FPS tático competitivo</div>
          <h1>Cada round<br />é uma decisão.</h1>
          <p>Duelos 1v1, esquadrões 2v2 e 3v3. Servidor autoritativo, 15 patentes e nenhuma vantagem à venda.</p>
          <div className="auth-ranks">
            {[1, 4, 7, 10, 13, 15].map((o) => <RankEmblem key={o} order={o} size={40} />)}
          </div>
        </div>
        <div className="label">© VANTA: FRONTLINE</div>
      </aside>
      <main className="auth-main">
        <div className="auth-card panel cut stagger">
          <div>
            <div className="label">Terminal de acesso</div>
            <h2>{title}</h2>
            {subtitle && <p className="auth-sub">{subtitle}</p>}
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
