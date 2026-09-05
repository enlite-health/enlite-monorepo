import { ReactNode } from 'react';
import { Label, Text } from '@presentation/components/atoms';
import type { LabelSize } from '@presentation/components/atoms/Label';

interface FormFieldProps {
  label: string;
  /**
   * Tamanho do rótulo — mesma escala do `Label`. `compact` (12px, cor primária) é para formulário
   * denso, em colunas: o rótulo de 18px cinza foi desenhado para uma coluna com respiro e, numa
   * grade de três campos, ele quebra linha e compete com o valor. Default inalterado.
   */
  labelSize?: LabelSize;
  /** Texto auxiliar curto exibido abaixo do label (ex.: diferenciar Sexo de Género). */
  hint?: string;
  error?: string;
  required?: boolean;
  optional?: boolean;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}

export function FormField({
  label,
  hint,
  error,
  required = false,
  optional = false,
  labelSize = 'default',
  children,
  htmlFor,
  className = '',
}: FormFieldProps): JSX.Element {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <Label htmlFor={htmlFor} required={required} optional={optional} size={labelSize}>
        {label}
      </Label>
      {hint && (
        <Text as="span" size="xs" color="muted" className="-mt-0.5">
          {hint}
        </Text>
      )}
      {children}
      {error && <span className="text-red-500 text-xs">{error}</span>}
    </div>
  );
}
