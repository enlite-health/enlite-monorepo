import { Text } from '@presentation/components/atoms/Text';

interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** `ta('...')` do drawer — mesmo helper de tradução, sem duplicar o prefixo aqui. */
  ta: (key: string) => string;
}

/**
 * Checkbox "Marcar como principal" (spec 019, US 4.2) — extraído do `PatientAddressDrawer.tsx`,
 * onde o MESMO bloco (label + input + `Text`, mesmo `data-testid="pad-mark-primary"`) estava
 * duplicado nos dois ramos do formulário: criar (opt-in, sempre visível) e editar (só quando o
 * endereço ainda não é o principal). Achado F3 do gate `revisao-pr` — as duas cópias já
 * divergiam apenas na condição de exibição ao redor, nunca no conteúdo do próprio checkbox.
 * Único consumidor é o drawer (mesmo padrão de `AddressTypeFields.tsx`, extraído pelo mesmo
 * motivo — ver docblock lá).
 */
export function MarkPrimaryCheckbox({ checked, onChange, ta }: Props): JSX.Element {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid="pad-mark-primary"
      />
      <Text as="span" size="sm" color="inherit">{ta('markPrimary')}</Text>
    </label>
  );
}
