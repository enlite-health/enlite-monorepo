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

  const fullName = [patient.firstName, patient.lastName].filter(Boolean).join(' ').trim();
  // D249: no lead "para otra persona" quem se identifica é o RESPONSÁVEL, e o
  // paciente nasce sem nome. O traço é literal — diz "ainda não sabemos", que é
  // diferente de um nome fabricado a partir de quem ligou por ele.
  const responsibleName = patient.responsibleName ?? null;
  const semNome = t('admin.patients.kanban.noName', { defaultValue: '—' });
  // Lead do formulário público: sem nome, todo card diz "Solicitante" e o board
  // vira N caixas idênticas. O contato mascarado é o que desempata — só existe
  // quando o servidor decidiu que existe (lex C2); aqui não há regra nenhuma.
  const leadContact = patient.leadContactEmailMasked ?? null;
  // A COLUNA já se chama "Solicitante": repetir a palavra em negrito escuro em
  // cada card é ruído, e empurrava para cinza de 11px justamente a única coisa
  // que distingue um card do outro. Quando há contato, ele É a identidade.
  // Ordem de identidade, e a ordem importa:
  //  1. o contato mascarado, quando o SERVIDOR o mandou. Ele só vem para ficha
  //     com o placeholder da era pré-D249 (`isLeadPlaceholderName`), e nessas o
  //     `firstName` é literalmente "Solicitante" — tratar isso como "tem nome"
  //     apagaria o desempate das 13 fichas que já estão em produção;
  //  2. o nome do paciente;
  //  3. o traço + "Responsável: X" — o lead novo "para otra persona";
  //  4. o traço sozinho, que é o fim da linha.
  const mostraContatoNoTitulo = Boolean(leadContact);
  // `fullName` já é string (o join sempre retorna uma) — um `?? null` aqui seria
  // ramo morto, verde por nunca ser alcançado.
  const tituloFinal = leadContact ?? (fullName || semNome);
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
          data-clarity-mask={mostraContatoNoTitulo ? 'True' : undefined}
        >
          {/* O `Text` não repassa props extras, então testid e title vivem no
              span — não vale mexer num átomo compartilhado por isto. */}
          {/* Sem `title`: o Clarity declara mascarar o CONTEÚDO do nó e dos
              filhos, não os atributos (lex C9, 31/08). O atributo era redundante
              — o mesmo texto já é o visível. Enquanto o gate A2 (transferência
              AR→EUA) estiver aberto, contato que não precisa ir ao Clarity não vai. */}
          <span data-testid={mostraContatoNoTitulo ? `patient-kanban-card-${patient.id}-contact` : undefined}>
            <Text as="span" size="sm" weight="semibold" className="text-[#180149] truncate hover:underline">
              {tituloFinal}
            </Text>
          </span>
        </button>
        {patient.caseNumber != null && (
          <span className="shrink-0 inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-50 text-purple-700">
            {t('admin.patients.kanban.caseNumber', { defaultValue: 'Caso' })} #{patient.caseNumber}
          </span>
        )}
      </div>
      {!mostraContatoNoTitulo && !fullName && responsibleName && (
        // O nome de quem responde pelo paciente, no lugar em que o e-mail
        // aparecia. Sem isto o card diria só "—" e voltaria a ser indistinguível.
        <div
          data-testid={`patient-kanban-card-${patient.id}-responsible`}
          className="mt-0.5 truncate"
        >
          <Text as="span" size="xs" color="secondary">
            {t('admin.patients.kanban.responsible', { defaultValue: 'Responsable' })}: {responsibleName}
          </Text>
        </div>
      )}
      {mostraContatoNoTitulo && patient.leadContactIsResponsible && (
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
