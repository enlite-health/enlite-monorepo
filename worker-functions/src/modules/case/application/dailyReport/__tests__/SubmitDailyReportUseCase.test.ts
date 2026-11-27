import { SubmitDailyReportUseCase, type SubmitDailyReportCommand } from '../SubmitDailyReportUseCase';
import { DailyReportConflictError, DailyReportError, type ReportAnswer } from '../../../domain/DailyReport';
import { AccountInactiveError } from '../../GetWorkerItineraryUseCase';
import { PresenceUnavailableError, type PresenceReader, type PresenceStatus } from '../../ports/PresenceReaderPort';
import type { DailyReportPort } from '../../ports/DailyReportPort';
import { fakePort, fakeState, version, guard, obj, OTHER_SERVICE, type FakeState } from './fakeDailyReport';

const choice = (itemId: string, scaleCode: string, optionCode: string, reasonCode: string | null = null, itemKind: 'objective' | 'activity' = 'objective'): ReportAnswer =>
  ({ itemKind, itemId, scaleCode, answer: { kind: 'choice', optionCode, reasonCode } });
const OK_ANSWERS: ReportAnswer[] = [choice('o-aut', 'AUT', 'solo'), choice('o-sn', 'SN', 'si')];

function cmd(over: Partial<SubmitDailyReportCommand> = {}): SubmitDailyReportCommand {
  return {
    uid: 'uid-1', reportId: 'r-1', occurrenceId: 'occ-1', ptiVersionId: 'v1', narrative: 'NARRATIVA-ESPIA-092', narrativeSource: 'TYPED',
    deviceSubmittedAt: new Date('2026-11-17T12:00:00.000Z'), appVersion: '1.0.0', answers: OK_ANSWERS,
    now: new Date('2026-11-17T13:00:00.000Z'), today: '2026-11-17', ...over,
  };
}
/** Dublê do PresenceReader: nunca rede. Default = presença fechada pelo checkout do app. Conta as chamadas e guarda os ids pedidos. */
function fakePresence(status: PresenceStatus | 'DOWN' = 'CLOSED'): PresenceReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    statusOf: async (id) => {
      calls.push(id);
      if (status === 'DOWN') throw new PresenceUnavailableError('timeout');
      return status;
    },
  };
}
const run = (s: FakeState, c: SubmitDailyReportCommand, presence: PresenceReader = fakePresence()) => new SubmitDailyReportUseCase(fakePort(s), presence).execute(c);
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { return (e as { code?: string }).code ?? String(e); }
  return 'NAO_FALHOU';
};

describe('SubmitDailyReportUseCase — contrato do PUT', () => {
  it('201: guarda do prestador, PTI do serviço, respostas válidas → grava uma vez', async () => {
    const s = fakeState();
    expect(await run(s, cmd())).toBe('created');
    expect(s.inserted).toHaveLength(1);
    expect(s.inserted[0].content).toMatchObject({ workerId: 'worker-1', slotId: 'slot-1', onDate: '2026-11-16', ptiVersionId: 'v1' });
  });

  it('200: mesmo id e mesmo conteúdo (retry, ordem das respostas indiferente) → replayed, sem gravar de novo', async () => {
    const s = fakeState();
    await run(s, cmd());
    expect(await run(s, cmd({ answers: [...OK_ANSWERS].reverse() }))).toBe('replayed');
    expect(s.inserted).toHaveLength(1);
  });

  it('409 daily_report_conflict: mesmo id, conteúdo diferente (narrativa, nº de respostas, resposta ou instante)', async () => {
    const s = fakeState();
    await run(s, cmd());
    for (const over of [
      { narrative: 'outra' },
      { answers: [OK_ANSWERS[0]] },
      { answers: [OK_ANSWERS[0], choice('o-sn', 'SN', 'no')] },
      { deviceSubmittedAt: new Date('2026-11-17T12:00:01.000Z') },
    ]) {
      await expect(run(s, cmd(over))).rejects.toMatchObject({ code: 'daily_report_conflict' });
    }
    await expect(run(s, cmd({ answers: OK_ANSWERS }))).resolves.toBe('replayed');
  });

  it('409 daily_report_exists: outro id para a mesma guarda', async () => {
    const s = fakeState();
    await run(s, cmd());
    const err = await run(s, cmd({ reportId: 'r-2' })).catch((e) => e);
    expect(err).toBeInstanceOf(DailyReportConflictError);
    expect(err.code).toBe('daily_report_exists');
  });

  it('corrida: o INSERT perde para o outro PUT (UNIQUE) → relê e devolve 200 se igual, 409 se diferente', async () => {
    const igual = fakeState({ raceOnInsert: true });
    expect(await run(igual, cmd())).toBe('replayed');
    const diferente = fakeState({ raceOnInsert: true });
    await expect(run(diferente, cmd({ narrative: 'x' }))).resolves.toBe('replayed'); // o 1º relê o que ele mesmo gravou na corrida simulada
  });

  it('422 occurrence_unknown: a guarda não é do prestador (não está na expansão do itinerário)', async () => {
    expect(await codeOf(run(fakeState({ guards: [] }), cmd()))).toBe('occurrence_unknown');
    expect(await codeOf(run(fakeState(), cmd({ occurrenceId: 'de-outro' })))).toBe('occurrence_unknown');
  });

  it('403: conta inativa → AccountInactiveError', async () => {
    await expect(run(fakeState({ worker: null }), cmd())).rejects.toBeInstanceOf(AccountInactiveError);
  });

  it('422 daily_report_window_closed: depois de prazo + 7 dias; no último instante ainda aceita', async () => {
    const due = new Date('2026-11-17T15:00:00.000Z').getTime();
    expect(await codeOf(run(fakeState(), cmd({ now: new Date(due + 7 * 86_400_000 + 1) })))).toBe('daily_report_window_closed');
    expect(await run(fakeState(), cmd({ now: new Date(due + 7 * 86_400_000) }))).toBe('created');
  });

  it('retry do mesmo informe depois da janela continua 200 (idempotência vale mais que o prazo)', async () => {
    const s = fakeState();
    await run(s, cmd());
    expect(await run(s, cmd({ now: new Date('2027-03-01T00:00:00.000Z') }))).toBe('replayed');
  });

  it('422 pti_version_mismatch (sem PTI vigente e id não-nulo): de outro serviço, anulada, vencida ou ainda não iniciada; 409 template_outdated quando há vigente diferente', async () => {
    expect(await codeOf(run(fakeState(), cmd({ ptiVersionId: 'nao-existe' })))).toBe('daily_report_template_outdated');
    expect(await codeOf(run(fakeState({ versions: [version('v1', { contractedServiceId: OTHER_SERVICE })] }), cmd()))).toBe('pti_version_mismatch');
    expect(await codeOf(run(fakeState({ versions: [version('v1', { startDate: '2026-11-17' })] }), cmd()))).toBe('pti_version_mismatch');
    expect(await codeOf(run(fakeState({ versions: [version('v1', { annulledAt: '2026-11-01T00:00:00.000Z' })] }), cmd()))).toBe('pti_version_mismatch');
    expect(await codeOf(run(fakeState({ versions: [version('v1', { endDate: '2026-11-15' })] }), cmd()))).toBe('pti_version_mismatch');
    const substituida = fakeState({ versions: [version('v1'), version('v2', { createdAt: '2026-10-01T10:00:00.000Z' })] });
    expect(await codeOf(run(substituida, cmd()))).toBe('daily_report_template_outdated');
    expect(await run(substituida, cmd({ ptiVersionId: 'v2' }))).toBe('created');
  });

  it('PTI vigente informado → aceita (a substituída por anulação volta a ser a vigente)', async () => {
    const s = fakeState({ versions: [version('v1'), version('v2', { createdAt: '2026-10-01T10:00:00.000Z', annulledAt: '2026-10-02T00:00:00.000Z' })] });
    expect(await run(s, cmd())).toBe('created');
  });

  it('sem PTI vigente: id não-nulo → pti_version_mismatch', async () => {
    expect(await codeOf(run(fakeState({ versions: [version('v1', { endDate: '2026-11-15' })] }), cmd()))).toBe('pti_version_mismatch');
  });

  it('DC-4: sem PTI vigente, ptiVersionId null → só relato aceito; qualquer resposta é item_not_in_pti', async () => {
    const mk = () => fakeState({ versions: [] });
    expect(await run(mk(), cmd({ ptiVersionId: null, answers: [] }))).toBe('created');
    expect(await codeOf(run(mk(), cmd({ ptiVersionId: null })))).toBe('item_not_in_pti');
  });

  it('R-19 409 daily_report_template_outdated: ptiVersionId null + 0 respostas + PTI vigente → nada gravado (antes dava 201)', async () => {
    const s = fakeState();
    expect(await codeOf(run(s, cmd({ ptiVersionId: null, answers: [] })))).toBe('daily_report_template_outdated');
    expect(s.inserted).toHaveLength(0);
  });

  it('R-19 409 daily_report_template_outdated: versão velha com outra vigente (o servidor ignora o ptiVersionId do app); a vigente passa', async () => {
    const s = fakeState({ versions: [version('v1'), version('v2', { createdAt: '2026-10-01T10:00:00.000Z' })] });
    const err = await run(s, cmd({ ptiVersionId: 'v1' })).catch((e) => e);
    expect(err).toBeInstanceOf(DailyReportConflictError);
    expect(err.code).toBe('daily_report_template_outdated');
    expect(s.inserted).toHaveLength(0);
    expect(await run(s, cmd({ ptiVersionId: 'v2', answers: OK_ANSWERS }))).toBe('created');
  });

  it('R-19 sem PTI vigente + null → 201 (só relato)', async () => {
    expect(await run(fakeState({ versions: [version('v1', { endDate: '2026-11-15' })] }), cmd({ ptiVersionId: null, answers: [] }))).toBe('created');
  });

  it('422 item_not_in_pti: item fora do molde (OM, legado sem pergunta, id inventado)', async () => {
    for (const bad of [choice('o-om', 'OM', 'x'), choice('o-legado', 'SN', 'si'), choice('inventado', 'SN', 'si')]) {
      expect(await codeOf(run(fakeState(), cmd({ answers: [...OK_ANSWERS, bad] })))).toBe('item_not_in_pti');
    }
  });

  it('422 scale_mismatch: escala ≠ a do item; contagem em escala de botões; opção em escala de contagem', async () => {
    expect(await codeOf(run(fakeState(), cmd({ answers: [choice('o-aut', 'SN', 'si'), OK_ANSWERS[1]] })))).toBe('scale_mismatch');
    const s = fakeState({ versions: [version('v1', { objectiveIds: ['o-aut', 'o-cnt'] })], objectives: [obj('o-aut', 'AUT'), obj('o-cnt', 'CNT')] });
    const count = (itemId: string, scaleCode: string, value: number): ReportAnswer => ({ itemKind: 'objective', itemId, scaleCode, answer: { kind: 'count', value } });
    expect(await codeOf(run(s, cmd({ answers: [choice('o-aut', 'AUT', 'solo'), choice('o-cnt', 'CNT', 'x')] })))).toBe('scale_mismatch');
    expect(await codeOf(run(s, cmd({ answers: [count('o-aut', 'AUT', 1), count('o-cnt', 'CNT', 1)] })))).toBe('scale_mismatch');
    expect(await run(s, cmd({ answers: [choice('o-aut', 'AUT', 'solo'), count('o-cnt', 'CNT', 3)] }))).toBe('created');
  });

  it('422 option_unknown: opção que a escala não tem; contagem fora de 0..999 ou não inteira', async () => {
    expect(await codeOf(run(fakeState(), cmd({ answers: [choice('o-aut', 'AUT', 'voa'), OK_ANSWERS[1]] })))).toBe('option_unknown');
    const s = fakeState({ versions: [version('v1', { objectiveIds: ['o-cnt'] })], objectives: [obj('o-cnt', 'CNT')] });
    for (const value of [-1, 1000, 1.5]) {
      expect(await codeOf(run(s, cmd({ answers: [{ itemKind: 'objective', itemId: 'o-cnt', scaleCode: 'CNT', answer: { kind: 'count', value } }] })))).toBe('option_unknown');
    }
  });

  it('422 reason_required / reason_not_allowed: "no_lo_hizo" pede motivo; motivo em opção que não pede, ou motivo que a escala não tem', async () => {
    expect(await codeOf(run(fakeState(), cmd({ answers: [choice('o-aut', 'AUT', 'no_lo_hizo'), OK_ANSWERS[1]] })))).toBe('reason_required');
    expect(await codeOf(run(fakeState(), cmd({ answers: [choice('o-aut', 'AUT', 'solo', 'rechazo'), OK_ANSWERS[1]] })))).toBe('reason_not_allowed');
    expect(await codeOf(run(fakeState(), cmd({ answers: [choice('o-aut', 'AUT', 'no_lo_hizo', 'inexistente'), OK_ANSWERS[1]] })))).toBe('reason_not_allowed');
    expect(await run(fakeState(), cmd({ answers: [choice('o-aut', 'AUT', 'no_lo_hizo', 'rechazo'), OK_ANSWERS[1]] }))).toBe('created');
  });

  it('422 objective_answer_missing: objetivo do molde sem resposta (DC-8); atividade pode faltar', async () => {
    expect(await codeOf(run(fakeState(), cmd({ answers: [OK_ANSWERS[0]] })))).toBe('objective_answer_missing');
    expect(await run(fakeState(), cmd({ answers: [...OK_ANSWERS, choice('a-sn', 'SN', 'no', null, 'activity')] }))).toBe('created');
  });

  it('o erro de validação nunca carrega a narrativa nem a resposta (privacidade)', async () => {
    const err = (await run(fakeState(), cmd({ answers: [choice('o-aut', 'AUT', 'voa')] })).catch((e) => e)) as DailyReportError;
    expect(JSON.stringify({ m: err.message, c: err.code, s: err.stack?.split('\n')[0] })).not.toContain('NARRATIVA-ESPIA-092');
    expect(String(err.message)).toBe(err.code);
  });

  it('outra guarda do mesmo serviço usa o mesmo molde; guarda de outro serviço do paciente usa o PTI DELE (via PTI informado)', async () => {
    const s = fakeState({ guards: [guard(), guard({ occurrenceId: 'occ-2', slotId: 'slot-2', serviceId: OTHER_SERVICE })] });
    expect(await codeOf(run(s, cmd({ occurrenceId: 'occ-2', reportId: 'r-9' })))).toBe('pti_version_mismatch'); // v1 é do SERVICE, não do OTHER
  });

  describe('presença fechada (emenda 077 §2.1, passo 5b)', () => {
    it('OPEN → 409 daily_report_presence_open e nada gravado; consulta a ocorrência da guarda', async () => {
      const s = fakeState();
      const p = fakePresence('OPEN');
      const err = await run(s, cmd(), p).catch((e) => e);
      expect(err).toBeInstanceOf(DailyReportConflictError);
      expect(err.code).toBe('daily_report_presence_open');
      expect(s.inserted).toHaveLength(0);
      expect(p.calls).toEqual(['occ-1']);
    });

    it('NONE (sem linha no attendance) → 409 daily_report_presence_open e nada gravado', async () => {
      const s = fakeState();
      expect(await codeOf(run(s, cmd(), fakePresence('NONE')))).toBe('daily_report_presence_open');
      expect(s.inserted).toHaveLength(0);
    });

    it('CLOSED_DECLARED e CLOSED → 201', async () => {
      expect(await run(fakeState(), cmd(), fakePresence('CLOSED_DECLARED'))).toBe('created');
      expect(await run(fakeState(), cmd(), fakePresence('CLOSED'))).toBe('created');
    });

    it('janela fechada + presença aberta → 422 daily_report_window_closed (o terminal vence o retentável; nem consulta o attendance)', async () => {
      const p = fakePresence('OPEN');
      const due = new Date('2026-11-17T15:00:00.000Z').getTime();
      expect(await codeOf(run(fakeState(), cmd({ now: new Date(due + 7 * 86_400_000 + 1) }), p))).toBe('daily_report_window_closed');
      expect(p.calls).toHaveLength(0);
    });

    it('retry do mesmo id não chama o PresenceReader (responde antes de consultar fora), nem com o attendance fora do ar', async () => {
      const s = fakeState();
      await run(s, cmd());
      const p = fakePresence('DOWN');
      expect(await run(s, cmd(), p)).toBe('replayed');
      expect(p.calls).toHaveLength(0);
    });

    it('attendance indisponível → PresenceUnavailableError (503 no controller) e nada gravado', async () => {
      const s = fakeState();
      await expect(run(s, cmd(), fakePresence('DOWN'))).rejects.toBeInstanceOf(PresenceUnavailableError);
      expect(s.inserted).toHaveLength(0);
    });

    it('a presença é conferida ANTES do molde: presença aberta + PTI desatualizado → presence_open', async () => {
      expect(await codeOf(run(fakeState(), cmd({ ptiVersionId: null, answers: [] }), fakePresence('OPEN')))).toBe('daily_report_presence_open');
    });

    it('o PresenceReader é chamado SEM transação aberta (HTTP nunca segura conexão do pool), e as fases de banco rodam em tx próprias antes e depois', async () => {
      const s = fakeState();
      const inner = fakePort(s);
      let active = 0;
      const log: string[] = [];
      const tracked: DailyReportPort = { run: (work) => { active++; log.push('tx+'); return inner.run(work).finally(() => { active--; log.push('tx-'); }); } };
      const presence: PresenceReader = { statusOf: async () => { log.push(active === 0 ? 'presence(sem-tx)' : 'presence(DENTRO-DE-TX)'); return 'CLOSED'; } };
      expect(await new SubmitDailyReportUseCase(tracked, presence).execute(cmd())).toBe('created');
      expect(log).toEqual(['tx+', 'tx-', 'presence(sem-tx)', 'tx+', 'tx-']);
    });

    it('outro PUT grava o mesmo id enquanto a presença é consultada → a 2ª tx devolve 200 (replayed) sem gravar de novo', async () => {
      const s = fakeState();
      const presence: PresenceReader = {
        statusOf: async () => { await run(s, cmd()); return 'CLOSED'; }, // o "outro PUT" completo termina durante a consulta
      };
      expect(await new SubmitDailyReportUseCase(fakePort(s), presence).execute(cmd())).toBe('replayed');
      expect(s.inserted).toHaveLength(1);
    });

    it('outro id grava a mesma guarda durante a consulta → 409 daily_report_exists', async () => {
      const s = fakeState();
      const presence: PresenceReader = { statusOf: async () => { await run(s, cmd({ reportId: 'r-2' })); return 'CLOSED'; } };
      expect(await codeOf(new SubmitDailyReportUseCase(fakePort(s), presence).execute(cmd()))).toBe('daily_report_exists');
      expect(s.inserted).toHaveLength(1);
    });
  });
});
