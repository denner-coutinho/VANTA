import { useId } from "react";
import { Link } from "react-router-dom";
import { AVATAR_COLORS, cardStyle, parseClanLogo, type ClanShape, type PlayerCardView } from "@vanta/shared";
import { RankEmblem } from "./RankEmblem";

const SHAPE_PATH: Record<ClanShape, string> = {
  shield: "M32 4l24 8v18c0 15-10 25-24 30C18 55 8 45 8 30V12z",
  hex: "M32 4l24 14v28L32 60 8 46V18z",
  diamond: "M32 3l29 29-29 29L3 32z",
  circle: "M32 4a28 28 0 1 0 0.01 0z",
  chevron: "M8 10h48v28L32 58 8 38z",
  crosshair: "M32 6a26 26 0 1 0 0.01 0zM32 16a16 16 0 1 1-0.01 0z",
};

/** Logo de clã: forma + cor escolhidas pelo líder, com a tag no centro. Tudo vetorial e original. */
export function ClanLogo({ logoKey, tag, size = 48 }: { logoKey: string; tag: string; size?: number }) {
  const { shape, color } = parseClanLogo(logoKey);
  const gid = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={`Logo do clã ${tag}`} className="clan-logo">
      <defs>
        <linearGradient id={`cl${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".55" />
          <stop offset="1" stopColor={color} stopOpacity=".12" />
        </linearGradient>
      </defs>
      <path d={SHAPE_PATH[shape]} fill={`url(#cl${gid})`} stroke={color} strokeWidth="2.5" strokeLinejoin="round" fillRule="evenodd" />
      <text x="32" y="37" textAnchor="middle" fontSize={tag.length > 3 ? 13 : 16} fontWeight="700" fill="#fff" fontFamily="var(--f-display)" letterSpacing=".04em">{tag}</text>
    </svg>
  );
}

export function Avatar({ name, avatarKey, size = 56 }: { name: string; avatarKey: string; size?: number }) {
  const color = AVATAR_COLORS[avatarKey] ?? AVATAR_COLORS.default!;
  return (
    <span className="avatar" style={{ width: size, height: size, borderColor: color, color, fontSize: size * 0.42 }} aria-hidden>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function CardPattern({ pattern, accent, id }: { pattern: string; accent: string; id: string }) {
  const common = { stroke: accent, strokeOpacity: 0.22, fill: "none", strokeWidth: 1 };
  switch (pattern) {
    case "grid":
      return <pattern id={id} width="18" height="18" patternUnits="userSpaceOnUse"><path d="M18 0H0V18" {...common} /></pattern>;
    case "circuit":
      return <pattern id={id} width="40" height="40" patternUnits="userSpaceOnUse"><path d="M0 20h12l6-6h10M28 14v-14M18 40v-12l6-6h16" {...common} /><circle cx="28" cy="14" r="2" fill={accent} fillOpacity=".3" /></pattern>;
    case "chevrons":
      return <pattern id={id} width="28" height="20" patternUnits="userSpaceOnUse"><path d="M0 14l14-8 14 8" {...common} strokeWidth="2" /></pattern>;
    case "rings":
      return <pattern id={id} width="60" height="60" patternUnits="userSpaceOnUse"><circle cx="30" cy="30" r="12" {...common} /><circle cx="30" cy="30" r="24" {...common} /></pattern>;
    case "shards":
      return <pattern id={id} width="50" height="50" patternUnits="userSpaceOnUse"><path d="M0 50L25 0l10 30zM30 50l20-35" {...common} /></pattern>;
    default:
      return <pattern id={id} width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)"><path d="M0 0v14" {...common} /></pattern>;
  }
}

/** Cartão do jogador: fundo do estilo escolhido, avatar, nome, [TAG] do clã, título, nível e patente. */
export function PlayerCard({ card, link = false, compact = false }: { card: PlayerCardView; link?: boolean; compact?: boolean }) {
  const style = cardStyle(card.playerCardKey);
  const pid = `pc${useId().replace(/:/g, "")}`;
  const name = (
    <strong className="pc-name">
      {card.clan && <span className="pc-tag">[{card.clan.tag}]</span>} {card.username}
    </strong>
  );
  return (
    <div className={`player-card ${compact ? "compact" : ""}`} style={{ background: `linear-gradient(120deg, ${style.from}, ${style.to})`, borderColor: style.accent }} data-testid="player-card" data-card={style.key}>
      <svg className="pc-bg" aria-hidden width="100%" height="100%"><defs><CardPattern pattern={style.pattern} accent={style.accent} id={pid} /></defs><rect width="100%" height="100%" fill={`url(#${pid})`} /></svg>
      <Avatar name={card.username} avatarKey={card.avatarKey} size={compact ? 40 : 60} />
      <div className="pc-main">
        {link ? <Link to={`/jogador/${encodeURIComponent(card.username)}`} className="pc-link">{name}</Link> : name}
        {card.title && <span className="pc-title" style={{ color: style.accent }}>{card.title}</span>}
        <span className="pc-level">Nível {card.level}</span>
      </div>
      {card.rankOrder !== null && <RankEmblem order={card.rankOrder} size={compact ? 34 : 48} />}
      {card.clan && !compact && <Link to={`/cla/${card.clan.tag}`} className="pc-clan" title={card.clan.name}><ClanLogo logoKey={card.clan.logoKey} tag={card.clan.tag} size={44} /></Link>}
    </div>
  );
}
