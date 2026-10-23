// TEMPORÁRIO (spec 070 T1→T4): mantém os 11 importadores do atom antigo
// compilando até o T4 migrá-los para <Combobox multiple>. Removido no T4.
import { Combobox, type ComboboxOption } from '../Combobox';

export interface MultiSelectProps {
  options: ComboboxOption[];
  value: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  inputSize?: 'default' | 'compact' | 'dense';
  disabled?: boolean;
  id?: string;
  /** Ignorada: a busca agora é regra do Combobox (>= SEARCH_MIN_OPTIONS). */
  searchable?: boolean;
  searchPlaceholder?: string;
  noResultsLabel?: string;
}

export function MultiSelect({ searchable: _searchable, ...rest }: MultiSelectProps): JSX.Element {
  // default do Combobox é 'default' (60px); os multi existentes eram 'compact'.
  return <Combobox multiple {...rest} inputSize={rest.inputSize ?? 'compact'} />;
}
