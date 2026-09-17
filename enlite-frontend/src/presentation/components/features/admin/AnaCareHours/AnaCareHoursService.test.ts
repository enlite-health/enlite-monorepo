/**
 * Portado de `repos/infra/_worktrees/proto-anacare-horas/.../AnaCareHoursService.test.ts` (26
 * testes) com as adaptações do contrato HTTP fixo da fase 1: `validator` some dos comandos
 * (validação vem da sessão no backend — aqui o Fake grava um nome fixo, como o backend faria),
 * `contestShift` ganha `reason` obrigatório (1.5b) e nota agora é OPCIONAL — mais os testes NOVOS
 * de 1.5b (motivo fora do enum / nota acima do limite).
 */
import { describe, it, expect } from 'vitest';
import { AnaCareHoursServiceError, FakeAnaCareHoursService } from './AnaCareHoursService';
import { CONTEST_NOTE_MAX_LENGTH } from './types';
import type { AnaCareMonthSnapshot, AnaCareShift } from './types';

function makeShift(overrides: Partial<AnaCareShift> = {}): AnaCareShift {
  return {
    id: 'shift-1',
    date: '2026-08-14',
    scheduledStart: '08:00',
    scheduledEnd: '16:00',
    actualStart: '08:00',
    actualEnd: '16:00',
    hoursActual: 8,
    hoursScheduled: 8,
    origin: 'app',
    status: 'pendiente',
    anaCareShiftId: '90101',
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<AnaCareMonthSnapshot> = {}, shifts: AnaCareShift[] = [makeShift()]): AnaCareMonthSnapshot {
  return {
    month: '2026-08',
    updatedAt: '2026-09-15T08:00:00-03:00',
    stale: false,
    snapshotState: 'fresco',
    circuitBreakerOpen: false,
    patients: [
      {
        anaCareId: '90000',
        linked: true,
        name: 'Lucía Fernández QA',
        providers: [{ anaCareId: '90200', linked: true, name: 'Rocío García QA', shifts }],
      },
    ],
    ...overrides,
  };
}

function makeService(overrides: Partial<AnaCareMonthSnapshot> = {}, shifts?: AnaCareShift[]): FakeAnaCareHoursService {
  return new FakeAnaCareHoursService({ '2026-08': makeSnapshot(overrides, shifts) });
}

describe('getMonthSnapshot', () => {
  it('POSITIVO — devolve o snapshot do mês pedido', async () => {
    const service = makeService();
    const snapshot = await service.getMonthSnapshot('2026-08');
    expect(snapshot.month).toBe('2026-08');
    expect(snapshot.patients).toHaveLength(1);
  });

  it('NEGATIVO — mês sem dado nenhum devolve snapshot vazio (nunca lança)', async () => {
    const service = makeService();
    const snapshot = await service.getMonthSnapshot('2099-01');
    expect(snapshot.patients).toEqual([]);
  });

  it('POSITIVO — filtro por patientSearch (nome) restringe a lista de pacientes', async () => {
    const service = makeService();
    const snapshot = await service.getMonthSnapshot('2026-08', { patientSearch: 'Lucía' });
    expect(snapshot.patients).toHaveLength(1);
  });

  it('NEGATIVO — filtro por patientSearch sem match devolve lista vazia', async () => {
    const service = makeService();
    const snapshot = await service.getMonthSnapshot('2026-08', { patientSearch: 'zzz-no-existe' });
    expect(snapshot.patients).toEqual([]);
  });

  it('POSITIVO — filtro por providerId restringe aos pacientes daquele prestador', async () => {
    const service = makeService();
    const snapshot = await service.getMonthSnapshot('2026-08', { providerId: '90200' });
    expect(snapshot.patients).toHaveLength(1);
  });

  it('NEGATIVO — filtro por providerId inexistente devolve lista vazia', async () => {
    const service = makeService();
    const snapshot = await service.getMonthSnapshot('2026-08', { providerId: '00000' });
    expect(snapshot.patients).toEqual([]);
  });

  it('POSITIVO — paciente SEM vínculo (sem nome) é buscável pelo ID Ana Care', async () => {
    const service = new FakeAnaCareHoursService({
      '2026-08': makeSnapshot({
        patients: [{ anaCareId: '90447', linked: false, providers: [{ anaCareId: '90512', linked: false, shifts: [makeShift()] }] }],
      }),
    });
    const snapshot = await service.getMonthSnapshot('2026-08', { patientSearch: '90447' });
    expect(snapshot.patients).toHaveLength(1);
  });
});

describe('getPatientMonth', () => {
  it('POSITIVO — devolve o paciente pedido', async () => {
    const service = makeService();
    const patient = await service.getPatientMonth('2026-08', '90000');
    expect(patient?.anaCareId).toBe('90000');
  });

  it('NEGATIVO — paciente inexistente devolve null (nunca lança)', async () => {
    const service = makeService();
    const patient = await service.getPatientMonth('2026-08', 'no-existe');
    expect(patient).toBeNull();
  });
});

describe('getRetratoStatus', () => {
  it('POSITIVO — reflete stale/circuitBreakerOpen do snapshot', async () => {
    const service = makeService({ stale: true, circuitBreakerOpen: true, updatedAt: '2026-09-13T00:00:00-03:00' });
    const status = await service.getRetratoStatus('2026-08');
    expect(status).toEqual({ updatedAt: '2026-09-13T00:00:00-03:00', stale: true, circuitBreakerOpen: true });
  });

  it('NEGATIVO — mês sem dado devolve status "em dia" (nunca lança)', async () => {
    const service = makeService();
    const status = await service.getRetratoStatus('2099-01');
    expect(status.stale).toBe(false);
    expect(status.circuitBreakerOpen).toBe(false);
  });
});

describe('validateShift', () => {
  it('POSITIVO — turno pendente vira validado, com validatedBy.name/validatedAt (validador vem da sessão)', async () => {
    const service = makeService();
    await service.validateShift({ shiftId: 'shift-1' });
    const patient = await service.getPatientMonth('2026-08', '90000');
    const shift = patient!.providers[0].shifts[0];
    expect(shift.status).toBe('validado');
    expect(shift.validatedBy?.name).toBeTruthy();
    expect(shift.validatedAt).toBeTruthy();
  });

  it('POSITIVO — turno contestado TAMBÉM pode ser validado depois (só validado congela)', async () => {
    const service = makeService({}, [makeShift({ status: 'contestado', contestReason: 'otro' })]);
    await service.validateShift({ shiftId: 'shift-1' });
    const patient = await service.getPatientMonth('2026-08', '90000');
    expect(patient!.providers[0].shifts[0].status).toBe('validado');
  });

  it('NEGATIVO — turno já validado é recusado (não pode reabrir)', async () => {
    const service = makeService({}, [makeShift({ status: 'validado', validatedBy: { id: 'e2e-qa', name: 'Equipo QA' }, validatedAt: '2026-09-01T00:00:00-03:00' })]);
    await expect(service.validateShift({ shiftId: 'shift-1' })).rejects.toThrow(AnaCareHoursServiceError);
  });

  it('NEGATIVO — retrato desatualizado recusa toda escrita (stale)', async () => {
    const service = makeService({ stale: true });
    await expect(service.validateShift({ shiftId: 'shift-1' })).rejects.toMatchObject({ code: 'RETRATO_DESATUALIZADO' });
  });

  it('NEGATIVO — retrato desatualizado recusa toda escrita (disjuntor aberto)', async () => {
    const service = makeService({ circuitBreakerOpen: true });
    await expect(service.validateShift({ shiftId: 'shift-1' })).rejects.toMatchObject({ code: 'RETRATO_DESATUALIZADO' });
  });

  it('NEGATIVO — turno inexistente não lança (silencioso, nada muda)', async () => {
    const service = makeService();
    await expect(service.validateShift({ shiftId: 'no-existe' })).resolves.toBeUndefined();
    const patient = await service.getPatientMonth('2026-08', '90000');
    expect(patient!.providers[0].shifts[0].status).toBe('pendiente');
  });
});

describe('validateBatch', () => {
  it('POSITIVO — valida todos os turnos pendentes da lista', async () => {
    const service = makeService({}, [makeShift({ id: 's1', status: 'pendiente' }), makeShift({ id: 's2', status: 'pendiente' })]);
    await service.validateBatch({ shiftIds: ['s1', 's2'] });
    const patient = await service.getPatientMonth('2026-08', '90000');
    expect(patient!.providers[0].shifts.every((s) => s.status === 'validado')).toBe(true);
  });

  it('POSITIVO — lote valida turno CONTESTADO junto (mesma regra do validateShift único — só validado congela)', async () => {
    const service = makeService({}, [
      makeShift({ id: 's1', status: 'pendiente' }),
      makeShift({ id: 's2', status: 'validado', validatedBy: { id: 'e2e-qa', name: 'Equipo QA' }, validatedAt: '2026-09-01T00:00:00-03:00' }),
      makeShift({ id: 's3', status: 'contestado', contestReason: 'otro', contestNote: 'nota' }),
    ]);
    await service.validateBatch({ shiftIds: ['s1', 's2', 's3'] });
    const patient = await service.getPatientMonth('2026-08', '90000');
    const byId = Object.fromEntries(patient!.providers[0].shifts.map((s) => [s.id, s]));
    expect(byId.s1.status).toBe('validado');
    expect(byId.s2.status).toBe('validado'); // já estava, permanece — não é reaberto
    expect(byId.s3.status).toBe('validado'); // contestado TAMBÉM validado pelo lote
    expect(byId.s3.contestNote).toBe('nota'); // nota preservada, intocada
  });

  it('NEGATIVO — retrato desatualizado recusa o lote inteiro', async () => {
    const service = makeService({ stale: true }, [makeShift({ id: 's1', status: 'pendiente' })]);
    await expect(service.validateBatch({ shiftIds: ['s1'] })).rejects.toMatchObject({ code: 'RETRATO_DESATUALIZADO' });
  });

  it('POSITIVO — lote com IDs de prestadores DIFERENTES do mesmo paciente valida os dois', async () => {
    const service = new FakeAnaCareHoursService({
      '2026-08': {
        month: '2026-08',
        updatedAt: '2026-09-15T08:00:00-03:00',
        stale: false,
        snapshotState: 'fresco',
        circuitBreakerOpen: false,
        patients: [
          {
            anaCareId: '90000',
            linked: true,
            name: 'Lucía Fernández QA',
            providers: [
              { anaCareId: 'p1', linked: true, name: 'Prestador Uno QA', shifts: [makeShift({ id: 's1', status: 'pendiente' })] },
              { anaCareId: 'p2', linked: true, name: 'Prestador Dos QA', shifts: [makeShift({ id: 's2', status: 'pendiente' })] },
            ],
          },
        ],
      },
    });
    await service.validateBatch({ shiftIds: ['s1', 's2'] });
    const patient = await service.getPatientMonth('2026-08', '90000');
    const [p1, p2] = patient!.providers;
    expect(p1.shifts[0].status).toBe('validado');
    expect(p2.shifts[0].status).toBe('validado');
  });

  it('NEGATIVO — retrato desatualizado recusa o lote INTEIRO mesmo com IDs mistos de prestadores — nenhum turno é tocado', async () => {
    const service = new FakeAnaCareHoursService({
      '2026-08': {
        month: '2026-08',
        updatedAt: '2026-09-15T08:00:00-03:00',
        stale: true,
        snapshotState: 'velho',
        circuitBreakerOpen: false,
        patients: [
          {
            anaCareId: '90000',
            linked: true,
            name: 'Lucía Fernández QA',
            providers: [
              { anaCareId: 'p1', linked: true, name: 'Prestador Uno QA', shifts: [makeShift({ id: 's1', status: 'pendiente' })] },
              { anaCareId: 'p2', linked: true, name: 'Prestador Dos QA', shifts: [makeShift({ id: 's2', status: 'pendiente' })] },
            ],
          },
        ],
      },
    });
    await expect(service.validateBatch({ shiftIds: ['s1', 's2'] })).rejects.toMatchObject({ code: 'RETRATO_DESATUALIZADO' });
    const patient = await service.getPatientMonth('2026-08', '90000');
    expect(patient!.providers[0].shifts[0].status).toBe('pendiente');
    expect(patient!.providers[1].shifts[0].status).toBe('pendiente');
  });
});

describe('contestShift', () => {
  it('POSITIVO — turno pendente vira contestado, com motivo e nota', async () => {
    const service = makeService();
    await service.contestShift({ shiftId: 'shift-1', reason: 'horario_distinto', note: 'Horário não confere' });
    const patient = await service.getPatientMonth('2026-08', '90000');
    const shift = patient!.providers[0].shifts[0];
    expect(shift.status).toBe('contestado');
    expect(shift.contestReason).toBe('horario_distinto');
    expect(shift.contestNote).toBe('Horário não confere');
  });

  it('POSITIVO — nota é OPCIONAL (1.5b, D344 revoga a obrigatoriedade anterior)', async () => {
    const service = makeService();
    await service.contestShift({ shiftId: 'shift-1', reason: 'no_asistio' });
    const patient = await service.getPatientMonth('2026-08', '90000');
    const shift = patient!.providers[0].shifts[0];
    expect(shift.status).toBe('contestado');
    expect(shift.contestNote).toBeUndefined();
  });

  it('NEGATIVO — motivo fora do enum é recusado (1.5b)', async () => {
    const service = makeService();
    await expect(
      service.contestShift({ shiftId: 'shift-1', reason: 'motivo-inventado' as never }),
    ).rejects.toMatchObject({ code: 'MOTIVO_INVALIDO' });
  });

  it(`NEGATIVO — nota acima de ${CONTEST_NOTE_MAX_LENGTH} caracteres é recusada (1.5b)`, async () => {
    const service = makeService();
    const notaLonga = 'x'.repeat(CONTEST_NOTE_MAX_LENGTH + 1);
    await expect(service.contestShift({ shiftId: 'shift-1', reason: 'otro', note: notaLonga })).rejects.toMatchObject({
      code: 'NOTA_MUITO_LONGA',
    });
  });

  it(`POSITIVO — nota com exatamente ${CONTEST_NOTE_MAX_LENGTH} caracteres é aceita (limite, não abaixo dele)`, async () => {
    const service = makeService();
    const notaNoLimite = 'x'.repeat(CONTEST_NOTE_MAX_LENGTH);
    await expect(service.contestShift({ shiftId: 'shift-1', reason: 'otro', note: notaNoLimite })).resolves.toBeUndefined();
  });

  it('NEGATIVO — retrato desatualizado recusa a contestação', async () => {
    const service = makeService({ stale: true });
    await expect(service.contestShift({ shiftId: 'shift-1', reason: 'otro', note: 'nota válida' })).rejects.toMatchObject({
      code: 'RETRATO_DESATUALIZADO',
    });
  });
});
