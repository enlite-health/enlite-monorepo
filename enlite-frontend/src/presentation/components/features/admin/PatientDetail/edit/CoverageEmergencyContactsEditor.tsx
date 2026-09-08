/**
 * CoverageEmergencyContactsEditor — a lista dos contatos de emergência da COBERTURA MÉDICA dentro do
 * drawer de cobertura (417; D301.3b — Ana Joulie 08/09: "profissional direto, ambulância, central de
 * atendimento de emergência"). A tela edita a lista inteira e manda a lista inteira (`replaceAll`).
 *
 * lex C10 (dever de informar, Ley 25.326 art. 6): o aviso abaixo do título diz, em es-AR, que o contato
 * do terceiro será registrado e impresso no documento entregue à família/financiador.
 */
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import {
  COVERAGE_EMERGENCY_CONTACT_KINDS,
  COVERAGE_EMERGENCY_CONTACT_NAME_MAX,
  COVERAGE_EMERGENCY_CONTACT_PHONE_MAX,
  COVERAGE_EMERGENCY_CONTACTS_MAX,
  type CoverageEmergencyContactKind,
  type PatientCoverageEmergencyContactInput,
} from '@domain/entities/PatientCoverage';
import { contactFieldErrors } from './coverageContactValidation';
import { Button } from '@presentation/components/atoms/Button';
import { Select } from '@presentation/components/atoms/Select';
import { Text } from '@presentation/components/atoms/Text';
import { Label } from '@presentation/components/atoms/Label';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';

interface Props {
  value: PatientCoverageEmergencyContactInput[];
  onChange: (next: PatientCoverageEmergencyContactInput[]) => void;
  disabled?: boolean;
  /** lex C3: sem `patient_care_team:read` o servidor recusa (403) um profissional direto — a tela não o oferece. Esconder por omissão. */
  allowDirectProfessional?: boolean;
}

export function CoverageEmergencyContactsEditor({ value, onChange, disabled = false, allowDirectProfessional = false }: Props): JSX.Element {
  const { t } = useTranslation();
  const tc = (k: string) => t(`admin.patients.detail.coverageCard.${k}`);
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);

  const update = (i: number, patch: Partial<PatientCoverageEmergencyContactInput>): void =>
    onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const remove = (i: number): void => onChange(value.filter((_, j) => j !== i));
  const add = (): void => onChange([...value, { kind: 'AMBULANCE', name: '', phone: '' }]);

  const kindOptions = COVERAGE_EMERGENCY_CONTACT_KINDS
    .filter((k) => allowDirectProfessional || k !== 'DIRECT_PROFESSIONAL')
    .map((k) => ({ value: k, label: tc(`emergencyContactKinds.${k}`) }));

  return (
    <div className="flex flex-col gap-3" data-testid="pcv-emergency-contacts">
      <div className="flex items-center justify-between gap-2">
        <Label>{tc('emergencyContacts')}</Label>
        <Button type="button" variant="outline" size="sm" onClick={add} disabled={disabled || value.length >= COVERAGE_EMERGENCY_CONTACTS_MAX} className="flex items-center gap-1" data-testid="pcv-contact-add">
          <Plus className="w-4 h-4" />
          {te('coverageContactAdd')}
        </Button>
      </div>
      {/* lex C10 — dever de informar no ponto da coleta. */}
      <Text size="xs" color="muted" data-testid="pcv-contacts-notice">{te('coverageContactNotice')}</Text>

      {value.length === 0 && <Text size="sm" color="muted" data-testid="pcv-contacts-empty">{te('coverageContactEmpty')}</Text>}

      {value.map((c, i) => {
        const { name: nameBad, phone: phoneBad } = contactFieldErrors(c);
        return (
          // lex C2.1: nome de profissional é texto — a linha inteira leva a máscara do Clarity (molde EquipeTratanteCard).
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)_auto] gap-2 items-start" data-clarity-mask="True" data-testid={`pcv-contact-${i}`}>
            <Select
              id={`pcv-contact-kind-${i}`}
              inputSize="compact"
              value={c.kind}
              onValueChange={(v) => update(i, { kind: v as CoverageEmergencyContactKind })}
              options={kindOptions}
              disabled={disabled}
              data-testid={`pcv-contact-kind-${i}`}
            />
            <div>
              <InputWithIcon
                id={`pcv-contact-name-${i}`}
                inputSize="compact"
                value={c.name}
                placeholder={te('coverageContactName')}
                maxLength={COVERAGE_EMERGENCY_CONTACT_NAME_MAX}
                onChange={(e) => update(i, { name: e.target.value })}
                disabled={disabled}
                aria-invalid={nameBad}
                data-testid={`pcv-contact-name-${i}`}
              />
            </div>
            <div>
              <InputWithIcon
                id={`pcv-contact-phone-${i}`}
                inputSize="compact"
                type="tel"
                value={c.phone}
                placeholder={te('coverageContactPhone')}
                maxLength={COVERAGE_EMERGENCY_CONTACT_PHONE_MAX}
                onChange={(e) => update(i, { phone: e.target.value })}
                disabled={disabled}
                aria-invalid={phoneBad}
                data-testid={`pcv-contact-phone-${i}`}
              />
            </div>
            <button type="button" onClick={() => remove(i)} disabled={disabled} aria-label={te('coverageContactRemove')} className="p-2 rounded text-slate-400 hover:text-red-600 disabled:opacity-50" data-testid={`pcv-contact-remove-${i}`}>
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
