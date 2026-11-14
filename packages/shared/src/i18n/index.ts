import { ptBR } from "./pt-BR.js";

/** Idiomas suportados. Para adicionar um idioma: crie o arquivo com o mesmo formato de `ptBR`. */
export type Locale = "pt-BR";
export type Messages = typeof ptBR;
export const DEFAULT_LOCALE: Locale = "pt-BR";
export const MESSAGES: Record<Locale, Messages> = { "pt-BR": ptBR };
export { ptBR };
