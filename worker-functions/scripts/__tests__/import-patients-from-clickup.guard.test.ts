/**
 * Parecer do lex (11/09/2026): a carga manual do ClickUp só cria paciente NOVO — nunca UPDATE.
 * Puro: sem DB, sem rede — recebe a contagem já lida e decide.
 *
 * BLOCKER do gate (achado numa rodada posterior): `existingCount === null` (SELECT falhou) TEM
 * de ser tratado como "não é seguro criar" — fail-closed. A régua provada aqui é a mesma que
 * fechou o buraco: sem este comportamento, um SELECT forçado a falhar deixava o motor rodar e
 * SOBRESCREVER um paciente existente.
 */
import {
  decideIfNewPatientAllowed,
  runSingleTaskApply,
  PATIENT_ALREADY_EXISTS_MESSAGE,
  EXISTING_CHECK_FAILED_MESSAGE,
} from '../import-patients-from-clickup-guard';

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

  it('existingCount = null (SELECT falhou) → allowed:false — FAIL CLOSED, nunca tratado como zero/novo', () => {
    const r = decideIfNewPatientAllowed({ clickupTaskId: 'cu-1', existingCount: null });
    expect(r).toEqual({ allowed: false, reason: EXISTING_CHECK_FAILED_MESSAGE });
  });

  it('a mensagem de null é DIFERENTE da de "já existe" — quem lê precisa distinguir os dois casos', () => {
    expect(EXISTING_CHECK_FAILED_MESSAGE).not.toBe(PATIENT_ALREADY_EXISTS_MESSAGE);
  });

  it('a mensagem de recusa nunca leva o clickupTaskId nem qualquer outro dado — só o texto fixo', () => {
    // C1 do parecer do lex: o stdout roda dentro de sessões do Claude. A mensagem de recusa é
    // uma constante fixa, nunca interpolada com dado do paciente/task.
    const r = decideIfNewPatientAllowed({ clickupTaskId: 'cu-com-id-sensivel-123', existingCount: 5 });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).not.toContain('cu-com-id-sensivel-123');
  });
});

describe('runSingleTaskApply — ÚNICO ponto de decisão entre abortar e chamar o motor', () => {
  it('decision.allowed=false → aborta SEM chamar o motor (o BLOCKER do gate)', async () => {
    const callEngine = jest.fn(async () => ({ kind: 'UPDATED' }));
    const decision = decideIfNewPatientAllowed({ clickupTaskId: 'cu-1', existingCount: null });

    const outcome = await runSingleTaskApply(decision, callEngine);

    expect(outcome).toEqual({ aborted: true, reason: EXISTING_CHECK_FAILED_MESSAGE });
    expect(callEngine).not.toHaveBeenCalled();
  });

  it('decision.allowed=false (paciente já existe) → aborta SEM chamar o motor', async () => {
    const callEngine = jest.fn(async () => ({ kind: 'UPDATED' }));
    const decision = decideIfNewPatientAllowed({ clickupTaskId: 'cu-1', existingCount: 4 });

    const outcome = await runSingleTaskApply(decision, callEngine);

    expect(outcome).toEqual({ aborted: true, reason: PATIENT_ALREADY_EXISTS_MESSAGE });
    expect(callEngine).not.toHaveBeenCalled();
  });

  it('decision.allowed=true → chama o motor EXATAMENTE uma vez e devolve o resultado', async () => {
    const resultadoDoMotor = { kind: 'CREATED', patientId: 'p-1' };
    const callEngine = jest.fn(async () => resultadoDoMotor);
    const decision = decideIfNewPatientAllowed({ clickupTaskId: 'cu-1', existingCount: 0 });

    const outcome = await runSingleTaskApply(decision, callEngine);

    expect(callEngine).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ aborted: false, result: resultadoDoMotor });
  });
});
