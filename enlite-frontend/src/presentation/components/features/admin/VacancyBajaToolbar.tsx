import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { Checkbox } from '@presentation/components/atoms/Checkbox';
import { useActionGate } from '@presentation/hooks/useCellAccess';

interface VacancyBajaToolbarProps {
  showBaja: boolean;
  onShowBajaChange: (next: boolean) => void;
  talentumManual: boolean;
  onTalentumManualChange: (next: boolean) => void;
  selectedCount: number;
  onBulkBaja: () => void;
  onClearSelection: () => void;
}

/**
 * Spec 084 F1/F2/F4 — a faixa entre os filtros e a tabela: "Mostrar dadas de baja" (só consulta), a lista manual do Talentum e a
 * baixa em lote. Dar baixa usa a MESMA célula que edita a vaga (`vacancy:update`, P5); sem ela o botão SOME. NÃO existe "reativar".
 */
export function VacancyBajaToolbar({
  showBaja,
  onShowBajaChange,
  talentumManual,
  onTalentumManualChange,
  selectedCount,
  onBulkBaja,
  onClearSelection,
}: VacancyBajaToolbarProps): JSX.Element {
  const { t } = useTranslation();
  const canBaja = useActionGate('vacancy', 'update').allowed;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2" data-testid="vacancy-baja-toolbar">
      <Checkbox
        id="vacancies-show-baja"
        data-testid="vacancies-show-baja"
        checked={showBaja}
        onChange={(e) => onShowBajaChange(e.target.checked)}
        label={t('admin.vacancies.baja.showToggle')}
      />
      <Checkbox
        id="vacancies-talentum-manual"
        data-testid="vacancies-talentum-manual"
        checked={talentumManual}
        onChange={(e) => onTalentumManualChange(e.target.checked)}
        label={t('admin.vacancies.baja.talentumManualToggle')}
      />
      {canBaja && selectedCount > 0 && (
        <div className="ml-auto flex items-center gap-3" data-testid="vacancy-baja-bulk-bar">
          <Text size="sm" color="secondary">{t('admin.vacancies.baja.selectedCount', { count: selectedCount })}</Text>
          <Button variant="outline" size="sm" onClick={onClearSelection} data-testid="vacancy-baja-clear">
            {t('admin.vacancies.baja.clearSelection')}
          </Button>
          <Button variant="primary" size="sm" onClick={onBulkBaja} data-testid="vacancy-baja-bulk-button">
            {t('admin.vacancies.baja.bulkButton', { count: selectedCount })}
          </Button>
        </div>
      )}
    </div>
  );
}
