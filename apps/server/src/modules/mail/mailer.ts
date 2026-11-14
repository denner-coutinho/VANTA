import nodemailer from "nodemailer";
import type { FastifyBaseLogger } from "fastify";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

export class SmtpMailer implements Mailer {
  private transport;
  constructor(opts: { host: string; port: number; user?: string; pass?: string; from: string }) {
    this.from = opts.from;
    this.transport = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.port === 465,
      auth: opts.user ? { user: opts.user, pass: opts.pass } : undefined,
    });
  }
  private from: string;
  async send(msg: MailMessage) {
    await this.transport.sendMail({ from: this.from, ...msg });
  }
}

/** Desenvolvimento sem SMTP: registra o e-mail no log. Nunca usado em produção. */
export class LogMailer implements Mailer {
  constructor(private readonly log: FastifyBaseLogger) {}
  async send(msg: MailMessage) {
    this.log.warn({ to: msg.to, subject: msg.subject }, `[e-mail de desenvolvimento]\n${msg.text}`);
  }
}

/** Usado nos testes: guarda as mensagens em memória. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(msg: MailMessage) {
    this.sent.push(msg);
  }
  lastTo(email: string): MailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === email);
  }
}
