import { useId } from 'react';

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Texto visível do rótulo (vem do chamador, já traduzido). */
  label: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/**
 * Interruptor acessível (`role="switch"`). Trilho 32×18, botão 14 px.
 * Ligado = primary (#180149); desligado = gray-600 (#D9D9D9) + anel interno 1 px gray-800 (#737373).
 * ⚠️ Divergência do canvas 089: o trilho #D9D9D9 sobre branco dá 1,41:1 (falha WCAG 1.4.11, mínimo 3:1); com o anel #737373
 * o limite do controle contra o fundo branco dá 4,74:1. O anel é `ring` (box-shadow inset): não muda o layout do botão de 14 px.
 * `<button>` nativo: Space e Enter acionam o clique sem código extra.
 */
export function Switch({ checked, onChange, label, disabled = false, id, className = '' }: SwitchProps): JSX.Element {
  const autoId = useId();
  const labelId = `${id ?? autoId}-label`;

  return (
    <div className={`inline-flex items-center gap-2 ${className}`}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${
          checked ? 'bg-primary' : 'bg-gray-600 ring-1 ring-inset ring-gray-800'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <span
          aria-hidden="true"
          className={`absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
      <span
        id={labelId}
        onClick={() => {
          if (!disabled) onChange(!checked);
        }}
        className={`font-lexend text-[13px] leading-5 text-primary select-none ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
      >
        {label}
      </span>
    </div>
  );
}
