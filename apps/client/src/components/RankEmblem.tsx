import { RANKS, type RankDefinition } from "@vanta/shared";

/**
 * Ícone exclusivo de cada uma das 15 patentes, gerado em SVG:
 * a silhueta muda por tier (escudo, losango, hexágono, estrela, coroa)
 * e o número de divisas indica a divisão (I, II, III).
 */
export function RankEmblem({ order, size = 48, title = true }: { order: number; size?: number; title?: boolean }) {
  const rank: RankDefinition = RANKS[Math.min(15, Math.max(1, order)) - 1]!;
  const id = `rk-${rank.code}`;
  const chevrons = rank.division ?? 0;
  const shape = SHAPES[rank.tier];
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={rank.name}>
      {title && <title>{rank.name}</title>}
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={rank.glow} />
          <stop offset="1" stopColor={rank.color} />
        </linearGradient>
        <filter id={`${id}-f`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.2" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <g filter={`url(#${id}-f)`}>
        <path d={shape} fill="#0D111C" stroke={`url(#${id}-g)`} strokeWidth="2.5" strokeLinejoin="round" />
        <path d={shape} fill={rank.color} opacity=".18" transform="translate(32 32) scale(.78) translate(-32 -32)" />
        {rank.tier === "SUPREMO" ? (
          <path d="M20 38l4-14 8 8 8-8 4 14z M22 42h20v3H22z" fill={`url(#${id}-g)`} />
        ) : (
          Array.from({ length: chevrons }).map((_, i) => (
            <path key={i} d={`M20 ${44 - i * 8}l12-7 12 7v-4l-12-7-12 7z`} fill={`url(#${id}-g)`} />
          ))
        )}
      </g>
    </svg>
  );
}

const SHAPES: Record<RankDefinition["tier"], string> = {
  RECRUTA: "M32 6l20 8v18c0 13-9 21-20 26C21 53 12 45 12 32V14z",
  COMBATENTE: "M32 4l26 28-26 28L6 32z",
  ESPECIALISTA: "M32 4l24 14v28L32 60 8 46V18z",
  ELITE: "M32 3l7 15 16-4-6 15 12 9-15 5 2 16-16-8-16 8 2-16-15-5 12-9-6-15 16 4z",
  MESTRE: "M32 3l9 9h13v13l7 7-7 7v13H41l-9 9-9-9H10V39l-7-7 7-7V12h13z",
  SUPREMO: "M32 2l10 8 12-2 2 12 8 10-8 10-2 12-12-2-10 8-10-8-12 2-2-12-8-10 8-10 2-12 12 2z",
};
