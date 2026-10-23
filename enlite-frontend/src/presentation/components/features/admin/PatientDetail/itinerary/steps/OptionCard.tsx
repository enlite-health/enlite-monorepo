import type { ReactNode } from 'react';
import { Circle, CircleDot } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';

interface OptionCardProps {
  /** Agrupa os rádios do passo (um `name` por pergunta). */
  name: string;
  selected: boolean;
  onSelect: () => void;
  title: string;
  description?: string;
  /** Aparece SÓ com a opção marcada (as datas, a pessoa que cobre…). Fica FORA do `<label>`: controles dentro de um rádio não valem. */
  children?: ReactNode;
  /** Opção de uma linha só (pessoa): centraliza o conteúdo na vertical. */
  compact?: boolean;
  /** O avatar à esquerda do título (opção de pessoa). */
  leading?: ReactNode;
  'data-testid': string;
}

/**
 * A opção-cartão do fluxo (mockup `.opt`): rádio de verdade (`<input type="radio">` visualmente oculto, `role="radio"` nativo, foco e
 * teclado de graça) com o desenho do mockup — borda lilás e fundo #FBF7FF quando marcada, círculo cheio no lugar do vazio.
 */
export function OptionCard({ name, selected, onSelect, title, description, children, compact = false, leading, 'data-testid': testId }: OptionCardProps): JSX.Element {
  return (
    <div className={`rounded-2xl border-2 px-3.5 py-3 ${selected ? 'border-clinic bg-[#FBF7FF]' : 'border-[#D6CDE0] bg-white'}`} data-testid={testId} data-selected={selected}>
      <label className={`flex cursor-pointer gap-3 ${compact ? 'items-center' : 'items-start'}`}>
        <input type="radio" name={name} checked={selected} onChange={onSelect} className="peer sr-only" />
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center peer-focus-visible:rounded-full peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-clinic ${selected ? 'text-clinic' : 'text-primary'}`} aria-hidden="true">
          {selected ? <CircleDot size={22} /> : <Circle size={22} />}
        </span>
        {leading}
        <span className="flex min-w-0 flex-1 flex-col">
          <Text as="span" weight="semibold" color="primary">
            {title}
          </Text>
          {description && (
            <Text as="span" size="sm" color="tertiary">
              {description}
            </Text>
          )}
        </span>
      </label>
      {selected && children && <div className="mt-3 flex flex-col gap-3 pl-9">{children}</div>}
    </div>
  );
}
