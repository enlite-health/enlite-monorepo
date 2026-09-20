/**
 * TherapeuticProjectContactsRepository — resolve os contatos ligados a uma versão do projeto
 * terapêutico (migration 429; lex-pr7 C5/C6) para a LEITURA. Único ponto que faz o JOIN de
 * `patient_therapeutic_project_contacts` com as 4 tabelas de origem — a versão só guarda ids.
 *
 * Regra única (lex C5, `contracts/therapeutic-project.md:33`): contato INATIVO → `{kind,id,
 * inactive:true}` sem nome/telefone (mesmo em versão histórica); contato SEM CÉLULA de origem →
 * `{kind,id,redacted:true}`. Nunca as duas coisas ao mesmo tempo, e a checagem de célula vem ANTES
 * do JOIN — decisão primeiro, KMS depois (D286/lex P3, mesmo desenho de `patientContainerAccess`).
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import type { ContactRef, ContactRefKind, ResolvedTherapeuticContact, ResolvedTherapeuticContactKind } from '../domain/TherapeuticProject';
import { canReadPatientContainer } from './../application/patientContainerAccess';
import { containerOfContactKind } from '../application/therapeuticProjectAccess';

interface LinkRow {
  contact_kind: ResolvedTherapeuticContactKind;
  responsible_id: string | null;
  external_contact_id: string | null;
  coverage_contact_id: string | null;
  professional_id: string | null;
  sort_order: number;
}

/** Resultado da resolução: os contatos projetados + os containers EFETIVAMENTE servidos (lex C6). */
export interface ResolvedTherapeuticContacts {
  contacts: ResolvedTherapeuticContact[];
  containersServed: ReadonlySet<'family' | 'coverage' | 'care_team'>;
  /**
   * Os mesmos `kind`+`id` da ligação, CRUS (contrato `therapeutic-project.md:41`) — o GET devolve
   * isso ao lado de `contacts` pra "Editar" reconstruir a seleção sem depender do resolvido (que
   * pode vir redigido/inativo). `kind`/`id` NÃO são dado sensível por si (é o que `contacts` já
   * expõe mesmo redigido/inativo — lex-pr7 C5 só protege nome/telefone) — por isso, ao contrário de
   * `contacts`, não passa pela checagem de célula: sempre as `links.rows` inteiras.
   */
  contactRefs: ContactRef[];
  careTeamIds: string[];
}

const KIND_TO_CONTAINER = {
  RESPONSIBLE: 'family',
  EXTERNAL: 'family',
  COVERAGE: 'coverage',
  CARE_TEAM: 'careTeam',
} as const;

export class TherapeuticProjectContactsRepository {
  private poolMemo?: Pool;

  constructor(private readonly enc: KMSEncryptionService = new KMSEncryptionService()) {}

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  async resolve(
    versionId: string,
    cells: readonly string[] | null | undefined,
    cli: Pool | PoolClient = this.pool,
  ): Promise<ResolvedTherapeuticContacts> {
    const links = await cli.query<LinkRow>(
      `SELECT contact_kind, responsible_id, external_contact_id, coverage_contact_id, professional_id, sort_order
         FROM patient_therapeutic_project_contacts
        WHERE version_id = $1
        ORDER BY sort_order ASC`,
      [versionId],
    );
    if (links.rows.length === 0) return { contacts: [], containersServed: new Set(), contactRefs: [], careTeamIds: [] };

    // Deriva DESTA mesma `links.rows` (sem 2ª query) — `refIdOf` é a mesma regra do INSERT
    // (`TherapeuticProjectRepository.CONTACT_COLUMN`), lida de volta.
    const refIdOf = (row: LinkRow): string =>
      (row.responsible_id ?? row.external_contact_id ?? row.coverage_contact_id ?? row.professional_id) as string;
    const contactRefs: ContactRef[] = links.rows
      .filter((r) => r.contact_kind !== 'CARE_TEAM')
      .map((r) => ({ kind: r.contact_kind as ContactRefKind, id: refIdOf(r) }));
    const careTeamIds: string[] = links.rows.filter((r) => r.contact_kind === 'CARE_TEAM').map(refIdOf);

    const containersServed = new Set<'family' | 'coverage' | 'care_team'>();
    const contacts: ResolvedTherapeuticContact[] = [];
    const toResolve: { row: LinkRow; refId: string }[] = [];

    for (const row of links.rows) {
      const refId = (row.responsible_id ?? row.external_contact_id ?? row.coverage_contact_id ?? row.professional_id) as string;
      const container = KIND_TO_CONTAINER[row.contact_kind];
      if (!canReadPatientContainer(cells, container)) {
        contacts.push({ kind: row.contact_kind, id: refId, redacted: true });
        continue;
      }
      toResolve.push({ row, refId });
    }

    if (toResolve.length > 0) {
      const resolvedById = await this.fetchOrigins(cli, toResolve);
      for (const { row, refId } of toResolve) {
        const found = resolvedById.get(`${row.contact_kind}:${refId}`);
        if (!found || !found.active) {
          contacts.push({ kind: row.contact_kind, id: refId, inactive: true });
          continue;
        }
        containersServed.add(containerOfContactKind(row.contact_kind));
        contacts.push({
          kind: row.contact_kind,
          id: refId,
          name: found.name,
          phone: found.phone,
          ...(found.relation ? { relation: found.relation } : {}),
          ...(found.specialty ? { specialty: found.specialty } : {}),
        });
      }
    }

    // Reordena pela `sort_order` original (redigidos + resolvidos foram empilhados em ordens distintas).
    // Invariante: todo `contacts.push` acima usa `kind`/`id` tirados de UMA linha de `links.rows`
    // (o mesmo `refId` que monta a chave aqui) — a chave SEMPRE existe no mapa; `!` documenta isso
    // em vez de um `?? 0` que nenhum teste alcançaria (ramo morto).
    const orderById = new Map(links.rows.map((r, i) => [`${r.contact_kind}:${r.responsible_id ?? r.external_contact_id ?? r.coverage_contact_id ?? r.professional_id}`, i]));
    contacts.sort((a, b) => orderById.get(`${a.kind}:${a.id}`)! - orderById.get(`${b.kind}:${b.id}`)!);

    return { contacts, containersServed, contactRefs, careTeamIds };
  }

  private async fetchOrigins(
    cli: Pool | PoolClient,
    toResolve: { row: LinkRow; refId: string }[],
  ): Promise<Map<string, { active: boolean; name: string; phone: string | null; relation?: string; specialty?: string }>> {
    const out = new Map<string, { active: boolean; name: string; phone: string | null; relation?: string; specialty?: string }>();
    const idsOf = (kind: ResolvedTherapeuticContactKind) => toResolve.filter((t) => t.row.contact_kind === kind).map((t) => t.refId);

    const responsibleIds = idsOf('RESPONSIBLE');
    if (responsibleIds.length > 0) {
      const res = await cli.query<{ id: string; first_name: string; last_name: string; relationship: string | null; phone_encrypted: string | null; active: boolean }>(
        `SELECT id, first_name, last_name, relationship, phone_encrypted, active FROM patient_responsibles WHERE id = ANY($1)`,
        [responsibleIds],
      );
      for (const r of res.rows) {
        out.set(`RESPONSIBLE:${r.id}`, {
          active: r.active,
          name: `${r.first_name} ${r.last_name}`.trim(),
          phone: r.phone_encrypted ? await this.enc.decrypt(r.phone_encrypted) : null,
          ...(r.relationship ? { relation: r.relationship } : {}),
        });
      }
    }

    const externalIds = idsOf('EXTERNAL');
    if (externalIds.length > 0) {
      const res = await cli.query<{ id: string; name: string; relation: string; phone_encrypted: string | null; active: boolean }>(
        `SELECT id, name, relation, phone_encrypted, active FROM patient_external_contacts WHERE id = ANY($1)`,
        [externalIds],
      );
      for (const r of res.rows) {
        out.set(`EXTERNAL:${r.id}`, {
          active: r.active,
          name: r.name,
          phone: r.phone_encrypted ? await this.enc.decrypt(r.phone_encrypted) : null,
          relation: r.relation,
        });
      }
    }

    const coverageIds = idsOf('COVERAGE');
    if (coverageIds.length > 0) {
      const res = await cli.query<{ id: string; name: string; kind: string; phone_encrypted: string | null; active: boolean }>(
        `SELECT id, name, kind, phone_encrypted, active FROM patient_coverage_emergency_contacts WHERE id = ANY($1)`,
        [coverageIds],
      );
      for (const r of res.rows) {
        out.set(`COVERAGE:${r.id}`, {
          active: r.active,
          name: r.name,
          phone: r.phone_encrypted ? await this.enc.decrypt(r.phone_encrypted) : null,
          relation: r.kind,
        });
      }
    }

    const careTeamIds = idsOf('CARE_TEAM');
    if (careTeamIds.length > 0) {
      const res = await cli.query<{ id: string; name: string; specialty: string | null; phone_encrypted: string | null; active: boolean }>(
        `SELECT id, name, specialty, phone_encrypted, active FROM patient_professionals WHERE id = ANY($1)`,
        [careTeamIds],
      );
      for (const r of res.rows) {
        out.set(`CARE_TEAM:${r.id}`, {
          active: r.active,
          name: r.name,
          phone: r.phone_encrypted ? await this.enc.decrypt(r.phone_encrypted) : null,
          ...(r.specialty ? { specialty: r.specialty } : {}),
        });
      }
    }

    return out;
  }
}
