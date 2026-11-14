import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const Errors = {
  badRequest: (code: string, msg: string, details?: unknown) => new AppError(400, code, msg, details),
  unauthorized: (msg = "Autenticação necessária.") => new AppError(401, "UNAUTHORIZED", msg),
  forbidden: (msg = "Você não tem permissão para esta ação.") => new AppError(403, "FORBIDDEN", msg),
  notFound: (msg = "Recurso não encontrado.") => new AppError(404, "NOT_FOUND", msg),
  conflict: (code: string, msg: string) => new AppError(409, code, msg),
  tooMany: (msg: string, retryAfterSec?: number) => new AppError(429, "TOO_MANY_REQUESTS", msg, retryAfterSec ? { retryAfterSec } : undefined),
};

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof AppError) {
    if (err.statusCode === 429 && (err.details as { retryAfterSec?: number })?.retryAfterSec) {
      reply.header("Retry-After", String((err.details as { retryAfterSec: number }).retryAfterSec));
    }
    return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof ZodError) {
    return reply.status(400).send({
      error: {
        code: "VALIDATION_ERROR",
        message: err.issues[0]?.message ?? "Dados inválidos.",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
  }
  const fe = err as FastifyError;
  if (fe.statusCode === 429) {
    return reply.status(429).send({ error: { code: "TOO_MANY_REQUESTS", message: "Muitas requisições. Aguarde um pouco e tente novamente." } });
  }
  if (fe.statusCode && fe.statusCode < 500) {
    return reply.status(fe.statusCode).send({ error: { code: fe.code ?? "BAD_REQUEST", message: fe.message } });
  }
  req.log.error({ err }, "Erro interno");
  return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Erro interno do servidor." } });
}
