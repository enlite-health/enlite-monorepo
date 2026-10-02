import { GetFunnelByWorkerUseCase } from '../GetFunnelByWorkerUseCase';
import { OPEN_JOB_STATUSES } from '../../domain/openJobStatuses';
import { managementDashboardSchema, type ManagementDashboardData } from '../managementDashboardSchema';

interface Row {
  worker_id: string;
  stage: string | null;
  source: string | null;
  messaged_at: Date | null;
}

function row(partial: Partial<Row> & { worker_id: string }): Row {
  return { stage: 'IN_PROGRESS', source: 'talentum', messaged_at: null, ...partial };
}

function mockDb(rows: Row[]): { query: jest.Mock } {
  return { query: jest.fn().mockResolvedValue({ rows }) };
}

function sum(colunas: Record<string, number>): number {
  return Object.values(colunas).reduce((a, b) => a + b, 0);
}

describe('GetFunnelByWorkerUseCase', () => {
  it('conta o prestador UMA vez, mesmo em 10 vagas da mesma coluna', async () => {
    // O caso do Diego: "o profissional que está em 10 vagas aparece acumulado na soma".
    const rows = Array.from({ length: 10 }, () => row({ worker_id: 'w1' }));
    const result = await new GetFunnelByWorkerUseCase(mockDb(rows) as never).execute();

    expect(result.total).toBe(1);
    expect(result.porEtapa.IN_PROGRESS).toBe(1);
    expect(result.consolidado.IN_PROGRESS).toBe(1);
  });

  it('na vista por etapa o prestador aparece em CADA coluna em que está (não soma)', async () => {
    const result = await new GetFunnelByWorkerUseCase(
      mockDb([
        row({ worker_id: 'w1', stage: 'REJECTED' }),
        row({ worker_id: 'w1', stage: 'IN_PROGRESS' }),
      ]) as never,
    ).execute();

    expect(result.porEtapa.REJECTED).toBe(1);
    expect(result.porEtapa.IN_PROGRESS).toBe(1);
    expect(sum(result.porEtapa)).toBe(2);
    expect(result.total).toBe(1); // a soma NÃO fecha com o total — é o contrato da vista
  });

  it('na vista consolidada o prestador cai na coluna mais avançada', async () => {
    // Rejeitado na vaga A e em progresso na vaga B é candidato ativo, não rejeitado.
    const result = await new GetFunnelByWorkerUseCase(
      mockDb([
        row({ worker_id: 'w1', stage: 'REJECTED' }),
        row({ worker_id: 'w1', stage: 'IN_PROGRESS' }),
      ]) as never,
    ).execute();

    expect(result.consolidado.IN_PROGRESS).toBe(1);
    expect(result.consolidado.REJECTED).toBe(0);
  });

  it('a soma da vista consolidada é SEMPRE igual ao total (trava do contrato)', async () => {
    const rows = [
      row({ worker_id: 'w1', stage: 'INVITED', source: 'talentum' }),
      row({ worker_id: 'w1', stage: 'SELECTED' }),
      row({ worker_id: 'w2', stage: 'REJECTED' }),
      row({ worker_id: 'w2', stage: 'CONFIRMED' }),
      row({ worker_id: 'w3', stage: 'QUALIFIED' }),
      row({ worker_id: 'w4', stage: 'INVITED', source: 'manual' }),
      row({ worker_id: 'w5', stage: 'PRE_SCREENING' }),
    ];
    const result = await new GetFunnelByWorkerUseCase(mockDb(rows) as never).execute();

    expect(result.total).toBe(5);
    expect(sum(result.consolidado)).toBe(result.total);
    expect(result.consolidado.SELECTED).toBe(1); // w1
    expect(result.consolidado.CONFIRMED).toBe(1); // w2 (não REJECTED)
    expect(result.consolidado.COMPLETED).toBe(1); // w3 — QUALIFIED vive na coluna COMPLETED
    expect(result.consolidado.INICIADO).toBe(1); // w4 — INVITED+manual
    expect(result.consolidado.PRE_SCREENING).toBe(1); // w5
  });

  it('agrupa pelas MESMAS colunas do Kanban (COMPLETED/QUALIFIED/IN_DOUBT juntas)', async () => {
    // O bug original: o painel lia etapa crua e mostrava "Completos: 4" enquanto a
    // coluna do Kanban tinha 2.541 cards.
    const result = await new GetFunnelByWorkerUseCase(
      mockDb([
        row({ worker_id: 'w1', stage: 'COMPLETED' }),
        row({ worker_id: 'w2', stage: 'QUALIFIED' }),
        row({ worker_id: 'w3', stage: 'IN_DOUBT' }),
      ]) as never,
    ).execute();

    expect(result.porEtapa.COMPLETED).toBe(3);
    expect(sum(result.consolidado)).toBe(3);
  });

  it('ignora o candidato de matching que nunca recebeu mensagem', async () => {
    // Mesma regra que o Kanban aplica (isMatchedNotInvited) — 669 linhas em prod.
    const result = await new GetFunnelByWorkerUseCase(
      mockDb([
        row({ worker_id: 'fantasma', stage: 'INVITED', source: 'system', messaged_at: null }),
        row({ worker_id: 'real', stage: 'INVITED', source: 'system', messaged_at: new Date() }),
      ]) as never,
    ).execute();

    expect(result.total).toBe(1);
    expect(result.porEtapa.INVITED).toBe(1);
  });

  it('candidato do match (INVITED/system/sem messaged) some do payload parseado — nenhuma chave COMPATIBLE (DX-5.4)', async () => {
    // O painel NÃO ganha Compatíveis nesta fase (D437 item 1: `:107` mantém o
    // `continue`). `porEtapa`/`consolidado` NASCEM com `COMPATIBLE: 0`
    // (emptyFunnelColumnCounts inclui as 10 colunas), mas o contrato do endpoint
    // (`funnelColumnCountsSchema`, só 9 chaves, sem `.strict()`) descarta a chave
    // no `.parse()` — o descarte é correto por construção (sempre 0).
    const result = await new GetFunnelByWorkerUseCase(
      mockDb([
        row({ worker_id: 'fantasma', stage: 'INVITED', source: 'system', messaged_at: null }),
        row({ worker_id: 'real', stage: 'INVITED', source: 'system', messaged_at: new Date() }),
      ]) as never,
    ).execute();

    expect(result.porEtapa.INVITED).toBe(1);
    expect((result.porEtapa as Record<string, number>).COMPATIBLE).toBe(0);

    const payload: ManagementDashboardData = {
      scope: { countries: ['AR'], requested: 'ALL' },
      bigNumbers: {
        equiposArmados: 0, equiposPorArmar: 0, pacientesActivos: 0,
        vacantesAbiertas: 0, vacantesPausadas: 0,
      },
      equipoArmada: {
        armados: 0, porArmar: 0, semConfig: 0, pendenteClasificacao: 0,
        pctRespostaRapidaArmado: { num: 0, den: 0, excluidos: 0, pct: null },
      },
      pacientes: {
        activos: 0, ubicacionesActivas: 0, solicitudes: 0, entrevistaAgendada: 0,
        enAdmision: 0, enBusca: 0, sobrepoe: true,
      },
      horas: {
        totais: 0, aPreencher: 0, ativas: 0, ativasConSchedule: 0, ativasSinSchedule: 0,
        coberturaConSchedule: 0, coberturaSinSchedule: 0,
      },
      prioridades: { completosEsperandoAgendamiento: 0, registrosIncompletos: 0, bloqueadosAlPostularse: 0 },
      funnelPorPrestador: {
        total: result.total,
        recorte: 'vagas-vivas',
        periodoDias: null,
        bloqueados: 0,
        porEtapa: { somavel: false, colunas: result.porEtapa },
        consolidado: { somavel: true, colunas: result.consolidado },
      },
      funnel: {
        invitados: 0, bloqueados: 0, preScreening: 0, completos: 0,
        agendados: 0, seleccionados: 0, rechazados: 0,
      },
      encuadres: { agendadosEstaSemana: 0, semDataRegistrada: 0 },
      cadastros: {
        leads: 0, completos: 0, alocados: 0, alocadosActivos: 0, alocadosCubriendoGuardias: 0,
        incompletos: 0, nuevosCompletosMes: 0,
      },
    };

    const parsed = managementDashboardSchema.parse(payload);

    expect(parsed.funnelPorPrestador.porEtapa.colunas).not.toHaveProperty('COMPATIBLE');
    expect(parsed.funnelPorPrestador.porEtapa.colunas.INVITED).toBe(1);
  });

  it('devolve zero em TODAS as colunas quando não há ninguém (nunca chave ausente)', async () => {
    const result = await new GetFunnelByWorkerUseCase(mockDb([]) as never).execute();

    expect(result.total).toBe(0);
    expect(result.porEtapa).toEqual({
      COMPATIBLE: 0, INVITED: 0, INICIADO: 0, PRE_SCREENING: 0, IN_PROGRESS: 0,
      COMPLETED: 0, CONFIRMED: 0, SELECTED: 0, QUICK_RESPONSE_TEAM: 0, REJECTED: 0,
    });
    expect(result.consolidado).toEqual(result.porEtapa);
  });

  /**
   * O recorte de vaga viva / prestador mergeado é aplicado em SQL — com pool
   * mockado não dá pra exercitá-lo de verdade. O que este teste garante é que os
   * filtros não sumam da query num refactor; a verificação com dado real é contra
   * o banco de produção (tasks.md, bloco 3).
   */
  it('recorta em SQL: vaga viva, não rascunho, não apagada e prestador não mergeado', async () => {
    const db = mockDb([]);
    await new GetFunnelByWorkerUseCase(db as never).execute();

    const sql: string = db.query.mock.calls[0][0];
    expect(sql).toContain('jp.deleted_at IS NULL');
    expect(sql).toContain('jp.is_draft = false');
    expect(sql).toContain('w.merged_into_id IS NULL');
    for (const status of OPEN_JOB_STATUSES) {
      expect(sql).toContain(`'${status}'`);
    }
    // Não vaza PII: a query só lê id/estado, nunca coluna criptografada.
    expect(sql).not.toMatch(/_encrypted|_bidx/);
  });
});
