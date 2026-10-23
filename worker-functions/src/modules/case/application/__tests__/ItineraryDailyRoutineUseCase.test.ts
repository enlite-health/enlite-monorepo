/**
 * ItineraryDailyRoutineUseCase — spec 069 F4 (T401/T408/T412). A transação é do banco real (e2e `069-rotina-diaria`); aqui
 * `withActorContext` entrega um client fantasma e repropaga erro, como o real.
 *
 * T408 (fuso): `now = 2026-11-03T02:30:00Z` é 23:30 de 02/11 em Buenos Aires e em São Paulo — a data de operação tem de ser
 * `2026-11-02`, NUNCA a UTC (`2026-11-03`). Sem nenhuma variável `TZ=`: `toISOString()` é UTC em qualquer máquina, então trocar
 * `operationDateOf` por ele deixa este teste vermelho em qualquer fuso do processo. A asserção de SANIDADE prova que o instante
 * discrimina (UTC ≠ local); `TZ=Asia/Tokyo` e `TZ=America/Los_Angeles` externos provam que o processo não decide.
 */
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({}) }) },
}));
const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({ reportError: (...a: unknown[]) => mockReportError(...a) }));
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: jest.fn(async (_pool: unknown, fn: (c: unknown) => Promise<unknown>) => fn({ __client: true })),
}));

import { ItineraryDailyRoutineUseCase } from '../ItineraryDailyRoutineUseCase';

const NOW = new Date('2026-11-03T02:30:00Z'); // AR/BR: 23:30 do dia 2; UTC: já é dia 3
const failAlert = { operationDate: '2026-11-02', alertRecipients: 0, notified: 0, alreadySent: 0, emailsSent: 0, emailsSkipped: 0, emailsFailed: 0, skippedNoCountry: 0, failures: 0 };

function montar(over: { candidatos?: Record<string, string[]>; outcomes?: Record<string, string | Error>; alertFailures?: number } = {}) {
  const runs = {
    begin: jest.fn(async (_c?: unknown, _country?: string, _date?: string) => undefined),
    finish: jest.fn(async (_c?: unknown, _country?: string, _date?: string, _failures?: number) => undefined),
    listDerivationCandidates: jest.fn(async (_c: unknown, country: string) => over.candidatos?.[country] ?? []),
  };
  const derivation = {
    run: jest.fn(async (_c: unknown, patientId: string) => {
      const o = over.outcomes?.[patientId] ?? 'unchanged';
      if (o instanceof Error) throw o;
      return o;
    }),
  };
  const alert = { execute: jest.fn(async () => ({ ...failAlert, failures: over.alertFailures ?? 0 })) };
  return { uc: new ItineraryDailyRoutineUseCase(runs as never, derivation as never, alert as never), runs, derivation, alert };
}

describe('ItineraryDailyRoutineUseCase (spec 069 F4)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('T408 fuso: a data de operação é a do PAÍS (2026-11-02), não a UTC (2026-11-03) — sanidade + begin/finish gravam a data local', async () => {
    // sanidade: o instante discrimina — se UTC == local o teste passaria por coincidência
    expect(NOW.toISOString().slice(0, 10)).toBe('2026-11-03');
    const { uc, runs, alert } = montar();
    const r = await uc.execute({ now: NOW, countries: ['AR', 'BR'] });

    expect(r.countries.AR.operationDate).toBe('2026-11-02');
    expect(r.countries.BR.operationDate).toBe('2026-11-02');
    expect(runs.begin.mock.calls.map((c) => [c[1], c[2]])).toEqual([['AR', '2026-11-02'], ['BR', '2026-11-02']]);
    expect(runs.finish.mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([['AR', '2026-11-02', 0], ['BR', '2026-11-02', 0]]);
    expect(alert.execute).toHaveBeenCalledWith({ now: NOW, countries: ['AR', 'BR'] });
  });

  it('ordem fixa: begin → candidatos → derivação de cada paciente → alerta → finish (o alerta só depois da derivação de TODOS os países)', async () => {
    const ordem: string[] = [];
    const { uc, runs, derivation, alert } = montar({ candidatos: { AR: ['p1'], BR: ['p2'] } });
    runs.begin.mockImplementation(async (_c?: unknown, country?: string) => void ordem.push(`begin:${country}`));
    derivation.run.mockImplementation(async (_c: unknown, id: string) => (ordem.push(`derive:${id}`), 'unchanged'));
    alert.execute.mockImplementation(async () => (ordem.push('alert'), failAlert));
    runs.finish.mockImplementation(async (_c?: unknown, country?: string) => void ordem.push(`finish:${country}`));
    await uc.execute({ now: NOW, countries: ['AR', 'BR'] });
    expect(ordem).toEqual(['begin:AR', 'derive:p1', 'begin:BR', 'derive:p2', 'alert', 'finish:AR', 'finish:BR']);
  });

  it('T401 conta moved / unchanged / notReady / not_subject (=unchanged) por país', async () => {
    const { uc } = montar({ candidatos: { AR: ['a', 'b', 'c', 'd'] }, outcomes: { a: 'moved', b: 'not_ready', c: 'unchanged', d: 'not_subject' } });
    const r = await uc.execute({ now: NOW, countries: ['AR'] });
    expect(r.countries.AR).toEqual({ operationDate: '2026-11-02', patientsChecked: 4, moved: 1, unchanged: 2, notReady: 1, failures: 0 });
  });

  it('isolamento por paciente: erro de um é contado e reportado, os demais seguem; finish grava failures = derivação + alerta', async () => {
    const { uc, runs, derivation } = montar({ candidatos: { AR: ['bom1', 'ruim', 'bom2'] }, outcomes: { ruim: new Error('boom') }, alertFailures: 2 });
    const r = await uc.execute({ now: NOW, countries: ['AR'] });
    expect(derivation.run).toHaveBeenCalledTimes(3);
    expect(r.countries.AR).toMatchObject({ patientsChecked: 3, unchanged: 2, failures: 1 });
    expect(mockReportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ source: 'ItineraryDailyRoutineUseCase:derive', country: 'AR' }));
    expect(runs.finish).toHaveBeenCalledWith(expect.anything(), 'AR', '2026-11-02', 3);
  });

  it('erro não-Error é embrulhado em Error ao reportar', async () => {
    const { uc, derivation } = montar({ candidatos: { AR: ['p'] } });
    derivation.run.mockRejectedValueOnce('texto solto');
    await uc.execute({ now: NOW, countries: ['AR'] });
    expect(mockReportError).toHaveBeenCalledWith(expect.objectContaining({ message: 'texto solto' }), expect.anything());
  });

  it('construtor sem argumentos monta as dependências reais (derivação, repositório, alerta)', () => {
    expect(new ItineraryDailyRoutineUseCase()).toBeInstanceOf(ItineraryDailyRoutineUseCase);
  });
});
