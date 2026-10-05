import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Eye } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Label } from '@presentation/components/atoms/Label';
import { Input } from '@presentation/components/atoms/Input';
import { SearchableSelect } from '@presentation/components/molecules/SearchableSelect/SearchableSelect';
import { ActionButton } from '@presentation/components/features/access';
import { Button } from '@presentation/components/atoms/Button';
import { Select } from '@presentation/components/atoms/Select';
import { SidePanelShell } from './SidePanelShell';
import { RemoveFromItineraryPanel } from './RemoveFromItineraryPanel';
import type { ExitDestination } from '@domain/entities/ServiceTeam';
import type { ServiceTeamMember } from '@domain/entities/ServiceTeam';
import { weekdayName } from './substitutionDates';
import { workerLabel } from './workerLabel';

interface ItineraryEditAppointmentModalProps {
  slot: { weekday: number; startTime: string; endTime: string };
  /** Endereço de ENTRADA (o do serviço) — só leitura (D445.6: "endereço de saída" fica fora). */
  addressLabel: string;
  /** As opções de `allocation-options` (os Seleccionados do serviço); `null` = ainda carregando. */
  options: ServiceTeamMember[] | null;
  /** A vaga viva do serviço — link "ir a la vacante" da Búsqueda de Urgência (D445.7). `null` sem vaga. */
  vacancyId: string | null;
  currentWorkerId: string | null;
  onSubmit: (workerId: string) => void;
  onCancel: () => void;
  /**
   * Fase 4: tirar o prestador ATUAL da faixa, com motivo e destino. Sem ele (ou sem prestador atual) a ação
   * "Quitar del itinerario" não aparece. A escrita é de quem abre o modal.
   */
  onRemove?: (reasonCategory: string, destination: ExitDestination) => void;
  /** Envio do "Quitar" em curso — desabilita o Confirmar do painel. */
  removing?: boolean;
  /** Erro (já traduzido) do último "Quitar"; o painel fica aberto. */
  removeError?: string | null;
}

/**
 * "Editar agendamiento" (D445.3; nós Figma 11340:76269/76377/76652): o modal que reúne a ação de
 * ALOCAR (antes um modal à parte, `AllocateSlotModal`) com os campos do Figma. "Día de la semana"
 * e "Horario" ficam DESABILITADOS (chave imutável do slot — nunca editáveis aqui). "Dirección de
 * saída", "Valor da hora" e a etiqueta "Regular/Fin de semana" do Figma ficam FORA (D445.6 — sem
 * fonte / não é deste domínio). "Búsqueda de urgencia - Complementar" (D445.7) NÃO aloca: sem
 * fonte medida para os contadores de raio, mostra só o link para a vaga — os contadores do Figma
 * (Trabajadores Seleccionados/en el perfil) ficam listados como "Sem fonte" no fecho da fase, não
 * inventados aqui.
 */
export function ItineraryEditAppointmentModal({
  slot,
  addressLabel,
  options,
  vacancyId,
  currentWorkerId,
  onSubmit,
  onCancel,
  onRemove,
  removing = false,
  removeError = null,
}: ItineraryEditAppointmentModalProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const tm = (key: string, opts?: Record<string, unknown>) => t(`admin.patients.detail.itinerary.editModal.${key}`, opts);
  const [workerId, setWorkerId] = useState(currentWorkerId ?? '');
  const [showRemove, setShowRemove] = useState(false);
  const currentMember = currentWorkerId ? (options ?? []).find((m) => m.workerId === currentWorkerId) : undefined;

  const workerOptions = (options ?? []).map((member) => ({
    value: member.workerId,
    label: workerLabel(t, member.workerId, member.displayName),
  }));

  const fieldLabel = 'font-semibold !text-[16px] !leading-[1.35]';
  const disabledLabel = `${fieldLabel} !text-[#d9d9d9]`;
  // Disabled do Figma: fundo branco, borda e texto #d9d9d9 (o do atom é fundo cinza e texto #737373).
  const disabledField =
    '!bg-white [&_select]:!text-[#d9d9d9] [&_svg]:!text-[#d9d9d9]';
  // O `Input` sem ícones recebe o `className` NO PRÓPRIO <input> (não num wrapper): sem `[&_input]`.
  const disabledInput = '!bg-white !text-[#d9d9d9] cursor-not-allowed';

  return (
    <>
    <SidePanelShell ariaLabel={tm('title')} onClose={onCancel} testId="itinerario-editar-modal">
      <div className="flex items-center justify-between w-full">
        <Heading level={1} as="h2" weight="semibold" color="primary">
          {tm('title')}
        </Heading>
        <ActionButton
          resource="patient_itinerary"
          action="update"
          variant="primary"
          size="md"
          className="w-[160px]"
          onClick={() => onSubmit(workerId)}
          disabled={!workerId}
          data-testid="itinerario-editar-guardar"
        >
          {tm('save')}
        </ActionButton>
      </div>

      <div className="flex flex-col gap-1">
        <Label className={disabledLabel}>{tm('weekday')}</Label>
        <Select
          inputSize="compact"
          disabled
          value={String(slot.weekday)}
          options={[{ value: String(slot.weekday), label: weekdayName(slot.weekday, i18n.language) }]}
          className={`capitalize ${disabledField}`}
          data-testid="itinerario-editar-dia"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label className={disabledLabel}>{tm('schedule')}</Label>
        <Input
          inputSize="compact"
          value={`${slot.startTime} - ${slot.endTime}`}
          disabled
          readOnly
          className={disabledInput}
          data-testid="itinerario-editar-horario"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label className={fieldLabel}>{tm('entryAddress')}</Label>
        <Input
          inputSize="compact"
          value={addressLabel}
          readOnly
          className="[&_input]:cursor-default"
          data-testid="itinerario-editar-endereco"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label className={fieldLabel}>{tm('assignWorker')}</Label>
        {/* SearchableSelect compact é h-10; o desenho pede o campo de 48px (h-12) com texto #737373 de 14px. */}
        <div className="[&_button]:!h-12 [&_button]:!text-[#737373] [&_button]:!py-0">
          <SearchableSelect
            data-testid="itinerario-editar-prestador"
            inputSize="compact"
            options={workerOptions}
            value={workerId}
            onChange={setWorkerId}
            disabled={options === null}
            placeholder={tm('selectPlaceholder')}
            emptyMessage={tm('noOptions')}
          />
        </div>
        {options !== null && options.length === 0 && (
          <Text size="xs" color="secondary" data-testid="itinerario-editar-sem-opcoes">
            {tm('noOptions')}
          </Text>
        )}
      </div>

      {options !== null && options.length > 0 && (
        <div className="flex flex-col gap-4">
          <Heading level={1} as="h3" weight="semibold" color="secondary">
            {tm('preselectedTitle')}
          </Heading>
          <div className="flex flex-wrap gap-x-[17px] gap-y-[10px]" data-testid="itinerario-editar-preselecionados">
            {options.map((member) => (
              <div
                key={member.workerId}
                data-testid={`itinerario-editar-card-${member.workerId}`}
                className={`flex items-center justify-between gap-3 w-[240px] rounded-lg border px-4 py-[10px] bg-[#f7f7f7] ${
                  workerId === member.workerId ? 'border-primary' : 'border-[#d9d9d9]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setWorkerId(member.workerId)}
                  data-testid={`itinerario-editar-selecionar-${member.workerId}`}
                  className="flex items-center gap-2 flex-1 min-w-0 text-left"
                >
                  <span className="size-8 rounded bg-gray-300 shrink-0" aria-hidden="true" />
                  <span className="flex flex-col min-w-0">
                    <Text as="span" size="base" weight="medium" color="primary" className="truncate">
                      {workerLabel(t, member.workerId, member.displayName)}
                    </Text>
                    {member.occupation && (
                      <Text as="span" size="sm" color="secondary" data-testid={`itinerario-editar-ocupacao-${member.workerId}`}>
                        {t(`admin.patients.detail.contractedServicesCard.serviceTypes.${member.occupation}`, member.occupation)}
                      </Text>
                    )}
                  </span>
                </button>
                <Link
                  to={`/admin/workers/${member.workerId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid={`itinerario-editar-ver-perfil-${member.workerId}`}
                  title={tm('viewProfile')}
                  className="shrink-0 text-primary"
                >
                  <Eye size={19} aria-hidden="true" />
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-4">
        <Heading level={1} as="h3" weight="semibold" color="secondary">
          {tm('urgentSearchTitle')}
        </Heading>
        <Text size="sm" color="secondary" data-testid="itinerario-editar-sem-fonte-contadores">
          {tm('urgentSearchNoSource')}
        </Text>
        {vacancyId ? (
          <Link to={`/admin/vacancies/${vacancyId}`} data-testid="itinerario-editar-link-vaga" className="self-start">
            <Button variant="outline" size="sm">
              {tm('goToVacancy')}
            </Button>
          </Link>
        ) : (
          <Text size="xs" color="secondary" data-testid="itinerario-editar-sem-vaga">
            {tm('noVacancy')}
          </Text>
        )}
      </div>

      {onRemove && currentWorkerId && (
        <div className="flex flex-col gap-2">
          <ActionButton
            resource="patient_itinerary"
            action="update"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setShowRemove(true)}
            data-testid={`itinerario-quitar-${currentWorkerId}`}
          >
            {tm('removeFromItinerary')}
          </ActionButton>
        </div>
      )}

      <Text as="p" size="xs" color="secondary" data-testid="itinerario-editar-anacare-aviso">
        {tm('anaCareNotice')}
      </Text>
    </SidePanelShell>
    {/* Irmão do modal, não filho: o modal tem `transform`, que viraria o bloco de contenção do `fixed` do painel. */}
    {showRemove && onRemove && currentWorkerId && (
      <RemoveFromItineraryPanel
        workerLabel={workerLabel(t, currentWorkerId, currentMember?.displayName ?? null)}
        onConfirm={onRemove}
        onCancel={() => setShowRemove(false)}
        submitting={removing}
        errorMessage={removeError}
      />
    )}
    </>
  );
}
