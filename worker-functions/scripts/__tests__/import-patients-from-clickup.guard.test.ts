/**
 * Parecer do lex (11/09/2026): a carga manual do ClickUp só cria paciente NOVO — nunca UPDATE.
 * Puro: sem DB, sem rede — recebe a contagem já lida e decide.
 */
import { decideIfNewPatientAllowed, PATIENT_ALREADY_EXISTS_MESSAGE } from '../import-patients-from-clickup-guard';

describe('decideIfNewPatientAllowed', () => {
  it('existingCount = 0 → allowed:true (paciente novo, pode criar)', () => {
    const r = decideIfNewPatientAllowed({ clickupTaskId: 'cu-1', existingCount: 0 });
    expect(r).toEqual({ allowed: true });
  });

  it('existingCount = 1 → allowed:false, mensagem EXATA pedida pelo lex', () => {
    const r = decideIfNewPatientAllowed({ clickupTaskId: 'cu-1', existingCount: 1 });
    expect(r).toEqual({ allowed: false, reason: PATIENT_ALREADY_EXISTS_MESSAGE });
  });

  it('existingCount > 1 (duplicata inesperada) → ainda assim allowed:false — recusa, nunca escolhe qual', () => {
    const r = decideIfNewPatientAllowed({ clickupTaskId: 'cu-1', existingCount: 3 });
    expect(r.allowed).toBe(false);
  });

  it('a mensagem de recusa nunca leva o clickupTaskId nem qualquer outro dado — só o texto fixo', () => {
    // C1 do parecer do lex: o stdout roda dentro de sessões do Claude. A mensagem de recusa é
    // uma constante fixa, nunca interpolada com dado do paciente/task.
    const r = decideIfNewPatientAllowed({ clickupTaskId: 'cu-com-id-sensivel-123', existingCount: 5 });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).not.toContain('cu-com-id-sensivel-123');
  });
});
