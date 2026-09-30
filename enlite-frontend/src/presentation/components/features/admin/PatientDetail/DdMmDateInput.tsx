import { Calendar } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { inputWrapperClasses } from '@presentation/components/atoms/Input/inputClasses';
import { formatDdMmYyyy } from './ddMmDate';

interface DdMmDateInputProps {
  /** Data pura `YYYY-MM-DD`. */
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  /** Vai para o `<input type="date">` transparente por cima (é nele que o teste digita/muda). */
  'data-testid'?: string;
}

/**
 * Campo de data em dd/mm/aaaa (es-AR) com UM só ícone de calendário: o texto formatado por
 * baixo e o `<input type="date">` nativo transparente por cima (clicar abre o seletor do
 * navegador; o indicador nativo do Chrome fica invisível). Mesma técnica do painel do prestador
 * do encuadre — a `<input type="date">` crua mostra mm/dd/yyyy conforme o locale do navegador.
 */
export function DdMmDateInput({ value, onChange, ariaLabel, 'data-testid': testId }: DdMmDateInputProps): JSX.Element {
  return (
    <div className={`${inputWrapperClasses({ size: 'compact' })} justify-between relative`}>
      <Text as="span" size="sm" weight="medium" color="inherit">
        {formatDdMmYyyy(value)}
      </Text>
      <Calendar className="w-[22px] h-[22px] text-[#737373] shrink-0 pointer-events-none" aria-hidden="true" />
      <input
        type="date"
        lang="es-AR"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        data-testid={testId}
      />
    </div>
  );
}
