/**
 * LinkExistingVacancyAction — botão "Vincular vaga existente" ao lado do foguete (spec 079, T033).
 * A visibilidade é decidida pelo card (a MESMA do foguete). Diferente do foguete, NUNCA fica
 * desabilitado por `missing`: o portão de elegibilidade é do preview/backend, dentro do modal.
 */
import { useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link2 } from 'lucide-react';
import { useToast } from '@presentation/hooks/useToast';
import { LinkExistingVacancyModal } from './LinkExistingVacancyModal';

interface Props {
  patientId: string;
  serviceId: string;
  serviceCode: string;
  /** Mesmo refresh que o foguete dispara depois do sucesso (refetch do detalhe). */
  onLinked: () => void;
}

export function LinkExistingVacancyAction({ patientId, serviceId, serviceCode, onLinked }: Props) {
  const { t } = useTranslation();
  const showToast = useToast();
  const [open, setOpen] = useState(false);
  const tc = (k: string, o?: Record<string, unknown>) => t(`admin.patients.detail.contractedServicesCard.linkExistingVacancy.${k}`, o);
  const serviceLabel = t(`admin.patients.detail.contractedServicesCard.serviceTypes.${serviceCode}`, serviceCode);

  const handleOpen = (e: MouseEvent): void => {
    e.stopPropagation();
    setOpen(true);
  };

  return (
    // O modal vive dentro da <tr> clicável: o wrapper impede que cliques nele (bolhas do React) abram o detalhe.
    <span onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={handleOpen}
        title={tc('button')}
        aria-label={tc('aria', { service: serviceLabel })}
        data-testid={`contracted-service-link-existing-vacancy-${serviceId}`}
        className="text-primary hover:text-primary/70 transition-colors p-1 rounded focus:outline-none focus:ring-2 focus:ring-primary"
      >
        <Link2 className="w-4 h-4" strokeWidth={2} />
      </button>
      <LinkExistingVacancyModal
        open={open}
        patientId={patientId}
        serviceId={serviceId}
        serviceLabel={serviceLabel}
        onClose={() => setOpen(false)}
        onLinked={() => {
          setOpen(false);
          showToast(tc('success'), 'success');
          onLinked();
        }}
      />
    </span>
  );
}
