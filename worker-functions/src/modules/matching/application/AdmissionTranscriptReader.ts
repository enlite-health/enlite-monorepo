import { createHash } from 'crypto';
import type { ImportCandidate } from '../infrastructure/AdmissionImportRepository';
import { MAX_TRANSCRIPT_PAGES, assembleTranscript, decideMatch, matchWindow, type MatchDecision } from '../domain/admissionImport';
import {
  TactiqTransientError,
  TactiqUnauthorizedError,
  type TactiqAccessFailure,
  type TactiqMcpPort,
  type TactiqMeetingItem,
  type TactiqTokenProvider,
} from './ports/TactiqPorts';

export type Transcript = { meetingId: string; text: string; sha256: string; chars: number };

/** O que os passos 1 a 4 da importação (token, busca, provas, páginas e integridade) concluíram. Fechado: o chamador decide o estado. */
export type TranscriptRead =
  | { kind: 'busy' }
  | { kind: 'no_access'; reason: TactiqAccessFailure }
  | { kind: 'mcp_failed'; err: unknown; where: 'search' | 'transcript' }
  | { kind: 'verdict'; decision: Exclude<MatchDecision, { kind: 'matched' }> }
  | { kind: 'integrity' }
  | { kind: 'read'; parts: Transcript[] };

export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/**
 * AdmissionTranscriptReader — a leitura do Tactiq da importação (spec 050 F27, R-53), EXTRAÍDA de `AdmissionImportService`.
 *
 * Tudo o que usa o token do responsável (busca por código + janela, as provas, TODAS as páginas e a integridade) acontece dentro
 * de `TactiqTokenProvider.withHostAccess`: uma leitura por vez por responsável. Cofre, Vertex e PDF ficam FORA, no chamador.
 * Não decide estado nem grava nada: devolve o resultado fechado.
 */
export class AdmissionTranscriptReader {
  constructor(
    private readonly tokens: TactiqTokenProvider,
    private readonly mcp: TactiqMcpPort,
  ) {}

  async read(a: Pick<ImportCandidate, 'host_email' | 'admission_code' | 'slot_start'>): Promise<TranscriptRead> {
    const code = a.admission_code as string;
    const access = await this.tokens.withHostAccess<TranscriptRead>(a.host_email, async (token) => {
      // 2. busca por código + janela, com o token do responsável.
      const window = matchWindow(a.slot_start);
      let items: TactiqMeetingItem[];
      try {
        items = await this.mcp.searchMeetings(token, { query: code, dateFrom: window.from.toISOString(), dateTo: window.to.toISOString() });
      } catch (err) {
        return { kind: 'mcp_failed', err, where: 'search' };
      }
      // 3. as provas (P1 código exato, P3 janela e duração, unicidade/partes).
      const decision = decideMatch({ code, slotStart: a.slot_start, items });
      if (decision.kind !== 'matched') return { kind: 'verdict', decision };
      // 4. integridade: todas as páginas, soma = totalChars, sha256 por parte.
      return this.readParts(token, decision.parts);
    });
    if (access.ok) return access.value;
    return access.reason === 'busy' ? { kind: 'busy' } : { kind: 'no_access', reason: access.reason };
  }

  /** Lê TODAS as páginas de cada parte (até `hasMore=false`) e confere a integridade. */
  private async readParts(token: string, meetings: TactiqMeetingItem[]): Promise<TranscriptRead> {
    const parts: Transcript[] = [];
    for (const m of meetings) {
      const pages = [];
      try {
        for (let page = 1; page <= MAX_TRANSCRIPT_PAGES + 1; page += 1) {
          const p = await this.mcp.getTranscriptPage(token, m.id, page);
          pages.push(p);
          if (!p.hasMore) break;
        }
      } catch (err) {
        return { kind: 'mcp_failed', err: err instanceof TactiqUnauthorizedError ? err : new TactiqTransientError('transcript'), where: 'transcript' };
      }
      if (pages.length > MAX_TRANSCRIPT_PAGES || pages[pages.length - 1].hasMore) return { kind: 'integrity' };
      const assembled = assembleTranscript(pages);
      if (!assembled.ok) return { kind: 'integrity' };
      parts.push({ meetingId: m.id, text: assembled.text, sha256: sha256Hex(assembled.text), chars: assembled.chars });
    }
    return { kind: 'read', parts };
  }
}
