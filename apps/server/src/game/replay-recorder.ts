import { createGzip, gunzipSync, type Gzip } from "node:zlib";
import type { ReplayFile, SpecFrame } from "@vanta/shared";

export type ReplayHeader = Omit<ReplayFile, "frames">;

export interface EncodedReplay {
  matchId: string;
  version: number;
  /** ReplayFile em JSON, compactado com gzip (um único membro: o navegador abre com DecompressionStream). */
  data: Buffer;
  frameCount: number;
  firstTick: number;
  lastTick: number;
}

/** Quadros serializados acumulados antes de mandar para o compressor (~2 s de partida). */
const BATCH_FRAMES = 30;

/**
 * Grava o replay compactando enquanto a partida acontece (Fase 8, parte 2).
 *
 * Antes, os quadros ficavam como objetos na memória até o fim: uma partida 3v3 de 20 minutos
 * ocupava ~40 MB de heap, e o JSON + gzip de tudo no fim travava o loop de 60 Hz de todas as
 * partidas do processo. Agora cada quadro vira JSON na hora e vai para um gzip em streaming
 * (que roda fora da thread principal); na memória fica só o resultado compactado.
 *
 * O arquivo final continua sendo o mesmo ReplayFile em JSON: {"frames":[...], ...cabeçalho}.
 */
export class ReplayRecorder {
  private gz: Gzip;
  private chunks: Buffer[] = [];
  private batch: string[] = [];
  /** Último quadro, ainda em objeto: dois envios no mesmo tick (ex.: fim da partida) se juntam nele. */
  private last: SpecFrame | null = null;
  private wrote = false;
  private done: Promise<void>;
  private finished = false;
  frameCount = 0;
  firstTick = -1;
  lastTick = -1;

  constructor() {
    this.gz = createGzip({ level: 6, memLevel: 7 });
    this.gz.on("data", (c: Buffer) => this.chunks.push(c));
    this.done = new Promise((resolve, reject) => {
      this.gz.once("end", resolve);
      this.gz.once("error", reject);
    });
    this.gz.write('{"frames":[');
  }

  push(frame: SpecFrame) {
    if (this.finished) return;
    if (this.last?.tick === frame.tick) {
      this.last = { ...frame, ev: [...this.last.ev, ...frame.ev] };
      return;
    }
    this.flushLast();
    this.last = frame;
    if (this.firstTick < 0) this.firstTick = frame.tick;
    this.lastTick = frame.tick;
    this.frameCount++;
  }

  private flushLast() {
    if (!this.last) return;
    this.batch.push(JSON.stringify(this.last));
    this.last = null;
    if (this.batch.length >= BATCH_FRAMES) this.writeBatch();
  }

  private writeBatch() {
    if (!this.batch.length) return;
    this.gz.write((this.wrote ? "," : "") + this.batch.join(","));
    this.wrote = true;
    this.batch = [];
  }

  /** Fecha o arquivo com o cabeçalho e devolve o gzip pronto. */
  async finish(header: ReplayHeader): Promise<EncodedReplay> {
    if (!this.finished) {
      this.finished = true;
      this.flushLast();
      this.writeBatch();
      const head = JSON.stringify(header);
      this.gz.end("]" + (head.length > 2 ? "," + head.slice(1) : "}"));
    }
    await this.done;
    return { matchId: header.matchId, version: header.v, data: Buffer.concat(this.chunks), frameCount: this.frameCount, firstTick: this.firstTick, lastTick: this.lastTick };
  }

  /** Para quem monta o replay inteiro de uma vez (testes, ferramentas). */
  static fromFile(file: ReplayFile): PendingReplay {
    const { frames, ...header } = file;
    const recorder = new ReplayRecorder();
    for (const f of frames) recorder.push(f);
    return { header, recorder };
  }
}

/** Replay de uma partida que acabou: cabeçalho pronto, compressão ainda terminando. */
export interface PendingReplay {
  header: ReplayHeader;
  recorder: ReplayRecorder;
}

export function decodeReplay(e: EncodedReplay | Buffer): ReplayFile {
  return JSON.parse(gunzipSync(Buffer.isBuffer(e) ? e : e.data).toString()) as ReplayFile;
}
