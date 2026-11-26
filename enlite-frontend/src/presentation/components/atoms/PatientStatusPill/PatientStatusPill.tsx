import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';

interface PatientStatusPillProps {
  /**
   * `patients.status` lido por join na resposta da vaga (estado-automatico-do-paciente, D3). `null`/ausente = o ator não lê o
   * container `patient` (a resposta traz `redacted.patient`) ou a vaga não tem paciente: mostra "—", nunca um rótulo inventado.
   */
  status: string | null | undefined;
  className?: string;
}

/** Reaproveita as chaves i18n das colunas do Kanban de pacientes (`admin.patients.kanban.columns.*`) — um vocabulário só. */
export function PatientStatusPill({ status, className = '' }: PatientStatusPillProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <span
      data-testid="patient-status-pill"
      data-patient-status={status ?? ''}
      className={`inline-flex items-center px-2 py-0.5 rounded-full bg-cyan-100 text-primary ${className}`}
    >
      <Text as="span" size="xs" weight="medium" color="inherit">
        {status ? t(`admin.patients.kanban.columns.${status}`, { defaultValue: status }) : '—'}
      </Text>
    </span>
  );
}
