import type { FunnelTableRow } from '@domain/entities/Funnel';

export type RegistrationFilter = 'ALL' | 'COMPLETE' | 'INCOMPLETE';

export interface FunnelRowFilters {
  query: string;
  registration: RegistrationFilter;
}

export const DEFAULT_FUNNEL_ROW_FILTERS: FunnelRowFilters = {
  query: '',
  registration: 'ALL',
};

/** Minúsculas e sem acento: "María" e "maria" se igualam. */
function normalizeName(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

function matchesQuery(row: FunnelTableRow, query: string): boolean {
  const trimmed = query.trim();
  if (trimmed === '') return true;

  if (row.workerName && normalizeName(row.workerName).includes(normalizeName(trimmed))) {
    return true;
  }

  // O telefone só entra se o texto digitado tem ao menos um dígito; os dois lados são
  // comparados só por dígitos (o formato armazenado do telefone não é garantido).
  const queryDigits = digitsOnly(trimmed);
  if (queryDigits === '' || !row.workerPhone) return false;
  return digitsOnly(row.workerPhone).includes(queryDigits);
}

function matchesRegistration(row: FunnelTableRow, registration: RegistrationFilter): boolean {
  if (registration === 'COMPLETE') return row.registrationComplete === true;
  if (registration === 'INCOMPLETE') return row.registrationComplete === false;
  return true;
}

/** Busca (nome OU telefone) E registro. Filtra a resposta inteira no front; o back não pagina. */
export function filterFunnelRows(
  rows: FunnelTableRow[],
  { query, registration }: FunnelRowFilters,
): FunnelTableRow[] {
  return rows.filter(
    (row) => matchesQuery(row, query) && matchesRegistration(row, registration),
  );
}

export function hasActiveFilters({ query, registration }: FunnelRowFilters): boolean {
  return query.trim() !== '' || registration !== 'ALL';
}
