import { ReactNode } from 'react';
import { Label, Text } from '@presentation/components/atoms';

interface FormFieldProps {
  label: string;
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
  children,
  htmlFor,
  className = '',
}: FormFieldProps): JSX.Element {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <Label htmlFor={htmlFor} required={required} optional={optional}>
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
