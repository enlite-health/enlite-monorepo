import { decideSummaryRetry, MAX_SUMMARY_RETRY_AUTHORIZATIONS, summaryRetryView, type SummaryRetryFacts, type SummaryRetryListFacts } from '../admissionSummaryRetry';

const MAX = 3;
const base: SummaryRetryFacts = { appointmentStatus: 'booked', importStatus: 'blocked', modelFailuresSinceAuthorization: 3, authorizations: 0 };
const com = (o: Partial<SummaryRetryFacts>): SummaryRetryFacts => ({ ...base, ...o });

describe('decideSummaryRetry (spec 050 F11, R-38)', () => {
  it('esgotada (3 falhas do modelo desde a última autorização), sem autorização gasta → autoriza', () => {
    expect(decideSummaryRetry(base, MAX)).toEqual({ kind: 'authorize' });
  });

  it('a 2ª autorização ainda passa; a 3ª é recusada pelo teto (409)', () => {
    expect(decideSummaryRetry(com({ authorizations: MAX_SUMMARY_RETRY_AUTHORIZATIONS - 1 }), MAX)).toEqual({ kind: 'authorize' });
    expect(decideSummaryRetry(com({ authorizations: MAX_SUMMARY_RETRY_AUTHORIZATIONS }), MAX)).toEqual({ kind: 'refuse', reason: 'authorization_limit' });
  });

  it('não esgotada (inclui prompt_* e catálogo, que não entram na contagem) → só roda agora, sem gastar autorização — mesmo com o teto de autorizações já gasto', () => {
    expect(decideSummaryRetry(com({ modelFailuresSinceAuthorization: 0, importStatus: 'waiting' }), MAX)).toEqual({ kind: 'run_now' });
    expect(decideSummaryRetry(com({ modelFailuresSinceAuthorization: MAX - 1 }), MAX)).toEqual({ kind: 'run_now' });
    expect(decideSummaryRetry(com({ modelFailuresSinceAuthorization: 0, authorizations: MAX_SUMMARY_RETRY_AUTHORIZATIONS }), MAX)).toEqual({ kind: 'run_now' });
  });

  it('reunião concluída (`done`) → recusa already_done, mesmo esgotada e com autorização sobrando', () => {
    expect(decideSummaryRetry(com({ importStatus: 'done' }), MAX)).toEqual({ kind: 'refuse', reason: 'already_done' });
  });

  it('reunião cancelada ou com importação terminal (rejected/ambiguous/expired/nula) → recusa', () => {
    expect(decideSummaryRetry(com({ appointmentStatus: 'cancelled' }), MAX)).toEqual({ kind: 'refuse', reason: 'appointment_not_booked' });
    for (const importStatus of ['rejected', 'ambiguous', 'expired', null]) {
      expect(decideSummaryRetry(com({ importStatus }), MAX)).toEqual({ kind: 'refuse', reason: 'import_terminal' });
    }
  });
});

describe('summaryRetryView (o estado do botão na lista da aba)', () => {
  const lista: SummaryRetryListFacts = { appointmentStatus: 'booked', importStatus: 'blocked', modelFailuresSinceAuthorization: 3, anyFailuresSinceAuthorization: 3, authorizations: 0 };
  const com = (o: Partial<SummaryRetryListFacts>): SummaryRetryListFacts => ({ ...lista, ...o });

  it('esgotada → exhausted com as autorizações que restam; teto gasto → 0 restantes', () => {
    expect(summaryRetryView(lista, MAX)).toEqual({ exhausted: true, authorizationsLeft: 2 });
    expect(summaryRetryView(com({ authorizations: 1 }), MAX)).toEqual({ exhausted: true, authorizationsLeft: 1 });
    expect(summaryRetryView(com({ authorizations: 2 }), MAX)).toEqual({ exhausted: true, authorizationsLeft: 0 });
  });

  it('falha que não conta no teto (prompt_*/catálogo) → botão que só roda agora (exhausted=false)', () => {
    expect(summaryRetryView(com({ modelFailuresSinceAuthorization: 0, anyFailuresSinceAuthorization: 1, importStatus: 'waiting' }), MAX)).toEqual({ exhausted: false, authorizationsLeft: 2 });
  });

  it('sem nenhuma falha desde a última autorização, `done`, terminal ou reunião não `booked` → sem botão (null)', () => {
    expect(summaryRetryView(com({ modelFailuresSinceAuthorization: 0, anyFailuresSinceAuthorization: 0 }), MAX)).toBeNull();
    expect(summaryRetryView(com({ importStatus: 'done' }), MAX)).toBeNull();
    expect(summaryRetryView(com({ importStatus: 'rejected' }), MAX)).toBeNull();
    expect(summaryRetryView(com({ appointmentStatus: 'cancelled' }), MAX)).toBeNull();
  });
});
