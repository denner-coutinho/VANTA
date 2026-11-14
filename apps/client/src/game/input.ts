/** Mapa de teclas (código físico, independe do layout ABNT/US). Personalizável no futuro pelas configurações. */
export const KEYBINDS = {
  forward: ["KeyW", "ArrowUp"],
  back: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  jump: ["Space"],
  sprint: ["ShiftLeft", "ShiftRight"],
  // Ctrl+W fecha a aba fora da tela cheia; por isso C também agacha.
  crouch: ["ControlLeft", "ControlRight", "KeyC"],
  reload: ["KeyR"],
  interact: ["KeyE"],
  slot1: ["Digit1"],
  slot2: ["Digit2"],
  slot3: ["Digit3"],
} as const;

export type Action = keyof typeof KEYBINDS;

export class InputManager {
  private down = new Set<string>();
  private pressedOnce = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  fire = false;
  aim = false;
  locked = false;
  private wheel = 0;

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

  consumeWheel() {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  takeMouse() {
    const d = { x: this.mouseDX, y: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.locked) return;
    if (e.code !== "Escape" && e.code !== "F11" && e.code !== "F12") e.preventDefault();
    if (!this.down.has(e.code)) this.pressedOnce.add(e.code);
    this.down.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent) => this.down.delete(e.code);
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
    if (e.button === 0) this.fire = true;
    if (e.button === 2) this.aim = true;
  };
  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.fire = false;
    if (e.button === 2) this.aim = false;
  };
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
