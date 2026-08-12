export { normalizeSearch } from '@shared/utils/normalizeSearch';
import { normalizeSearch } from '@shared/utils/normalizeSearch';

// Campos selecionados para detalhe de worker — compartilhado por getWorkerById e
// getWorkerByPhone (AdminWorkersController). ana_care_id/ana_care_synced_at
// (migrations 014/231) espelham o status de sync AnaCare no detalhe do worker.
export const WORKER_DETAIL_COLS = [
  'w.id, w.email, w.phone, w.country, w.timezone, w.status, w.is_test',
  'w.data_sources, w.created_at, w.updated_at, w.deleted_at',
  'w.document_type, w.profession, w.occupation, w.knowledge_level',
  'w.title_certificate, w.experience_types, w.years_experience',
  'w.preferred_types, w.preferred_age_range, w.hobbies, w.diagnostic_preferences',
  'w.first_name_encrypted, w.last_name_encrypted, w.birth_date_encrypted',
  'w.sex_encrypted, w.gender_encrypted, w.document_number_encrypted',
  'w.profile_photo_url_encrypted, w.languages_encrypted',
  'w.whatsapp_phone_encrypted, w.linkedin_url_encrypted',
  'w.sexual_orientation_encrypted, w.race_encrypted, w.religion_encrypted',
  'w.weight_kg_encrypted, w.height_cm_encrypted',
  'w.ana_care_id, w.ana_care_synced_at',
].join(', ');

export function mapPlatformLabel(dataSources: string[]): string {
  if (!dataSources || dataSources.length === 0) return 'enlite_app';
  if (dataSources.some(s => s === 'candidatos' || s === 'candidatos_no_terminaron')) return 'talentum';
  if (dataSources.includes('planilla_operativa')) return 'planilla_operativa';
  if (dataSources.includes('ana_care')) return 'ana_care';
  if (dataSources.includes('talent_search')) return 'talent_search';
  return dataSources[0];
}

export interface WorkerListItem {
  id: string;
  name: string;
  email: string;
  casesCount: number;
  documentsStatus: string;
  documentsComplete: boolean;
  status: string;
  platform: string;
  createdAt: string;
}

/**
 * Verifica se todos os tokens da busca aparecem em ao menos um dos campos.
 * Suporta multi-palavra ("John Snow") e é insensível a acentos/case.
 */
export function matchesSearch(searchTerm: string, fields: string[]): boolean {
  const tokens = normalizeSearch(searchTerm).split(/\s+/).filter(Boolean);
  const normalizedFields = fields.map(normalizeSearch);
  const concatenated = normalizedFields.join(' ');
  return tokens.every((token) => concatenated.includes(token));
}
