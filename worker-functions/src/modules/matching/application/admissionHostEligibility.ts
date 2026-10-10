/**
 * Quem pode ser responsável por uma agenda do SITE (spec 050 F7, R-23 parcial, R-26).
 *
 * Uma só régua para o painel e para o site: `isHostApt` sobre o estado que o `TactiqLinkGate` devolve. Hoje "apta" é só o vínculo
 * Tactiq `linked`; a prova de captura e o relatório do Chrome entram aqui nas fases seguintes, para os dois lados de uma vez.
 */
import { logger } from '@shared/logging';
import type { TactiqLinkGate, TactiqLinkState } from './ports/TactiqPorts';
import { isHostRosterEnabled } from '../domain/admissionSchedulingConfig';

/** Evento do alarme R-26 (filtro de alerta da F12): roster com gente, mas ninguém apta. */
export const NO_ELIGIBLE_HOST_EVENT = 'admission.site.no_eligible_host';

/** O que o paciente lê quando não há horário por falta de responsável apta (texto da spec, R-26). */
export const NO_ELIGIBLE_HOST_MESSAGE = 'Por el momento no hay horarios disponibles. Te vamos a contactar por WhatsApp.';

export function isHostApt(state: TactiqLinkState | undefined): boolean {
  return state === 'linked';
}

/** Filtra o roster pela trava. Sem gate FALHA ALTO: um gate ausente que deixasse passar seria a trava desligada em silêncio. */
export async function aptHosts<T extends { email: string }>(gate: TactiqLinkGate | undefined, hosts: T[]): Promise<T[]> {
  if (!gate) throw new Error('AdmissionSchedulingService: o sorteio do site exige o gate do vínculo do Tactiq (spec 050 F7)');
  if (hosts.length === 0) return [];
  const states = await gate.statesFor(hosts.map((h) => h.email));
  return hosts.filter((h) => isHostApt(states.get(h.email.toLowerCase())));
}

/** Alarme R-26: só contagem e país (sem e-mail de ninguém — CM3 do veredito do lex). */
export function logNoEligibleHost(country: string, rosterSize: number): void {
  logger.warn({ event: NO_ELIGIBLE_HOST_EVENT, country, rosterSize }, `[admission] ${NO_ELIGIBLE_HOST_EVENT}: roster sem responsável apta`);
}

/** Roster → só as aptas; roster com gente e ninguém apta dispara o alarme R-26. */
export async function aptRoster<T extends { email: string }>(gate: TactiqLinkGate | undefined, roster: T[], country: string): Promise<T[]> {
  const apt = await aptHosts(gate, roster);
  if (apt.length === 0 && roster.length > 0) logNoEligibleHost(country, roster.length);
  return apt;
}

/** O site responde "sem horários" com a mensagem de contato? Roster ligado, com gente, e ninguém apta (consulta silenciosa, sem alarme). */
export async function noEligibleHost(
  hosts: { listActiveByCountry(country: never): Promise<Array<{ email: string }>> },
  gate: TactiqLinkGate | undefined,
  country: string,
): Promise<boolean> {
  if (!isHostRosterEnabled()) return false;
  const roster = await hosts.listActiveByCountry(country as never);
  return roster.length > 0 && (await aptHosts(gate, roster)).length === 0;
}
