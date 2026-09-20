import type { ReactNode } from 'react';
import { Label, Text } from '@presentation/components/atoms';

interface ReadOnlyFieldProps {
  id?: string;
  label: string;
  /** O valor exibido quando NÃO se pode editar. `null`/`''` vira `—`. */
  value: ReactNode;
  /** `true` → renderiza o `children` (o input); `false` → texto. */
  editable: boolean;
  children?: ReactNode;
  className?: string;
}

/**
 * Um campo que é input em `write` e TEXTO em `read`. Não é `<input readOnly>`:
 * um input travado ainda parece editável (cursor, foco, borda) e convida ao
 * clique que não faz nada. Em `read` o campo é um parágrafo — e o `children`
 * (o input) nem é montado.
 */
export function ReadOnlyField({ id, label, value, editable, children, className = '' }: ReadOnlyFieldProps): JSX.Element {
  return (
    <div className={className}>
      <Label htmlFor={editable ? id : undefined}>{label}</Label>
      {editable ? (
        children
      ) : (
        <div className="px-3 py-2 min-h-[40px] flex items-center" data-testid={id ? `${id}-readonly` : undefined}>
          <Text as="span" size="sm" color="primary">
            {value === null || value === undefined || value === '' ? '—' : value}
          </Text>
        </div>
      )}
    </div>
  );
}
