import { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { PatientClinical } from '../domain/PatientClinical';
import type { DependencyLevel } from '../domain/enums/DependencyLevel';
import type { ClinicalSpecialty } from '../domain/enums/ClinicalSpecialty';
import type { Profession } from '../../worker/domain/enums/Profession';

export interface PatientClinicalUpsertInput {
  patientId: string;
  diagnosis?: string | null;
  dependencyLevel?: DependencyLevel | null;
  clinicalSpecialty?: ClinicalSpecialty | null;
  /**
   * A leitura da origem foi POSSÍVEL? `false` ⇒ `clinical_specialty` não é tocada.
   *
   * Não confundir com `clinicalSpecialty === null`: `null` com `readable:true` é vazio
   * legítimo e É gravado (D-E). `readable:false` é "não consegui ler" e não escreve nada.
   * Ausente = `true`, para que nenhum chamador antigo pare de escrever em silêncio.
   */
  clinicalSpecialtyReadable?: boolean;
  /** @deprecated Use clinicalSpecialty instead. Preserved for backward compat. */
  clinicalSegments?: string | null;
  /** TEXT[] in DB after migration 139. */
  serviceType?: Profession[] | null;
  // `deviceType` SAIU deste tipo (spec 012, US-B4): `patients.device_type` é FK (308) e DERIVADO
  // de `patient_device_types` por trigger (310). O drawer clínico grava CÓDIGOS do catálogo pelo
  // `PatientDeviceTypeRepository.replaceCodesForPatient`; ninguém escreve o escalar.
  additionalComments?: string | null;
  emergencyInstructions?: string | null;
  hasJudicialProtection?: boolean | null;
  hasCud?: boolean | null;
  hasConsent?: boolean | null;
  /**
   * uid do staff que está editando (REQ-01/D195). Só é gravado quando
   * `additionalComments` veio no input — é a autoria DESSE campo, não do bloco.
   */
  actorUid?: string | null;
}

/**
 * PatientClinicalRepository — persists clinical fields of a patient.
 * Backed by Postgres TODAY. Future: Healthcare API (month 9).
 * Does NOT join workers, job_postings, or any domain outside patient.
 */
export class PatientClinicalRepository {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  /**
   * Atualização PARCIAL com semântica de JSON Merge Patch (RFC 7396, D211.1):
   *   - chave AUSENTE (`undefined`)  → a coluna NÃO é tocada;
   *   - chave presente com `null`    → a coluna é limpa;
   *   - `has_consent` é registro legal: `null` nunca limpa (COALESCE, D108).
   *
   * Por que importa: o drawer clínico manda só o que mudou. Antes, todo campo
   * omitido virava NULL — editar só as observações apagava o diagnóstico
   * (medido no e2e, 29/08).
   *
   * Efeito no sync do ClickUp (ClickUpPatientMapper.map): o mapper NÃO emite
   * `clinicalSegments` nem `deviceType` — as chaves ficam AUSENTES e, sob Merge
   * Patch, `clinical_segments`/`device_type` deixam de ser zeradas a cada sync
   * (antes deste contrato, viravam NULL). O que o mapper emite com `null`
   * explícito (diagnosis, additionalComments, dependencyLevel…) continua sendo
   * limpo quando o campo está vazio no ClickUp (D167). Teste que fixa isso:
   * PatientClinicalRepository.test.ts ("chaves que o mapper não emite").
   */
  async upsert(
    input: PatientClinicalUpsertInput,
    client?: PoolClient,
  ): Promise<void> {
    const executor = client ?? this.pool;

    const sets: string[] = [];
    const params: unknown[] = [input.patientId];
    const push = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (input.diagnosis !== undefined) push('diagnosis', input.diagnosis);
    if (input.dependencyLevel !== undefined) push('dependency_level', input.dependencyLevel);
    if (input.clinicalSegments !== undefined) push('clinical_segments', input.clinicalSegments);
    if (input.serviceType !== undefined) {
      // serviceType is TEXT[] in DB after migration 139. Empty array → NULL (never store []).
      push('service_type', input.serviceType !== null && input.serviceType.length > 0 ? input.serviceType : null);
    }
    if (input.additionalComments !== undefined) {
      push('additional_comments', input.additionalComments);
      // Autoria de additional_comments: só muda quando o campo veio no PATCH.
      // Grava o uid, nunca o valor (lex 29/08, item 3).
      params.push(input.actorUid ?? null);
      sets.push('additional_comments_updated_at = NOW()');
      sets.push(`additional_comments_updated_by = $${params.length}`);
    }
    if (input.emergencyInstructions !== undefined) {
      push('emergency_instructions', input.emergencyInstructions);
      // Autoria própria do campo (D211.2, molde de additional_comments): uid, nunca o valor.
      params.push(input.actorUid ?? null);
      sets.push('emergency_instructions_updated_at = NOW()');
      sets.push(`emergency_instructions_updated_by = $${params.length}`);
    }
    if (input.hasJudicialProtection !== undefined) push('has_judicial_protection', input.hasJudicialProtection);
    if (input.hasCud !== undefined) push('has_cud', input.hasCud);
    if (input.hasConsent !== undefined) {
      // has_consent is a LEGAL record (Ley 25.326/LGPD): null/omitted ⇒ preserved.
      // Explicit false still writes false; clearing consent is the opt-out flow's job (D108).
      params.push(input.hasConsent);
      sets.push(`has_consent = COALESCE($${params.length}, has_consent)`);
    }
    if (input.clinicalSpecialty !== undefined) {
      // ⚠️ `clinicalSpecialtyReadable` é o conserto do ALTA da rodada 4 do QA-caça da 2.2, e ele é
      // a MESMA distinção da D167 — um nível acima, no DERIVADO.
      //
      // Antes: `clinical_specialty = $N` com `?? null`. Um `null` chegando aqui significava DUAS
      // coisas — "a origem não preencheu" (vazio legítimo, e a D-E manda gravar: dado congelado
      // *parece* dado) e "a origem mandou um valor que o catálogo não traduziu" (leitura
      // impossível, e gravar apaga). O 2º caso apagava `'ASD'` de um paciente e não punha nada no
      // lugar: o cru estava protegido por `skipped-unreadable` e o derivado era apagado no MESMO
      // webhook. Medido pelo QA-caça com uuid desconhecido.
      //
      // Agora o chamador declara qual dos dois é. `false` NÃO grava — sob o Merge Patch (D211.1)
      // isso é simplesmente não entrar no SET: a coluna fica com o valor anterior, sem COALESCE e
      // sem leitura prévia. (Na versão pré-Merge-Patch isto era um `CASE WHEN $12 THEN $11 ELSE
      // clinical_specialty END`; o efeito é o mesmo.)
      //
      // Default `true` de propósito: todo chamador anterior a esta mudança escrevia sempre, e um
      // default `false` os faria parar de escrever em silêncio — trocaria um apagamento por um
      // congelamento, que é pior porque não aparece.
      if (input.clinicalSpecialtyReadable ?? true) push('clinical_specialty', input.clinicalSpecialty);
    }

    // Nada veio além do id: não há o que gravar (nem bater updated_at à toa).
    if (sets.length === 0) return;

    sets.push('updated_at = NOW()');
    await executor.query(
      `UPDATE patients SET
        ${sets.join(',\n        ')}
       WHERE id = $1`,
      params,
    );
  }

  async findByPatientId(patientId: string): Promise<PatientClinical | null> {
    const result = await this.pool.query<PatientClinical>(
      `SELECT
        id AS "patientId",
        diagnosis, dependency_level AS "dependencyLevel",
        clinical_segments AS "clinicalSegments",
        service_type AS "serviceType", device_type AS "deviceType",
        additional_comments AS "additionalComments",
        emergency_instructions AS "emergencyInstructions",
        has_judicial_protection AS "hasJudicialProtection",
        has_cud AS "hasCud", has_consent AS "hasConsent"
       FROM patients WHERE id = $1`,
      [patientId],
    );
    return result.rows[0] ?? null;
  }
}
