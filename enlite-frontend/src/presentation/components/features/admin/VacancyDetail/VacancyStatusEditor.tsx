import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Loader2 } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { VacancyLifecycleBadge } from '@presentation/components/atoms/VacancyLifecycleBadge';
import { STATUS_GRAVAVEIS, type CicloDeVida, type StatusGravavel } from '@domain/value-objects/vacancyLifecycle';

/** O editor da vaga só grava o CICLO DE VIDA (estado-automatico-do-paciente, D3/E5): os 4 de `STATUS_GRAVAVEIS`. */
export type EditableVacancyStatus = StatusGravavel;

interface VacancyStatusEditorProps {
  /** Valor gravado hoje (para marcar a opção atual e saber se há o que "Reanudar"); o que a tela MOSTRA é `lifecycle`. */
  status: string;
  /** Ciclo de vida calculado pelo back (tabela do dono). */
  lifecycle: CicloDeVida | null | undefined;
  /**
   * Spec 084 (R4/P1): vaga de serviço contratado nunca é ENCERRADA, só pausada — "Cerrado" não é oferecido (o servidor
   * recusa também, 409). Vaga sem serviço segue podendo encerrar.
   */
  hasService?: boolean;
  /** E8: o valor de ESCRITA que "Reanudar" envia — calculado pelo back (`resumeStatus`); o editor só o repete. */
  resumeStatus?: StatusGravavel;
  isSaving?: boolean;
  disabled?: boolean;
  onChange: (next: EditableVacancyStatus) => void | Promise<void>;
}

export function VacancyStatusEditor({
  status,
  lifecycle,
  hasService = false,
  resumeStatus = 'SEARCHING',
  isSaving = false,
  disabled = false,
  onChange,
}: VacancyStatusEditorProps): JSX.Element {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = async (next: EditableVacancyStatus): Promise<void> => {
    setIsOpen(false);
    if (next === status) return;
    await onChange(next);
  };

  const isDisabled = disabled || isSaving;
  const options = STATUS_GRAVAVEIS.filter((o) => !(hasService && o === 'CLOSED'));

  return (
    <div className="relative inline-flex" ref={containerRef}>
      <button
        type="button"
        data-testid="vacancy-status-editor-trigger"
        onClick={() => !isDisabled && setIsOpen((open) => !open)}
        disabled={isDisabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={t('admin.vacancyDetail.statusEditor.editLabel')}
        className={`inline-flex items-center gap-1.5 rounded transition-opacity ${
          isDisabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer hover:opacity-90'
        }`}
      >
        <VacancyLifecycleBadge lifecycle={lifecycle} />
        {isSaving ? (
          <Loader2 className="w-4 h-4 text-gray-700 animate-spin" />
        ) : (
          <ChevronDown
            className={`w-4 h-4 text-gray-700 transition-transform ${isOpen ? 'rotate-180' : ''}`}
            strokeWidth={2}
          />
        )}
      </button>

      {isOpen && !isDisabled && (
        <ul
          role="listbox"
          data-testid="vacancy-status-editor-dropdown"
          className="absolute right-0 top-full mt-1 z-20 min-w-[180px] rounded-lg border border-gray-300 bg-white shadow-lg py-1"
        >
          {status === 'ON_HOLD' && (
            <li role="option" aria-selected={false}>
              <button
                type="button"
                data-testid="vacancy-status-option-RESUME"
                onClick={() => handleSelect(resumeStatus)}
                className="w-full text-left px-4 py-2 hover:bg-gray-100 transition-colors"
              >
                <Text as="span" size="sm" color="primary" weight="medium">
                  {t('admin.vacancyDetail.statusEditor.resume')} → {t(`admin.vacancyDetail.statusEditor.options.${resumeStatus}`)}
                </Text>
              </button>
            </li>
          )}
          {options.map((option) => {
            const isCurrent = option === status;
            return (
              <li key={option} role="option" aria-selected={isCurrent}>
                <button
                  type="button"
                  data-testid={`vacancy-status-option-${option}`}
                  onClick={() => handleSelect(option)}
                  className={`w-full text-left px-4 py-2 hover:bg-gray-100 transition-colors ${
                    isCurrent ? 'bg-gray-50' : ''
                  }`}
                >
                  <Text as="span" size="sm" color="primary" weight={isCurrent ? 'medium' : undefined}>
                    {t(`admin.vacancyDetail.statusEditor.options.${option}`)}
                  </Text>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
