/**
 * loadVacancyCase — a consulta do caso que `VacancyTalentumController.generateAIContent` faz,
 * somente-leitura, compartilhada pelo preview (1 prompt) e pela simulação (vacante inteira) — spec 029.
 * Mesma consulta e mesmo mapeamento da produção; uma cópia por caso de uso divergiria em silêncio.
 */
import type { Pool } from 'pg';
import { applyEffectiveAgeRange } from '../../case/domain/ProviderAgeBandMapping';
import { JobPostingNotFoundError } from '../infrastructure/TalentumDescriptionService';
import {
  vacancyEffectiveJoinSql,
  vacancyEffectiveScheduleSql,
  vacancyEffectiveRequiredSexSql,
  vacancyEffectiveRequiredProfessionsSql,
  vacancyEffectiveRequiredExperienceSql,
  vacancyEffectiveWorkScheduleSql,
  vacancyEffectivePaymentDaySql,
  vacancyEffectiveProvidersNeededSql,
  vacancyEffectiveAgeRangeSql,
} from '@shared/sql/vacancyEffectiveFieldsSql';

export async function loadVacancyCase(db: Pool, jobPostingId: string) {
  const result = await db.query(
    `SELECT
         jp.id, jp.title, jp.case_number, ${vacancyEffectiveRequiredProfessionsSql('jp')} AS required_professions,
         ${vacancyEffectiveRequiredSexSql('jp')} AS required_sex,
         ${vacancyEffectiveAgeRangeSql('jp')}, ${vacancyEffectiveRequiredExperienceSql('jp')} AS required_experience, jp.worker_attributes,
         ${vacancyEffectiveScheduleSql('jp')} AS schedule, ${vacancyEffectiveWorkScheduleSql('jp')} AS work_schedule,
         ${vacancyEffectiveProvidersNeededSql('jp')} AS providers_needed, jp.salary_text,
         ${vacancyEffectivePaymentDaySql('jp')} AS payment_day, jp.daily_obs,
         pa.address_formatted, pa.city, pa.state,
         p.diagnosis, p.dependency_level, p.service_type
       FROM job_postings jp
       ${vacancyEffectiveJoinSql('jp')}
       LEFT JOIN patient_addresses pa ON jp.patient_address_id = pa.id
       LEFT JOIN patients p ON jp.patient_id = p.id
       WHERE jp.id = $1`,
    [jobPostingId],
  );
  if (result.rows.length === 0) {
    throw new JobPostingNotFoundError(jobPostingId);
  }
  const row = applyEffectiveAgeRange(result.rows[0]);
  return {
    vacancy: {
      title: row.title, case_number: row.case_number,
      required_professions: row.required_professions, required_sex: row.required_sex,
      age_range_min: row.age_range_min, age_range_max: row.age_range_max,
      required_experience: row.required_experience, worker_attributes: row.worker_attributes,
      schedule: row.schedule, work_schedule: row.work_schedule,
      providers_needed: row.providers_needed, salary_text: row.salary_text,
      payment_day: row.payment_day, daily_obs: row.daily_obs,
    },
    patient: { diagnosis: row.diagnosis, dependency_level: row.dependency_level, service_type: row.service_type },
    address: { address_formatted: row.address_formatted, city: row.city, state: row.state },
  };
}
