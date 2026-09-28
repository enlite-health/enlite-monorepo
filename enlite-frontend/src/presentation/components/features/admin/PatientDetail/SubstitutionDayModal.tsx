import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Button } from '@presentation/components/atoms/Button';
import { Select, type SelectOption } from '@presentation/components/atoms/Select';
import { SearchableSelect } from '@presentation/components/molecules/SearchableSelect/SearchableSelect';
import { nextDatesOfWeekday, formatDDMM } from './substitutionDates';
import type { ServiceTeamAllocation, ServiceTeamMember } from '@domain/entities/ServiceTeam';

interface SubstitutionDayModalProps {
  allocations: ServiceTeamAllocation[];
  selected: ServiceTeamMember[];
  asOf: string;
  onSubmit: (allocationId: string, date: string, substituteWorkerId: string | null) => void;
  onCancel: () => void;
}

/** Quantas próximas datas o `Select` oferece (DX-13.13) — sempre por `nextDatesOfWeekday`. */
const DATES_COUNT = 8;

/** Valor sentinela da opção "sin reemplazo" no `SearchableSelect` — nunca vaza para `onSubmit` (vira `null`). */
const NO_SUBSTITUTE_VALUE = '__NO_SUBSTITUTE__';

/**
 * Referência UTC de um domingo (2023-01-01) para nomear o dia da semana sem criar chave de i18n
 * nova fora do bloco fechado no P30 (`weekday` 0=domingo…6=sábado, a mesma convenção do
 * `dayOfWeek`/`nextDatesOfWeekday`). Só o NOME do dia (`Intl`, locale do idioma ativo) — nunca a
 * data em si, que vem sempre de `nextDatesOfWeekday`.
 */
const WEEKDAY_REFERENCE_UTC_MS = Date.UTC(2023, 0, 1);

function weekdayName(weekday: number, language: string): string {
  const locale = language.startsWith('pt') ? 'pt-BR' : 'es-AR';
  const ms = WEEKDAY_REFERENCE_UTC_MS + weekday * 24 * 60 * 60 * 1000;
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(ms));
}

/**
 * DX-13.13 — o modal "Sustituir un día", aberto pelo botão no card do titular em `IN_SERVICE`.
 * Molde visual de `RejectionReasonSelect.tsx`. 3 selects em cascata: faixa (`allocations` do
 * titular) → data (as próximas `DATES_COUNT` do dia da semana da faixa, a partir de `asOf`) →
 * substituto (`SearchableSelect` alimentado SÓ por `selected`, + "sin reemplazo"). `onSubmit`
 * nunca recebe a faixa/dia — o pai (`ServiceTeamBoard`) já sabe qual card abriu o modal.
 */
export function SubstitutionDayModal({
  allocations,
  selected,
  asOf,
  onSubmit,
  onCancel,
}: SubstitutionDayModalProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const [allocationId, setAllocationId] = useState(allocations.length === 1 ? allocations[0].allocationId : '');
  const [date, setDate] = useState('');
  const [substituteWorkerId, setSubstituteWorkerId] = useState(NO_SUBSTITUTE_VALUE);

  const allocation = allocations.find((a) => a.allocationId === allocationId) ?? null;

  const slotOptions: SelectOption[] = allocations.map((a) => ({
    value: a.allocationId,
    label: `${weekdayName(a.weekday, i18n.language)} ${a.startTime}-${a.endTime}`,
  }));

  const dateOptions: SelectOption[] = allocation
    ? nextDatesOfWeekday(asOf, allocation.weekday, DATES_COUNT).map((d) => ({ value: d, label: formatDDMM(d) }))
    : [];

  const workerOptions = [
    { value: NO_SUBSTITUTE_VALUE, label: t('admin.patients.detail.serviceTeam.substitution.noSubstitute') },
    ...selected.map((member) => ({
      value: member.workerId,
      label: member.displayName ?? t('admin.patients.detail.serviceTeam.unnamedWorker', { shortId: member.workerId.slice(-8) }),
    })),
  ];

  function handleSlotChange(value: string): void {
    setAllocationId(value);
    setDate('');
  }

  function handleConfirm(): void {
    if (!allocationId || !date) return;
    onSubmit(allocationId, date, substituteWorkerId === NO_SUBSTITUTE_VALUE ? null : substituteWorkerId);
  }

  const canConfirm = Boolean(allocationId && date);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" data-testid="substitution-modal">
      <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl flex flex-col gap-4">
        <Heading level={3} className="text-primary">
          {t('admin.patients.detail.serviceTeam.substitution.title')}
        </Heading>

        <Select
          data-testid="substitution-slot"
          options={slotOptions}
          value={allocationId}
          onValueChange={handleSlotChange}
          placeholder={t('admin.patients.detail.serviceTeam.substitution.slot')}
        />

        <Select
          data-testid="substitution-date"
          options={dateOptions}
          value={date}
          onValueChange={setDate}
          disabled={!allocation}
          placeholder={t('admin.patients.detail.serviceTeam.substitution.date')}
        />

        <SearchableSelect
          data-testid="substitution-worker"
          options={workerOptions}
          value={substituteWorkerId}
          onChange={setSubstituteWorkerId}
          label={t('admin.patients.detail.serviceTeam.substitution.worker')}
        />

        <div className="flex gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            className="flex-1"
            data-testid="substitution-cancel"
          >
            {t('admin.patients.detail.serviceTeam.substitution.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="flex-1"
            data-testid="substitution-confirm"
          >
            {t('admin.patients.detail.serviceTeam.substitution.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
