/** Logotipo original de VANTA: FRONTLINE — monograma “V” fendido + lettering. */
export function LogoMark({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="lm-a" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5C9BFF" />
          <stop offset="1" stopColor="#287BFF" />
        </linearGradient>
        <linearGradient id="lm-b" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#A879FF" />
          <stop offset="1" stopColor="#823BFF" />
        </linearGradient>
      </defs>
      <path d="M4 8h14l14 30 14-30h14L38 56h-12z" fill="url(#lm-a)" />
      <path d="M26 56h12l5-11H21z" fill="url(#lm-b)" />
      <path d="M18 8l6 0 8 17-3 6z" fill="#fff" opacity=".25" />
    </svg>
  );
}

export function Logo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const s = { sm: [30, 18, 9], md: [44, 26, 11], lg: [92, 64, 18] }[size] as [number, number, number];
  return (
    <div className={`logo logo-${size}`} style={{ display: "flex", alignItems: "center", gap: s[0] * 0.28 }}>
      <LogoMark size={s[0]} />
      <div style={{ lineHeight: 1 }}>
        <div style={{ fontFamily: "var(--f-display)", fontWeight: 700, fontSize: s[1], letterSpacing: "0.16em" }}>
          VANTA<span style={{ color: "var(--c-blue)" }}>:</span>
        </div>
        <div style={{ fontFamily: "var(--f-display)", fontWeight: 500, fontSize: s[2], letterSpacing: "0.62em", color: "var(--c-dim)", marginTop: s[2] * 0.4 }}>
          FRONTLINE
        </div>
      </div>
    </div>
  );
}
