import { useTranslation } from 'react-i18next';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import type { AnaCareShift } from './types';
import { pendingOriginBreakdown, totalHours, type SinCheckinHoursMode } from './selectors';

interface ValidateBatchModalProps {
  /** Turnos SELECIONADOS — pode misturar prestadores diferentes do mesmo paciente. */
  shifts: AnaCareShift[];
  onConfirm: () => void;
  onCancel: () => void;
  sinCheckinHoursMode?: SinCheckinHoursMode;
}

export function ValidateBatchModal({ shifts, onConfirm, onCancel, sinCheckinHoursMode = 'zero' }: ValidateBatchModalProps): JSX.Element {
  const { t } = useTranslation();
  const hours = totalHours(shifts, sinCheckinHoursMode);
  const breakdown = pendingOriginBreakdown(shifts);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" data-testid="anacare-hours-batch-modal">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6 flex flex-col gap-4">
        <Heading level={3}>
          {t('admin.anacareHours.batchModal.titleSelection', { count: shifts.length, hours: hours.toFixed(1) })}
        </Heading>
        <Text color="muted">
          {t('admin.anacareHours.batchModal.description', { sinCheckin: breakdown.sinCheckin, webAdmin: breakdown.webAdmin })}
        </Text>
        <div className="flex justify-end gap-3 mt-2">
          <Button variant="outline" onClick={onCancel} data-testid="anacare-hours-batch-modal-cancel">
            {t('admin.anacareHours.batchModal.cancel')}
          </Button>
          <Button onClick={onConfirm} data-testid="anacare-hours-batch-modal-confirm">
            {t('admin.anacareHours.batchModal.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
