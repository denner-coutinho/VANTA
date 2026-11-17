import { z } from "zod";

/**
 * Teclas remapeáveis (Fase 7, parte 5). Usa o código físico da tecla (KeyboardEvent.code),
 * que independe do layout (ABNT, US). Botões do mouse viram "Mouse0".."Mouse4".
 * Cada ação tem até 2 teclas. Salvo na conta (Profile.settings) e no navegador.
 */
export const BIND_ACTIONS = [
  "forward", "back", "left", "right", "jump", "sprint", "crouch",
  "fire", "aim", "reload", "interact", "slot1", "slot2", "slot3", "nextWeapon",
  "scoreboard", "chat", "chatAll",
] as const;
export type BindAction = (typeof BIND_ACTIONS)[number];
export type Keybinds = Record<BindAction, string[]>;

export const BIND_LABEL: Record<BindAction, string> = {
  forward: "Andar para frente", back: "Andar para trás", left: "Andar para a esquerda", right: "Andar para a direita",
  jump: "Pular", sprint: "Correr", crouch: "Agachar",
  fire: "Atirar", aim: "Mirar", reload: "Recarregar", interact: "Interagir",
  slot1: "Arma principal", slot2: "Arma secundária", slot3: "Terceira arma", nextWeapon: "Próxima arma",
  scoreboard: "Placar", chat: "Chat da equipe", chatAll: "Chat de todos",
};

export const BIND_GROUPS: Array<{ label: string; actions: BindAction[] }> = [
  { label: "Movimento", actions: ["forward", "back", "left", "right", "jump", "sprint", "crouch"] },
  { label: "Combate", actions: ["fire", "aim", "reload", "interact", "slot1", "slot2", "slot3", "nextWeapon"] },
  { label: "Interface", actions: ["scoreboard", "chat", "chatAll"] },
];

export const DEFAULT_KEYBINDS: Keybinds = {
  forward: ["KeyW", "ArrowUp"],
  back: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  jump: ["Space"],
  sprint: ["ShiftLeft", "ShiftRight"],
  // Ctrl+W fecha a aba fora da tela cheia; por isso C também agacha.
  crouch: ["ControlLeft", "KeyC"],
  fire: ["Mouse0"],
  aim: ["Mouse2"],
  reload: ["KeyR"],
  interact: ["KeyE"],
  slot1: ["Digit1"],
  slot2: ["Digit2"],
  slot3: ["Digit3"],
  nextWeapon: ["KeyQ"],
  scoreboard: ["Tab"],
  chat: ["Enter"],
  chatAll: ["KeyY"],
};

/** Teclas do navegador/sistema que o jogo nunca captura. */
export const RESERVED_KEYS = new Set(["Escape", "F11", "F12", "MetaLeft", "MetaRight", "OSLeft", "OSRight", "ContextMenu"]);

const CODE_RE = /^(Key[A-Z]|Digit[0-9]|Numpad[0-9A-Za-z]+|Arrow(Up|Down|Left|Right)|F([1-9]|10)|Mouse[0-4]|Space|Tab|Enter|Backspace|Backquote|Minus|Equal|Bracket(Left|Right)|Backslash|Semicolon|Quote|Comma|Period|Slash|IntlBackslash|IntlRo|CapsLock|(Shift|Control|Alt)(Left|Right)|Insert|Delete|Home|End|PageUp|PageDown)$/;

export function isBindableCode(code: string): boolean {
  return CODE_RE.test(code) && !RESERVED_KEYS.has(code);
}

/**
 * Aceita qualquer coisa vinda do navegador ou do banco e devolve um mapa válido:
 * teclas desconhecidas saem, cada tecla fica numa ação só (a primeira que a usa) e
 * ações sem tecla voltam ao padrão se o padrão estiver livre.
 */
export function sanitizeKeybinds(raw: unknown): Keybinds {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const used = new Set<string>();
  const out = {} as Keybinds;
  for (const a of BIND_ACTIONS) {
    const list = Array.isArray(src[a]) ? (src[a] as unknown[]) : DEFAULT_KEYBINDS[a];
    out[a] = [];
    for (const k of list) {
      if (typeof k !== "string" || !isBindableCode(k) || used.has(k) || out[a].length >= 2) continue;
      used.add(k);
      out[a].push(k);
    }
  }
  for (const a of BIND_ACTIONS) {
    if (out[a].length) continue;
    for (const k of DEFAULT_KEYBINDS[a]) if (!used.has(k)) { used.add(k); out[a].push(k); }
  }
  return out;
}

/**
 * Liga `code` à ação no espaço `slot` (0 ou 1). Se outra ação usava a tecla,
 * ela perde essa tecla (e a função conta quem perdeu, para avisar o jogador).
 */
export function assignKey(binds: Keybinds, action: BindAction, slot: 0 | 1, code: string): { binds: Keybinds; takenFrom: BindAction | null } {
  if (!isBindableCode(code)) return { binds, takenFrom: null };
  const next = Object.fromEntries(BIND_ACTIONS.map((a) => [a, [...binds[a]]])) as Keybinds;
  let takenFrom: BindAction | null = null;
  for (const a of BIND_ACTIONS) {
    const i = next[a].indexOf(code);
    if (i >= 0 && !(a === action && i === slot)) {
      next[a].splice(i, 1);
      if (a !== action) takenFrom = a;
    }
  }
  const list = next[action];
  if (slot < list.length) list[slot] = code;
  else list.push(code);
  next[action] = list.slice(0, 2);
  return { binds: next, takenFrom };
}

export function clearKey(binds: Keybinds, action: BindAction, slot: 0 | 1): Keybinds {
  const next = Object.fromEntries(BIND_ACTIONS.map((a) => [a, [...binds[a]]])) as Keybinds;
  next[action].splice(slot, 1);
  return next;
}

/** Nome curto da tecla para a interface. */
export function keyLabel(code: string | undefined): string {
  if (!code) return "—";
  const fixed: Record<string, string> = {
    Mouse0: "Botão esquerdo", Mouse1: "Botão do meio", Mouse2: "Botão direito", Mouse3: "Mouse 4", Mouse4: "Mouse 5",
    Space: "Espaço", ShiftLeft: "Shift esq.", ShiftRight: "Shift dir.", ControlLeft: "Ctrl esq.", ControlRight: "Ctrl dir.",
    AltLeft: "Alt esq.", AltRight: "Alt dir.", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
    Enter: "Enter", Tab: "Tab", Backspace: "Backspace", CapsLock: "Caps Lock", Backquote: "'", Minus: "-", Equal: "=",
    BracketLeft: "´", BracketRight: "[", Backslash: "]", Semicolon: "Ç", Quote: "~", Comma: ",", Period: ".", Slash: ";", IntlBackslash: "\\", IntlRo: "/",
  };
  if (fixed[code]) return fixed[code]!;
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return code;
}

export const keybindsSchema = z.record(z.string(), z.array(z.string().max(24)).max(2)).transform(sanitizeKeybinds);

/** Configurações guardadas na conta. Só o que vale levar para outro computador. */
export const accountSettingsSchema = z.object({
  keybinds: keybindsSchema.optional(),
  sensitivity: z.number().min(0.1).max(4).optional(),
  fov: z.number().int().min(70).max(110).optional(),
});
export type AccountSettings = z.infer<typeof accountSettingsSchema>;
