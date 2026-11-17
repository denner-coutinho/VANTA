import { describe, expect, it } from "vitest";
import { banInputSchema, canRevoke, hasPermission, maskEmail, outranks, punishmentError, resolveReportSchema } from "./admin.js";
import { DEFAULT_KEYBINDS, assignKey, clearKey, isBindableCode, keyLabel, sanitizeKeybinds } from "./keybinds.js";

describe("permissões do painel", () => {
  it("cada cargo herda o anterior e só o superadmin mexe em cargos", () => {
    expect(hasPermission("PLAYER", "panel.view")).toBe(false);
    expect(hasPermission("MODERATOR", "reports.handle")).toBe(true);
    expect(hasPermission("MODERATOR", "users.viewEmail")).toBe(false);
    expect(hasPermission("MODERATOR", "wallet.adjust")).toBe(false);
    expect(hasPermission("ADMIN", "wallet.adjust")).toBe(true);
    expect(hasPermission("ADMIN", "roles.manage")).toBe(false);
    expect(hasPermission("SUPERADMIN", "roles.manage")).toBe(true);
  });

  it("só age sobre cargo menor", () => {
    expect(outranks("MODERATOR", "PLAYER")).toBe(true);
    expect(outranks("MODERATOR", "MODERATOR")).toBe(false);
    expect(outranks("ADMIN", "SUPERADMIN")).toBe(false);
  });

  it("moderador tem prazo máximo e não aplica ranqueado nem permanente", () => {
    expect(punishmentError("MODERATOR", "CHAT_MUTE", 24)).toBeNull();
    expect(punishmentError("MODERATOR", "CHAT_MUTE", 24 * 8)).toMatch(/168 horas/);
    expect(punishmentError("MODERATOR", "SUSPENSION", 72)).toBeNull();
    expect(punishmentError("MODERATOR", "SUSPENSION", 73)).toMatch(/72 horas/);
    expect(punishmentError("MODERATOR", "RANKED_BAN", 24)).toMatch(/não pode/);
    expect(punishmentError("MODERATOR", "PERMANENT", null)).toMatch(/não pode/);
    expect(punishmentError("ADMIN", "SUSPENSION", 24 * 30)).toBeNull();
    expect(punishmentError("ADMIN", "PERMANENT", null)).toBeNull();
    expect(canRevoke("MODERATOR", "SUSPENSION")).toBe(true);
    expect(canRevoke("MODERATOR", "PERMANENT")).toBe(false);
  });

  it("valida a punição e a resolução da denúncia", () => {
    expect(banInputSchema.safeParse({ type: "PERMANENT", reason: "trapaça comprovada", hours: 10 }).success).toBe(false);
    expect(banInputSchema.safeParse({ type: "SUSPENSION", reason: "ofensas", hours: null }).success).toBe(false);
    expect(banInputSchema.safeParse({ type: "SUSPENSION", reason: "ofen", hours: 2 }).success).toBe(false);
    expect(banInputSchema.safeParse({ type: "SUSPENSION", reason: "ofensas no chat", hours: 2 }).success).toBe(true);
    expect(resolveReportSchema.safeParse({ status: "DISMISSED" }).success).toBe(false);
    expect(resolveReportSchema.safeParse({ status: "IN_REVIEW" }).success).toBe(true);
    expect(resolveReportSchema.safeParse({ status: "DISMISSED", resolution: "sem provas", ban: { type: "CHAT_MUTE", reason: "teste de motivo", hours: 1 } }).success).toBe(false);
  });

  it("mascara o e-mail", () => {
    expect(maskEmail("joana@exemplo.com")).toBe("jo***@exemplo.com");
  });
});

describe("teclas remapeáveis", () => {
  it("o padrão é válido e não repete tecla", () => {
    const all = Object.values(DEFAULT_KEYBINDS).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(sanitizeKeybinds(DEFAULT_KEYBINDS)).toEqual(DEFAULT_KEYBINDS);
  });

  it("limpa lixo, teclas reservadas e repetidas", () => {
    const s = sanitizeKeybinds({ forward: ["KeyI", "Escape", "<script>"], back: ["KeyI", "KeyK"], jump: "Space", fire: ["Mouse9"] });
    expect(s.forward).toEqual(["KeyI"]);
    expect(s.back).toEqual(["KeyK"]);
    expect(s.jump).toEqual(["Space"]); // não era lista: volta ao padrão
    expect(s.fire).toEqual(["Mouse0"]); // inválida: volta ao padrão
    expect(isBindableCode("F12")).toBe(false);
    expect(isBindableCode("Mouse3")).toBe(true);
  });

  it("trocar uma tecla tira ela da outra ação", () => {
    const { binds, takenFrom } = assignKey(DEFAULT_KEYBINDS, "jump", 0, "KeyR");
    expect(binds.jump).toEqual(["KeyR"]);
    expect(binds.reload).toEqual([]);
    expect(takenFrom).toBe("reload");
    expect(assignKey(DEFAULT_KEYBINDS, "jump", 1, "KeyV").binds.jump).toEqual(["Space", "KeyV"]);
    expect(assignKey(DEFAULT_KEYBINDS, "jump", 0, "Escape").binds).toBe(DEFAULT_KEYBINDS);
    expect(clearKey(DEFAULT_KEYBINDS, "forward", 1).forward).toEqual(["KeyW"]);
    expect(keyLabel("Mouse2")).toBe("Botão direito");
    expect(keyLabel("KeyG")).toBe("G");
  });
});
