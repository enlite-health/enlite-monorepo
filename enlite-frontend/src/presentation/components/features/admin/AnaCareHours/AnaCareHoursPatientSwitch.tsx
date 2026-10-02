/**
 * "Cambiar de paciente" no detalhe de horas (spec 032, FR-006/P2): ícone (montado DENTRO do Heading, logo
 * após o nome) que abre um
 * modal com autocomplete. Opções = pacientes do retrato do mês que a LISTA já mostra (zero GET novo),
 * SEM o paciente atual. Escolher chama `onSelect(id)` (a página-rota navega mantendo `?month`) e fecha;
 * "Cancelar"/Esc fecham sem navegar. Casca no molde de `AnaCareHoursExportDialog`.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { patientSearchOptions } from './patientOptions';
import { PatientSwapIcon } from './PatientSwapIcon';
import { ProviderFilterCombobox } from './ProviderFilterCombobox';
import type { AnaCareListPatient } from './types';

interface AnaCareHoursPatientSwitchProps {
  /** Pacientes do retrato do mês (o que a lista mostra). `[]` com retrato não construído. */
  patients: AnaCareListPatient[];
  currentPatientId: string;
  onSelect: (patientId: string) => void;
}

const I18N = 'admin.anacareHours.detail';
const FIELD_ID = 'anacare-hours-patient-switch-combobox';

export function AnaCareHoursPatientSwitch({ patients, currentPatientId, onSelect }: AnaCareHoursPatientSwitchProps): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const options = useMemo(() => patientSearchOptions(patients.filter((p) => p.anaCareId !== currentPatientId)), [patients, currentPatientId]);

  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    // Captura: o combobox aberto dá `stopPropagation` no Esc; sem isto, com o campo focado, o Esc não fecharia o modal.
    document.addEventListener('keydown', onKeyDown, true);
    document.getElementById(FIELD_ID)?.focus();
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  function handleChoose(patientId: string): void {
    if (patientId === '') return;
    setOpen(false);
    onSelect(patientId);
  }

  const label = t(`${I18N}.patientSwitchLabel`);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label}
        title={label}
        // Só o ícone: sem borda, fundo nem padding (o reset do Tailwind já zera o <button>); foco visível só no teclado.
        className="ml-[0.35em] inline-flex items-center align-middle text-inherit rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        data-testid="anacare-hours-patient-switch-button"
      >
        <PatientSwapIcon />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" data-testid="anacare-hours-patient-switch-modal">
          <div role="dialog" aria-modal="true" aria-labelledby="anacare-hours-patient-switch-title" className="bg-white rounded-xl shadow-lg w-full max-w-md p-6 flex flex-col gap-4">
            <Heading level={3} id="anacare-hours-patient-switch-title">{t(`${I18N}.patientSwitchTitle`)}</Heading>
            <div className="flex flex-col gap-1.5">
              <ProviderFilterCombobox
                id={FIELD_ID}
                options={options}
                value=""
                onValueChange={handleChoose}
                placeholder={t(`${I18N}.patientSwitchPlaceholder`)}
                ariaLabel={label}
                noMatchLabel={t(`${I18N}.patientSwitchNoMatch`)}
                hideAllOption
              />
              <Text size="xs" color="muted" data-testid="anacare-hours-patient-switch-help">{t('admin.anacareHours.export.help')}</Text>
              {patients.length === 0 && (
                <Text size="xs" className="!text-amber-700" data-testid="anacare-hours-patient-switch-no-patients">{t('admin.anacareHours.export.noPatients')}</Text>
              )}
            </div>
            <div className="flex justify-end gap-3 mt-2">
              <Button variant="outline" onClick={() => setOpen(false)} data-testid="anacare-hours-patient-switch-cancel">{t(`${I18N}.patientSwitchCancel`)}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
