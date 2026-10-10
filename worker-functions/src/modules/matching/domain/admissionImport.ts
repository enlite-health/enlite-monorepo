import type { TactiqMeetingItem, TactiqTranscriptPage } from '../application/ports/TactiqPorts';

/** A importação só começa 10 min depois do fim REAL da call (F5 grava `conference_ended_at`). */
export const IMPORT_MIN_DELAY_MS = 10 * 60 * 1000;
/** 72 h sem transcrição -> `expired` + alarme (spec §4.3). */
export const IMPORT_EXPIRE_AFTER_MS = 72 * 60 * 60 * 1000;
/**
 * Depois deste tempo do fim real, a conta vinculada que NÃO enxerga reunião nenhuma com o código é tratada como conta errada
 * (spec §3.0.1, passo 5). ⚙️ (minha, a confirmar): a spec não fixa a espera; 3 h cobre o atraso normal de sincronia do Tactiq.
 * Limite conhecido: "extensão desligada" e "conta errada" são indistinguíveis só pelo MCP (ver §11).
 */
export const WRONG_ACCOUNT_AFTER_MS = 3 * 60 * 60 * 1000;
/** P3: `createdAt` em [início − 15 min, início + 60 min]. */
export const MATCH_WINDOW_BEFORE_MS = 15 * 60 * 1000;
export const MATCH_WINDOW_AFTER_MS = 60 * 60 * 1000;
/** Teto de páginas por reunião (1 h de admissão ~ 3 páginas; 2 h = 5). Passou disso, é anomalia: não importa. */
export const MAX_TRANSCRIPT_PAGES = 40;

export function matchWindow(slotStart: Date): { from: Date; to: Date } {
  return {
    from: new Date(slotStart.getTime() - MATCH_WINDOW_BEFORE_MS),
    to: new Date(slotStart.getTime() + MATCH_WINDOW_AFTER_MS),
  };
}

/**
 * P1: o título contém o código EXATO. `ADM-7K3Q9P` não casa com `ADM-7K3Q9PX` nem com `XADM-7K3Q9P` (fronteira de
 * alfanumérico dos dois lados) — `includes` aceitaria um código parecido e importaria a transcrição de OUTRA reunião.
 */
export function titleHasExactCode(title: string, code: string): boolean {
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![0-9A-Za-z])${escaped}(?![0-9A-Za-z])`).test(title);
}

export type MatchDecision =
  | { kind: 'none'; reason: 'not_found' | 'code_mismatch' }
  | { kind: 'rejected'; reason: 'time_window' }
  | { kind: 'ambiguous'; reason: 'overlap' }
  | { kind: 'matched'; parts: TactiqMeetingItem[] };

function startOf(m: TactiqMeetingItem): number {
  return Date.parse(m.createdAt);
}

/**
 * O que a lista devolvida pelo MCP diz sobre a reunião (spec §3.3), sem I/O:
 *  - P1 código exato no título; P3 `createdAt` na janela e `durationSeconds > 0`;
 *  - 1 candidata -> importa; 2+ SEM sobreposição no tempo (queda de conexão) -> partes em ordem cronológica;
 *  - 2+ sobrepostas -> ambígua (nada é importado).
 * A autoria (P2) não está aqui: vem de a chamada usar o token do responsável.
 */
export function decideMatch(input: { code: string; slotStart: Date; items: readonly TactiqMeetingItem[] }): MatchDecision {
  const { code, slotStart, items } = input;
  const titled = items.filter((m) => titleHasExactCode(m.title, code));
  if (titled.length === 0) return { kind: 'none', reason: items.length === 0 ? 'not_found' : 'code_mismatch' };

  const { from, to } = matchWindow(slotStart);
  const byId = new Map<string, TactiqMeetingItem>();
  for (const m of titled) {
    const t = startOf(m);
    if (Number.isFinite(t) && t >= from.getTime() && t <= to.getTime() && m.durationSeconds > 0) byId.set(m.id, m);
  }
  const valid = [...byId.values()].sort((a, b) => startOf(a) - startOf(b));
  if (valid.length === 0) return { kind: 'rejected', reason: 'time_window' };

  for (let i = 1; i < valid.length; i += 1) {
    const previousEnd = startOf(valid[i - 1]) + valid[i - 1].durationSeconds * 1000;
    if (startOf(valid[i]) < previousEnd) return { kind: 'ambiguous', reason: 'overlap' };
  }
  return { kind: 'matched', parts: valid };
}

export type AssembleResult =
  | { ok: true; text: string; chars: number }
  | { ok: false; reason: 'integrity' };

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Integridade (spec §3.3): páginas 1..N em sequência, todas dizendo o mesmo `totalChars`, e a soma dos caracteres das
 * entradas IGUAL a esse total. Qualquer divergência -> não importa (um trecho perdido viraria um resumo errado).
 */
export function assembleTranscript(pages: readonly TactiqTranscriptPage[]): AssembleResult {
  if (pages.length === 0) return { ok: false, reason: 'integrity' };
  const total = pages[0].totalChars;
  let chars = 0;
  const lines: string[] = [];
  for (let i = 0; i < pages.length; i += 1) {
    const p = pages[i];
    if (p.page !== i + 1 || p.totalChars !== total) return { ok: false, reason: 'integrity' };
    for (const e of p.entries) {
      chars += e.text.length;
      lines.push(`[${clock(e.startSeconds)}] ${e.speaker}: ${e.text}`);
    }
  }
  if (chars !== total || total <= 0) return { ok: false, reason: 'integrity' };
  return { ok: true, text: lines.join('\n'), chars };
}

/** Várias partes: cabeçalho por parte, em ordem cronológica. Uma parte só: o texto puro. */
export function joinParts(parts: ReadonlyArray<{ meetingId: string; text: string }>): string {
  if (parts.length === 1) return parts[0].text;
  return parts.map((p, i) => `=== Parte ${i + 1} de ${parts.length} · ${p.meetingId} ===\n${p.text}`).join('\n\n');
}
