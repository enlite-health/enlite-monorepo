/**
 * EnquadreTab — aba "Enquadre" do detalhe da vaga (spec 052): o cabeçalho (criar evento + contador de completados sem
 * evento), os estados carregando/erro/vazio e a tabela de eventos. Molde: AdmissionTab (mesma anatomia).
 *
 * "Crear evento" é `ActionButton` (`enquadre_event:create`). `createOpen` monta o drawer. O evento aberto vive na URL
 * (`?event=`, spec 076): o clique na linha faz PUSH (o voltar do navegador desfaz a seleção) e a aba troca a lista pelo kanban
 * do evento ("← Eventos" apaga `event` com `replace` e recarrega). O kanban só monta com a lista da vaga carregada E o id
 * dentro dela: id inexistente ou de OUTRA vaga cai na lista (FR-16) e `getEvent` nunca é chamado para ele.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CalendarPlus, Loader2 } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import { useEnquadreEvents } from '@hooks/admin/useEnquadreEvents';
import { useEnquadreAvailableWorkers } from '@hooks/admin/useEnquadreAvailableWorkers';
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

  const [createOpen, setCreateOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const eventParam = searchParams.get('event');
  // Só vale o id que a lista DESTA vaga contém (nunca monta o kanban antes de conferir a lista).
  const selectedEventId = status === 'ok' && eventParam !== null && events.some((e) => e.id === eventParam) ? eventParam : null;

  const setEvent = (eventId: string | null, replace: boolean): void => {
    setSearchParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (eventId === null) n.delete('event');
        else n.set('event', eventId);
        return n;
      },
      { replace },
    );
  };

  // Lista carregada e o id não está nela (outra vaga, inexistente): apaga `event` e fica na lista.
  useEffect(() => {
    if (status === 'ok' && eventParam !== null && selectedEventId === null) setEvent(null, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, eventParam, selectedEventId]);

  // Abrir um evento (deep link ou clique na linha) alinha a aba no TOPO da tela: o kanban nasce abaixo da dobra do cabeçalho da
  // vaga. Medido (e2e, 1440x900): quem rola é o <main> do AdminLayout (não o window); o scroll disparado no clique corria ANTES
  // do kanban carregar (scrollHeight curto, rolou ~120px) e o conteúdo cresceu depois. Por isso o alinhamento espera o kanban
  // assentar (`onSettled`, 1× por abertura) e roda no próximo frame, com o layout já final; a `min-h-screen` do wrapper garante
  // altura abaixo para o topo da aba chegar ao topo mesmo com poucos cards. "← Eventos", coluna e re-render não rolam.
  // Molde: ThreadView (`prefers-reduced-motion` + `scrollIntoView?.` porque o jsdom não o tem).
  const tabRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true,
    [],
  );
  const alignTab = useCallback((): void => {
    requestAnimationFrame(() => {
      tabRef.current?.scrollIntoView?.({ block: 'start', behavior: prefersReducedMotion ? 'auto' : 'smooth' });
    });
  }, [prefersReducedMotion]);

  const backToList = (): void => {
    setEvent(null, true);
    void reload();
    void available.reload();
  };

  if (selectedEventId) {
    return (
      <div ref={tabRef} className="flex flex-col gap-4 min-h-screen" data-testid="enquadre-tab" data-selected-event={selectedEventId}>
        <EnquadreEventKanban vacancyId={vacancyId} eventId={selectedEventId} now={now} onBack={backToList} onSettled={alignTab} />
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
        <EnquadreEventsTable vacancyId={vacancyId} events={events} now={now()} onSelect={(id) => setEvent(id, false)} />
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
