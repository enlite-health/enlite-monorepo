import * as functions from 'firebase-functions';
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { buildInsertQuery, buildInsertParams } from '@modules/matching';
import {
  computePatientCompleteness,
  type PatientCompletenessCode,
} from '../domain/PatientCompleteness';
import { vacancyRangeForProviderAgeBand } from '../domain/ProviderAgeBandMapping';
import type { ProviderAgeBand } from '../domain/enums/ContractedService';

/**
 * Thrown when the patient does not exist (or was soft-deleted). The controller
 * maps this to a 404.
 */
export class PatientNotFoundError extends Error {
  constructor(patientId: string) {
    super(`Patient not found: ${patientId}`);
    this.name = 'PatientNotFoundError';
  }
}

/**
 * Thrown when the patient is not ready to activate — spec 014 US-D1/SUP-D1, lex D1.1/D1.2.
 * `missing` is computed by the SAME function (`computePatientCompleteness`) that feeds the
 * checklist on `GET /:id` — the gate here and the codes shown in the ficha never drift apart
 * because both read from one place. The controller maps this to 422 with `{code:
 * 'PATIENT_NOT_READY', details: { missing } }`.
 */
export class PatientNotReadyError extends Error {
  readonly missing: PatientCompletenessCode[];

  constructor(patientId: string, missing: PatientCompletenessCode[]) {
    super(`No se puede activar el paciente: falta ${missing.join(', ')}. (patientId=${patientId})`);
    this.name = 'PatientNotReadyError';
    this.missing = missing;
  }
}

/**
 * Thrown when the patient has zero non-archived addresses. Activation generates
 * one draft vacancy PER location — with no location there is nothing to create,
 * so we refuse (422) instead of moving the patient to ACTIVE with no vacancy.
 *
 * A `PatientNotReadyError` specialised to `missing: ['ADDRESS']` — kept as its own named class
 * (rather than folded into the generic one) because it predates spec 014 and existing callers
 * (`AdminPatientsController`, its tests) already narrow on this exact type; the message text is
 * also unchanged from before this spec. `instanceof PatientNotReadyError` still holds for it.
 */
export class NoActiveAddressError extends PatientNotReadyError {
  constructor(patientId: string) {
    super(patientId, ['ADDRESS']);
    this.name = 'NoActiveAddressError';
    this.message =
      `No se puede activar el paciente sin ninguna localización (dirección activa). ` +
      `Agregá al menos una dirección antes de activar. (patientId=${patientId})`;
  }
}

export interface ActivatePatientResult {
  patientId: string;
  status: 'ACTIVE';
  createdVacancyIds: string[];
  /** true when the patient was already ACTIVE — idempotent no-op, no vacancy created. */
  alreadyActive: boolean;
}

/**
 * ActivatePatientUseCase — decisão D5 (plano-app-pacientes §6 Fase 2).
 *
 * Activating a patient means: "the service was approved; open the recruitment
 * for it". The service is defined BY LOCATION (D5: the draft vacancy per address
 * IS the contracted-service-by-location — no separate table). So activation:
 *
 *   1. Loads the patient (must exist, must not already be ACTIVE).
 *   2. For EACH non-archived patient_address, creates ONE draft job_posting
 *      through the SAME insert used by POST /api/admin/vacancies
 *      (buildInsertQuery/buildInsertParams — no duplicated SQL). The vacancy is
 *      born is_draft=true (DB default, migration 168), status 'PENDING_ACTIVATION'
 *      and salary_text 'A convenir' (buildInsertParams defaults). Minimal fields
 *      only — the operator completes each draft later.
 *   3. Moves the patient to ACTIVE.
 *
 * Everything runs in ONE transaction: either every draft vacancy + the status
 * move commit together, or nothing does. This is stronger than "create vacancies
 * then moveStatus" (two transactions) because a crash between the two would leave
 * the patient non-ACTIVE with orphan drafts — and a retry would DUPLICATE them.
 *
 * Idempotency: a patient already ACTIVE returns { alreadyActive: true,
 * createdVacancyIds: [] } without creating anything (no duplicate vacancies).
 *
 * Spec 013 (bloco C) + migration 330 (decisão do Gabriel 05/09: "UM serviço é 1 endereço; cada
 * serviço vira UMA vacante"): with ≥1 ACTIVE `patient_contracted_services` row, activation creates
 * ONE draft vacancy PER SERVICE, at the address the service points to (`address_id`), and stamps
 * `contracted_service_id`. It NO LONGER multiplies services × addresses — that cartesian product
 * put "Cuidador" at the school and "AT" at home (2 services × 2 addresses = 4 drafts, 2 wrong;
 * RISCO-11 of the 02/09 meeting). A service without a live address is a blocking checklist code
 * (SERVICE_ADDRESS, `PatientCompleteness.ts`) — activation refuses (422) rather than guessing.
 * Only CODIFIED defaults propagate to the vaga (`providers_needed`, `schedule`; lex C-b2
 * caminho 1): `worker_profile_sought`/`salary_text` never come from the service. `schedule` is
 * copied verbatim (same array format `scheduleToJsonb` persists) and may be NULL — "the operator
 * can create a vacante without a schedule yet" (Gabriel 05/09); they fill it on the vaga, as
 * today (`OPERATIONAL_EDITABLE_FIELDS`). `weekly_hours`/`care_location`/dispositivos have NO
 * matching column on `job_postings` and are NOT propagated. With ZERO active services (every
 * patient before this feature is adopted), activation falls back to the PREVIOUS behaviour — one
 * draft per address, no `contracted_service_id` — so existing patients are not blocked.
 *
 * Spec 015 (US-A6.2, D254 item 6): each service-born vaga also inherits `age_range_min/max` from
 * the service's `provider_age_band`, through the SAME single mapping used everywhere else
 * (`vacancyRangeForProviderAgeBand`, `ProviderAgeBandMapping.ts`) — never a local re-derivation.
 * `null` (not informed) and the fallback (no service) both resolve to `{min:null,max:null}`.
 *
 * NOTE (deliberate): unlike VacancyCrudController.createVacancy, this use case
 * does NOT emit a `vacancy.created` domain event. That event drives
 * VacancyAutoInviteHandler, which runs matchmaking + WhatsApp auto-invite and
 * only skips on is_test — NOT on is_draft. These are incomplete rascunhos
 * ('A convenir', no requirements) that must be completed by hand before they
 * recruit anyone, so firing matchmaking here would be wrong.
 *
 * GATE de POST /activate (spec 014, decisão do Gabriel 03/09): bloqueia SÓ por ADDRESS — e, desde
 * a migration 330, por SERVICE_ADDRESS (mesma razão: a vaga precisa de endereço). Os demais
 * códigos de `computePatientCompleteness` (RESPONSIBLE/COVERAGE/CONTRACTED_SERVICE/
 * CONSENT) são checklist informativo (`GET /:id` → `completeness.missing[]`), não bloqueio.
 * Medido na réplica de produção (só contagens): 370 pacientes vivos, apenas 23 com
 * `has_consent=true` — o campo só é gravado pelo espelho do ClickUp e pelo formulário público,
 * nunca pelo painel; dos 6 candidatos a ativar no dia da medição, 4 estavam sem consentimento.
 * Bloquear por CONSENT/RESPONSIBLE/COVERAGE travaria a operação quase inteira hoje. Isto
 * restaura o comportamento de antes do bloco D (um agente anterior tinha ampliado o gate para
 * os 4 códigos não-clínicos; revertido aqui). Reversível a qualquer momento pelo Gabriel.
 */
export class ActivatePatientUseCase {
  private readonly pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool ?? DatabaseConnection.getInstance().getPool();
  }

  async execute(patientId: string): Promise<ActivatePatientResult> {
    const startMs = Date.now();
    const client: PoolClient = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const patientRes = await client.query<{
        id: string;
        status: string;
        case_number: number | null;
        birth_date: string | Date | null;
        has_consent: boolean | null;
        insurance_informed: string | null;
      }>(
        `SELECT id, status, case_number, birth_date, has_consent,
                COALESCE(insurance_informed, health_insurance_name) AS insurance_informed
           FROM patients
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [patientId],
      );

      if ((patientRes.rowCount ?? 0) === 0) {
        // Throw — the single catch below rolls back once (avoids double ROLLBACK).
        throw new PatientNotFoundError(patientId);
      }

      const { status, case_number, birth_date, has_consent, insurance_informed } = patientRes.rows[0];

      // Idempotent: already ACTIVE → do not create a second set of vacancies.
      if (status === 'ACTIVE') {
        await client.query('ROLLBACK');
        functions.logger.info('activate_patient.noop_already_active', { patientId });
        return { patientId, status: 'ACTIVE', createdVacancyIds: [], alreadyActive: true };
      }

      const addrRes = await client.query<{ id: string }>(
        `SELECT id
           FROM patient_addresses
          WHERE patient_id = $1 AND archived_at IS NULL
          ORDER BY display_order ASC, created_at ASC`,
        [patientId],
      );

      // Spec 013 bloco C: services declared for this patient, ACTIVE only. Zero rows here is
      // the case for every patient today (the entity nasceu vazia) — the loop below falls back
      // to one draft per address, exactly like before this feature.
      const serviceRes = await client.query<{
        id: string;
        providers_needed: number | null;
        // Spec 015 (US-A6.2): coluna nova (migration 322) — a query já filtrava `WHERE active`,
        // então um serviço inativo simplesmente não aparece aqui (mesmo shape de antes).
        provider_age_band: string | null;
        // Migration 330: `live_address_id` é o endereço do serviço SÓ se ele existe e não está
        // arquivado — NULL cobre "sem vínculo" e "vínculo com endereço arquivado" de uma vez.
        live_address_id: string | null;
        schedule: unknown;
      }>(
        `SELECT pcs.id, pcs.providers_needed, pcs.provider_age_band, pcs.schedule,
                pa.id AS live_address_id
           FROM patient_contracted_services pcs
           LEFT JOIN patient_addresses pa
                  ON pa.id = pcs.address_id AND pa.archived_at IS NULL
          WHERE pcs.patient_id = $1 AND pcs.active
          ORDER BY pcs.created_at ASC`,
        [patientId],
      );
      const servicesWithoutAddress = serviceRes.rows.filter((r) => r.live_address_id == null);
      // Decisão do Gabriel 07/09: serviço ativo sem horário barra a ativação. `[]` conta como
      // ausente tanto quanto `null` — o SELECT acima traz `pcs.schedule` cru do banco.
      const servicesWithoutSchedule = serviceRes.rows.filter(
        (r) => !Array.isArray(r.schedule) || r.schedule.length === 0,
      );

      const respRes = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM patient_responsibles WHERE patient_id = $1`,
        [patientId],
      );

      // Spec 014 (US-D1/SUP-D1, lex D1.1/D1.2): `computePatientCompleteness` continua a fonte
      // ÚNICA do checklist — `missing[]`/`ready` no `GET /:id` cobre os 6 códigos
      // (ADDRESS/RESPONSIBLE/COVERAGE/CONTRACTED_SERVICE/SERVICE_ADDRESS/CONSENT), informativo. `blocking` já
      // vem filtrado por ACTIVATION_BLOCKING_CODES (D255) — o gate abaixo LÊ blocking, nunca
      // reimplementa "quais códigos bloqueiam" comparando `missing` a um código fixo (QA-caça
      // rodada 1, defeito 2: a cópia local só bloqueava ADDRESS por coincidência).
      const { blocking } = computePatientCompleteness({
        birthDate: birth_date,
        hasConsent: has_consent,
        insuranceInformed: insurance_informed,
        activeAddressCount: addrRes.rowCount ?? 0,
        activeResponsibleCount: respRes.rows[0]?.count ?? 0,
        activeContractedServiceCount: serviceRes.rowCount ?? 0,
        activeContractedServicesWithoutAddressCount: servicesWithoutAddress.length,
        activeContractedServicesWithoutScheduleCount: servicesWithoutSchedule.length,
      });

      // GATE do POST /activate = ADDRESS e, desde a migration 330 (D283), SERVICE_ADDRESS — os
      // dois pela mesma razão: a vaga precisa de endereço. Origem da régua (Gabriel, 03/09, revertendo o que o
      // agente anterior do bloco D tinha feito — bloquear também por RESPONSIBLE/COVERAGE/
      // CONSENT). Medido na réplica de produção (só contagens, D165): 370 pacientes vivos, 23
      // com has_consent=true — `has_consent` hoje só é gravado pelo espelho do ClickUp e pelo
      // formulário público, NUNCA pelo painel. Dos 6 candidatos a ativar no dia da medição, 4
      // estavam sem consentimento: bloquear por CONSENT/RESPONSIBLE/COVERAGE travaria a
      // operação quase inteira. Os demais códigos ficam no checklist como pendência informativa,
      // não como bloqueio — reversível: é só ACTIVATION_BLOCKING_CODES mudar (PatientCompleteness.ts).
      if (blocking.length > 0) {
        // Throw — the single catch below rolls back once (avoids double ROLLBACK).
        // O erro nomeia o que REALMENTE barrou: `NoActiveAddressError` hardcoda `['ADDRESS']` e
        // uma mensagem sobre endereço, então só serve quando ADDRESS é o único bloqueio. Desde a
        // 330 há um segundo código (SERVICE_ADDRESS): sozinho ou junto, cai no genérico — senão o
        // 422 diria "falta o endereço" para quem tem endereço.
        throw blocking.length === 1 && blocking[0] === 'ADDRESS'
          ? new NoActiveAddressError(patientId)
          : new PatientNotReadyError(patientId, blocking);
      }

      const pairs: Array<{
        addressId: string;
        serviceId: string | null;
        providersNeeded: number | null;
        // Spec 015 (US-A6.2): sempre um objeto (nunca null) — vacancyRangeForProviderAgeBand
        // já resolve "não informado"/fallback para {min:null,max:null} (ProviderAgeBandMapping.ts).
        ageRange: { min: number | null; max: number | null };
        /** Migration 330: horário do encuadre, copiado tal qual; null = a vaga nasce sem horário. */
        schedule: unknown;
      }> =
        serviceRes.rowCount && serviceRes.rowCount > 0
          ? // Migration 330: UMA vaga POR SERVIÇO, no endereço do serviço. O gate acima já
            // garantiu que todo serviço ativo tem endereço vivo (SERVICE_ADDRESS bloqueia), então
            // `live_address_id` nunca é null aqui — o `!` é coberto pelo gate, não por fé.
            serviceRes.rows.map((svc) => ({
              addressId: svc.live_address_id!,
              serviceId: svc.id,
              providersNeeded: svc.providers_needed,
              ageRange: vacancyRangeForProviderAgeBand(svc.provider_age_band as ProviderAgeBand | null),
              // Desde a decisão do Gabriel 07/09, o gate SERVICE_SCHEDULE acima já recusou
              // qualquer serviço ativo sem horário — o que chega aqui SEMPRE tem array não-vazio.
              // Um `?? null` seria ramo inalcançável (a vaga nascia sem horário até 05/09).
              schedule: svc.schedule,
            }))
          : addrRes.rows.map((addr) => ({
              addressId: addr.id,
              serviceId: null,
              providersNeeded: null,
              ageRange: { min: null, max: null },
              schedule: null,
            }));

      const createdVacancyIds: string[] = [];
      for (const pair of pairs) {
        // Same vacancy_number sequence + title convention as createVacancy.
        const vnRes = await client.query<{ vn: string }>(
          "SELECT nextval('job_postings_vacancy_number_seq') AS vn",
        );
        const vacancyNumber = parseInt(vnRes.rows[0].vn, 10);
        const computedTitle = `CASO ${case_number}-${vacancyNumber}`;

        // Minimal draft: only patient_id, case_number, patient_address_id (+ contracted_service_id
        // and providers_needed when the pair comes from a declared service). Everything else
        // falls back to the buildInsertParams defaults (salary_text 'A convenir', status
        // 'PENDING_ACTIVATION', required_professions []) and the DB defaults (is_draft true).
        // NEVER worker_profile_sought/salary_text from the service (lex C-b2/C-c.3).
        const params = buildInsertParams({
          vacancyNumber,
          case_number,
          computedTitle,
          patient_id: patientId,
          patient_address_id: pair.addressId,
          contracted_service_id: pair.serviceId,
          required_professions: null,
          required_sex: null,
          // Spec 015 (US-A6.2, D254 item 6): herda da franja do SERVIÇO — fonte única
          // vacancyRangeForProviderAgeBand (ProviderAgeBandMapping.ts). Fallback (sem serviço) e
          // "não informado" resolvem para null/null acima, na construção de `pairs`.
          age_range_min: pair.ageRange.min,
          age_range_max: pair.ageRange.max,
          worker_profile_sought: null,
          required_experience: null,
          worker_attributes: null,
          schedule: pair.schedule,
          work_schedule: null,
          providers_needed: pair.providersNeeded,
          salary_text: null,
          payment_day: null,
          daily_obs: null,
          status: undefined,
          published_at: null,
          closes_at: null,
          is_test: false,
        });

        const insRes = await client.query<{ id: string }>(buildInsertQuery(), params);
        createdVacancyIds.push(insRes.rows[0].id);
      }

      // Move to ACTIVE in the SAME transaction — replicating exactly what
      // `PatientService.moveStatus` does (it cannot be called directly here: it opens its
      // OWN connection/transaction, which would break the single-transaction atomicity this
      // use case depends on — see the class docblock). QA 🟡2: the previous bare
      // `UPDATE ... SET status='ACTIVE'` left `on_hold_reason`/`on_hold_note` stale when
      // activating a patient that was ON_HOLD, and left `patient_status_history.change_source`
      // NULL because nothing set `app.change_source` before the UPDATE that the migration-254
      // trigger reads from.
      await client.query("SELECT set_config('app.change_source', $1, true)", ['activate']);
      await client.query(
        `UPDATE patients SET status = 'ACTIVE', on_hold_reason = NULL, on_hold_note = NULL, updated_at = NOW() WHERE id = $1`,
        [patientId],
      );

      await client.query('COMMIT');

      functions.logger.info('activate_patient.completed', {
        patientId,
        createdVacancyCount: createdVacancyIds.length,
        createdVacancyIds,
        durationMs: Date.now() - startMs,
      });

      return { patientId, status: 'ACTIVE', createdVacancyIds, alreadyActive: false };
    } catch (err) {
      // Best-effort rollback for the unexpected-error path (the explicit
      // early-return paths above already rolled back before throwing).
      try {
        await client.query('ROLLBACK');
      } catch {
        /* transaction already closed */
      }
      if (!(err instanceof PatientNotFoundError) && !(err instanceof PatientNotReadyError)) {
        functions.logger.error('activate_patient.failed', {
          patientId,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startMs,
        });
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
