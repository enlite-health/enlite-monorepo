/**
 * EnquadreWorkerPicker — lista de caixas de seleção de prestadores (spec 052). Genérico: não sabe se está em "criar
 * evento" ou em "gestionar convocados". Prestador sem e-mail válido aparece DESABILITADO com o motivo escrito (molde:
 * a lista de responsáveis de NewAdmissionModal, que usa rádio; aqui é seleção múltipla). O tipo só carrega
 * `hasValidEmail`; nenhum endereço passa por aqui.
 */
import type { JSX } from 'react';
import { Text } from '@presentation/components/atoms/Text';
import type { EnquadreWorkerOption } from '@domain/entities/EnquadreEvent';

interface Props {
  options: readonly EnquadreWorkerOption[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  /** Texto do motivo mostrado no prestador desabilitado. */
  noEmailReason: string;
  /** Congela a lista (chamada em curso). */
  disabled?: boolean;
  /** Prefixo dos data-testid: `<prefix>-list`, `<prefix>-option-<id>`, `-checkbox-<id>`, `-reason-<id>`. */
  testIdPrefix?: string;
}

export function EnquadreWorkerPicker({ options, selected, onChange, noEmailReason, disabled = false, testIdPrefix = 'enquadre-worker' }: Props): JSX.Element {
  const toggle = (id: string): void => {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  return (
    <div className="flex flex-col gap-2" data-testid={`${testIdPrefix}-list`}>
      {options.map((w) => {
        const blocked = !w.hasValidEmail;
        const checked = selected.includes(w.id);
        return (
          <label
            key={w.id}
            data-testid={`${testIdPrefix}-option-${w.id}`}
            data-disabled={blocked ? 'true' : 'false'}
            className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border ${checked ? 'border-primary bg-gray-200' : 'border-gray-600 bg-white'} ${blocked ? 'cursor-not-allowed' : 'cursor-pointer hover:border-primary'}`}
          >
            <input
              type="checkbox"
              checked={checked && !blocked}
              disabled={blocked || disabled}
              onChange={() => toggle(w.id)}
              className="mt-1"
              data-testid={`${testIdPrefix}-checkbox-${w.id}`}
            />
            <span className="flex flex-col min-w-0">
              <Text as="span" size="sm" weight="medium" color="inherit" className={`truncate ${blocked ? 'text-slate-600' : 'text-gray-900'}`} data-clarity-mask="True">
                {w.name}
              </Text>
              {blocked && (
                <Text color="inherit" as="span" size="xs" weight="medium" className="text-amber-900" data-testid={`${testIdPrefix}-reason-${w.id}`}>
                  {noEmailReason}
                </Text>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}
