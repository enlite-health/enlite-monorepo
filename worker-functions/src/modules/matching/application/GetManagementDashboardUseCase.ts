import type { Pool } from 'pg';
import { managementDashboardSchema, type ManagementDashboardData } from './managementDashboardSchema';
import { GetArmedCasesUseCase } from './GetArmedCasesUseCase';
import { GetFunnelByWorkerUseCase } from './GetFunnelByWorkerUseCase';
import { COUNTRY_CODES, type CountryCode } from '@shared/domain/countryCodes';
import {
  computeScheduleWeeklyHours,
  hasStructuredSchedule,
} from '../domain/scheduleHours';
import {
  jobStatusCountsQuery,
  patientsActiveCountQuery,
  pacienteEstadosQuery,
  ubicacionesActivasQuery,
  horasAtivasQuery,
  workerCadastrosQuery,
  funnelLegadoQuery,
  esperandoAgendaQuery,
  alocadosAnaCareQuery,
  bloqueadosQuery,
  encuadresSemanaQuery,
  type CountRow,
} from './managementDashboardQueries';

export interface ManagementDashboardOptions {
  /** Filtro por ENTRADA no funil por prestador (7/30/90 dias). Ausente = tudo. */
  funnelPeriodDays?: number;
  /**
   * Países que a agregação deve enxergar (PR-9, `lex` #9, FR-732). Resolvido
   * SEMPRE pelo controller via `resolveCountryScope` — nunca opcional na
   * prática, mas default para os dois países aqui para não quebrar chamador
   * antigo (ex.: teste unitário direto do use case) com um comportamento
   * silenciosamente diferente: os dois países é o universo inteiro de hoje,
   * então o predicado explícito vira um no-op funcional sem deixar de existir
   * na query (L9-3 — nunca depende de a RLS estar ligada).
   */
  countries?: CountryCode[];
  /** O que foi pedido (`?country=`), já normalizado pelo resolvedor — ecoado em `scope.requested`. */
  requested?: CountryCode | 'ALL';
}

/**
 * Capacidade semanal contratada de encuadres (reuniões de coordenação).
 * Origem: call 22/07 (Marcel, 01:53 — "80 reuniões = 40h × 2/h, contratadas"),
 * confirmada em 30/07 com pedido explícito de ser CONFIGURÁVEL.
 * REVISADA para 30 na call de produto de 12/08 (Diego/Marcel, task 86ak04ygv):
 * o denominador passa a refletir a capacidade real da coordenação. Zero/inválida →
 * o percentual é OMITIDO do payload (nunca divisão por zero, nunca 0% falso).
 *
 * ⚠️ ARMADILHA DO DEFAULT ESPELHADO — ler antes de trocar este número.
 * O `36` abaixo é só o fallback de dev/test. Em prd/stg a env
 * `ENCUADRE_WEEKLY_CAPACITY` vem dos workflows e VENCE o default: mudar aqui não
 * muda produção. E o erro não é silencioso de cara — é pior. Trocar só este literal
 * deixa VERMELHO o teste do default (`__tests__/GetManagementDashboardUseCase.test.ts`,
 * valor esperado na :252 — `{agendados: 8, capacidade: 36, pct: 22.2}` — afirmado com a
 * env apagada). A armadilha é o passo SEGUINTE: "consertar" o teste para o valor novo
 * devolve a suíte ao verde e dá a sensação de mudança feita, enquanto prd/stg seguem
 * no valor antigo, porque a env continua a mesma.
 *
 * QUEM DECIDE PRODUÇÃO SÃO OS WORKFLOWS. O valor é espelhado em 4 lugares:
 *   1. este default                        — só dev/test
 *   2. .github/workflows/backend-prd.yml   ← o que vale em PRODUÇÃO
 *   3. .github/workflows/backend-stg.yml   ← o que vale em STAGING
 *   4. worker-functions/.env.example       — inventário de env, não afeta runtime
 * Alterar nos 4 e só ENTÃO atualizar o valor esperado do teste — depois dos
 * workflows, nunca no lugar deles.
 */
function readEncuadreWeeklyCapacity(): number | null {
  const raw = process.env.ENCUADRE_WEEKLY_CAPACITY ?? '36';
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Agrega as métricas do "Dashboard para Gestão à Vista" (ClickUp 86ajb4qnw).
 *
 * READ-ONLY: apenas COUNT/GROUP BY sobre tabelas existentes. Nunca toca colunas
 * *_encrypted (zero PII). Não cria tabelas nem inventa colunas — cada número tem
 * fonte verificada. A saída é validada pelo Zod antes de retornar.
 */
export class GetManagementDashboardUseCase {
  constructor(private readonly db: Pool) {}

  async execute(options?: ManagementDashboardOptions): Promise<ManagementDashboardData> {
    const countries: CountryCode[] = options?.countries ?? [...COUNTRY_CODES];

    // Equipe Armada RODA ANTES do Promise.all: o card "Em Busca" precisa dos ids
    // dos casos ARMADA (classificação de domínio em JS — nunca replicada em SQL).
    // Custo: 1 query serializada (~17ms em prod, medido na change anterior).
    const armed = await new GetArmedCasesUseCase(this.db).execute(countries);

    const [
      funnelPorPrestador,
      jobRows,
      patientRows,
      pacienteEstadosRow,
      ubicacionesRow,
      horasAtivasRows,
      workerRow,
      funnelRows,
      esperandoRow,
      allocatedRow,
      blockedRow,
      encuadreRow,
    ] =
      await Promise.all([
        // Funil por PRESTADOR, recortado à operação viva (ver GetFunnelByWorkerUseCase).
        new GetFunnelByWorkerUseCase(this.db).execute(options?.funnelPeriodDays, countries),
        jobStatusCountsQuery(this.db, countries),
        patientsActiveCountQuery(this.db, countries),
        pacienteEstadosQuery(this.db, armed.armadaCaseIds, countries),
        ubicacionesActivasQuery(this.db, countries),
        horasAtivasQuery(this.db, countries),
        workerCadastrosQuery(this.db, countries),
        funnelLegadoQuery(this.db, countries),
        esperandoAgendaQuery(this.db, countries),
        alocadosAnaCareQuery(this.db, countries),
        bloqueadosQuery(this.db, countries),
        encuadresSemanaQuery(this.db, countries),
      ]);

    const jobs = toRecord(jobRows.rows);
    const funnel = toRecord(funnelRows.rows);

    const patient = patientRows.rows[0] ?? { activos: 0 };
    const estados = pacienteEstadosRow.rows[0] ?? {
      solicitudes: 0,
      entrevista_agendada: 0,
      en_admision: 0,
      en_busca: 0,
    };
    const ubicaciones = ubicacionesRow.rows[0]?.ubicaciones ?? 0;

    // Horas ativas: soma em JS com o parser de domínio (mesmo padrão do armed).
    let horasAtivas = 0;
    let ativasConSchedule = 0;
    let ativasSinSchedule = 0;
    for (const row of horasAtivasRows.rows) {
      horasAtivas += computeScheduleWeeklyHours(row.schedule);
      if (hasStructuredSchedule(row.schedule)) ativasConSchedule += 1;
      else ativasSinSchedule += 1;
    }

    const capacidadeSemana = readEncuadreWeeklyCapacity();
    const worker = workerRow.rows[0] ?? { leads: 0, completos: 0, incompletos: 0, nuevos: 0 };
    const alocadosActivos = allocatedRow.rows[0]?.activos ?? 0;
    const alocadosCubriendoGuardias = allocatedRow.rows[0]?.cubriendo_guardias ?? 0;
    const allocated = alocadosActivos + alocadosCubriendoGuardias;
    const blocked = blockedRow.rows[0]?.bloqueados ?? 0;
    const encuadre = encuadreRow.rows[0]?.agendados ?? 0;
    const encuadreSemData = encuadreRow.rows[0]?.sem_data ?? 0;

    // Vagas abertas POR STATUS — conceito distinto de "equipe por armar" (bucket).
    // Mantido como estava para não quebrar vacantesAbiertas (teste de regressão).
    const openByStatus =
      pick(jobs, 'SEARCHING') + pick(jobs, 'SEARCHING_REPLACEMENT') + pick(jobs, 'RAPID_RESPONSE');

    const data: ManagementDashboardData = {
      // PR-9 (`lex` #9, FR-734): o seletor do front lista `scope.countries`
      // (nunca COUNTRY_CODES inteiro) — nunca uma string livre, só enum de país.
      scope: {
        countries,
        requested: options?.requested ?? 'ALL',
      },
      bigNumbers: {
        // Agora baseado na regra "Equipe Armada" (não mais job_postings.status).
        equiposArmados: armed.armados,
        equiposPorArmar: armed.porArmar,
        pacientesActivos: patient.activos,
        vacantesAbiertas: openByStatus + pick(jobs, 'PENDING_ACTIVATION'),
        vacantesPausadas: pick(jobs, 'SUSPENDED'),
      },
      equipoArmada: {
        armados: armed.armados,
        porArmar: armed.porArmar,
        semConfig: armed.semConfig,
        pendenteClasificacao: armed.pendenteClasificacao,
        pctRespostaRapidaArmado: {
          num: armed.respostaRapida.num,
          den: armed.respostaRapida.den,
          excluidos: armed.respostaRapida.excluidos,
          pct:
            armed.respostaRapida.den > 0
              ? round1Pct((armed.respostaRapida.num / armed.respostaRapida.den) * 100)
              : null,
        },
      },
      pacientes: {
        activos: patient.activos,
        ubicacionesActivas: ubicaciones,
        solicitudes: estados.solicitudes,
        entrevistaAgendada: estados.entrevista_agendada,
        enAdmision: estados.en_admision,
        enBusca: estados.en_busca,
        sobrepoe: true,
      },
      horas: {
        totais: armed.horasTotais,
        aPreencher: armed.horasAPreencher,
        ativas: round1(horasAtivas),
        ativasConSchedule,
        ativasSinSchedule,
        coberturaConSchedule: armed.coberturaConSchedule,
        coberturaSinSchedule: armed.coberturaSinSchedule,
      },
      prioridades: {
        // Pessoas distintas em vaga viva — fila de contato, não acervo de candidaturas.
        completosEsperandoAgendamiento: esperandoRow.rows[0]?.esperando ?? 0,
        // registrosIncompletos: backlog de import (workers.status INCOMPLETE_REGISTER),
        // deduplicado por pessoa — não é bloqueio de postulação.
        registrosIncompletos: worker.incompletos,
        // bloqueadosAlPostularse: pessoas distintas barradas pelo gate de cadastro
        // incompleto ao tentar se candidatar, já recortado a vaga viva + não desativado
        // (mesma fonte/filtro de funnel.bloqueados — ver query `blockedRow` acima).
        bloqueadosAlPostularse: blocked,
      },
      funnelPorPrestador: {
        total: funnelPorPrestador.total,
        recorte: 'vagas-vivas',
        periodoDias: options?.funnelPeriodDays ?? null,
        bloqueados: blocked,
        porEtapa: { somavel: false, colunas: funnelPorPrestador.porEtapa },
        consolidado: { somavel: true, colunas: funnelPorPrestador.consolidado },
      },
      funnel: {
        invitados: pick(funnel, 'INVITED'),
        bloqueados: blocked,
        preScreening: pick(funnel, 'PRE_SCREENING'),
        completos: pick(funnel, 'COMPLETED'),
        agendados: pick(funnel, 'CONFIRMED'),
        seleccionados: pick(funnel, 'SELECTED'),
        rechazados: pick(funnel, 'REJECTED'),
      },
      encuadres: {
        agendadosEstaSemana: encuadre,
        semDataRegistrada: encuadreSemData,
        // Omitido quando a capacidade está zerada/inválida (nunca 0% fabricado).
        ...(capacidadeSemana != null
          ? {
              pctCapacidadeSemana: {
                agendados: encuadre,
                capacidade: capacidadeSemana,
                pct: round1Pct((encuadre / capacidadeSemana) * 100),
              },
            }
          : {}),
      },
      cadastros: {
        leads: worker.leads,
        completos: worker.completos,
        alocados: allocated,
        alocadosActivos,
        alocadosCubriendoGuardias,
        incompletos: worker.incompletos,
        nuevosCompletosMes: worker.nuevos,
      },
    };

    // Contrato: garante que nenhum número negativo/NaN escape (defesa em profundidade).
    return managementDashboardSchema.parse(data);
  }
}

function toRecord(rows: CountRow[]): Record<string, number> {
  const record: Record<string, number> = {};
  for (const row of rows) {
    if (row.k != null) record[row.k] = row.count;
  }
  return record;
}

function pick(record: Record<string, number>, key: string): number {
  return record[key] ?? 0;
}

/** Arredonda a 1 casa (mesma convenção de scheduleHours). */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Percentual com 1 casa — 0.0 real continua 0.0; nunca NaN (guard no caller). */
function round1Pct(value: number): number {
  return Math.round(value * 10) / 10;
}
