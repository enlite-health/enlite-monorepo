/**
 * itineraryWriteSchemas — `itineraryAbsenceBodySchema.date` (Fase 13, DX-13.8).
 *
 * Achado C2 (veredito parcial-1): o regex `^\d{4}-\d{2}-\d{2}$` sozinho aceitava calendário
 * inexistente (`2026-02-31`) — só o `$2::date` do Postgres rejeitava (22008), virando 500 genérico
 * em vez de 400. O `.refine` faz o round-trip em `Date.UTC` (mesmo padrão de
 * `isValidIsoBirthDate.ts`) ANTES do banco.
 */
import { itineraryAbsenceBodySchema } from '../itineraryWriteSchemas';

describe('itineraryAbsenceBodySchema.date', () => {
  it('data real → aceita', () => {
    const r = itineraryAbsenceBodySchema.safeParse({ date: '2026-09-28' });
    expect(r.success).toBe(true);
  });

  it('2026-02-31 (fevereiro não tem 31 dias) → falha de parse, nunca chega ao banco', () => {
    const r = itineraryAbsenceBodySchema.safeParse({ date: '2026-02-31' });
    expect(r.success).toBe(false);
  });

  it('2026-13-01 (mês 13 não existe) → falha de parse', () => {
    const r = itineraryAbsenceBodySchema.safeParse({ date: '2026-13-01' });
    expect(r.success).toBe(false);
  });

  it('2026-00-10 (mês 0 não existe) → falha de parse', () => {
    const r = itineraryAbsenceBodySchema.safeParse({ date: '2026-00-10' });
    expect(r.success).toBe(false);
  });

  it('formato fora do regex (não-dígitos) segue recusado pelo regex, antes do refine', () => {
    const r = itineraryAbsenceBodySchema.safeParse({ date: '28/09/2026' });
    expect(r.success).toBe(false);
  });

  it('ano bissexto: 2028-02-29 é real → aceita; 2026-02-29 (não bissexto) → recusa', () => {
    expect(itineraryAbsenceBodySchema.safeParse({ date: '2028-02-29' }).success).toBe(true);
    expect(itineraryAbsenceBodySchema.safeParse({ date: '2026-02-29' }).success).toBe(false);
  });
});
