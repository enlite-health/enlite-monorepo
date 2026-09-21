/**
 * ConversationAttachmentValidator — pipeline de validação de anexo de conversa (spec 022, Bloco 3,
 * T308; D-14). Ordem FIXA, para no primeiro que falhar:
 *
 *  1. Tamanho (`MAX_ATTACHMENT_BYTES`) — defesa em profundidade; o limite "de verdade" é o
 *     `multer` na rota (413 antes deste código rodar), mas este validador não confia em nunca ser
 *     chamado fora de um multer configurado.
 *  2. Magic bytes (`file-type`) → allowlist de `content_type` (`ConversationAttachmentPolicy`).
 *  3. Imagem (`image/png`/`image/jpeg`): `sharp` re-encode SEM `.withMetadata()` — a ausência dela
 *     é o que garante 0 EXIF/GPS na saída (mesmo padrão de `PatientPhotoProcessor.ts`).
 *  4. PDF: recusa se o buffer contiver qualquer um de `/JavaScript`, `/JS`, `/OpenAction`,
 *     `/Launch`, `/EmbeddedFile` (nomes de objeto PDF são ASCII — varredura de string basta,
 *     nenhum parser de PDF precisa entrar no projeto só para isto).
 *  5. `.docx`: abre o zip com `yauzl` (lê o DIRETÓRIO CENTRAL — mais robusto que o parsing
 *     sequencial que `file-type` faz só para detectar o tipo) e recusa se existir a entrada
 *     `word/vbaProject.bin` OU se `[Content_Types].xml` contiver `macroEnabled`.
 *  6. `.doc` legado: `file-type` não distingue `.doc`/`.xls`/`.ppt` dentro de um Compound File
 *     Binary sem inspecionar o stream inteiro (medido nesta sessão: `file-type@16` devolve
 *     `application/x-cfb` genérico mesmo para um CFB com um stream `WordDocument` de verdade) —
 *     por isso QUALQUER CFB (`application/x-cfb`) cai neste balde, junto com o `application/msword`
 *     nomeado em D-14 (caso uma versão futura do detector avance a distinção). Nenhum tipo da
 *     allowlist é CFB-based, então tratar os dois juntos não abre exceção nenhuma.
 *
 * `file-type` é ESM-only (`"type": "module"`) — a versão instalada (`file-type@16.5.4`, fixada em
 * T005/F7 por ser CJS) resolve certo em runtime, mas o RE-EXPORT `export { fromBuffer, ... } from
 * './core'` do `index.d.ts` quebra o TYPE CHECKER deste projeto (`moduleResolution: "node"` +
 * `export =` em `core.d.ts` — TS2305/TS2339 medidos nesta sessão). Import direto de
 * `'file-type/core'` via `import X = require(...)` (sintaxe canônica para módulo `export =`)
 * contorna o problema sem tocar `tsconfig.json`.
 */
import type { Readable } from 'stream';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import FileType = require('file-type/core');
import yauzl from 'yauzl';
import sharp from 'sharp';
import {
  MAX_ATTACHMENT_BYTES,
  isAllowedAttachmentContentType,
  type AllowedAttachmentContentType,
} from './ConversationAttachmentPolicy';

export type AttachmentRejectionCode =
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'MALICIOUS_CONTENT_DETECTED'
  | 'LEGACY_DOC_NOT_ALLOWED';

export interface AttachmentValidationOk {
  ok: true;
  contentType: AllowedAttachmentContentType;
  /** Buffer FINAL a subir — re-codificado (sem EXIF) para imagem; idêntico ao de entrada nos demais tipos. */
  buffer: Buffer;
}

export interface AttachmentValidationFail {
  ok: false;
  code: AttachmentRejectionCode;
  message: string;
}

export type AttachmentValidationResult = AttachmentValidationOk | AttachmentValidationFail;

/** CFB genérico (`.doc`/`.xls`/`.ppt` legados) — ver nota de classe sobre a limitação do detector. */
const LEGACY_OFFICE_MIME_TYPES = new Set(['application/x-cfb', 'application/msword']);

/** Nomes de objeto PDF que indicam conteúdo ativo/malicioso (D-14) — ASCII, varredura direta de string. */
const PDF_MALICIOUS_TOKENS = ['/JavaScript', '/JS', '/OpenAction', '/Launch', '/EmbeddedFile'];

const LEGACY_DOC_MESSAGE = 'Formato .doc no es aceptado; guardá como .docx / Formato .doc não é aceito; salve como .docx';

/**
 * Teto de `[Content_Types].xml` DECLARADO no header do zip (achado MÉDIO do gate revisao-pr, B3):
 * `readZipEntries` lia essa entrada INTEIRA em memória (`chunks.push`) sem checar
 * `entry.uncompressedSize` antes — um `.docx` de até `MAX_ATTACHMENT_BYTES` (10 MB, já checado
 * ANTES desta função) pode ainda assim declarar essa entrada com um `uncompressedSize` gigante no
 * header (yauzl lê o valor do DIRETÓRIO CENTRAL, sem decodificar nada) — DoS de memória da API
 * antes de qualquer detecção de macro rodar. 1 MB é generoso: um `[Content_Types].xml` real de
 * `.docx` tem algumas centenas de bytes.
 */
const MAX_CONTENT_TYPES_XML_BYTES = 1 * 1024 * 1024;
/** Teto AGREGADO (soma de `uncompressedSize` de TODAS as entradas) — mesma defesa contra zip bomb
 * clássico (poucos bytes comprimidos que declaram uma expansão enorme), mesmo quando nenhuma
 * entrada isolada excede o teto acima. */
const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

/** Erro interno de `readZipEntries` — o header do zip (`entry.uncompressedSize`, lido do
 *  diretório central, nunca decodificado) declara um tamanho acima do teto ANTES de qualquer
 *  `openReadStream`. `validateDocx` traduz para `MALICIOUS_CONTENT_DETECTED` (não
 *  `UNSUPPORTED_MEDIA_TYPE` — um zip malformado de verdade cai no catch genérico). */
class ZipEntryTooLargeError extends Error {}

export class ConversationAttachmentValidator {
  async validate(buffer: Buffer): Promise<AttachmentValidationResult> {
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      return { ok: false, code: 'FILE_TOO_LARGE', message: `Arquivo excede o limite de ${MAX_ATTACHMENT_BYTES} bytes` };
    }

    const detected = await this.detectType(buffer);
    const mime = detected?.mime;

    if (mime && LEGACY_OFFICE_MIME_TYPES.has(mime)) {
      return { ok: false, code: 'LEGACY_DOC_NOT_ALLOWED', message: LEGACY_DOC_MESSAGE };
    }

    if (!mime || !isAllowedAttachmentContentType(mime)) {
      return {
        ok: false,
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: mime ? `Tipo de arquivo não suportado: ${mime}` : 'Tipo de arquivo não reconhecido',
      };
    }

    if (mime === 'image/png' || mime === 'image/jpeg') {
      return this.validateImage(buffer, mime);
    }

    if (mime === 'application/pdf') {
      return this.validatePdf(buffer);
    }

    // única allowlist restante: docx
    return this.validateDocx(buffer);
  }

  /** `file-type` pode lançar (`strtok3.EndOfStreamError` e afins) em buffer pequeno/truncado —
   *  nunca deve virar 500: sem detecção = `UNSUPPORTED_MEDIA_TYPE` (fail-closed). */
  private async detectType(buffer: Buffer): Promise<{ ext: string; mime: string } | undefined> {
    try {
      return await FileType.fromBuffer(buffer);
    } catch {
      return undefined;
    }
  }

  private async validateImage(buffer: Buffer, mime: 'image/png' | 'image/jpeg'): Promise<AttachmentValidationResult> {
    try {
      const pipeline = sharp(buffer, { failOn: 'error' }).rotate(); // aplica orientação EXIF antes de descartá-la
      // Sem `.withMetadata()` de propósito — é a ausência dela que garante 0 EXIF/GPS na saída.
      const reencoded = mime === 'image/png' ? await pipeline.png().toBuffer() : await pipeline.jpeg({ quality: 90 }).toBuffer();
      return { ok: true, contentType: mime, buffer: reencoded };
    } catch {
      return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Imagem inválida ou corrompida' };
    }
  }

  private validatePdf(buffer: Buffer): AttachmentValidationResult {
    // Nomes de objeto PDF são ASCII — `latin1` preserva 1 byte = 1 char, suficiente para a busca.
    const text = buffer.toString('latin1');
    const hasMaliciousToken = PDF_MALICIOUS_TOKENS.some((token) => text.includes(token));
    if (hasMaliciousToken) {
      return { ok: false, code: 'MALICIOUS_CONTENT_DETECTED', message: 'PDF contém conteúdo ativo não permitido' };
    }
    return { ok: true, contentType: 'application/pdf', buffer };
  }

  private async validateDocx(buffer: Buffer): Promise<AttachmentValidationResult> {
    let entries: string[];
    let contentTypesXml: string | null;
    try {
      ({ entries, contentTypesXml } = await this.readZipEntries(buffer));
    } catch (err) {
      if (err instanceof ZipEntryTooLargeError) {
        return { ok: false, code: 'MALICIOUS_CONTENT_DETECTED', message: '.docx com entrada de tamanho suspeito (possível zip bomb)' };
      }
      return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: '.docx inválido ou corrompido' };
    }

    if (entries.includes('word/vbaProject.bin')) {
      return { ok: false, code: 'MALICIOUS_CONTENT_DETECTED', message: '.docx contém macro (VBA) não permitida' };
    }
    if (contentTypesXml?.includes('macroEnabled')) {
      return { ok: false, code: 'MALICIOUS_CONTENT_DETECTED', message: '.docx contém macro habilitada não permitida' };
    }

    return {
      ok: true,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer,
    };
  }

  /** `yauzl` promisificado — lê o DIRETÓRIO CENTRAL (nomes de todas as entradas) e o conteúdo de
   *  `[Content_Types].xml` quando presente. `try/finally` fecha o `zipfile` sempre (arquivo
   *  corrompido não pode vazar file handle).
   *
   *  🔒 Achado do gate revisao-pr (B3): `entry.uncompressedSize` vem do DIRETÓRIO CENTRAL (metadado
   *  do header, `yauzl` não decodifica nada pra obter esse número) — checar ANTES de
   *  `openReadStream` rejeita um zip bomb (entrada com tamanho declarado gigante) SEM gastar
   *  memória nenhuma decodificando. Duas checagens: por entrada (`[Content_Types].xml`, a única
   *  que este código efetivamente LÊ) e agregada (soma de todas — mesma defesa mesmo se o ataque
   *  mirar outra entrada qualquer do zip). */
  private readZipEntries(buffer: Buffer): Promise<{ entries: string[]; contentTypesXml: string | null }> {
    return new Promise((resolve, reject) => {
      yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
        if (err || !zipfile) { reject(err ?? new Error('zip inválido')); return; }

        const entries: string[] = [];
        let contentTypesXml: string | null = null;
        let totalUncompressedBytes = 0;
        let settled = false;

        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          try { zipfile.close(); } catch { /* já fechado */ }
          if (error) reject(error);
          else resolve({ entries, contentTypesXml });
        };

        zipfile.on('error', (error) => finish(error));
        zipfile.on('end', () => finish());

        zipfile.on('entry', (entry: yauzl.Entry) => {
          entries.push(entry.fileName);

          totalUncompressedBytes += entry.uncompressedSize;
          if (totalUncompressedBytes > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
            finish(new ZipEntryTooLargeError('soma de uncompressedSize do zip acima do teto (possível zip bomb)'));
            return;
          }

          if (entry.fileName !== '[Content_Types].xml' || /\/$/.test(entry.fileName)) {
            zipfile.readEntry();
            return;
          }
          if (entry.uncompressedSize > MAX_CONTENT_TYPES_XML_BYTES) {
            finish(new ZipEntryTooLargeError('[Content_Types].xml declara tamanho acima do teto (possível zip bomb)'));
            return;
          }
          zipfile.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream) { finish(streamErr ?? new Error('falha ao ler [Content_Types].xml')); return; }
            const chunks: Buffer[] = [];
            (stream as Readable).on('data', (chunk: Buffer) => chunks.push(chunk));
            (stream as Readable).on('end', () => {
              contentTypesXml = Buffer.concat(chunks).toString('utf8');
              zipfile.readEntry();
            });
            (stream as Readable).on('error', (streamReadErr) => finish(streamReadErr));
          });
        });

        zipfile.readEntry();
      });
    });
  }
}
