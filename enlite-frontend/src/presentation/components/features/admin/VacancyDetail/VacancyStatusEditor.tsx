import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Loader2 } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { VacancyStatusBadge } from '@presentation/components/atoms/VacancyStatusBadge/VacancyStatusBadge';

const EDITABLE_STATUSES = [
  'SEARCHING',
  'SEARCHING_REPLACEMENT',
  'RAPID_RESPONSE',
  'ACTIVE',
  // Spec 084 F5 (R18): "En espera" — a pausa da vaga de serviço ativo (mantém Kanban, histórico e link curto).
  'ON_HOLD',
  'SUSPENDED',
  'CLOSED',
] as const;

export type EditableVacancyStatus = typeof EDITABLE_STATUSES[number];

interface VacancyStatusEditorProps {
  status: string;
  /**
   * Spec 084 (R4/P1): vaga de serviço contratado nunca é ENCERRADA, só pausada — "Cerrado" não é oferecido (o servidor
   * recusa também, 409). Vaga sem serviço segue podendo encerrar.
   */
  hasService?: boolean;
  /** Status de antes do "En espera": "Reanudar" devolve a ele (sem registro → "En búsqueda"). */
  statusBeforeHold?: string | null;
  isSaving?: boolean;
  disabled?: boolean;
  onChange: (next: EditableVacancyStatus) => void | Promise<void>;
}

export function VacancyStatusEditor({
  status,
  hasService = false,
  statusBeforeHold = null,
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
  const options = EDITABLE_STATUSES.filter((o) => !(hasService && o === 'CLOSED'));
  const resumeTarget: EditableVacancyStatus =
    (EDITABLE_STATUSES as readonly string[]).includes(statusBeforeHold ?? '') && statusBeforeHold !== 'ON_HOLD'
      ? (statusBeforeHold as EditableVacancyStatus)
      : 'SEARCHING';

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
        <VacancyStatusBadge status={status} />
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
                onClick={() => handleSelect(resumeTarget)}
                className="w-full text-left px-4 py-2 hover:bg-gray-100 transition-colors"
              >
                <Text as="span" size="sm" color="primary" weight="medium">
                  {t('admin.vacancyDetail.statusEditor.resume')} → {t(`admin.vacancyDetail.statusBadge.${resumeTarget}`)}
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
                    {t(`admin.vacancyDetail.statusBadge.${option}`)}
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
