/**
 * EnquadreTab — aba "Enquadre" do detalhe da vaga (spec 052): o cabeçalho (criar evento + contador de completados sem
 * evento), os estados carregando/erro/vazio e a tabela de eventos. Molde: AdmissionTab (mesma anatomia).
 *
 * "Crear evento" é `ActionButton` (`enquadre_event:create`). `createOpen` monta o drawer; o clique
 * na linha guarda `selectedEventId` e a aba troca a lista pelo kanban do evento ("← Eventos" volta e recarrega).
 */
import { useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarPlus, Loader2 } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import { useEnquadreEvents } from '@hooks/admin/useEnquadreEvents';
import { useEnquadreAvailableWorkers } from '@hooks/admin/useEnquadreAvailableWorkers';
import { timeZoneForCountry } from '../../PatientDetail/admission/admissionTime';
import { CreateEnquadreEventDrawer } from './CreateEnquadreEventDrawer';
import { EnquadreEventKanban } from './EnquadreEventKanban';
import { EnquadreEventsTable } from './EnquadreEventsTable';

interface Props {
  vacancyId: string;
  /** Relógio injetável (teste e harness). */
  now?: () => Date;
}

export function EnquadreTab({ vacancyId, now = () => new Date() }: Props): JSX.Element {
  const { t } = useTranslation();
  const te = (key: string, opts?: Record<string, unknown>): string => t(`admin.vacancyDetail.enquadre.${key}`, opts);
  const { events, status, reload } = useEnquadreEvents(vacancyId);
  const available = useEnquadreAvailableWorkers(vacancyId);
  // O operador é argentino: sem país da vaga aqui, o fuso é o de Buenos Aires (mesmo default da aba Admissão).
  const timeZone = timeZoneForCountry(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  const backToList = (): void => {
    setSelectedEventId(null);
    void reload();
    void available.reload();
  };

  if (selectedEventId) {
    return (
      <div className="flex flex-col gap-4" data-testid="enquadre-tab" data-selected-event={selectedEventId}>
        <EnquadreEventKanban vacancyId={vacancyId} eventId={selectedEventId} now={now} onBack={backToList} />
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-4"
      data-testid="enquadre-tab"
      data-create-open={createOpen}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <Heading level={2} weight="semibold" color="secondary">{te('title')}</Heading>
          {available.status === 'ok' && (
            <Text color="inherit" as="span" size="sm" className="text-slate-600" data-testid="enquadre-unassigned-count" data-count={available.count}>
              {te('unassignedCount', { count: available.count })}
            </Text>
          )}
        </div>
        <ActionButton resource="enquadre_event" action="create" variant="primary" size="sm" onClick={() => setCreateOpen(true)} data-testid="enquadre-create-button">
          <CalendarPlus className="w-4 h-4 mr-2" aria-hidden="true" />
          {te('newButton')}
        </ActionButton>
      </div>

      {status === 'loading' && (
        <div className="flex items-center gap-2 text-slate-600 text-sm" data-testid="enquadre-loading">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          {te('loading')}
        </div>
      )}
      {status === 'error' && (
        <Text color="inherit" as="p" size="sm" role="alert" className="text-red-800" data-testid="enquadre-load-error">{te('loadError')}</Text>
      )}
      {status === 'ok' && events.length === 0 && (
        <div className="flex flex-col items-start gap-3" data-testid="enquadre-empty">
          <Text color="inherit" as="p" size="sm" className="italic text-slate-600">{te('empty')}</Text>
          <ActionButton resource="enquadre_event" action="create" variant="outline" size="sm" onClick={() => setCreateOpen(true)} data-testid="enquadre-empty-create-button">
            {te('newButton')}
          </ActionButton>
        </div>
      )}
      {status === 'ok' && events.length > 0 && (
        <EnquadreEventsTable events={events} timeZone={timeZone} now={now()} onSelect={setSelectedEventId} />
      )}

      {createOpen && (
        <CreateEnquadreEventDrawer
          vacancyId={vacancyId}
          workers={available.workers}
          workersStatus={available.status}
          now={now}
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); void reload(); void available.reload(); }}
          onStaleData={() => { void available.reload(); }}
        />
      )}
    </div>
  );
}
