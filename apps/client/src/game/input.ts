import { DEFAULT_KEYBINDS, sanitizeKeybinds, type BindAction, type Keybinds } from "@vanta/shared";

/**
 * Mapa de teclas atual (código físico, independe do layout ABNT/US). Remapeável nas configurações;
 * botões do mouse entram como "Mouse0".."Mouse4".
 */
let KEYBINDS: Keybinds = sanitizeKeybinds(DEFAULT_KEYBINDS);
export function setKeybinds(b: Keybinds) {
  KEYBINDS = sanitizeKeybinds(b);
}
export function currentKeybinds(): Keybinds {
  return KEYBINDS;
}
/** A tecla (ou botão) do evento faz essa ação? Usado pelas telas (placar, chat). */
export function matchesBind(a: BindAction, code: string) {
  return KEYBINDS[a].includes(code);
}

export type Action = BindAction;

export class InputManager {
  private down = new Set<string>();
  private pressedOnce = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  fire = false;
  aim = false;
  locked = false;
  private wheel = 0;
  private fireTap = false;

  constructor(private readonly el: HTMLElement, private readonly onLockChange: (locked: boolean) => void) {
    document.addEventListener("keydown", this.onKeyDown);
    document.addEventListener("keyup", this.onKeyUp);
    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("mousedown", this.onMouseDown);
    document.addEventListener("mouseup", this.onMouseUp);
    document.addEventListener("wheel", this.onWheel, { passive: true });
    document.addEventListener("pointerlockchange", this.onPointerLock);
    document.addEventListener("contextmenu", this.prevent);
    window.addEventListener("blur", this.reset);
  }

  requestLock() {
    const p = this.el.requestPointerLock?.({ unadjustedMovement: true } as never) as unknown as Promise<void> | undefined;
    // Alguns navegadores não suportam unadjustedMovement: tenta sem.
    p?.catch?.(() => this.el.requestPointerLock?.());
  }

  isDown(a: Action) {
    return KEYBINDS[a].some((k) => this.down.has(k));
  }

  /** Verdadeiro uma única vez por pressionamento. */
  consume(a: Action) {
    const hit = KEYBINDS[a].some((k) => this.pressedOnce.has(k));
    KEYBINDS[a].forEach((k) => this.pressedOnce.delete(k));
    return hit;
  }

  /** Clique rápido entre dois ticks (FPS baixo) ainda conta como um disparo. */
  consumeFireTap() {
    const t = this.fireTap;
    this.fireTap = false;
    return t;
  }

  /** Rodinha do mouse mais a tecla de próxima arma. */
  consumeWheel() {
    const w = this.wheel + (this.consume("nextWeapon") ? 1 : 0);
    this.wheel = 0;
    return w;
  }

  takeMouse() {
    const d = { x: this.mouseDX, y: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  /** Tecla ou botão do mouse pressionado (o mesmo caminho para os dois: qualquer ação aceita qualquer um). */
  private press(code: string) {
    if (!this.down.has(code)) {
      this.pressedOnce.add(code);
      if (KEYBINDS.fire.includes(code)) this.fireTap = true;
    }
    this.down.add(code);
    this.syncButtons();
  }
  private release(code: string) {
    this.down.delete(code);
    this.syncButtons();
  }
  private syncButtons() {
    this.fire = this.isDown("fire");
    this.aim = this.isDown("aim");
  }
  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.locked) return;
    // Digitando num campo (ex.: chat): as teclas são do campo, não do jogo.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (e.code !== "Escape" && e.code !== "F11" && e.code !== "F12") e.preventDefault();
    this.press(e.code);
  };
  private onKeyUp = (e: KeyboardEvent) => this.release(e.code);
  private lockedAt = 0;
  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return;
    // Chrome às vezes envia um salto enorme logo após travar o ponteiro: descartamos picos.
    if (performance.now() - this.lockedAt < 120 || Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
    this.mouseDX += e.movementX;
    this.mouseDY += e.movementY;
  };
  private onMouseDown = (e: MouseEvent) => {
    if (!this.locked) return;
    if (e.button === 1 || e.button > 2) e.preventDefault(); // botão do meio e laterais: sem rolar nem voltar página
    this.press(`Mouse${e.button}`);
  };
  private onMouseUp = (e: MouseEvent) => this.release(`Mouse${e.button}`);
  private onWheel = (e: WheelEvent) => {
    if (this.locked) this.wheel += Math.sign(e.deltaY);
  };
  private onPointerLock = () => {
    this.locked = document.pointerLockElement === this.el;
    if (this.locked) this.lockedAt = performance.now();
    if (!this.locked) this.reset();
    this.onLockChange(this.locked);
  };
  private prevent = (e: Event) => this.locked && e.preventDefault();
  private reset = () => {
    this.down.clear();
    this.pressedOnce.clear();
    this.fire = false;
    this.fireTap = false;
    this.aim = false;
    this.mouseDX = this.mouseDY = 0;
  };

  dispose() {
    document.removeEventListener("keydown", this.onKeyDown);
    document.removeEventListener("keyup", this.onKeyUp);
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("mousedown", this.onMouseDown);
    document.removeEventListener("mouseup", this.onMouseUp);
    document.removeEventListener("wheel", this.onWheel);
    document.removeEventListener("pointerlockchange", this.onPointerLock);
    document.removeEventListener("contextmenu", this.prevent);
    window.removeEventListener("blur", this.reset);
    if (document.pointerLockElement === this.el) document.exitPointerLock();
  }
}
