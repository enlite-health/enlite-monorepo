import { useState, type MouseEvent } from 'react';
import { Rocket } from 'lucide-react';
import { ActionButton } from '@presentation/components/features/access';
import { useCanActivateRecruitment } from '@presentation/hooks/useCellAccess';
import { useToast } from '@presentation/hooks/useToast';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import { runActivateRecruitmentClick } from './activateRecruitmentClick';
import { LinkExistingVacancyModal } from './LinkExistingVacancyModal';

export function ActivateRecruitmentAction({
  patientId,
  service,
  missing,
  onActivated,
  t,
}: {
  patientId: string;
  service: PatientContractedServiceDetail;
  missing: string[];
  onActivated: () => void;
  t: (k: string, o?: any) => string;
}) {
  const showToast = useToast();
  const [busy, setBusy] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const tc = (k: string, o?: Record<string, unknown>) => t(`admin.patients.detail.contractedServicesCard.${k}`, o);
  const serviceLabel = t(`admin.patients.detail.contractedServicesCard.serviceTypes.${service.serviceCode}`, service.serviceCode);

  // Hook incondicional (regra do React) — o GATE em si só se aplica depois do ramo
  // "Ver vacante" abaixo, que não muda em relação à `stage`. Fonte única com o subcard do
  // Kanban de pacientes (PatientKanbanSubcards.tsx) — gate fecho N3.
  const podeAtivar = useCanActivateRecruitment();

  // Spec 047 (F3): o ícone "Ver vacante" saiu — o código da vacante (coluna) é o caminho. Com vaga viva não há o que
  // ativar; com `liveVacancyRedacted` o ator não lê vagas, então "tem vaga ou não" é desconhecido — nunca oferecer.
  if (service.liveVacancy || service.liveVacancyRedacted) return null;

  // Regra do Gabriel (12/09, PR-8b 15/09): a rota de ativação (POST .../activate-recruitment) exige
  // patient_services:update E vacancy:update JUNTAS (contracts/permissions-split.md — "ação sobre
  // recurso existente") — quem não tem as duas células não vê o BOTÃO de ativar. Só este ramo
  // (o "Ver vacante" acima já retornou e não passa por aqui).
  if (!podeAtivar) return null;

  const handleClick = async (e: MouseEvent): Promise<void> => {
    e.stopPropagation();
    await runActivateRecruitmentClick({
      patientId, serviceId: service.id, missing, busy, setBusy, onActivated, openLinkModal: () => setLinkOpen(true), tc, t, showToast,
    });
  };
  // "Criar vaga nova" no modal do vínculo: mesmo caminho do foguete, com o sinal explícito (o backend pula a guarda e audita).
  const handleCreateNew = async (): Promise<void> => {
    setLinkOpen(false);
    await runActivateRecruitmentClick({
      patientId, serviceId: service.id, missing, busy, setBusy, onActivated, openLinkModal: () => setLinkOpen(true), tc, t, showToast,
      createNewVacancy: true,
    });
  };

  return (
    <>
    <ActionButton
      resource="patient_services"
      action="update"
      variant="ghost"
      size="sm"
      onClick={handleClick}
      disabled={missing.length > 0 || busy}
      title={missing.length > 0 ? tc('activateRecruitmentTooltip', { items: missing.map((code) => t(`admin.patients.detail.completeness.items.${code}`, code)).join(', ') }) : undefined}
      aria-label={tc('activateRecruitmentAria', { service: serviceLabel })}
      data-testid={`contracted-service-activate-recruitment-${service.id}`}
      className="text-primary hover:text-primary/70 transition-colors p-1 rounded focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <Rocket className="w-4 h-4" strokeWidth={2} />
    </ActionButton>
    {/* O foguete achou vaga sem serviço do paciente: abre o MESMO modal do vínculo (spec 079). Dentro da <tr> clicável, o wrapper segura as bolhas. */}
    <span onClick={(e) => e.stopPropagation()}>
      <LinkExistingVacancyModal
        open={linkOpen}
        patientId={patientId}
        serviceId={service.id}
        serviceLabel={serviceLabel}
        notice={tc('linkExistingVacancy.rocketNotice')}
        rocket={{ onCreateNew: () => void handleCreateNew() }}
        onClose={() => setLinkOpen(false)}
        onLinked={() => {
          setLinkOpen(false);
          showToast(tc('linkExistingVacancy.success'), 'success');
          onActivated();
        }}
      />
    </span>
    </>
  );
}
