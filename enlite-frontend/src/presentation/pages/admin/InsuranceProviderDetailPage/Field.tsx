import type { ComponentProps } from 'react';
import { Text } from '@presentation/components/atoms/Text';
import { FormField } from '@presentation/components/molecules/FormField';

type Props = Omit<ComponentProps<typeof FormField>, 'hint' | 'hintBelow'> & {
  /** Instrução curta abaixo do campo. Em `slate-600` (7,6:1): a do `FormField` é cinza translúcido do tema (~2:1) e aqui a instrução carrega regra (ex.: "digite 0 se isento"). */
  hint?: string;
};

/** `FormField` com a dica sempre abaixo do campo e legível (régua AAA do projeto). */
export function Field({ hint, children, ...rest }: Props): JSX.Element {
  return (
    <FormField {...rest}>
      {children}
      {hint && <Text as="span" size="xs" color="inherit" className="text-slate-600">{hint}</Text>}
    </FormField>
  );
}
