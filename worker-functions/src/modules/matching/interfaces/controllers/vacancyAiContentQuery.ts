import { Pool } from 'pg';
import { vacancyEffectiveAgeRangeSql, vacancyEffectiveJoinSql, vacancyEffectiveProvidersNeededSql, vacancyEffectiveScheduleSql } from '@shared/sql/vacancyEffectiveFieldsSql';
import { applyEffectiveAgeRange } from '@modules/case/domain/ProviderAgeBandMapping';

/**
 * Reads the vacancy row that feeds `VacancyTalentumController.generateAIContent` (what is handed to
 * `GeminiVacancyParserService.generateFromVacancyData`). Split out of the controller (400-line limit) and
 * exported so the single-source e2e can prove the READ (effective schedule / providers / age range)
 * without reaching Gemini. Returns null when the vacancy does not exist.
 */
export async function loadVacancyForAiContent(db: Pool, id: string) {
  const result = await db.query(
    `SELECT
       jp.id, jp.title, jp.case_number, jp.required_professions, jp.required_sex,
       ${vacancyEffectiveAgeRangeSql('jp')}, jp.required_experience, jp.worker_attributes,
       ${vacancyEffectiveScheduleSql('jp')} AS schedule, jp.work_schedule, ${vacancyEffectiveProvidersNeededSql('jp')} AS providers_needed, jp.salary_text,
       jp.payment_day, jp.daily_obs,
       pa.address_formatted, pa.city, pa.state,
       p.diagnosis, p.dependency_level, p.service_type
     FROM job_postings jp
     ${vacancyEffectiveJoinSql('jp')}
     LEFT JOIN patient_addresses pa ON jp.patient_address_id = pa.id
     LEFT JOIN patients p ON jp.patient_id = p.id
     WHERE jp.id = $1`,
    [id],
  );

  if (result.rows.length === 0) return null;

  const row = applyEffectiveAgeRange(result.rows[0]);
  const vacancyData = {
    title: row.title, case_number: row.case_number,
    required_professions: row.required_professions, required_sex: row.required_sex,
    age_range_min: row.age_range_min, age_range_max: row.age_range_max,
    required_experience: row.required_experience, worker_attributes: row.worker_attributes,
    schedule: row.schedule, work_schedule: row.work_schedule,
    providers_needed: row.providers_needed, salary_text: row.salary_text,
    payment_day: row.payment_day, daily_obs: row.daily_obs,
  };
  const patientData = { diagnosis: row.diagnosis, dependency_level: row.dependency_level, service_type: row.service_type };
  const addressData = { address_formatted: row.address_formatted, city: row.city, state: row.state };
  return { vacancyData, patientData, addressData };
}
