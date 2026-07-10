import { GetManagementDashboardUseCase } from '../GetManagementDashboardUseCase';

/**
 * Ordem das queries:
 *   1. GetArmedCasesUseCase (SERIALIZADA antes do Promise.all — "Em Busca" precisa
 *      dos ids ARMADA do classificador de domínio) → rows por caso
 * Promise.all (invocação síncrona em ordem de array):
 *   2. GetFunnelByWorkerUseCase      → rows por candidatura
 *   3. job_postings status           → rows [{k,count}]
 *   4. patients activos              → rows [{activos}]
 *   5. pacientes estados (CHEGANDO)  → rows [{solicitudes,entrevista_agendada,en_admision,en_busca}]
 *   6. ubicaciones ativas            → rows [{ubicaciones}]
 *   7. horas ativas (schedules)      → rows [{schedule}]
 *   8. workers agregados             → rows [{leads,completos,incompletos,nuevos}]
 *   9. funnel por etapa (LEGADO)     → rows [{k,count}]
 *  10. esperando agenda (fila real)  → rows [{esperando}]
 *  11. alocados (ana_care_status)    → rows [{activos, cubriendo_guardias}]
 *  12. blocked (pessoas, vaga viva)  → rows [{bloqueados}] — alimenta TANTO
 *      funnel.bloqueados QUANTO prioridades.bloqueadosAlPostularse (mesma fonte
 *      já recortada a vaga viva + não desativado, ver GetManagementDashboardUseCase).
 *  13. encuadres semana + sem data   → rows [{agendados, sem_data}]
 */
interface FunnelWorkerRow {
  worker_id: string;
  stage: string | null;
  source: string | null;
  messaged_at: Date | null;
}
interface ArmedRow {
  id: string;
  providers_needed: string | null;
  schedule: unknown;
  sel_total: number;
  sel_with_role: number;
  sel_titular: number;
  sel_substituto: number;
}
interface EstadosRow {
  solicitudes: number;
  entrevista_agendada: number;
  en_admision: number;
  en_busca: number;
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
  funnelPorPrestador: FunnelWorkerRow[] = [],
  encuadresSemData = 0,
  esperandoAgenda = 0,
  estados: EstadosRow = { solicitudes: 0, entrevista_agendada: 0, en_admision: 0, en_busca: 0 },
  ubicaciones = 0,
  horasAtivas: Array<{ schedule: unknown }> = [],
): { query: jest.Mock } {
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: armed })
    .mockResolvedValueOnce({ rows: funnelPorPrestador })
    .mockResolvedValueOnce({ rows: jobs })
    .mockResolvedValueOnce({ rows: [patient] })
    .mockResolvedValueOnce({ rows: [estados] })
    .mockResolvedValueOnce({ rows: [{ ubicaciones }] })
    .mockResolvedValueOnce({ rows: horasAtivas })
    .mockResolvedValueOnce({ rows: [worker] })
    .mockResolvedValueOnce({ rows: funnel })
    .mockResolvedValueOnce({ rows: [{ esperando: esperandoAgenda }] })
    .mockResolvedValueOnce({ rows: [{ activos: alocados.activos, cubriendo_guardias: alocados.cubriendoGuardias }] })
    .mockResolvedValueOnce({ rows: [{ bloqueados }] })
    .mockResolvedValueOnce({ rows: [{ agendados, sem_data: encuadresSemData }] });
  return { query };
}

/** Índices de mock.calls por query (0-based), para as travas de forma do SQL. */
const CALL = {
  armed: 0,
  funnelPorPrestador: 1,
  jobs: 2,
  patients: 3,
  estados: 4,
  ubicaciones: 5,
  horasAtivas: 6,
  workers: 7,
  funnelLegado: 8,
  esperando: 9,
  alocados: 10,
  blocked: 11,
  encuadres: 12,
} as const;

function armedRow(partial: Partial<ArmedRow>): ArmedRow {
  return {
    id: 'case-1',
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
  afterEach(() => {
    delete process.env.ENCUADRE_WEEKLY_CAPACITY;
  });

  it('agrega big numbers, equipe armada, pacientes, horas, prioridades, funil, encuadres e cadastros', async () => {
    const db = mockDb(
      [
        // ARMADA: 1 titular + 10 substitutos, schedule 4h → tb conta no % RR (num)
        armedRow({
          id: 'case-armada',
          providers_needed: '1', sel_total: 11, sel_with_role: 11, sel_titular: 1, sel_substituto: 10,
          schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
        }),
        // POR_ARMAR: classificável e incompleto (1 substituto < 10), schedule 6h
        armedRow({
          id: 'case-por-armar',
          providers_needed: '2', sel_total: 2, sel_with_role: 2, sel_titular: 1, sel_substituto: 1,
          schedule: [{ dayOfWeek: 2, startTime: '09:00', endTime: '15:00' }],
        }),
        // PENDENTE_CLASSIFICACAO: selecionados sem papel, sem schedule
        armedRow({ id: 'case-pendente', providers_needed: '3', sel_total: 2, sel_with_role: 0, schedule: null }),
        // SEM_CONFIG: providers_needed nulo, sem schedule
        armedRow({ id: 'case-sem-config', providers_needed: null, schedule: null }),
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
      405, // pessoas distintas em vaga viva → funnel.bloqueados E prioridades.bloqueadosAlPostularse
      8, // encuadres agendados esta semana (denominador de capacidade default = 80)
      // Funil por prestador: w1 em 2 vagas (IN_PROGRESS + REJECTED) e w2 rejeitado.
      [
        { worker_id: 'w1', stage: 'IN_PROGRESS', source: 'talentum', messaged_at: null },
        { worker_id: 'w1', stage: 'REJECTED', source: 'talentum', messaged_at: null },
        { worker_id: 'w2', stage: 'REJECTED', source: 'manual', messaged_at: null },
      ],
      0,   // encuadres sem data
      569, // esperando agenda: PESSOAS em vaga viva
      // Linha CHEGANDO (Diego): estados atuais, exclusivos por precedência
      { solicitudes: 2, entrevista_agendada: 1, en_admision: 5, en_busca: 112 },
      339, // ubicaciones distintas de pacientes ativos
      // Horas ativas (vagas status=ACTIVE): 4h com schedule + 1 sem
      [{ schedule: [{ dayOfWeek: 3, startTime: '08:00', endTime: '12:00' }] }, { schedule: null }],
    );

    const useCase = new GetManagementDashboardUseCase(db as never);
    const result = await useCase.execute();

    expect(result).toEqual({
      bigNumbers: {
        equiposArmados: 1,
        equiposPorArmar: 1,
        pacientesActivos: 193,
        vacantesAbiertas: 152, // openByStatus 148 (81+58+9) + PENDING_ACTIVATION 4
        vacantesPausadas: 15,
      },
      equipoArmada: {
        armados: 1,
        porArmar: 1,
        semConfig: 1,
        pendenteClasificacao: 1,
        // num=1 (só a ARMADA tem ≥10 substitutos), den=2 (ARMADA+POR_ARMAR),
        // excluidos=2 (SEM_CONFIG + PENDENTE) — nunca no denominador.
        pctRespostaRapidaArmado: { num: 1, den: 2, excluidos: 2, pct: 50 },
      },
      pacientes: {
        activos: 193,
        ubicacionesActivas: 339,
        solicitudes: 2,
        entrevistaAgendada: 1,
        enAdmision: 5,
        enBusca: 112,
        sobrepoe: true,
      },
      horas: {
        totais: 10, // 4h + 6h (vagas vivas)
        aPreencher: 6, // só o POR_ARMAR com schedule
        ativas: 4, // vaga ACTIVE com schedule de 4h
        ativasConSchedule: 1,
        ativasSinSchedule: 1,
        coberturaConSchedule: 2,
        coberturaSinSchedule: 2,
      },
      prioridades: {
        completosEsperandoAgendamiento: 569,
        registrosIncompletos: 6632,
        // mesma fonte de funnel.bloqueados (405): pessoas distintas em vaga viva.
        bloqueadosAlPostularse: 405,
      },
      funnelPorPrestador: {
        total: 2,
        recorte: 'vagas-vivas',
        periodoDias: null,
        bloqueados: 405,
        porEtapa: {
          somavel: false,
          colunas: {
            INVITED: 0, INICIADO: 0, PRE_SCREENING: 0, IN_PROGRESS: 1,
            COMPLETED: 0, CONFIRMED: 0, SELECTED: 0, REJECTED: 2,
          },
        },
        consolidado: {
          somavel: true,
          colunas: {
            INVITED: 0, INICIADO: 0, PRE_SCREENING: 0, IN_PROGRESS: 1,
            COMPLETED: 0, CONFIRMED: 0, SELECTED: 0, REJECTED: 1,
          },
        },
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
      encuadres: {
        agendadosEstaSemana: 8,
        semDataRegistrada: 0,
        // Capacidade default 80 (env ausente): 8/80 = 10%.
        pctCapacidadeSemana: { agendados: 8, capacidade: 80, pct: 10 },
      },
      cadastros: {
        leads: 6882,
        completos: 250,
        alocados: 10,
        alocadosActivos: 7,
        alocadosCubriendoGuardias: 3,
        incompletos: 6632,
        nuevosCompletosMes: 14,
      },
    });
    expect(db.query).toHaveBeenCalledTimes(13);
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
    expect(result.equipoArmada).toEqual({
      armados: 0,
      porArmar: 0,
      semConfig: 0,
      pendenteClasificacao: 0,
      // den=0 → pct null, NUNCA um 0% fabricado por divisão degenerada.
      pctRespostaRapidaArmado: { num: 0, den: 0, excluidos: 0, pct: null },
    });
    expect(result.pacientes).toEqual({
      activos: 0,
      ubicacionesActivas: 0,
      solicitudes: 0,
      entrevistaAgendada: 0,
      enAdmision: 0,
      enBusca: 0,
      sobrepoe: true,
    });
    expect(result.horas).toEqual({
      totais: 0,
      aPreencher: 0,
      ativas: 0,
      ativasConSchedule: 0,
      ativasSinSchedule: 0,
      coberturaConSchedule: 0,
      coberturaSinSchedule: 0,
    });
    expect(result.funnel.invitados).toBe(0);
    expect(result.cadastros.leads).toBe(0);
  });

  it('faz fallback quando as queries escalares retornam zero linhas', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    // Sobrescreve a 3ª (jobs) para provar que o resto cai no fallback mesmo com dado.
    query
      .mockResolvedValueOnce({ rows: [] }) // armed
      .mockResolvedValueOnce({ rows: [] }) // funil por prestador
      .mockResolvedValueOnce({ rows: [{ k: 'ACTIVE', count: 5 }] }); // jobs

    const useCase = new GetManagementDashboardUseCase({ query } as never);
    const result = await useCase.execute();

    expect(result.bigNumbers.equiposArmados).toBe(0);
    expect(result.bigNumbers.pacientesActivos).toBe(0);
    expect(result.pacientes.enBusca).toBe(0);
    expect(result.cadastros.alocados).toBe(0);
    expect(result.encuadres.agendadosEstaSemana).toBe(0);
  });

  it('linha CHEGANDO: a forma do SQL trava precedência, terminais fora e ids ARMADA como parâmetro', async () => {
    // A precedência (Em Busca > Em Admissão > Entrevista > Solicitações) é SQL;
    // com pool mockado, a trava é a FORMA da query — os predicados não podem
    // sumir num refactor. A prova com dado real é a task 6.1.
    const db = mockDb([], [], { activos: 0 }, { leads: 0, completos: 0, incompletos: 0, nuevos: 0 }, [], { activos: 0, cubriendoGuardias: 0 }, 0, 0);
    await new GetManagementDashboardUseCase(db as never).execute();

    const [estadosSql, estadosParams] = db.query.mock.calls[CALL.estados];
    expect(estadosSql).toContain('admission_appointments');
    expect(estadosSql).toContain("status NOT IN ('DISCONTINUED', 'DISCHARGED')"); // zumbis fora
    expect(estadosSql).toContain("status IN ('ADMISSION', 'PENDING_ADMISSION')");
    expect(estadosSql).toContain('NOT em_busca_vaga'); // precedência exclusiva
    expect(estadosSql).toContain('$1::uuid[]'); // ids ARMADA do classificador de domínio
    expect(estadosParams).toEqual([[]]);

    const [ubicacionesSql] = db.query.mock.calls[CALL.ubicaciones];
    expect(ubicacionesSql).toContain('DISTINCT'); // dedup — 566 linhas cruas viram 339 reais
    expect(ubicacionesSql).toContain("p.status = 'ACTIVE'");

    const [horasAtivasSql] = db.query.mock.calls[CALL.horasAtivas];
    expect(horasAtivasSql).toContain("jp.status = 'ACTIVE'"); // em atendimento ≠ vivo (busca)
  });

  it('capacidade de encuadres é config: 60 no env muda o denominador sem código', async () => {
    process.env.ENCUADRE_WEEKLY_CAPACITY = '60';
    const db = mockDb([], [], { activos: 0 }, { leads: 0, completos: 0, incompletos: 0, nuevos: 0 }, [], { activos: 0, cubriendoGuardias: 0 }, 0, 30);
    const result = await new GetManagementDashboardUseCase(db as never).execute();

    expect(result.encuadres.pctCapacidadeSemana).toEqual({ agendados: 30, capacidade: 60, pct: 50 });
  });

  it('capacidade zerada ou inválida OMITE o percentual (nunca divisão por zero)', async () => {
    process.env.ENCUADRE_WEEKLY_CAPACITY = '0';
    const db = mockDb([], [], { activos: 0 }, { leads: 0, completos: 0, incompletos: 0, nuevos: 0 }, [], { activos: 0, cubriendoGuardias: 0 }, 0, 5);
    const result = await new GetManagementDashboardUseCase(db as never).execute();
    expect(result.encuadres.pctCapacidadeSemana).toBeUndefined();

    process.env.ENCUADRE_WEEKLY_CAPACITY = 'oitenta';
    const db2 = mockDb([], [], { activos: 0 }, { leads: 0, completos: 0, incompletos: 0, nuevos: 0 }, [], { activos: 0, cubriendoGuardias: 0 }, 0, 5);
    const result2 = await new GetManagementDashboardUseCase(db2 as never).execute();
    expect(result2.encuadres.pctCapacidadeSemana).toBeUndefined();
  });

  it('filtro por período: repassa os dias ao funil por prestador e ecoa no payload', async () => {
    const db = mockDb([], [], { activos: 0 }, { leads: 0, completos: 0, incompletos: 0, nuevos: 0 }, [], { activos: 0, cubriendoGuardias: 0 }, 0, 0);
    const result = await new GetManagementDashboardUseCase(db as never).execute({ funnelPeriodDays: 7 });

    expect(result.funnelPorPrestador.periodoDias).toBe(7);
    const [funnelSql, funnelParams] = db.query.mock.calls[CALL.funnelPorPrestador];
    expect(funnelSql).toContain('make_interval(days => $1)'); // filtra por ENTRADA no funil
    expect(funnelParams).toEqual([7]);
  });

  it('sem período: query do funil não tem predicado de data e periodoDias é null', async () => {
    const db = mockDb([], [], { activos: 0 }, { leads: 0, completos: 0, incompletos: 0, nuevos: 0 }, [], { activos: 0, cubriendoGuardias: 0 }, 0, 0);
    const result = await new GetManagementDashboardUseCase(db as never).execute();

    expect(result.funnelPorPrestador.periodoDias).toBeNull();
    const [funnelSql, funnelParams] = db.query.mock.calls[CALL.funnelPorPrestador];
    expect(funnelSql).not.toContain('make_interval');
    expect(funnelParams).toEqual([]);
  });

  it('conta entrevistas da semana no fuso da OPERAÇÃO e expõe quantos estão sem data', async () => {
    const db = mockDb([], [], { activos: 0 }, { leads: 0, completos: 0, incompletos: 0, nuevos: 0 }, [], { activos: 0, cubriendoGuardias: 0 }, 0, 7, [], 12);
    const result = await new GetManagementDashboardUseCase(db as never).execute();

    expect(result.encuadres.agendadosEstaSemana).toBe(7);
    expect(result.encuadres.semDataRegistrada).toBe(12);

    const encuadresSql: string = db.query.mock.calls[CALL.encuadres][0];
    expect(encuadresSql).toContain('worker_job_applications');
    expect(encuadresSql).toContain('interview_datetime'); // fonte atual
    expect(encuadresSql).toContain('e.interview_date'); // fallback do legado da importação
    expect(encuadresSql).toContain('America/Argentina/Buenos_Aires'); // não UTC
  });

  it('não conta paciente apagado em pacientesActivos', async () => {
    const db = mockDb([], [], { activos: 0 }, { leads: 0, completos: 0, incompletos: 0, nuevos: 0 }, [], { activos: 0, cubriendoGuardias: 0 }, 0, 0);
    await new GetManagementDashboardUseCase(db as never).execute();

    const patientsSql: string = db.query.mock.calls[CALL.patients][0];
    expect(patientsSql).toContain('FROM patients');
    expect(patientsSql).toContain('deleted_at IS NULL');
  });

  it('rejeita saída inválida via contrato Zod (defesa em profundidade)', async () => {
    const db = mockDb(
      [],
      [{ k: 'SUSPENDED', count: -1 }], // valor impossível → viola nonNegInt
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
