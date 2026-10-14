/**
 * Presença dos convocados do enquadre (spec 052, Fase 3, T-34c). Regra PURA, sem I/O: quem entrou na call (Meet) × quem foi convocado.
 *
 * Ligação (Gabriel, 14/10/2026: "por nome único; a sonda de e-mail fica fora"): um participante `signedin` é do convocado quando o nome
 * exibido, normalizado (minúsculas, sem acento, espaços colapsados), é igual ao nome de EXATAMENTE UM convocado do evento. Nome que
 * serve a 2 convocados, ou a nenhum, deixa o participante SEM DONO. `anonymous` (nome digitado: qualquer um digita o de outro) e
 * `phone` (telefone redigido) nunca são chave: sempre ficam sem dono.
 *
 * Estado por convocado: `present` (ligado, `match_method='display_name_unique'`) · `unidentified` (não ligado e sobrou participante sem
 * dono: pode ser ele) · `absent` (não ligado e ninguém sobrou sem dono: certeza de que não entrou).
 *
 * O resultado nunca carrega o nome: só ids internos dos convocados, o tipo do participante e o motivo.
 */
import type { MeetParticipant, MeetParticipantKind } from '../application/ports/MeetConferencePort';

export type EnquadreAttendance = 'present' | 'absent' | 'unidentified';
export type UnidentifiedReason = 'anonymous' | 'phone' | 'no_name_match' | 'name_ambiguous';

export interface PresenceConvocado {
  /** Id interno da participação (`enquadre_event_participants.id`). */
  id: string;
  /** Nome do prestador, decifrado só para esta comparação. */
  name: string;
}

export interface PresenceVerdict {
  attendance: EnquadreAttendance;
  matchMethod: 'display_name_unique' | null;
}

export interface OwnerlessParticipant {
  kind: MeetParticipantKind;
  reason: UnidentifiedReason;
}

export interface PresenceResult {
  byConvocado: Map<string, PresenceVerdict>;
  ownerless: OwnerlessParticipant[];
  /** Participantes distintos depois de juntar quem caiu e voltou. */
  participantCount: number;
}

export function normalizeDisplayName(name: string | null | undefined): string {
  return (name ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Quem caiu e voltou aparece em mais de uma conferência: o mesmo `users/{id}` (ou o mesmo tipo + nome) conta uma vez. */
function dedupe(participants: readonly MeetParticipant[]): MeetParticipant[] {
  const seen = new Set<string>();
  const out: MeetParticipant[] = [];
  for (const p of participants) {
    const key = `${p.kind}|${p.identityKey ?? normalizeDisplayName(p.displayName)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export function decidePresence(convocados: readonly PresenceConvocado[], participants: readonly MeetParticipant[]): PresenceResult {
  const idsByName = new Map<string, string[]>();
  for (const c of convocados) {
    const n = normalizeDisplayName(c.name);
    if (n) idsByName.set(n, [...(idsByName.get(n) ?? []), c.id]);
  }

  const unique = dedupe(participants);
  const linked = new Set<string>();
  const ownerless: OwnerlessParticipant[] = [];
  for (const p of unique) {
    if (p.kind === 'anonymous') ownerless.push({ kind: p.kind, reason: 'anonymous' });
    else if (p.kind === 'phone') ownerless.push({ kind: p.kind, reason: 'phone' });
    else {
      const owners = idsByName.get(normalizeDisplayName(p.displayName)) ?? [];
      if (owners.length === 1) linked.add(owners[0]);
      else ownerless.push({ kind: p.kind, reason: owners.length === 0 ? 'no_name_match' : 'name_ambiguous' });
    }
  }

  const byConvocado = new Map<string, PresenceVerdict>();
  for (const c of convocados) {
    if (linked.has(c.id)) byConvocado.set(c.id, { attendance: 'present', matchMethod: 'display_name_unique' });
    else byConvocado.set(c.id, { attendance: ownerless.length > 0 ? 'unidentified' : 'absent', matchMethod: null });
  }
  return { byConvocado, ownerless, participantCount: unique.length };
}
