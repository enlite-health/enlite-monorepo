import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Rocket, ExternalLink } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import type { PatientKanbanServiceSummary } from '@domain/entities/PatientDetail';

interface Props {
  patientId: string;
  services?: PatientKanbanServiceSummary[];
}

/** Ícone de ação do par (foguete/"ver vacante") — mesma classe nos dois ramos (G2, achado 6). */
const ICON_ACTION_CLASS =
  'text-primary hover:text-primary/70 transition-colors p-0.5 rounded focus:outline-none focus:ring-2 focus:ring-primary inline-flex items-center';

/**
 * Subcards do card do Kanban de pacientes (fase 8, DX-8.7): uma linha por serviço
 * contratado ATIVO, `nome · cobertas/contratadas · ícone`. Invariante 3 do "O que
 * implementa": este componente só MOSTRA — nenhum clique aqui dispara
 * `updatePatientStatus` nem `activateRecruitment` (DX-8.8). O foguete NAVEGA para a
 * ficha, onde a guarda de completude decide se a ativação é possível.
 */
export function PatientKanbanSubcards({ patientId, services }: Props): JSX.Element | null {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Regra do Gabriel (12/09, reusada da ficha — ServicosContratadosCard.tsx:74-78): o foguete de
  // ativar exige `patient_services:update` E `vacancy:update` JUNTAS. Mesmo hook, mesma decisão —
  // sem as duas células, sem foguete (G2, achado 1).
  const { allowed: podeEscreverServico } = useActionGate('patient_services', 'update');
  const { allowed: podeEscreverVaga } = useActionGate('vacancy', 'update');
  const podeAtivar = podeEscreverServico && podeEscreverVaga;

  if (!services?.length) return null;

  const unit = t('admin.patients.kanban.subcard.weeklyUnit');

  return (
    <div className="mt-2 pt-2 border-t border-gray-600 space-y-1">
      {services.map((service) => {
        const serviceLabel = t(
          `admin.patients.detail.contractedServicesCard.serviceTypes.${service.serviceCode}`,
          service.serviceCode,
        );
        const contracted = service.contratadas.weekly;
        const pairText = `${service.cobertas}/${contracted ?? '—'}`;
        const pairAria = t('admin.patients.kanban.subcard.pairAria', {
          covered: service.cobertas,
          contracted: contracted ?? '—',
        });

        return (
          <div
            key={service.contractedServiceId}
            data-testid="patient-kanban-subcard"
            data-service-id={service.contractedServiceId}
            className="flex items-center justify-between gap-2 min-w-0"
            role="group"
            title={pairAria}
            aria-label={pairAria}
          >
            <Text as="span" size="xs" color="secondary" className="flex-1 min-w-0 truncate">
              {serviceLabel}
            </Text>
            <div className="flex items-center gap-1 shrink-0">
              <Text
                as="span"
                size="xs"
                weight="semibold"
                color="primary"
                data-testid="patient-kanban-subcard-pair"
              >
                {pairText}
              </Text>
              <Text as="span" size="xs" color="muted">
                {unit}
              </Text>
              {service.liveVacancyId ? (
                <a
                  href={`/admin/vacancies/${service.liveVacancyId}`}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={t('admin.patients.detail.contractedServicesCard.viewVacancyAria', {
                    service: serviceLabel,
                  })}
                  data-testid="patient-kanban-subcard-vacancy"
                  className={ICON_ACTION_CLASS}
                >
                  <ExternalLink className="w-3.5 h-3.5" strokeWidth={2} />
                </a>
              ) : (
                podeAtivar && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/admin/patients/${patientId}`);
                    }}
                    aria-label={t('admin.patients.kanban.subcard.openToActivate', { service: serviceLabel })}
                    data-testid="patient-kanban-subcard-rocket"
                    className={ICON_ACTION_CLASS}
                  >
                    <Rocket className="w-3.5 h-3.5" strokeWidth={2} />
                  </button>
                )
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
