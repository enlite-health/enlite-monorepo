/**
 * Seleção inicial dos contatos ao EDITAR (extraído de `TherapeuticProjectForm.tsx`, limite de 400 linhas; sem mudança de regra).
 * Conserto 14/09 (achado do gate — decisão do Gabriel, fechada): ao EDITAR, um contato da versão de ORIGEM que já está
 * INATIVO não entra na seleção inicial (a versão antiga fica intocada; só a seleção da minor nova exclui). "Inativo" =
 * `from.contacts` (lex #7 C5) marca `inactive:true`, OU não tem entrada nenhuma pra esse `kind`/`id`. Contato ATIVO mas
 * REDIGIDO (`redacted:true`) TEM entrada — não cai aqui, a referência é MANTIDA.
 */
import type {
  ContactRef,
  ContactRefKind,
  ResolvedTherapeuticContactKind,
  TherapeuticProjectVersion,
} from '@domain/entities/TherapeuticProject';

export const idsOfKind = (refs: ContactRef[] | undefined, kind: ContactRefKind): string[] =>
  (refs ?? []).filter((r) => r.kind === kind).map((r) => r.id);

/**
 * Conserto 14/09 (achado do gate — decisão do Gabriel, fechada): ao EDITAR, um contato da versão
 * de ORIGEM que já está INATIVO não entra na seleção inicial (a versão antiga fica intocada; só a
 * seleção da minor nova exclui). "Inativo" = `from.contacts` (lex #7 C5 — a MESMA leitura resolvida
 * pela célula de origem, nunca uma checagem própria aqui) marca `inactive:true`, OU não tem
 * entrada nenhuma pra esse `kind`/`id` (a única forma disso acontecer é anomalia de dado — a 429
 * grava 1 ligação por `contactRefs`/`careTeamIds` e `resolve()` devolve 1 `contacts` por ligação).
 * Contato ATIVO mas REDIGIDO (`redacted:true`, sem célula de origem pra resolver nome/telefone)
 * TEM entrada em `contacts` — não cai aqui, a referência é MANTIDA (decisão do Gabriel: "não some").
 */
export const isInactiveOnEdit = (from: TherapeuticProjectVersion | null, kind: ResolvedTherapeuticContactKind, id: string): boolean => {
  const entry = from?.contacts.find((c) => c.kind === kind && c.id === id);
  return !entry || ('inactive' in entry && entry.inactive === true);
};

export const keptIdsOfKind = (from: TherapeuticProjectVersion | null, refs: ContactRef[] | undefined, kind: ContactRefKind): string[] =>
  idsOfKind(refs, kind).filter((id) => !isInactiveOnEdit(from, kind, id));

export const keptCareTeamIds = (from: TherapeuticProjectVersion | null): string[] =>
  (from?.careTeamIds ?? []).filter((id) => !isInactiveOnEdit(from, 'CARE_TEAM', id));

/** Quantos ids de cada `kind` saíram da seleção inicial por estarem inativos — só o AVISO precisa disso. */
export const removedInactiveByKind = (from: TherapeuticProjectVersion | null): { kind: ResolvedTherapeuticContactKind; count: number }[] => {
  const groups: [ResolvedTherapeuticContactKind, string[]][] = [
    ['RESPONSIBLE', idsOfKind(from?.contactRefs, 'RESPONSIBLE')],
    ['EXTERNAL', idsOfKind(from?.contactRefs, 'EXTERNAL')],
    ['COVERAGE', idsOfKind(from?.contactRefs, 'COVERAGE')],
    ['CARE_TEAM', from?.careTeamIds ?? []],
  ];
  return groups
    .map(([kind, ids]) => ({ kind, count: ids.filter((id) => isInactiveOnEdit(from, kind, id)).length }))
    .filter((g) => g.count > 0);
};

