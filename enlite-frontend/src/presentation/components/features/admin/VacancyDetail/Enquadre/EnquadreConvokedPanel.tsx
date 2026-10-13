/**
 * EnquadreConvokedPanel — "Gestionar convocados" de um evento ABERTO (spec 052, E16-E17): os convocados atuais, cada um
 * com "Quitar" (confirmação), e os completados disponíveis para acrescentar (o mesmo `EnquadreWorkerPicker` do drawer
 * de criar: prestador sem e-mail válido fica desabilitado com o motivo). Depois de qualquer mudança recarrega o evento
 * (`onChanged`) e a lista de disponíveis. Quem decide que o evento está aberto é o chamador (o botão nem existe fora disso).
 */
import { useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { ActionButton } from '@presentation/components/features/access';
import { SlideOverPanel } from '@presentation/components/molecules/SlideOverPanel/SlideOverPanel';
import { useEnquadreAvailableWorkers } from '@hooks/admin/useEnquadreAvailableWorkers';
import { AdminEnquadreApiService } from '@infrastructure/http/AdminEnquadreApiService';
import type { EnquadreEventDetail, EnquadreParticipant } from '@domain/entities/EnquadreEvent';
import { AdmissionConfirmDialog } from '../../PatientDetail/admission/AdmissionConfirmDialog';
import { EnquadreWorkerPicker } from './EnquadreWorkerPicker';
import { enquadreErrorKey, isEnquadreStateConflict } from './enquadreErrors';

const E = 'admin.vacancyDetail.enquadre';

interface Props {
  vacancyId: string;
  event: EnquadreEventDetail;
  onChanged: () => Promise<void>;
  onClose: () => void;
}

export function EnquadreConvokedPanel({ vacancyId, event, onChanged, onClose }: Props): JSX.Element {
  const { t } = useTranslation();
  const te = (key: string, opts?: Record<string, unknown>): string => t(`admin.vacancyDetail.enquadre.${key}`, opts);
  const available = useEnquadreAvailableWorkers(vacancyId);
  const [selected, setSelected] = useState<string[]>([]);
  const [pendingRemove, setPendingRemove] = useState<EnquadreParticipant | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    await Promise.all([onChanged(), available.reload()]);
  }

  async function add(): Promise<void> {
    if (selected.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await AdminEnquadreApiService.addParticipants(vacancyId, event.id, selected);
      setSelected([]);
      await refresh();
    } catch (err) {
      setError(t(enquadreErrorKey(err, `${E}.convoked.addError`)));
      if (isEnquadreStateConflict(err)) await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!pendingRemove) return;
    setBusy(true);
    setError(null);
    try {
      await AdminEnquadreApiService.removeParticipant(vacancyId, event.id, pendingRemove.id);
      setPendingRemove(null);
      await refresh();
    } catch (err) {
      setError(t(enquadreErrorKey(err, `${E}.convoked.removeError`)));
      setPendingRemove(null);
      if (isEnquadreStateConflict(err)) await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SlideOverPanel
        isOpen
        modal
        onClose={() => { if (!busy) onClose(); }}
        ariaLabel={te('convoked.title')}
        widthClassName="max-w-lg"
        testId="enquadre-convoked-panel"
        closeAriaLabel={te('create.close')}
      >
        <div className="px-6 pt-6 pb-4 border-b border-gray-600 shrink-0">
          <Heading level={2} weight="semibold" color="primary">{te('convoked.title')}</Heading>
        </div>

        <div className="px-6 py-5 flex flex-col gap-6 overflow-y-auto flex-1">
          <section className="flex flex-col gap-2" data-testid="enquadre-convoked-current" data-count={event.participants.length}>
            <Text as="span" size="2xs" color="primary" className="uppercase">{te('convoked.current')} ({event.participants.length})</Text>
            {event.participants.length === 0 && <Text size="sm" color="secondary" data-testid="enquadre-convoked-current-empty">{te('convoked.currentEmpty')}</Text>}
            {event.participants.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-gray-600 bg-white" data-testid={`enquadre-convoked-item-${p.id}`}>
                <Text as="span" size="sm" weight="medium" color="inherit" className="truncate text-gray-900" data-clarity-mask="True">{p.workerName}</Text>
                <ActionButton resource="enquadre_event" action="update" variant="outline" size="xs" disabled={busy} onClick={() => { setError(null); setPendingRemove(p); }} data-testid={`enquadre-convoked-remove-${p.id}`}>
                  {te('convoked.remove')}
                </ActionButton>
              </div>
            ))}
          </section>

          <section className="flex flex-col gap-2" data-testid="enquadre-convoked-available" data-count={available.workers.length}>
            <Text as="span" size="2xs" color="primary" className="uppercase">{te('convoked.available')} ({available.workers.length})</Text>
            {available.status === 'loading' && <Text size="sm" color="secondary" data-testid="enquadre-convoked-available-loading">{te('create.workersLoading')}</Text>}
            {available.status === 'error' && <Text color="inherit" size="sm" role="alert" className="text-red-800" data-testid="enquadre-convoked-available-error">{te('create.workersError')}</Text>}
            {available.status === 'ok' && available.workers.length === 0 && (
              <Text size="sm" color="secondary" data-testid="enquadre-convoked-none-available">{te('convoked.noneAvailable')}</Text>
            )}
            {available.status === 'ok' && available.workers.length > 0 && (
              <EnquadreWorkerPicker
                options={available.workers}
                selected={selected}
                onChange={setSelected}
                noEmailReason={te('create.noEmail')}
                disabled={busy}
                testIdPrefix="enquadre-convoked-worker"
              />
            )}
          </section>

          {error && <Text color="inherit" size="sm" role="alert" className="text-red-800" data-testid="enquadre-convoked-error">{error}</Text>}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-600 shrink-0">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy} data-testid="enquadre-convoked-close">{te('create.close')}</Button>
          <ActionButton resource="enquadre_event" action="update" variant="primary" size="sm" onClick={() => { void add(); }} disabled={busy || selected.length === 0} data-count={selected.length} data-testid="enquadre-convoked-add">
            {te('convoked.add', { count: selected.length })}
          </ActionButton>
        </div>
      </SlideOverPanel>

      {pendingRemove && (
        // O painel é z-50 e o diálogo z-40: o invólucro com z-index próprio cria um contexto de empilhamento acima do painel.
        <div className="relative z-[60]">
          <AdmissionConfirmDialog
            testId="enquadre-convoked-remove-dialog"
            title={te('convoked.removeConfirm.title', { name: pendingRemove.workerName })}
            body={te('convoked.removeConfirm.body')}
            confirmLabel={te('convoked.removeConfirm.confirm')}
            busyLabel={te('convoked.removeConfirm.busy')}
            busy={busy}
            error={error}
            onConfirm={() => { void remove(); }}
            onClose={() => setPendingRemove(null)}
          />
        </div>
      )}
    </>
  );
}
