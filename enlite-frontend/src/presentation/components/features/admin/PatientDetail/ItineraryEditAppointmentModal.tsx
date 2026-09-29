import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Label } from '@presentation/components/atoms/Label';
import { Input } from '@presentation/components/atoms/Input';
import { Select } from '@presentation/components/atoms/Select';
import { ActionButton } from '@presentation/components/features/access';
import { Button } from '@presentation/components/atoms/Button';
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
}

/**
 * "Editar agendamiento" (D445.2; nós Figma 11340:76269/76377/76652): o modal que reúne a ação de
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
}: ItineraryEditAppointmentModalProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const tm = (key: string, opts?: Record<string, unknown>) => t(`admin.patients.detail.itinerary.editModal.${key}`, opts);
  const [workerId, setWorkerId] = useState(currentWorkerId ?? '');

  const workerOptions = (options ?? []).map((member) => ({
    value: member.workerId,
    label: workerLabel(t, member.workerId, member.displayName),
  }));

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" data-testid="itinerario-editar-modal">
      <div className="bg-white rounded-2xl p-6 w-full max-w-lg shadow-xl flex flex-col gap-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <Heading level={3} color="primary">
            {tm('title')}
          </Heading>
          <ActionButton
            resource="patient_itinerary"
            action="update"
            variant="primary"
            size="sm"
            onClick={() => onSubmit(workerId)}
            disabled={!workerId}
            data-testid="itinerario-editar-guardar"
          >
            {tm('save')}
          </ActionButton>
        </div>

        <div className="flex flex-col gap-1">
          <Label>{tm('weekday')}</Label>
          <Input value={weekdayName(slot.weekday, i18n.language)} disabled readOnly className="capitalize" data-testid="itinerario-editar-dia" />
        </div>

        <div className="flex flex-col gap-1">
          <Label>{tm('schedule')}</Label>
          <Input value={`${slot.startTime} - ${slot.endTime}`} disabled readOnly data-testid="itinerario-editar-horario" />
        </div>

        <div className="flex flex-col gap-1">
          <Label>{tm('entryAddress')}</Label>
          <Input value={addressLabel} disabled readOnly data-testid="itinerario-editar-endereco" />
        </div>

        <div className="flex flex-col gap-1">
          <Label>{tm('assignWorker')}</Label>
          <Select
            data-testid="itinerario-editar-prestador"
            options={workerOptions}
            value={workerId}
            onValueChange={setWorkerId}
            disabled={options === null}
            placeholder={tm('selectPlaceholder')}
          />
          {options !== null && options.length === 0 && (
            <Text size="xs" color="secondary" data-testid="itinerario-editar-sem-opcoes">
              {tm('noOptions')}
            </Text>
          )}
        </div>

        {options !== null && options.length > 0 && (
          <div className="flex flex-col gap-2">
            <Text weight="medium" color="secondary">
              {tm('preselectedTitle')}
            </Text>
            <div className="grid grid-cols-2 gap-2" data-testid="itinerario-editar-preselecionados">
              {options.map((member) => (
                <button
                  key={member.workerId}
                  type="button"
                  onClick={() => setWorkerId(member.workerId)}
                  data-testid={`itinerario-editar-card-${member.workerId}`}
                  className={`flex items-center gap-2 rounded-lg border p-2 text-left ${
                    workerId === member.workerId ? 'border-primary bg-primary/5' : 'border-gray-600'
                  }`}
                >
                  <span className="size-8 rounded-full bg-gray-300 shrink-0" aria-hidden="true" />
                  <Text as="span" size="sm" weight="medium" color="primary">
                    {workerLabel(t, member.workerId, member.displayName)}
                  </Text>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2 border-t border-gray-600 pt-4">
          <Text weight="medium" color="secondary">
            {tm('urgentSearchTitle')}
          </Text>
          <Text size="xs" color="secondary" data-testid="itinerario-editar-sem-fonte-contadores">
            {tm('urgentSearchNoSource')}
          </Text>
          {vacancyId ? (
            <Link to={`/admin/vacancies/${vacancyId}`} data-testid="itinerario-editar-link-vaga">
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

        <Text as="p" size="xs" color="secondary" data-testid="itinerario-editar-anacare-aviso">
          {tm('anaCareNotice')}
        </Text>

        <div className="flex gap-3">
          <Button variant="outline" size="sm" onClick={onCancel} className="flex-1" data-testid="itinerario-editar-cancelar">
            {tm('cancel')}
          </Button>
        </div>
      </div>
    </div>
  );
}
