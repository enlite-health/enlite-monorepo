import { IMPORT_EXPIRE_AFTER_MS } from '../admissionImport';
import {
  HUMAN_BLOCK_REASONS,
  IMPORT_REMINDER_EVERY_MS,
  MAX_IMPORT_REMINDERS,
  decideStandingBlock,
  isLastReminder,
  noReminderFits,
  type StandingBlockDecision,
} from '../importBlockPolicy';

const MIN = 60_000;
const H = 60 * MIN;
const ENDED = new Date('2026-11-02T12:00:00Z');
const at = (base: Date, deltaMs: number): Date => new Date(base.getTime() + deltaMs);
/** Bloqueio normal: 10 min depois do fim. */
const BLOCKED = at(ENDED, 10 * MIN);

const decide = (sinceBlockMs: number, remindersSent: number, over: { blockedAt?: Date; linkedSinceBlock?: boolean } = {}): StandingBlockDecision =>
  decideStandingBlock({
    now: at(over.blockedAt ?? BLOCKED, sinceBlockMs),
    endedAt: ENDED,
    blockedAt: over.blockedAt ?? BLOCKED,
    remindersSent,
    linkedSinceBlock: over.linkedSinceBlock ?? false,
  });

describe('importBlockPolicy — constantes', () => {
  it('motivos humanos = no_link e wrong_account; 24 h; no máximo 2 lembretes; expira em 72 h', () => {
    expect([...HUMAN_BLOCK_REASONS]).toEqual(['no_link', 'wrong_account']);
    expect(IMPORT_REMINDER_EVERY_MS).toBe(24 * H);
    expect(MAX_IMPORT_REMINDERS).toBe(2);
    expect(IMPORT_EXPIRE_AFTER_MS).toBe(72 * H);
  });
});

describe('decideStandingBlock — instantes desde o bloqueio (bloqueio em fim+10 min)', () => {
  it.each<[string, number, number, StandingBlockDecision]>([
    ['0', 0, 0, 'wait'],
    ['14 min', 14 * MIN, 0, 'wait'],
    ['24 h, 0 lembretes', 24 * H, 0, 'remind'],
    ['47 h, 1 lembrete', 47 * H, 1, 'wait'],
    ['48 h, 1 lembrete', 48 * H, 1, 'remind'],
    ['48 h, 0 lembretes (rodadas perdidas): só o 1º é devido', 48 * H, 0, 'remind'],
    ['71 h, 2 lembretes', 71 * H, 2, 'wait'],
    ['fim+72 h (bloqueio+71h50)', 72 * H - 10 * MIN, 2, 'expire'],
    ['fim+72 h com 1 lembrete', 72 * H - 10 * MIN, 1, 'expire'],
    ['72 h desde o bloqueio, 2 lembretes', 72 * H, 2, 'expire'],
  ])('%s → %s', (_n, sinceBlock, sent, expected) => {
    expect(decide(sinceBlock, sent)).toBe(expected);
  });

  it('o teto de 2 lembretes vale mesmo que o relógio permita (nunca um 3º)', () => {
    // bloqueio logo no fim da call: o 3º nominal (bloqueio+72 h) já é >= fim+72 h, mas o teto é o que o segura antes.
    const early = at(ENDED, 0);
    expect(decideStandingBlock({ now: at(early, 71 * H), endedAt: ENDED, blockedAt: early, remindersSent: 2, linkedSinceBlock: false })).toBe('wait');
    expect(decideStandingBlock({ now: at(early, 48 * H), endedAt: ENDED, blockedAt: early, remindersSent: MAX_IMPORT_REMINDERS, linkedSinceBlock: false })).toBe('wait');
  });

  it('vínculo mais novo reabre, antes de qualquer outra decisão (inclusive depois do prazo)', () => {
    expect(decide(0, 0, { linkedSinceBlock: true })).toBe('reopen');
    expect(decide(100 * H, 2, { linkedSinceBlock: true })).toBe('reopen');
  });

  it('bloqueio em fim+30 h: cabe 1 lembrete (fim+54 h) e ele é o último; o 2º nominal (fim+78 h) não cabe', () => {
    const late = at(ENDED, 30 * H);
    expect(noReminderFits(late, ENDED)).toBe(false);
    expect(isLastReminder(0, late, ENDED)).toBe(false); // o próximo (nº 1) ainda cabe em fim+54 h < fim+72 h
    expect(decide(24 * H, 0, { blockedAt: late })).toBe('remind');
    expect(isLastReminder(1, late, ENDED)).toBe(true); // depois do 1º, bloqueio+48 h = fim+78 h >= fim+72 h
    expect(decide(48 * H, 1, { blockedAt: late })).toBe('expire'); // fim+78 h já passou de fim+72 h
    expect(decide(30 * H, 1, { blockedAt: late })).toBe('wait');
  });

  it('bloqueio em fim+50 h: nenhum lembrete cabe (a gestão vai no aviso inicial)', () => {
    const late = at(ENDED, 50 * H);
    expect(noReminderFits(late, ENDED)).toBe(true);
    expect(decide(24 * H, 0, { blockedAt: late })).toBe('expire'); // fim+74 h
    expect(decide(21 * H, 0, { blockedAt: late })).toBe('wait'); // fim+71 h: o lembrete nominal (fim+74 h) não cabe
  });
});

describe('isLastReminder / noReminderFits — caso normal', () => {
  it('normal (bloqueio em fim+10 min): o lembrete 1 não é o último; o 2 é', () => {
    expect(noReminderFits(BLOCKED, ENDED)).toBe(false);
    expect(isLastReminder(1, BLOCKED, ENDED)).toBe(false);
    expect(isLastReminder(2, BLOCKED, ENDED)).toBe(true);
  });

  it('limite exato: bloqueio + 24 h × (n+1) === fim + 72 h conta como "não cabe" (>=)', () => {
    const edge = at(ENDED, 48 * H); // bloqueio+24 h = fim+72 h
    expect(noReminderFits(edge, ENDED)).toBe(true);
    expect(isLastReminder(1, at(ENDED, 24 * H), ENDED)).toBe(true); // bloqueio+48 h = fim+72 h exatos
    expect(isLastReminder(1, at(ENDED, 24 * H - 1), ENDED)).toBe(false); // 1 ms antes: ainda cabe
  });
});
