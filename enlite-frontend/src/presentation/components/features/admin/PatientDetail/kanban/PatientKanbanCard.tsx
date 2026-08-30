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
  // Lead do formulário público: sem nome, todo card diz "Solicitante" e o board
  // vira N caixas idênticas. O contato mascarado é o que desempata — só existe
  // quando o servidor decidiu que existe (lex C2); aqui não há regra nenhuma.
  const leadContact = patient.leadContactEmailMasked ?? null;
  // A COLUNA já se chama "Solicitante": repetir a palavra em negrito escuro em
  // cada card é ruído, e empurrava para cinza de 11px justamente a única coisa
  // que distingue um card do outro. Quando há contato, ele É a identidade.
  const title = leadContact ?? fullName;
  const dependencyLabel = patient.dependencyLevel
    ? t(`admin.patients.dependencyOptions.${patient.dependencyLevel}`, { defaultValue: patient.dependencyLevel })
    : null;

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
          // `data-clarity-mask` SÓ quando o título é o contato: o Clarity grava
          // as sessões do painel e o modo do portal não é verificável daqui, então
          // a máscara do DOM é a garantia local (lex 30/08, C3). Nome de paciente
          // já tem o seu próprio tratamento e não entra nesta regra.
          data-clarity-mask={leadContact ? 'True' : undefined}
        >
          {/* O `Text` não repassa props extras, então testid e title vivem no
              span — não vale mexer num átomo compartilhado por isto. */}
          <span
            data-testid={leadContact ? `patient-kanban-card-${patient.id}-contact` : undefined}
            title={leadContact ?? undefined}
          >
            <Text as="span" size="sm" weight="semibold" className="text-[#180149] truncate hover:underline">
              {title}
            </Text>
          </span>
        </button>
        {patient.caseNumber != null && (
          <span className="shrink-0 inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-50 text-purple-700">
            {t('admin.patients.kanban.caseNumber', { defaultValue: 'Caso' })} #{patient.caseNumber}
          </span>
        )}
      </div>
      {leadContact && patient.leadContactIsResponsible && (
        // Sem esta marca o card atribuiria contato de um FAMILIAR ao paciente —
        // dado inexato sobre dois titulares (lex C6). Agora que o contato É o
        // título, dizer de quem ele é passou a ser ainda mais necessário.
        <span
          data-testid={`patient-kanban-card-${patient.id}-contact-responsible`}
          className="mt-1 inline-block rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
        >
          {t('admin.patients.kanban.contactOfResponsible', { defaultValue: 'Contacto del responsable' })}
        </span>
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
