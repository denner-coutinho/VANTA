import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";

/** Cria um PrismaClient. A API usa uma instância única por processo. */
export function createPrismaClient(url?: string): PrismaClient {
  return new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
}
