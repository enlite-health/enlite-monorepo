/**
 * acoesDeEstado — as ações humanas sobre o estado do paciente, em TABELA (Command por dado; estado-automatico-do-paciente F3, D5/D9,
 * design §1.1/§8). Pausar, suspender, dar alta e dar baja são ações de domínio com a origem `admin_panel` (FSM, célula do destino fora do
 * fluxo, trava de alocação e trilha valem como na troca de hoje); retomar e reativar usam a origem `resume` e o destino sai de
 * `resolverRetomada` — o cliente não escolhe. Domínio puro, sem `if`: o que varia mora na tabela.
 */
import type { EntradaDerivacao } from './derivarEstadoPaciente';
import { resolverRetomada } from './resolverRetomada';
import { CLINICAL_PATIENT_STATUSES, type ClinicalPatientStatus, type PatientStatus } from './enums/PatientStatus';
import type { PatientChangeSource } from './enums/PatientChangeSource';

export type Acao = 'pausar' | 'suspender' | 'dar_alta' | 'dar_baja' | 'retomar' | 'reativar';

/** O que a tela precisa COLETAR antes de pedir a ação (motivo fechado; nunca texto clínico). */
export type Exigencia = 'onHoldReason' | 'suspensionExitReason';

export interface ContextoDaAcao {
  /** As horas do itinerário (entrada da regra pura) — só `retomar` e `reativar` as leem. */
  readonly horas: EntradaDerivacao;
}

export interface DefinicaoDaAcao {
  /** Destino da ação, calculado aqui — nunca vem do cliente. */
  readonly destino: (ctx: ContextoDaAcao) => PatientStatus;
  /** Estados de partida em que a ação existe. */
  readonly de: readonly PatientStatus[];
  /** Origem gravada na trilha (`patient_status_history.change_source`). */
  readonly origem: PatientChangeSource;
  readonly exige: readonly Exigencia[];
}

const CLINICOS_MENOS = (fora: ClinicalPatientStatus): readonly PatientStatus[] => CLINICAL_PATIENT_STATUSES.filter((s) => s !== fora);
const fixo = (destino: ClinicalPatientStatus) => (): PatientStatus => destino;

export const ACOES: Readonly<Record<Acao, DefinicaoDaAcao>> = {
  pausar: { destino: fixo('ON_HOLD'), de: CLINICOS_MENOS('ON_HOLD'), origem: 'admin_panel', exige: ['onHoldReason'] },
  suspender: { destino: fixo('SUSPENDED'), de: CLINICOS_MENOS('SUSPENDED'), origem: 'admin_panel', exige: [] },
  dar_alta: { destino: fixo('ALTA'), de: CLINICOS_MENOS('ALTA'), origem: 'admin_panel', exige: [] },
  dar_baja: { destino: fixo('DISCHARGED'), de: CLINICOS_MENOS('DISCHARGED'), origem: 'admin_panel', exige: [] },
  retomar: { destino: (ctx) => resolverRetomada(ctx), de: ['ON_HOLD', 'SUSPENDED'], origem: 'resume', exige: [] },
  reativar: { destino: (ctx) => resolverRetomada(ctx), de: ['DISCHARGED'], origem: 'resume', exige: [] },
};

export const ACAO_NAMES = Object.keys(ACOES) as readonly Acao[];

/** Sair de `SUSPENDED` por decisão humana exige o motivo de saída, qualquer que seja a ação (regra de 29/09, vive no escritor). */
const EXIGENCIA_DE_SAIDA: Readonly<Partial<Record<PatientStatus, readonly Exigencia[]>>> = { SUSPENDED: ['suspensionExitReason'] };

/** A ação existe para um paciente neste estado? */
export const acaoDisponivelDe = (acao: Acao, de: PatientStatus | null): boolean => (ACOES[acao].de as readonly (PatientStatus | null)[]).includes(de);

/** O que a tela coleta para esta ação, neste estado de partida. */
export const exigenciasDe = (acao: Acao, de: PatientStatus | null): readonly Exigencia[] => [
  ...ACOES[acao].exige,
  ...(EXIGENCIA_DE_SAIDA[de as PatientStatus] ?? []),
];
