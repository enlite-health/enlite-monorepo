import { GetManagementDashboardUseCase } from '../GetManagementDashboardUseCase';

/**
 * Ordem das 8 queries (Promise.all, invocação síncrona em ordem de array):
 *   1. GetArmedCasesUseCase          → rows por caso [{providers_needed, schedule, sel_*}]
 *   2. job_postings status           → rows [{k,count}]
 *   3. patients activos              → rows [{activos}]
 *   4. workers agregados             → rows [{leads,completos,incompletos,nuevos}]
 *   5. funnel por etapa              → rows [{k,count}]
 *   6. alocados (ana_care_status)    → rows [{activos, cubriendo_guardias}]
 *   7. blocked registration_incompl  → rows [{bloqueados}]
 *   8. encuadres semana              → rows [{agendados}]
 */
interface ArmedRow {
  providers_needed: string | null;
  schedule: unknown;
  sel_total: number;
  sel_with_role: number;
  sel_titular: number;
  sel_substituto: number;
}

function mockDb(
  armed: ArmedRow[],
  jobs: Array<{ k: string; count: number }>,
  patient: { activos: number },
  worker: { leads: number; completos: number; incompletos: number; nuevos: number },
  funnel: Array<{ k: string; count: number }>,
  alocados: { activos: number; cubriendoGuardias: number },
  bloqueados: number,
  agendados: number,
): { query: jest.Mock } {
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: armed })
    .mockResolvedValueOnce({ rows: jobs })
    .mockResolvedValueOnce({ rows: [patient] })
    .mockResolvedValueOnce({ rows: [worker] })
    .mockResolvedValueOnce({ rows: funnel })
    .mockResolvedValueOnce({ rows: [{ activos: alocados.activos, cubriendo_guardias: alocados.cubriendoGuardias }] })
    .mockResolvedValueOnce({ rows: [{ bloqueados }] })
    .mockResolvedValueOnce({ rows: [{ agendados }] });
  return { query };
}

function armedRow(partial: Partial<ArmedRow>): ArmedRow {
  return {
    providers_needed: '1',
    schedule: null,
    sel_total: 0,
    sel_with_role: 0,
    sel_titular: 0,
    sel_substituto: 0,
    ...partial,
  };
}

describe('GetManagementDashboardUseCase', () => {
  it('agrega big numbers, equipe armada, horas, prioridades, funil, encuadres e cadastros', async () => {
    const db = mockDb(
      [
        // ARMADA: 1 titular + 10 substitutos, schedule 4h
        armedRow({
          providers_needed: '1', sel_total: 11, sel_with_role: 11, sel_titular: 1, sel_substituto: 10,
          schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
        }),
        // POR_ARMAR: classificável e incompleto, schedule 6h
        armedRow({
          providers_needed: '2', sel_total: 2, sel_with_role: 2, sel_titular: 1, sel_substituto: 1,
          schedule: [{ dayOfWeek: 2, startTime: '09:00', endTime: '15:00' }],
        }),
        // PENDENTE_CLASSIFICACAO: selecionados sem papel, sem schedule
        armedRow({ providers_needed: '3', sel_total: 2, sel_with_role: 0, schedule: null }),
        // SEM_CONFIG: providers_needed nulo, sem schedule
        armedRow({ providers_needed: null, schedule: null }),
      ],
      [
        { k: 'ACTIVE', count: 82 },
        { k: 'SEARCHING', count: 81 },
        { k: 'SEARCHING_REPLACEMENT', count: 58 },
        { k: 'RAPID_RESPONSE', count: 9 },
        { k: 'PENDING_ACTIVATION', count: 4 },
        { k: 'SUSPENDED', count: 15 },
        { k: 'CLOSED', count: 237 },
      ],
      { activos: 193 },
      { leads: 6882, completos: 250, incompletos: 6632, nuevos: 14 },
      [
        { k: 'INVITED', count: 3435 },
        { k: 'PRE_SCREENING', count: 90 },
        { k: 'IN_PROGRESS', count: 5190 },
        { k: 'COMPLETED', count: 4 },
        { k: 'QUALIFIED', count: 2387 },
        { k: 'CONFIRMED', count: 11 },
        { k: 'SELECTED', count: 2 },
        { k: 'REJECTED', count: 2498 },
      ],
      // alocados vem do ana_care_status (7 Activo + 3 Cubriendo guardias = 10),
      // DESACOPLADO do funil SELECTED (=2 acima). Prova que a fonte mudou.
      { activos: 7, cubriendoGuardias: 3 },
      405,
      0,
    );

    const useCase = new GetManagementDashboardUseCase(db as never);
    const result = await useCase.execute();

    expect(result).toEqual({
      bigNumbers: {
        equiposArmados: 1, // bucket ARMADA (não mais status ACTIVE)
        equiposPorArmar: 1, // bucket POR_ARMAR
        pacientesActivos: 193,
        vacantesAbiertas: 152, // openByStatus 148 (81+58+9) + PENDING_ACTIVATION 4 — regressão preservada
        vacantesPausadas: 15,
      },
      equipoArmada: {
        armados: 1,
        porArmar: 1,
        semConfig: 1,
        pendenteClasificacao: 1,
      },
      horas: {
        totais: 10, // 4h + 6h
        aPreencher: 6, // só o POR_ARMAR com schedule
        coberturaConSchedule: 2,
        coberturaSinSchedule: 2,
      },
      prioridades: {
        completosEsperandoAgendamiento: 2387,
        profesionalesBloqueados: 6632,
      },
      funnel: {
        invitados: 3435,
        bloqueados: 405,
        preScreening: 90,
        completos: 4,
        agendados: 11,
        seleccionados: 2,
        rechazados: 2498,
      },
      encuadres: { agendadosEstaSemana: 0 },
      cadastros: {
        leads: 6882,
        completos: 250,
        alocados: 10, // 7 Activo + 3 Cubriendo guardias — NÃO o funil SELECTED (=2)
        alocadosActivos: 7,
        alocadosCubriendoGuardias: 3,
        incompletos: 6632,
        nuevosCompletosMes: 14,
      },
    });
    expect(db.query).toHaveBeenCalledTimes(8);
  });

  it('trata status/etapas ausentes como zero (sem chaves parciais)', async () => {
    const db = mockDb(
      [],
      [],
      { activos: 0 },
      { leads: 0, completos: 0, incompletos: 0, nuevos: 0 },
      [],
      { activos: 0, cubriendoGuardias: 0 },
      0,
      0,
    );

    const useCase = new GetManagementDashboardUseCase(db as never);
    const result = await useCase.execute();

    expect(result.bigNumbers).toEqual({
      equiposArmados: 0,
      equiposPorArmar: 0,
      pacientesActivos: 0,
      vacantesAbiertas: 0,
      vacantesPausadas: 0,
    });
    expect(result.equipoArmada).toEqual({ armados: 0, porArmar: 0, semConfig: 0, pendenteClasificacao: 0 });
    expect(result.horas).toEqual({ totais: 0, aPreencher: 0, coberturaConSchedule: 0, coberturaSinSchedule: 0 });
    expect(result.funnel.invitados).toBe(0);
    expect(result.cadastros.leads).toBe(0);
  });

  it('faz fallback quando as queries escalares retornam zero linhas', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // armed vazio
      .mockResolvedValueOnce({ rows: [{ k: 'ACTIVE', count: 5 }] })
      .mockResolvedValueOnce({ rows: [] }) // patients vazio
      .mockResolvedValueOnce({ rows: [] }) // workers vazio
      .mockResolvedValueOnce({ rows: [] }) // funnel vazio
      .mockResolvedValueOnce({ rows: [] }) // alocados vazio
      .mockResolvedValueOnce({ rows: [] }) // blocked vazio
      .mockResolvedValueOnce({ rows: [] }); // encuadres vazio

    const useCase = new GetManagementDashboardUseCase({ query } as never);
    const result = await useCase.execute();

    // equiposArmados agora vem do bucket (armed vazio → 0), não do status ACTIVE.
    expect(result.bigNumbers.equiposArmados).toBe(0);
    expect(result.bigNumbers.pacientesActivos).toBe(0);
    expect(result.cadastros.alocados).toBe(0);
    expect(result.cadastros.alocadosActivos).toBe(0);
    expect(result.cadastros.alocadosCubriendoGuardias).toBe(0);
    expect(result.encuadres.agendadosEstaSemana).toBe(0);
  });

  it('rejeita saída inválida via contrato Zod (defesa em profundidade)', async () => {
    const db = mockDb(
      [],
      [{ k: 'SUSPENDED', count: -1 }], // valor impossível → viola nonNegInt em vacantesPausadas
      { activos: 0 },
      { leads: 0, completos: 0, incompletos: 0, nuevos: 0 },
      [],
      { activos: 0, cubriendoGuardias: 0 },
      0,
      0,
    );
    const useCase = new GetManagementDashboardUseCase(db as never);
    await expect(useCase.execute()).rejects.toThrow();
  });
});
