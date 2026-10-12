/**
 * spec 050 F28 — o portão do modo rápido (R-51) e o destino do gatilho depois da importação. Regras sem banco e sem relógio.
 */
import { createFastGate } from '../AdmissionFastGate';
import { fastAfterImport } from '../AdmissionFastSummaryStep';
import type { TranscriptRead } from '../AdmissionTranscriptReader';

const lida = (...blocks: number[]): TranscriptRead => ({
  kind: 'read', parts: blocks.map((b, i) => ({ meetingId: `m${i}`, text: 't', sha256: 's', chars: 1, blocks: b })),
});

describe('createFastGate', () => {
  it('pronta: contagem > 0, igual à anterior, sala fechada → não segura (e guarda a contagem)', () => {
    const g = createFastGate({ previousCount: 3, conferenceOpen: false });
    expect(g.count).toBeUndefined();
    expect(g.hold(lida(3))).toBe(false);
    expect(g.count).toBe(3);
  });

  it.each([
    ['1ª leitura (sem anterior)', { previousCount: null, conferenceOpen: false }, lida(3)],
    ['contagem mudou', { previousCount: 3, conferenceOpen: false }, lida(4)],
    ['sala aberta', { previousCount: 3, conferenceOpen: true }, lida(3)],
  ])('segura: %s', (_n, input, read) => {
    const g = createFastGate(input);
    expect(g.hold(read)).toBe(true);
  });

  it('várias partes somam os blocos; zero blocos nunca é pronta', () => {
    const g = createFastGate({ previousCount: 5, conferenceOpen: false });
    expect(g.hold(lida(2, 3))).toBe(false);
    expect(g.count).toBe(5);
    expect(createFastGate({ previousCount: 0, conferenceOpen: false }).hold(lida(0))).toBe(true);
  });

  it('não achou / ambígua / janela / integridade / MCP / sem vínculo: segura com contagem nula (quem decide terminal é a rede)', () => {
    const casos: TranscriptRead[] = [
      { kind: 'verdict', decision: { kind: 'none', reason: 'not_found' } },
      { kind: 'verdict', decision: { kind: 'ambiguous', reason: 'overlap' } },
      { kind: 'verdict', decision: { kind: 'rejected', reason: 'time_window' } },
      { kind: 'integrity' },
      { kind: 'mcp_failed', err: new Error('x'), where: 'search' },
      { kind: 'no_access', reason: 'no_link' },
    ];
    for (const c of casos) {
      const g = createFastGate({ previousCount: 3, conferenceOpen: false });
      expect(g.hold(c)).toBe(true);
      expect(g.count).toBeNull();
    }
  });

  it('`busy` e o token transitório NÃO seguram aqui: seguem o caminho de sempre (transient) e a contagem fica sem valor', () => {
    for (const c of [{ kind: 'busy' }, { kind: 'no_access', reason: 'transient' }] as TranscriptRead[]) {
      const g = createFastGate({ previousCount: 3, conferenceOpen: false });
      expect(g.hold(c)).toBe(false);
      expect(g.count).toBeUndefined();
    }
  });
});

describe('fastAfterImport', () => {
  it('cada resultado da importação tem um destino para o gatilho', () => {
    expect(fastAfterImport('not_ready')).toBe('count_read');
    expect([fastAfterImport('transient'), fastAfterImport('skipped_locked')]).toEqual(['release', 'release']);
    expect([fastAfterImport('done'), fastAfterImport('summary_failed'), fastAfterImport('vault_failed')]).toEqual(['fired', 'fired', 'fired']);
    for (const o of ['already_done', 'blocked', 'skipped_test', 'not_eligible', 'expired', 'rejected', 'ambiguous', 'waiting', 'wrong_account', 'too_early'] as const) {
      expect(fastAfterImport(o)).toBe('cancel');
    }
  });
});
