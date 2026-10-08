/** Número do caso da vaga, lido do paciente (spec 046 §3.1; exige `LEFT JOIN patients p`; NULL = sem paciente). */
// Segue a visibilidade do paciente: sob RLS de país (policy `patients_country_isolation`, migration 411) quem não vê o paciente vê NULL, como no nome.
export const VACANCY_CASE_NUMBER_SQL = 'p.case_number';
