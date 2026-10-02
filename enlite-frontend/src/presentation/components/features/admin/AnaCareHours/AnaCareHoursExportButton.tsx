/**
 * Botão "Exportar" da lista e do detalhe (spec 032). Dono do estado aberto/fechado do diálogo e do
 * gate `anacare_hours:export` (padrão de `AnaCareHoursDetailContainer`): sem a célula, desabilitado
 * com o motivo VISÍVEL (nunca só `title`). `disabledReason` (já traduzido) cobre "sem retrato real".
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';
import { Button } from '@presentation/components/atoms/Button';
import { Text } from '@presentation/components/atoms/Text';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { AnaCareHoursExportDialog } from './AnaCareHoursExportDialog';
import type { AnaCareHoursExportService } from './AnaCareHoursExportService';
import type { AnaCareListPatient } from './types';

interface AnaCareHoursExportButtonProps {
  service: AnaCareHoursExportService;
  patients: AnaCareListPatient[];
  initialMonth: string;
  initialPatientId?: string;
  initialPatientName?: string;
  /** Motivo (já traduzido) para desabilitar — ex.: retrato do mês ainda não chegou. */
  disabledReason?: string;
}

export function AnaCareHoursExportButton({ service, patients, initialMonth, initialPatientId, initialPatientName, disabledReason }: AnaCareHoursExportButtonProps): JSX.Element {
  const { t } = useTranslation();
  const exportGate = useActionGate('anacare_hours', 'export');
  const [open, setOpen] = useState(false);
  const reason = exportGate.denied ? t('admin.anacareHours.export.noCell') : disabledReason;

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={reason !== undefined} data-testid="anacare-hours-export-button">
        <span className="inline-flex items-center gap-2">
          <Download className="w-4 h-4" aria-hidden="true" />
          {t('admin.anacareHours.export.button')}
        </span>
      </Button>
      {reason !== undefined && (
        <Text as="span" size="xs" color="muted" data-testid="anacare-hours-export-disabled-reason">
          {reason}
        </Text>
      )}
      {open && (
        <AnaCareHoursExportDialog
          service={service}
          patients={patients}
          initialPatientId={initialPatientId}
          initialPatientName={initialPatientName}
          initialMonth={initialMonth}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
