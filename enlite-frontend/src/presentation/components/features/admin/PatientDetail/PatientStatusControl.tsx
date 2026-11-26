import { useTranslation } from 'react-i18next';
import type { PatientDetail } from '@domain/entities/PatientDetail';
import { Text } from '@presentation/components/atoms/Text';
import { buttonClasses } from '@presentation/components/atoms/Button/buttonClasses';
import { PatientStatusActions } from './PatientStatusActions';

interface Props {
  patient: PatientDetail;
  /** Chamado depois de uma ação aplicada, para a página reler (badge de estado + Historial). */
  onSaved: () => void;
}

/**
 * O estado clínico da ficha (spec 012, US-B7) — SÓ LEITURA desde a F5 de estado-automatico-do-paciente: o select livre saiu.
 * Mostra o estado atual e, ao lado, as AÇÕES dos estados humanos (`PatientStatusActions`: pausar, suspender, dar alta, dar baja,
 * retomar, reativar). Búsqueda, Reemplazo e Activo não são escolhidos por ninguém: quem os define é o fluxo automático (foguete e
 * itinerário). Só existe para quem já passou pela admissão; antes disso o caminho é o foguete do serviço contratado.
 */
export function PatientStatusControl({ patient, onSaved }: Props): JSX.Element | null {
  const { t } = useTranslation();
  if (patient.admissionStatus !== 'DONE') return null;

  const current = patient.status ?? 'ACTIVE';
  const label = String(t(`admin.patients.statusOptions.${current}`, current));
  const title = String(t('admin.patients.status.title'));

  return (
    <div className="flex flex-col gap-2 min-w-[240px]" data-testid="patient-status-control">
      <div className="flex items-center gap-2">
        {/* Mesma moldura `quiet`/`xs` dos botões da barra; não é botão nem select — nada aqui muda o estado. */}
        <Text
          as="span"
          size="sm"
          className={`whitespace-nowrap ${buttonClasses({ variant: 'quiet', size: 'xs' })} pointer-events-none`}
          data-testid="patient-status-current"
        >
          {title}: {label}
        </Text>
      </div>
      <PatientStatusActions patient={patient} onSaved={onSaved} />
    </div>
  );
}
