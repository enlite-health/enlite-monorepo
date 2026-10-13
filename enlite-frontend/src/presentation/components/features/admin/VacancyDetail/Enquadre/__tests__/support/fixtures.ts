/**
 * fixtures — os dados de mentira do protótipo do enquadre (spec 052, Fase 0). SÓ o harness importa este arquivo
 * (e o teste dos 17 estados). Regras: nomes "Ficticio/Ficticia NN", entrevistadoras "Entrevistadora Ficticia X",
 * ids curtos, nenhum contato (nem endereço nem número) e telefone sempre nulo. Imports RELATIVOS de propósito:
 * a verificação de dado real procura o caractere de arroba neste arquivo.
 */
import type {
  EnquadreHostOption,
  EnquadreParticipant,
  EnquadrePipelineState,
  EnquadreWorkerOption,
} from '@domain/entities/EnquadreEvent';
import type { FunnelStages } from '@hooks/admin/useWJAFunnel';
import type { SeedEvent } from './store';

/** Relógio fixo do protótipo: 14/10/2026 12:00 em Buenos Aires. */
export const HARNESS_NOW_ISO = '2026-10-14T12:00:00-03:00';
export const HARNESS_VACANCY_ID = 'vac-01';
const MEET_BASE = 'https://meet.example.test/';

export const HOSTS: EnquadreHostOption[] = [
  { id: 'h-a', name: 'Entrevistadora Ficticia A', linkState: 'linked' },
  { id: 'h-b', name: 'Entrevistadora Ficticia B', linkState: 'linked' },
  { id: 'h-c', name: 'Entrevistadora Ficticia C', linkState: 'unlinked' },
];

/** Os horários livres que o "servidor" devolve para qualquer entrevistador apto e qualquer dia. */
export const FREE_SLOTS: string[] = ['09:00', '11:30', '15:00'];

/** Completados disponíveis (fora de evento aberto): 3, um deles sem e-mail válido. */
export const AVAILABLE_BASE: EnquadreWorkerOption[] = [
  { id: 'w-11', name: 'Ficticio 11', hasValidEmail: true },
  { id: 'w-12', name: 'Ficticia 12', hasValidEmail: true },
  { id: 'w-13', name: 'Ficticio 13', hasValidEmail: false },
];

/** Drawer de criar (E6/E7): 5 prestadores selecionáveis. */
export const DRAWER_WORKERS: EnquadreWorkerOption[] = [
  { id: 'w-21', name: 'Ficticio 21', hasValidEmail: true },
  { id: 'w-22', name: 'Ficticia 22', hasValidEmail: true },
  { id: 'w-23', name: 'Ficticio 23', hasValidEmail: true },
  { id: 'w-24', name: 'Ficticia 24', hasValidEmail: true },
  { id: 'w-25', name: 'Ficticio 25', hasValidEmail: true },
];

/** E8: os mesmos 5 + 1 sem e-mail válido. */
export const DRAWER_WORKERS_WITH_BLOCKED: EnquadreWorkerOption[] = [
  ...DRAWER_WORKERS,
  { id: 'w-26', name: 'Ficticia 26', hasValidEmail: false },
];

const OCCUPATION = 'Acompañante terapéutico';

function part(
  n: string,
  column: EnquadreParticipant['column'] = 'CONVOKED',
  outcome: EnquadreParticipant['outcome'] = null,
  reason: string | null = null,
): EnquadreParticipant {
  const gender = Number(n) % 2 === 0 ? 'Ficticia' : 'Ficticio';
  return {
    id: `p-${n}`,
    workerId: `w-${n}`,
    workerName: `${gender} ${n}`,
    occupation: OCCUPATION,
    column,
    outcome,
    rejectionReasonCategory: reason,
  };
}

const parts = (ns: string[]): EnquadreParticipant[] => ns.map((n) => part(n));
const waiting: EnquadrePipelineState = { importStatus: 'waiting', summary: 'waiting', blockedReason: null };

/** 16/10 14:00, 5 convocados. */
export const EV_01: SeedEvent = {
  id: 'ev-01', startsAt: '2026-10-16T14:00:00-03:00', endsAt: '2026-10-16T15:00:00-03:00', hostName: 'Entrevistadora Ficticia A',
  phase: 'scheduled', meetLink: `${MEET_BASE}ev-01`, pipeline: null, participants: parts(['01', '02', '03', '04', '05']),
};
/** 17/10 10:00, 4 convocados. */
export const EV_02: SeedEvent = {
  id: 'ev-02', startsAt: '2026-10-17T10:00:00-03:00', endsAt: '2026-10-17T11:00:00-03:00', hostName: 'Entrevistadora Ficticia B',
  phase: 'scheduled', meetLink: `${MEET_BASE}ev-02`, pipeline: null, participants: parts(['06', '07', '08', '09']),
};
/** 14/10 10:00-11:00 já terminou, 6 convocados, 2 marcados (lista E4). */
export const EV_03: SeedEvent = {
  id: 'ev-03', startsAt: '2026-10-14T10:00:00-03:00', endsAt: '2026-10-14T11:00:00-03:00', hostName: 'Entrevistadora Ficticia A',
  phase: 'pending_close', meetLink: null, pipeline: null,
  participants: [part('31', 'SELECTED'), part('32', 'QUICK_RESPONSE_TEAM'), part('33'), part('34'), part('35'), part('36')],
};
/** O mesmo evento com 3 marcados (confirmação de encerrar, E11). */
export const EV_03_E11: SeedEvent = {
  ...EV_03,
  participants: [part('31', 'SELECTED'), part('32', 'QUICK_RESPONSE_TEAM'), part('33', 'REJECTED', null, 'WORKER_DECLINED'), part('34'), part('35'), part('36')],
};
/** Encerrado 09/10: 2 selecionados, 1 resposta rápida, 1 rejeitado, 1 devolvido. */
export const EV_04: SeedEvent = {
  id: 'ev-04', startsAt: '2026-10-09T10:00:00-03:00', endsAt: '2026-10-09T11:00:00-03:00', hostName: 'Entrevistadora Ficticia A',
  phase: 'closed', meetLink: null, pipeline: { importStatus: 'done', summary: 'ready', blockedReason: null },
  participants: [
    part('41', 'SELECTED', 'selected'), part('42', 'SELECTED', 'selected'), part('43', 'QUICK_RESPONSE_TEAM', 'quick_response'),
    part('44', 'REJECTED', 'rejected', 'WORKER_DECLINED'), part('45', 'CONVOKED', 'returned'),
  ],
};
/** Encerrado 06/10. */
export const EV_05: SeedEvent = {
  id: 'ev-05', startsAt: '2026-10-06T15:00:00-03:00', endsAt: '2026-10-06T16:00:00-03:00', hostName: 'Entrevistadora Ficticia B',
  phase: 'closed', meetLink: null, pipeline: waiting,
  participants: [part('51', 'SELECTED', 'selected'), part('52', 'REJECTED', 'rejected', 'OTHER'), part('53', 'CONVOKED', 'returned'), part('54', 'CONVOKED', 'returned')],
};

function closedWith(id: string, day: string, n: string, pipeline: EnquadrePipelineState): SeedEvent {
  return {
    id, startsAt: `2026-10-${day}T10:00:00-03:00`, endsAt: `2026-10-${day}T11:00:00-03:00`, hostName: 'Entrevistadora Ficticia A',
    phase: 'closed', meetLink: null, pipeline,
    participants: [part(`${n}1`, 'SELECTED', 'selected'), part(`${n}2`, 'CONVOKED', 'returned')],
  };
}

/** E12: 4 eventos encerrados, um por estado da esteira. */
export const EV_PIPELINE: SeedEvent[] = [
  closedWith('ev-71', '08', '71', { importStatus: 'waiting', summary: 'waiting', blockedReason: null }),
  closedWith('ev-72', '07', '72', { importStatus: 'done', summary: 'ready', blockedReason: null }),
  closedWith('ev-73', '05', '73', { importStatus: 'blocked', summary: 'waiting', blockedReason: 'Falta confirmar la identidad de un convocado' }),
  closedWith('ev-74', '02', '74', { importStatus: 'done', summary: 'unavailable', blockedReason: null }),
];

type Card = FunnelStages['COMPLETED'][number];

function card(n: string, convocation: Card['convocation'] = null, enquadreOrigin: Card['enquadreOrigin'] = null): Card {
  return {
    id: `c-${n}`, encuadreId: `enc-${n}`, workerId: `w-${n}`, workerName: `${Number(n) % 2 === 0 ? 'Ficticia' : 'Ficticio'} ${n}`,
    workerPhone: null, occupation: OCCUPATION, interviewDate: null, interviewTime: null, meetLink: null, resultado: null,
    attended: null, rejectionReasonCategory: null, rejectionReason: null, matchScore: null, talentumStatus: null,
    workZone: null, redireccionamiento: null, convocation, enquadreOrigin,
  };
}

/** E13: 3 cards em Completado (2 convocados), 1 em Selecionados e 1 em Resposta rápida (os 2 com o enquadre de origem). */
export function funnelStages(): FunnelStages {
  const at = { startsAt: '2026-10-16T14:00:00-03:00' };
  return {
    COMPATIBLE: [], INVITED: [], INICIADO: [], PRE_SCREENING: [], IN_PROGRESS: [],
    COMPLETED: [card('61', at), card('62', at), card('63')],
    CONFIRMED: [], SELECTED: [card('64', null, { eventCode: 'ENC-K7M2QX' })], QUICK_RESPONSE_TEAM: [card('65', null, { eventCode: 'ENC-R4T9WB' })], REJECTED: [],
  };
}
