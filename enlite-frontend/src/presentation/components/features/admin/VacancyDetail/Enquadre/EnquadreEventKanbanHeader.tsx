/**
 * EnquadreEventKanbanHeader — cabeçalho do kanban do evento (spec 052): "← Eventos", título (data · início–fim ·
 * entrevistador), "Abrir Meet" (só evento aberto e que ainda não terminou), e as ações do operador — "Gestionar
 * convocados", "Cancelar evento", "Encerrar evento". Em evento `closed`/`cancelled` nenhuma das três existe.
 * "Encerrar" só habilita em `pending_close`; fora disso o MOTIVO fica escrito na tela (não só em `title`, que não
 * aparece em print nem no toque) e ligado ao botão por `aria-describedby`.
 */
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Video } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import type { EnquadreEventDetail } from '@domain/entities/EnquadreEvent';
import { SealChip } from '../../PatientDetail/admission/AdmissionSeals';
import { isFuture } from '../../PatientDetail/admission/admissionTime';
import { dateAndTime } from './enquadreEventTime';
import { ENQUADRE_PHASE_KEY, ENQUADRE_PHASE_OPEN, ENQUADRE_PHASE_TONE } from './enquadreEventPhase';

interface Props {
  event: EnquadreEventDetail;
  timeZone: string;
  now: Date;
  onBack: () => void;
  onManageConvoked: () => void;
  onCancel: () => void;
  onClose: () => void;
}

export function EnquadreEventKanbanHeader({ event: e, timeZone, now, onBack, onManageConvoked, onCancel, onClose }: Props): JSX.Element {
  const { t } = useTranslation();
  const te = (key: string, opts?: Record<string, unknown>): string => t(`admin.vacancyDetail.enquadre.${key}`, opts);
  const open = ENQUADRE_PHASE_OPEN[e.phase];
  const [date, start] = dateAndTime(e.startsAt, timeZone);
  const [, end] = dateAndTime(e.endsAt, timeZone);
  const showMeet = open && isFuture(e.endsAt, now) && Boolean(e.meetLink);
  const closeBlocked = e.phase !== 'pending_close';
  const blockedId = `enquadre-kanban-close-blocked-${e.id}`;

  return (
    <div className="flex flex-col gap-3" data-testid="enquadre-kanban-header" data-phase={e.phase}>
      <div>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 text-primary underline"
          data-testid="enquadre-kanban-back"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          <Text as="span" size="sm" weight="medium" color="inherit">{te('kanban.back')}</Text>
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 min-w-0">
          <Heading level={2} weight="semibold" color="secondary" data-testid="enquadre-kanban-title" data-clarity-mask="True">
            {te('kanban.title', { date, start, end })} · {e.hostName}
          </Heading>
          <SealChip tone={ENQUADRE_PHASE_TONE[e.phase]} testId="enquadre-kanban-phase">{te(ENQUADRE_PHASE_KEY[e.phase])}</SealChip>
          {showMeet && (
            <a
              href={e.meetLink ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary underline"
              data-testid="enquadre-kanban-meet"
            >
              <Video size={14} aria-hidden="true" />
              <Text as="span" size="xs" weight="medium" color="inherit">{te('kanban.openMeet')}</Text>
            </a>
          )}
        </div>
        {open && (
          <div className="flex flex-wrap items-center gap-2" data-testid="enquadre-kanban-actions">
            <ActionButton resource="enquadre_event" action="update" variant="outline" size="sm" onClick={onManageConvoked} data-testid="enquadre-kanban-manage">{te('convoked.manage')}</ActionButton>
            <ActionButton resource="enquadre_event" action="update" variant="outline" size="sm" onClick={onCancel} data-testid="enquadre-kanban-cancel">{te('cancel.button')}</ActionButton>
            <ActionButton
              resource="enquadre_result"
              action="update"
              variant="primary"
              size="sm"
              onClick={onClose}
              disabled={closeBlocked}
              data-disabled={closeBlocked ? 'true' : 'false'}
              title={closeBlocked ? te('kanban.closeBlocked') : undefined}
              aria-describedby={closeBlocked ? blockedId : undefined}
              data-testid="enquadre-kanban-close"
            >
              {te('kanban.close')}
            </ActionButton>
          </div>
        )}
      </div>
      {open && closeBlocked && (
        <Text color="inherit" as="p" size="xs" className="text-slate-600 text-right" id={blockedId} data-testid="enquadre-kanban-close-blocked">
          {te('kanban.closeBlocked')}
        </Text>
      )}
      {!open && (
        <Text color="inherit" as="p" size="sm" className="italic text-slate-600" data-testid="enquadre-kanban-readonly">{te('kanban.readOnly')}</Text>
      )}
    </div>
  );
}
