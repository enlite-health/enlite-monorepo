import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Clock } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import type { PatientKanbanItem } from '@domain/entities/PatientDetail';

interface Props {
  patient: PatientKanbanItem;
}

/**
 * Lightweight card for the patient kanban. Intentionally minimal — name + case
 * number + dependency only, no sensitive clinical data on the board (privacy).
 * Reuses the visual language of KanbanCard without its worker-funnel props.
 */
export function PatientKanbanCard({ patient }: Props): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const fullName = [patient.firstName, patient.lastName].filter(Boolean).join(' ').trim()
    || t('admin.patients.kanban.noName', { defaultValue: 'Sin nombre' });
  const dependencyLabel = patient.dependencyLevel
    ? t(`admin.patients.dependencyOptions.${patient.dependencyLevel}`, { defaultValue: patient.dependencyLevel })
    : null;
  // Lead do formulário público: sem nome, todo card diz "Solicitante" e o board
  // vira N caixas idênticas. O contato mascarado é o que desempata — só existe
  // quando o servidor decidiu que existe (lex C2); aqui não há regra nenhuma.
  const leadContact = patient.leadContactEmailMasked ?? null;

  return (
    <div
      data-testid={`patient-kanban-card-${patient.id}`}
      className="bg-white rounded-xl border border-slate-200 p-3 shadow-sm hover:shadow-md transition-shadow cursor-grab active:cursor-grabbing"
    >
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          className="text-left truncate"
          onClick={(e) => { e.stopPropagation(); navigate(`/admin/patients/${patient.id}`); }}
          data-testid={`patient-kanban-card-${patient.id}-open`}
        >
          <Text as="span" size="sm" weight="semibold" className="text-[#180149] truncate hover:underline">
            {fullName}
          </Text>
        </button>
        {patient.caseNumber != null && (
          <span className="shrink-0 inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-50 text-purple-700">
            {t('admin.patients.kanban.caseNumber', { defaultValue: 'Caso' })} #{patient.caseNumber}
          </span>
        )}
      </div>
      {leadContact && (
        // `data-clarity-mask` — o Clarity grava as sessões do painel e o modo do
        // portal não é verificável aqui; a máscara do DOM é a garantia local
        // (lex 30/08, C3). Mesmo padrão de ClinicalLongText.tsx:34.
        <div className="mt-1" data-clarity-mask="True">
          <span
            data-testid={`patient-kanban-card-${patient.id}-contact`}
            className="block truncate text-[11px] text-slate-500"
            title={leadContact}
          >
            {leadContact}
          </span>
          {patient.leadContactIsResponsible && (
            // Sem esta marca o card atribuiria contato de um FAMILIAR ao
            // paciente — dado inexato sobre dois titulares (lex C6).
            <span
              data-testid={`patient-kanban-card-${patient.id}-contact-responsible`}
              className="mt-0.5 inline-block rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
            >
              {t('admin.patients.kanban.contactOfResponsible', { defaultValue: 'Contacto del responsable' })}
            </span>
          )}
        </div>
      )}
      {dependencyLabel && (
        <span className="inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-600">
          {dependencyLabel}
        </span>
      )}
      {patient.hoursInStage != null && (
        <div className="mt-1.5">
          <span
            data-testid={`sla-badge-${patient.id}`}
            data-breached={patient.slaBreached ? 'true' : 'false'}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
              patient.slaBreached
                ? 'bg-red-100 text-red-700 border border-red-300'
                : 'bg-slate-100 text-slate-600'
            }`}
          >
            <Clock className="w-3 h-3" />
            {patient.slaBreached
              ? t('admin.patients.sla.breached', {
                  hours: patient.hoursInStage,
                  defaultValue: '⚠ SLA · {{hours}}h',
                })
              : t('admin.patients.sla.inStage', {
                  hours: patient.hoursInStage,
                  defaultValue: 'detenido hace {{hours}}h',
                })}
          </span>
        </div>
      )}
    </div>
  );
}
