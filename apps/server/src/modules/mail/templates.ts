import type { MailMessage } from "./mailer.js";

const wrap = (title: string, body: string, cta: { label: string; url: string }) => `<!doctype html>
<html lang="pt-BR"><body style="margin:0;background:#090B12;font-family:Arial,sans-serif;color:#F4F6FA">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table width="560" cellpadding="0" cellspacing="0" style="background:#121725;border:1px solid #222938;border-radius:8px">
<tr><td style="padding:28px 32px;border-bottom:1px solid #222938;letter-spacing:4px;font-weight:bold">VANTA<span style="color:#287BFF">:</span> FRONTLINE</td></tr>
<tr><td style="padding:32px"><h1 style="margin:0 0 16px;font-size:22px">${title}</h1>${body}
<p style="margin:28px 0"><a href="${cta.url}" style="background:#287BFF;color:#fff;text-decoration:none;padding:14px 26px;border-radius:4px;font-weight:bold;letter-spacing:1px">${cta.label}</a></p>
<p style="color:#8C96A8;font-size:12px">Se o botão não funcionar, copie e cole este link no navegador:<br>${cta.url}</p>
</td></tr></table></td></tr></table></body></html>`;

export function verificationEmail(to: string, username: string, url: string): MailMessage {
  return {
    to,
    subject: "Confirme seu e-mail — VANTA: FRONTLINE",
    text: `Olá, ${username}!\n\nConfirme seu e-mail para ativar todos os recursos da conta:\n${url}\n\nO link expira em 24 horas. Se você não criou esta conta, ignore esta mensagem.`,
    html: wrap(`Bem-vindo, ${username}`, `<p>Confirme seu e-mail para ativar todos os recursos da sua conta. O link expira em 24 horas.</p><p style="color:#8C96A8">Se você não criou esta conta, ignore esta mensagem.</p>`, { label: "CONFIRMAR E-MAIL", url }),
  };
}

export function passwordResetEmail(to: string, username: string, url: string): MailMessage {
  return {
    to,
    subject: "Redefinição de senha — VANTA: FRONTLINE",
    text: `Olá, ${username}.\n\nRecebemos um pedido para redefinir sua senha:\n${url}\n\nO link expira em 1 hora e só pode ser usado uma vez. Se não foi você, ignore esta mensagem: sua senha continua a mesma.`,
    html: wrap("Redefinir senha", `<p>Recebemos um pedido para redefinir a senha da sua conta. O link expira em 1 hora e só pode ser usado uma vez.</p><p style="color:#8C96A8">Se não foi você, ignore esta mensagem: sua senha continua a mesma.</p>`, { label: "REDEFINIR SENHA", url }),
  };
}
