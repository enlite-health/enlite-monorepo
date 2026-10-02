/**
 * Diálogo único de exportação das horas de UM paciente num período (spec 032). Autocomplete =
 * pacientes do retrato do mês que a LISTA já mostra (zero GET novo; paciente fora do mês da lista
 * não aparece — o texto de ajuda avisa), mais o paciente atual injetado quando ausente. Casca no
 * molde de `ContestModal`. Trocar de paciente aqui NÃO navega: exporta o outro e fecha.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Input } from '@presentation/components/atoms/Input';
import { Label } from '@presentation/components/atoms/Label';
import { Text } from '@presentation/components/atoms/Text';
import { AnaCareHoursServiceError } from './AnaCareHoursService';
import type { AnaCareHoursExportService } from './AnaCareHoursExportService';
import { MAX_EXPORT_DAYS, rangeDays } from './exportRange';
import { ProviderFilterCombobox, type ProviderFilterOption } from './ProviderFilterCombobox';
import { patientSearchOption, patientSearchOptions } from './patientOptions';
import { lastDayOfMonthIso, navigableDateRange } from './selectors';
import type { AnaCareListPatient } from './types';

export interface AnaCareHoursExportDialogProps {
  service: AnaCareHoursExportService;
  /** Pacientes do retrato do mês (o que a lista mostra). `[]` com retrato não construído. */
  patients: AnaCareListPatient[];
  /** Paciente pré-selecionado (detalhe). Se não está em `patients`, entra como opção extra. */
  initialPatientId?: string;
  /** Nome do paciente pré-selecionado, só para o rótulo da opção injetada. */
  initialPatientName?: string;
  /** `YYYY-MM` — pré-preenche Desde (dia 1) e Hasta (último dia). */
  initialMonth: string;
  onClose: () => void;
}

const I18N = 'admin.anacareHours.export';

export function AnaCareHoursExportDialog({ service, patients, initialPatientId, initialPatientName, initialMonth, onClose }: AnaCareHoursExportDialogProps): JSX.Element {
  const { t } = useTranslation();
  const [patientId, setPatientId] = useState(initialPatientId ?? '');
  const [desde, setDesde] = useState(`${initialMonth}-01`);
  const [hasta, setHasta] = useState(lastDayOfMonthIso(initialMonth));
  const [submitting, setSubmitting] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const inFlight = useRef(false);
  const bounds = navigableDateRange();

  const options = useMemo<ProviderFilterOption[]>(() => {
    const list = patientSearchOptions(patients);
    if (initialPatientId && !list.some((o) => o.value === initialPatientId)) {
      list.unshift(patientSearchOption({ anaCareId: initialPatientId, name: initialPatientName }));
    }
    return list;
  }, [patients, initialPatientId, initialPatientName]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const days = rangeDays(desde, hasta);
  const reason: string | null = options.length === 0 ? null
    : patientId === '' ? 'noPatient'
    : days === null ? 'hastaBeforeDesde'
    : days > MAX_EXPORT_DAYS ? 'tooLong'
    : null;
  const canExport = options.length > 0 && reason === null && !submitting;

  async function handleExport(): Promise<void> {
    if (inFlight.current || !canExport) return; // 2º clique durante o voo é ignorado (a ref vale antes do re-render)
    inFlight.current = true;
    setSubmitting(true);
    setErrorCode(null);
    try {
      await service.exportPatientRange({ patientId, desde, hasta });
      onClose();
    } catch (err: unknown) {
      setErrorCode(err instanceof AnaCareHoursServiceError ? err.code : 'DESCONHECIDO');
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" data-testid="anacare-hours-export-dialog">
      <div role="dialog" aria-modal="true" aria-labelledby="anacare-hours-export-title" className="bg-white rounded-xl shadow-lg w-full max-w-md p-6 flex flex-col gap-4">
        <Heading level={3} id="anacare-hours-export-title">{t(`${I18N}.title`)}</Heading>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="anacare-hours-export-patient" required>{t(`${I18N}.patientLabel`)}</Label>
          <ProviderFilterCombobox
            id="anacare-hours-export-patient"
            options={options}
            value={patientId}
            onValueChange={setPatientId}
            placeholder={t(`${I18N}.patientPlaceholder`)}
            ariaLabel={t(`${I18N}.patientLabel`)}
            noMatchLabel={t(`${I18N}.patientNoMatch`)}
            hideAllOption
          />
          <Text size="xs" color="muted" data-testid="anacare-hours-export-help">{t(`${I18N}.help`)}</Text>
          {options.length === 0 && (
            <Text size="xs" className="!text-amber-700" data-testid="anacare-hours-export-no-patients">{t(`${I18N}.noPatients`)}</Text>
          )}
        </div>

        <div className="flex gap-3">
          <div className="flex flex-col gap-1.5 flex-1">
            <Label htmlFor="anacare-hours-export-desde" required>{t(`${I18N}.desde`)}</Label>
            <Input id="anacare-hours-export-desde" type="date" inputSize="compact" value={desde} min={bounds.min} max={bounds.max} onChange={(e) => setDesde(e.target.value)} data-testid="anacare-hours-export-desde" />
          </div>
          <div className="flex flex-col gap-1.5 flex-1">
            <Label htmlFor="anacare-hours-export-hasta" required>{t(`${I18N}.hasta`)}</Label>
            <Input id="anacare-hours-export-hasta" type="date" inputSize="compact" value={hasta} min={bounds.min} max={bounds.max} onChange={(e) => setHasta(e.target.value)} data-testid="anacare-hours-export-hasta" />
          </div>
        </div>

        {reason && (
          <Text size="xs" className="!text-amber-700" role="status" data-testid="anacare-hours-export-reason">{t(`${I18N}.reason.${reason}`)}</Text>
        )}
        {errorCode && (
          <Text size="xs" className="!text-red-600" role="alert" data-testid="anacare-hours-export-error">{t(`${I18N}.error.byCode.${errorCode}`)}</Text>
        )}

        <div className="flex justify-end gap-3 mt-2">
          <Button variant="outline" onClick={onClose} data-testid="anacare-hours-export-cancel">{t(`${I18N}.cancel`)}</Button>
          <Button onClick={() => void handleExport()} disabled={!canExport} aria-busy={submitting} isLoading={false} data-testid="anacare-hours-export-confirm">
            {submitting ? t(`${I18N}.exporting`) : t(`${I18N}.confirm`)}
          </Button>
        </div>
      </div>
    </div>
  );
}
