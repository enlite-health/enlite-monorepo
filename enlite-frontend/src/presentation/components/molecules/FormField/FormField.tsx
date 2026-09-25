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
  /**
   * Conteúdo extra ao lado do rótulo (fase-4, `completar-vacante-em-rascunho`: o link "Editar en
   * la ficha del paciente" de um campo travado pela origem). Não é `hint` — fica na MESMA linha
   * do rótulo, não abaixo/acima do campo.
   */
  labelExtra?: ReactNode;
  /** Texto auxiliar curto exibido abaixo do label (ex.: diferenciar Sexo de Género). */
  hint?: string;
  /**
   * Dica ABAIXO do campo em vez de entre rótulo e campo. Numa grade de 2 colunas, dica em cima
   * empurra o campo para baixo e desalinha a linha (Gabriel, 06/09); em baixo, os campos ficam
   * na mesma altura e a dica continua visível. Default `false`: nada muda no resto do app.
   */
  hintBelow?: boolean;
  error?: string;
  required?: boolean;
  optional?: boolean;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}

export function FormField({
  label,
  labelExtra,
  hint,
  hintBelow = false,
  error,
  required = false,
  optional = false,
  labelSize = 'default',
  children,
  htmlFor,
  className = '',
}: FormFieldProps): JSX.Element {
  const labelNode = (
    <Label htmlFor={htmlFor} required={required} optional={optional} size={labelSize}>
      {label}
    </Label>
  );

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      {/* `labelExtra` some na maioria dos usos — não envolve `Label` num wrapper novo nesse caso,
          para não mudar a posição de `label.parentElement` de quem já testa contra o root deste
          componente (ex. `ContractedServiceFormRow.test.tsx`, gate 06/09). */}
      {labelExtra ? (
        <div className="flex items-center gap-2">
          {labelNode}
          {labelExtra}
        </div>
      ) : (
        labelNode
      )}
      {hint && !hintBelow && (
        <Text as="span" size="xs" color="muted" className="-mt-0.5">
          {hint}
        </Text>
      )}
      {children}
      {hint && hintBelow && (
        <Text as="span" size="xs" color="muted">
          {hint}
        </Text>
      )}
      {error && <span className="text-red-500 text-xs">{error}</span>}
    </div>
  );
}
