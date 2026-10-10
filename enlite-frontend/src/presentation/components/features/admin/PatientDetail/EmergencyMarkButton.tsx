import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Siren, X, Loader2 } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
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
  // `isLoading` do Button trocaria o conteúdo por "Cargando…" e o botão voltaria a ficar largo:
  // aqui o carregando é `disabled` + ícone girando + `aria-busy`, sem texto.
  const spinner = <Loader2 className={isMarked ? 'w-3 h-3 animate-spin' : 'w-4 h-4 animate-spin'} />;

  // Marcado: só o "✕" (ghost, discreto) — quem diz "Emergencia" é o marcador de leitura
  // (`EmergencyMarkedBadge`), que fica FORA do botão para quem só lê continuar vendo a marca.
  if (isMarked) {
    return (
      <ActionButton
        resource="patient_family"
        action="update"
        variant="ghost"
        size="xs"
        onClick={toggle}
        disabled={busy}
        aria-busy={busy}
        title={label}
        aria-label={label}
        className="!h-5 !w-5 !p-0 inline-flex items-center justify-center text-gray-500 hover:text-red-600"
        data-testid={`emergency-mark-${kind}-${contactId}`}
      >
        {busy ? spinner : <X className="w-3 h-3" />}
      </ActionButton>
    );
  }

  return (
    <ActionButton
      resource="patient_family"
      action="update"
      variant="outline"
      size="sm"
      onClick={toggle}
      disabled={busy}
      aria-busy={busy}
      title={label}
      aria-label={label}
      className="p-2"
      data-testid={`emergency-mark-${kind}-${contactId}`}
    >
      {busy ? spinner : <Siren className="w-4 h-4" />}
    </ActionButton>
  );
}

/**
 * Marcador de LEITURA "Emergencia" (informação, não ação): aparece para qualquer ator com
 * `patient_family:read`, mesmo sem `:update` — por isso vive separado do botão acima.
 */
export function EmergencyMarkedBadge({ label, testId }: { label: string; testId: string }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-red-600" data-testid={testId}>
      <Siren className="w-3.5 h-3.5" />
      <Text as="span" size="xs" weight="semibold" color="inherit">{label}</Text>
    </span>
  );
}
