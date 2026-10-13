/**
 * ProfileField — par rótulo/valor da página Perfil. Mesma tipografia da antiga `TactiqLinkPage` (rótulo `2xs` primary em
 * caixa-alta; valor `sm` medium) e do `FieldPair` da ficha, mas com o valor em `text-gray-900` (17:1) em vez do
 * `muted` do `FieldPair` (1,96:1 — decisão do Gabriel só para a ficha do paciente). Aqui o dado é o que a pessoa veio
 * ler, e a régua do projeto para texto novo é 7:1.
 */
import type { JSX, ReactNode } from 'react';
import { Text } from '@presentation/components/atoms/Text';

interface ProfileFieldProps {
  label: string;
  value: ReactNode;
  testId?: string;
}

export function ProfileField({ label, value, testId }: ProfileFieldProps): JSX.Element {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <Text as="span" size="2xs" color="primary" className="uppercase tracking-wide">{label}</Text>
      <Text color="inherit" as="span" size="sm" weight="medium" className="text-gray-900 break-words" data-testid={testId}>{value}</Text>
    </div>
  );
}
