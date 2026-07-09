import { GetManagementDashboardUseCase } from '../GetManagementDashboardUseCase';

/**
 * Ordem das 7 queries (Promise.all, invocação síncrona em ordem de array):
 *   1. job_postings status         → rows [{k,count}]
 *   2. patients activos            → rows [{activos}]
 *   3. workers agregados           → rows [{leads,completos,incompletos,nuevos}]
 *   4. funnel por etapa            → rows [{k,count}]
 *   5. alocados (distinct SELECTED) → rows [{alocados}]
 *   6. blocked registration_incompl → rows [{bloqueados}]
 *   7. encuadres semana            → rows [{agendados}]
 */
function mockDb(
  jobs: Array<{ k: string; count: number }>,
  patient: { activos: number },
  worker: { leads: number; completos: number; incompletos: number; nuevos: number },
  funnel: Array<{ k: string; count: number }>,
  alocados: number,
  bloqueados: number,
  agendados: number,
): { query: jest.Mock } {
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: jobs })
    .mockResolvedValueOnce({ rows: [patient] })
    .mockResolvedValueOnce({ rows: [worker] })
    .mockResolvedValueOnce({ rows: funnel })
    .mockResolvedValueOnce({ rows: [{ alocados }] })
    .mockResolvedValueOnce({ rows: [{ bloqueados }] })
    .mockResolvedValueOnce({ rows: [{ agendados }] });
  return { query };
}

describe('GetManagementDashboardUseCase', () => {
  it('agrega big numbers, prioridades, funil, encuadres e cadastros', async () => {
    const db = mockDb(
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
      2,
      405,
      0,
    );

    const useCase = new GetManagementDashboardUseCase(db as never);
    const result = await useCase.execute();

    expect(result).toEqual({
      bigNumbers: {
        equiposArmados: 82,
        equiposPorArmar: 148, // 81 + 58 + 9
        pacientesActivos: 193,
        vacantesAbiertas: 152, // 148 + 4
        vacantesPausadas: 15,
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
        alocados: 2,
        incompletos: 6632,
        nuevosCompletosMes: 14,
      },
    });
    expect(db.query).toHaveBeenCalledTimes(7);
  });

  it('trata status/etapas ausentes como zero (sem chaves parciais)', async () => {
    const db = mockDb([], { activos: 0 }, { leads: 0, completos: 0, incompletos: 0, nuevos: 0 }, [], 0, 0, 0);

    const useCase = new GetManagementDashboardUseCase(db as never);
    const result = await useCase.execute();

    expect(result.bigNumbers).toEqual({
      equiposArmados: 0,
      equiposPorArmar: 0,
      pacientesActivos: 0,
      vacantesAbiertas: 0,
      vacantesPausadas: 0,
    });
    expect(result.funnel.invitados).toBe(0);
    expect(result.cadastros.leads).toBe(0);
  });

  it('faz fallback quando as queries escalares retornam zero linhas', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ k: 'ACTIVE', count: 5 }] })
      .mockResolvedValueOnce({ rows: [] }) // patients vazio
      .mockResolvedValueOnce({ rows: [] }) // workers vazio
      .mockResolvedValueOnce({ rows: [] }) // funnel vazio
      .mockResolvedValueOnce({ rows: [] }) // alocados vazio
      .mockResolvedValueOnce({ rows: [] }) // blocked vazio
      .mockResolvedValueOnce({ rows: [] }); // encuadres vazio

    const useCase = new GetManagementDashboardUseCase({ query } as never);
    const result = await useCase.execute();

    expect(result.bigNumbers.equiposArmados).toBe(5);
    expect(result.bigNumbers.pacientesActivos).toBe(0);
    expect(result.cadastros.alocados).toBe(0);
    expect(result.encuadres.agendadosEstaSemana).toBe(0);
  });

  it('rejeita saída inválida via contrato Zod (defesa em profundidade)', async () => {
    const db = mockDb(
      [{ k: 'ACTIVE', count: -1 }], // valor impossível → viola nonNegInt
      { activos: 0 },
      { leads: 0, completos: 0, incompletos: 0, nuevos: 0 },
      [],
      0,
      0,
      0,
    );
    const useCase = new GetManagementDashboardUseCase(db as never);
    await expect(useCase.execute()).rejects.toThrow();
  });
});
