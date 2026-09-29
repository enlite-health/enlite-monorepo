import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { Select } from '@presentation/components/atoms/Select';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import { Textarea } from '@presentation/components/atoms/Textarea';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@presentation/components/atoms/Table';
import { useServiceTeamContact } from '@hooks/admin/useServiceTeamContact';
import { workerLabel } from './workerLabel';
import type { ServiceTeamMember, ServiceTeamColumnId } from '@domain/entities/ServiceTeam';

interface ServiceTeamProviderModalProps {
  patientId: string;
  serviceId: string;
  member: ServiceTeamMember;
  columnId: ServiceTeamColumnId;
  onClose: () => void;
  /** "Estado" (decisão B do brief, rodada 2) delega para o MESMO mecanismo que os botões do card
   *  já usam (`ServiceTeamBoard.pending` → `RejectionReasonSelect`) — nenhuma ação nova, o modal
   *  fecha e o board abre o modal de motivo já existente. */
  onRequestReject: () => void;
  onRequestRevert: () => void;
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);

/**
 * `eventDate` é uma data PURA (YYYY-MM-DD, sem hora) — `new Date(isoDateOnly)` a interpreta como
 * meia-noite UTC, e `.toLocaleDateString('es-AR')` (UTC-3) rola pro dia ANTERIOR (medido:
 * '2026-09-29' virava "28/9/2026" no Historial). Formata pelos componentes da STRING, nunca por
 * `Date` — o mesmo problema que `formatDDMM` (substitutionDates.ts) já evita.
 */
function formatEventDate(dateIso: string): string {
  const [year, month, day] = dateIso.split('-');
  return `${day}/${month}/${year}`;
}

/**
 * Modal do prestador (Figma nó 11340:76413, rodada 2, decisão D): abre ao clicar no CARD (não nos
 * botões) de qualquer coluna do quadro C. Nome/telefone vêm projetados pela API
 * (`worker_contact:read` — o mesmo portão que já protege o nome no board; `phone: null` sem a
 * célula, nunca erro). "Contacto efectuado"/"Fecha"/"Notas" + "Guardar" gravam em
 * `service_team_contact_log` (migration 488) — cada "Guardar" é uma linha NOVA no "Historial".
 * "Estado" só oferece Rechazar/Revertir (as ações que já existem) — nenhuma porta lateral pras 3
 * colunas calculadas (D432).
 */
export function ServiceTeamProviderModal({
  patientId, serviceId, member, columnId, onClose, onRequestReject, onRequestRevert,
}: ServiceTeamProviderModalProps): JSX.Element {
  const { t } = useTranslation();
  const tm = (key: string, options?: Record<string, unknown>) => t(`admin.patients.detail.serviceTeamModal.${key}`, options);
  const { contact, status, register, saving, saveError } = useServiceTeamContact(patientId, serviceId, member.workerId);

  const [contacted, setContacted] = useState<'YES' | 'NO'>('NO');
  const [eventDate, setEventDate] = useState(todayIso());
  const [note, setNote] = useState('');

  const name = contact?.displayName ?? workerLabel(t, member.workerId, member.displayName);
  const waHref = contact?.phone ? `https://wa.me/${contact.phone.replace(/\D/g, '')}` : null;

  function handleSave(): void {
    void register({ contacted: contacted === 'YES', eventDate, note: note.trim() || null }).then(() => setNote(''));
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" data-testid="service-team-provider-modal">
      <div className="bg-white rounded-2xl p-6 w-full max-w-lg shadow-xl flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <Heading level={3} className="text-primary" data-testid="service-team-provider-modal-name">{name}</Heading>
          <button type="button" onClick={onClose} aria-label={tm('close')} data-testid="service-team-provider-modal-close" className="text-gray-800 hover:text-primary">✕</button>
        </div>

        {waHref && (
          <a href={waHref} target="_blank" rel="noreferrer" className="text-primary text-sm" data-testid="service-team-provider-modal-phone">
            {contact?.phone}
          </a>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-0.5">
            <Text size="xs" color="secondary">{tm('providerField')}</Text>
            <Text size="sm" weight="medium" data-testid="service-team-provider-modal-provider-field">{name}</Text>
          </div>
          <div className="flex flex-col gap-1">
            <Text size="xs" color="secondary">{tm('contactedLabel')}</Text>
            <Select
              data-testid="service-team-provider-modal-contacted"
              value={contacted}
              onValueChange={(v) => setContacted(v as 'YES' | 'NO')}
              options={[
                { value: 'YES', label: tm('contactedYes') },
                { value: 'NO', label: tm('contactedNo') },
              ]}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Text size="xs" color="secondary">{tm('statusLabel')}</Text>
          <Text size="sm" data-testid="service-team-provider-modal-column">{t(`admin.patients.detail.serviceTeam.columns.${columnId}`)}</Text>
          {columnId === 'SELECTED_FOR_SERVICE' && (
            <Button variant="outline" size="sm" onClick={onRequestReject} data-testid="service-team-provider-modal-reject">
              {t('admin.patients.detail.serviceTeam.rejectButton')}
            </Button>
          )}
          {columnId === 'REJECTED_FOR_SERVICE' && (
            <Button variant="outline" size="sm" onClick={onRequestRevert} data-testid="service-team-provider-modal-revert">
              {t('admin.patients.detail.serviceTeam.revertButton')}
            </Button>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <Text size="xs" color="secondary">{tm('eventDateLabel')}</Text>
          <InputWithIcon type="date" inputSize="compact" value={eventDate} onChange={(e) => setEventDate(e.target.value)} data-testid="service-team-provider-modal-event-date" />
        </div>

        <div className="flex flex-col gap-1">
          <Text size="xs" color="secondary">{tm('noteLabel')}</Text>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={tm('notePlaceholder')}
            data-testid="service-team-provider-modal-note"
          />
        </div>

        {saveError && (
          <Text size="sm" role="alert" className="text-red-600" data-testid="service-team-provider-modal-save-error">
            {tm('saveError')}
          </Text>
        )}

        <Button variant="primary" size="sm" onClick={handleSave} disabled={saving} data-testid="service-team-provider-modal-save">
          {tm('save')}
        </Button>

        <div className="border-t border-gray-600 pt-3">
          <Heading level={4} as="h5" weight="semibold" className="mb-2">{tm('historyTitle')}</Heading>
          {status === 'loading' && <Text size="sm" color="secondary">{tm('loading')}</Text>}
          {status === 'error' && <Text size="sm" role="alert" className="text-red-600">{tm('loadError')}</Text>}
          {status === 'ok' && (contact?.history.length ?? 0) === 0 && (
            <Text size="sm" color="secondary" data-testid="service-team-provider-modal-history-empty">{tm('historyEmpty')}</Text>
          )}
          {status === 'ok' && (contact?.history.length ?? 0) > 0 && (
            <Table>
              <TableHeader>
                <TableHead>{tm('historyDate')}</TableHead>
                <TableHead>{tm('historyNote')}</TableHead>
                <TableHead>{tm('historyResponse')}</TableHead>
              </TableHeader>
              <TableBody>
                {contact!.history.map((entry) => (
                  <TableRow key={entry.id} data-testid={`service-team-provider-modal-history-row-${entry.id}`}>
                    <TableCell>{formatEventDate(entry.eventDate)}</TableCell>
                    <TableCell>{entry.note ?? '—'}</TableCell>
                    <TableCell>{entry.contacted ? tm('contactedYes') : tm('contactedNo')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </div>
  );
}
