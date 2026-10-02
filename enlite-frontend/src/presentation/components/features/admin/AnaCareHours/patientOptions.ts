/**
 * Opções de autocomplete de paciente (spec 032), montadas a partir do retrato do mês que a LISTA
 * já mostra — usadas pelo diálogo de exportação e pelo modal "Cambiar de paciente". A busca casa o
 * nome OU o ID do Ana Care (`searchText`); o ID nunca é exibido à parte.
 */
import type { ProviderFilterOption } from './ProviderFilterCombobox';
import { patientDisplayName } from './selectors';

export function patientSearchOption(p: { anaCareId: string; name?: string }): ProviderFilterOption {
  const label = patientDisplayName(p);
  return { value: p.anaCareId, label, searchText: `${label} ${p.anaCareId}` };
}

export function patientSearchOptions(patients: Array<{ anaCareId: string; name?: string }>): ProviderFilterOption[] {
  return patients.map(patientSearchOption);
}
