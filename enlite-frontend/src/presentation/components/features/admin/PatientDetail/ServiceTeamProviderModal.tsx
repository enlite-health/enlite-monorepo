import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { Select } from '@presentation/components/atoms/Select';
import { Input } from '@presentation/components/atoms/Input';
import { inputWrapperClasses } from '@presentation/components/atoms/Input/inputClasses';
import { Textarea } from '@presentation/components/atoms/Textarea';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@presentation/components/atoms/Table';
import { RejectionReasonSelect } from '@presentation/components/features/admin/Kanban/RejectionReasonSelect';
import { useServiceTeamContact } from '@hooks/admin/useServiceTeamContact';
import { workerLabel } from './workerLabel';
import {
  SERVICE_TEAM_REJECT_REASONS,
  SERVICE_TEAM_REVERT_REASONS,
  type ServiceTeamMember,
  type ServiceTeamColumnId,
} from '@domain/entities/ServiceTeam';

interface ServiceTeamProviderModalProps {
  patientId: string;
  serviceId: string;
  member: ServiceTeamMember;
  columnId: ServiceTeamColumnId;
  onClose: () => void;
  /** Rodada 3: o modal aplica a ação ELE MESMO (ao Guardar) — mesmas funções que os botões do
   *  card já chamam (`ServiceTeamBoard.onReject`/`onRevert`), sem delegação/round-trip pelo board. */
  onReject: (workerId: string, reasonCategory: string) => void;
  onRevert: (workerId: string, reasonCategory: string) => void;
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);

/**
 * `eventDate` é uma data PURA (YYYY-MM-DD, sem hora) — `new Date(isoDateOnly)` a interpreta como
 * meia-noite UTC, e `.toLocaleDateString('es-AR')` (UTC-3) rola pro dia ANTERIOR (medido:
 * '2026-09-29' virava "28/9/2026" no Historial). Formata pelos componentes da STRING, nunca por
 * `Date` — o mesmo problema que `formatDDMM` (substitutionDates.ts) já evita. dd/mm/aaaa: o mesmo
 * texto serve o Historial e o campo "Fecha del evento" (Figma pede o locale es-AR, não o
 * mm/dd/yyyy nativo do <input type="date">).
 */
function formatEventDate(dateIso: string): string {
  const [year, month, day] = dateIso.split('-');
  return `${day}/${month}/${year}`;
}

type PendingAction = { kind: 'reject' | 'revert'; reasonCategory: string };

/**
 * Modal do prestador (Figma nó 11340:76413/76619, rodada 3): painel LATERAL ancorado à direita,
 * altura cheia, cantos arredondados só à esquerda (mesmo molde do `ContractedServiceDetailDrawer`)
 * — sem X, fecha por overlay/Esc. Nome/telefone vêm projetados pela API (`worker_contact:read`);
 * a linha do WhatsApp só existe quando `contact.phone` não é `null`.
 *
 * "Estado" é um SELECT com no máximo 2 opções (D446): o estado atual (sempre) e, quando a coluna
 * permite, a ação (Rechazar em Selecionado/En atención, Revertir em Rechazado — `IN_SERVICE` não
 * tem ação, o select fica com 1 opção só e desabilitado). Escolher a ação abre o MESMO
 * `RejectionReasonSelect` de sempre para capturar o motivo, mas a ação só é DISPARADA (`onReject`/
 * `onRevert`) ao clicar "Guardar" — selecionar e escolher motivo sozinho não chama a API nem move
 * o card. Guardar sempre grava o registro de contato (`service_team_contact_log`); só fecha o
 * painel quando havia uma ação pendente (o card muda de coluna e este `columnId` fica obsoleto).
 */
export function ServiceTeamProviderModal({
  patientId, serviceId, member, columnId, onClose, onReject, onRevert,
}: ServiceTeamProviderModalProps): JSX.Element {
  const { t } = useTranslation();
  const tm = (key: string, options?: Record<string, unknown>) => t(`admin.patients.detail.serviceTeamModal.${key}`, options);
  const tst = (key: string) => t(`admin.patients.detail.serviceTeam.${key}`);
  const { contact, status, register, saving, saveError } = useServiceTeamContact(patientId, serviceId, member.workerId);

  const [contacted, setContacted] = useState<'YES' | 'NO'>('NO');
  const [eventDate, setEventDate] = useState(todayIso());
  const [note, setNote] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [reasonPromptKind, setReasonPromptKind] = useState<'reject' | 'revert' | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const name = contact?.displayName ?? workerLabel(t, member.workerId, member.displayName);
  const waHref = contact?.phone ? `https://wa.me/${contact.phone.replace(/\D/g, '')}` : null;

  /** A ação permitida NESTA coluna (D446) — `null` em `IN_SERVICE`, que não tem porta lateral. */
  const actionKind: 'reject' | 'revert' | null =
    columnId === 'SELECTED_FOR_SERVICE' ? 'reject' : columnId === 'REJECTED_FOR_SERVICE' ? 'revert' : null;

  const estadoOptions = [
    { value: 'CURRENT', label: tst(`columns.${columnId}`) },
    ...(actionKind ? [{ value: actionKind.toUpperCase(), label: tst(`${actionKind}Button`) }] : []),
  ];
  const estadoValue = pendingAction ? pendingAction.kind.toUpperCase() : 'CURRENT';

  function handleEstadoChange(value: string): void {
    if (value === 'CURRENT') {
      setPendingAction(null);
      return;
    }
    if (actionKind) setReasonPromptKind(actionKind);
  }

  function handleReasonSubmit(category: string): void {
    if (reasonPromptKind) setPendingAction({ kind: reasonPromptKind, reasonCategory: category });
    setReasonPromptKind(null);
  }

  async function handleSave(): Promise<void> {
    const hadAction = pendingAction !== null;
    if (pendingAction) {
      if (pendingAction.kind === 'reject') onReject(member.workerId, pendingAction.reasonCategory);
      else onRevert(member.workerId, pendingAction.reasonCategory);
    }
    await register({ contacted: contacted === 'YES', eventDate, note: note.trim() || null });
    // A ação aplicada tira o membro DESTA coluna — `columnId` fica obsoleto, então fecha.
    // Sem ação, o painel fica aberto (o Historial acabou de ganhar uma linha nova).
    if (hadAction) onClose();
    else setNote('');
  }

  return (
    <>
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
        data-testid="service-team-provider-modal-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={name}
        className="fixed top-0 right-0 h-screen z-50 w-full max-w-xl bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col"
        data-testid="service-team-provider-modal"
      >
        <div className="flex-1 overflow-y-auto pl-12 pr-6 py-10 flex flex-col gap-6">
          <div className="flex items-center justify-between w-full">
            <Heading level={1} as="h2" weight="semibold" color="primary" data-testid="service-team-provider-modal-name">
              {name}
            </Heading>
            <Button variant="primary" size="md" onClick={() => void handleSave()} disabled={saving} data-testid="service-team-provider-modal-save">
              {tm('save')}
            </Button>
          </div>

          {waHref && (
            <a
              href={waHref}
              target="_blank"
              rel="noreferrer"
              className="flex gap-1 items-center text-primary -mt-4"
              data-testid="service-team-provider-modal-phone"
            >
              <Text as="span" size="sm" weight="medium" color="inherit">{contact?.phone}</Text>
            </a>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1">
              <Text size="xs" color="secondary" weight="semibold">{tm('providerField')}</Text>
              <Input value={name} disabled readOnly inputSize="compact" data-testid="service-team-provider-modal-provider-field" />
            </div>
            <div className="flex flex-col gap-1">
              <Text size="xs" color="secondary" weight="semibold">{tm('contactedLabel')}</Text>
              <Select
                inputSize="compact"
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

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1">
              <Text size="xs" color="secondary" weight="semibold">{tm('statusLabel')}</Text>
              <Select
                inputSize="compact"
                data-testid="service-team-provider-modal-status"
                value={estadoValue}
                onValueChange={handleEstadoChange}
                disabled={!actionKind}
                options={estadoOptions}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Text size="xs" color="secondary" weight="semibold">{tm('eventDateLabel')}</Text>
              <div className={`${inputWrapperClasses({ size: 'compact' })} justify-between relative`}>
                <Text as="span" size="sm" weight="medium" color="inherit" data-testid="service-team-provider-modal-event-date-text">
                  {formatEventDate(eventDate)}
                </Text>
                <Calendar className="w-[22px] h-[22px] text-[#737373] shrink-0 pointer-events-none" aria-hidden="true" />
                <input
                  type="date"
                  lang="es-AR"
                  value={eventDate}
                  onChange={(e) => setEventDate(e.target.value)}
                  aria-label={tm('eventDateLabel')}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  data-testid="service-team-provider-modal-event-date-input"
                />
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <Text size="xs" color="secondary" weight="semibold">{tm('noteLabel')}</Text>
            <Textarea
              inputSize="compact"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={tm('notePlaceholder')}
              rows={3}
              data-testid="service-team-provider-modal-note"
            />
          </div>

          {saveError && (
            <Text size="sm" role="alert" className="text-red-600" data-testid="service-team-provider-modal-save-error">
              {tm('saveError')}
            </Text>
          )}

          <div className="border-t border-gray-600 pt-4">
            <Text size="sm" color="secondary" weight="medium" className="mb-2">{tm('historyTitle')}</Text>
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

      {reasonPromptKind && (
        <RejectionReasonSelect
          options={reasonPromptKind === 'reject' ? SERVICE_TEAM_REJECT_REASONS : SERVICE_TEAM_REVERT_REASONS}
          titleKey={`admin.patients.detail.serviceTeam.${reasonPromptKind}Modal.title`}
          optionKeyPrefix={`admin.patients.detail.serviceTeam.${reasonPromptKind}Options`}
          confirmKey={`admin.patients.detail.serviceTeam.${reasonPromptKind}Modal.confirm`}
          cancelKey={`admin.patients.detail.serviceTeam.${reasonPromptKind}Modal.cancel`}
          testIdPrefix={`service-team-provider-modal-${reasonPromptKind}`}
          onSubmit={handleReasonSubmit}
          onCancel={() => setReasonPromptKind(null)}
        />
      )}
    </>
  );
}
