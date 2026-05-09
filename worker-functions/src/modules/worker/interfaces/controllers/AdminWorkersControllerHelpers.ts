export { normalizeSearch } from '@shared/utils/normalizeSearch';
import { normalizeSearch } from '@shared/utils/normalizeSearch';

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
