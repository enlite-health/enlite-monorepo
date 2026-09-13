import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlert, ShieldOff } from 'lucide-react';
import { AdminPatientContactRowsApiService } from '@infrastructure/http/AdminPatientContactRowsApiService';
import { ActionButton } from '@presentation/components/features/access';
import type { EmergencyContactRef } from '@domain/entities/PatientDetail';

interface Props {
  patientId: string;
  kind: EmergencyContactRef['kind'];
  contactId: string;
  /** `true` = esta linha É a marca de emergência vigente do paciente. */
  isMarked: boolean;
  onChanged: () => void;
}

/**
 * Botão de marcar/desmarcar contato de emergência do paciente (spec 018, PR-2, US-8, D-A).
 * Vive em CADA linha de `FamiliaresCard`/`ExternalContactsCard` — a marca é do paciente, mas a
 * ação nasce na linha do responsável ou do contato externo (D286: sem `patient_family:write` o
 * botão SOME, `ActionButton` default `mode='hide'`).
 */
export function EmergencyMarkButton({ patientId, kind, contactId, isMarked, onChanged }: Props): JSX.Element {
  const { t } = useTranslation();
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);
  const [busy, setBusy] = useState(false);

  const toggle = async (): Promise<void> => {
    setBusy(true);
    try {
      if (isMarked) {
        await AdminPatientContactRowsApiService.unmarkEmergencyContact(patientId);
      } else {
        await AdminPatientContactRowsApiService.markEmergencyContact(patientId, { kind, id: contactId });
      }
      onChanged();
    } catch {
      // Falha (404/422/500) não finge sucesso: `onChanged()` não roda, a tela mantém o estado
      // anterior. O erro específico (ex.: EMERGENCY_CONTACT_REQUIRES_PHONE) vira alerta simples —
      // sem eco de payload (lex C1.3).
      window.alert(te('markEmergencyContactError'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ActionButton
      resource="patient_family"
      action="write"
      variant={isMarked ? 'primary' : 'outline'}
      size="sm"
      onClick={toggle}
      isLoading={busy}
      className="flex items-center gap-1"
      data-testid={`emergency-mark-${kind}-${contactId}`}
    >
      {isMarked ? <ShieldOff className="w-3.5 h-3.5" /> : <ShieldAlert className="w-3.5 h-3.5" />}
      {isMarked ? te('unmarkEmergencyContact') : te('markEmergencyContact')}
    </ActionButton>
  );
}
