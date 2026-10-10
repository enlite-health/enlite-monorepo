import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Siren, Loader2 } from 'lucide-react';
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

  const label = te(isMarked ? 'unmarkEmergencyContact' : 'markEmergencyContact');

  // UM botão-ícone (sirene) do MESMO tamanho nos dois estados — é um toggle: vazado = não marcado,
  // preenchido = marcado (`aria-pressed`). `isLoading` do Button trocaria o conteúdo por "Cargando…"
  // e alargaria o botão: o carregando é `disabled` + ícone girando + `aria-busy`, sem texto.
  return (
    <ActionButton
      resource="patient_family"
      action="update"
      variant={isMarked ? 'primary' : 'outline'}
      size="sm"
      onClick={toggle}
      disabled={busy}
      aria-busy={busy}
      aria-pressed={isMarked}
      title={label}
      aria-label={label}
      className={isMarked ? 'p-2 !border-2' : 'p-2'}
      data-testid={`emergency-mark-${kind}-${contactId}`}
    >
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Siren className="w-4 h-4" />}
    </ActionButton>
  );
}
