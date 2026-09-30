import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { Select, type SelectOption } from '@presentation/components/atoms/Select';
import { SearchableSelect } from '@presentation/components/molecules/SearchableSelect/SearchableSelect';
import { nextDatesOfWeekday, formatDDMM, weekdayName } from './substitutionDates';
import type { ServiceTeamAllocation, ServiceTeamMember } from '@domain/entities/ServiceTeam';
import { workerLabel } from './workerLabel';
import { SidePanelShell } from './SidePanelShell';

interface SubstitutionDayModalProps {
  allocations: ServiceTeamAllocation[];
  selected: ServiceTeamMember[];
  asOf: string;
  onSubmit: (allocationId: string, date: string, substituteWorkerId: string | null) => void;
  onCancel: () => void;
  /**
   * D445.5 (reemplazo permanente) — SÓ presente quando o chamador oferece o modo "Entero". Sem
   * este prop (molde `ServiceTeamBoard`, comportamento intocado), o toggle nem aparece: o modal
   * continua sendo só "Sustituir un día" (complementar), zero mudança visual ali.
   */
  onSubmitPermanent?: (allocationId: string, newWorkerId: string, fromDate: string) => void;
  /**
   * Renderiza como PAINEL LATERAL (`SidePanelShell`: título + "Confirmar" na mesma linha, sem
   * botão Cancelar — fecha por overlay/Esc). É o "Nuevo +" da aba Itinerario; o `ServiceTeamBoard`
   * não passa e segue com o diálogo central de sempre.
   */
  panel?: boolean;
}

/** Quantas próximas datas o `Select` oferece (DX-13.13) — sempre por `nextDatesOfWeekday`. */
const DATES_COUNT = 8;

/** Valor sentinela da opção "sin reemplazo" no `SearchableSelect` — nunca vaza para `onSubmit` (vira `null`). */
const NO_SUBSTITUTE_VALUE = '__NO_SUBSTITUTE__';

type SubstitutionMode = 'COMPLEMENTARY' | 'PERMANENT';

/**
 * DX-13.13 — o modal "Sustituir un día", aberto pelo botão no card do titular em `IN_SERVICE`
 * (`ServiceTeamBoard`) e, D445.4/D445.5, pelo "Nuevo +" da aba Itinerario (`NewSubstitutionModal`)
 * — COMPONENTE ÚNICO, sem segunda implementação. 3 selects em cascata: faixa (`allocations` do
 * titular) → data (as próximas `DATES_COUNT` do dia da semana da faixa, a partir de `asOf`) →
 * substituto (`SearchableSelect` alimentado SÓ por `selected`, + "sin reemplazo" — só no modo
 * complementar). Quando `onSubmitPermanent` está presente, um toggle "Complementar (solo ese
 * día)" × "Entero (reemplazo permanente)" aparece (D445.5); no modo Entero a opção "sin
 * reemplazo" some (o reemplazo entero exige um titular novo) e `onSubmitPermanent` é chamado no
 * lugar de `onSubmit`. O aviso Ana Care (padrão D445) fica visível sempre que o modal abre.
 */
export function SubstitutionDayModal({
  allocations,
  selected,
  asOf,
  onSubmit,
  onCancel,
  onSubmitPermanent,
  panel = false,
}: SubstitutionDayModalProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const [allocationId, setAllocationId] = useState(allocations.length === 1 ? allocations[0].allocationId : '');
  const [date, setDate] = useState('');
  const [substituteWorkerId, setSubstituteWorkerId] = useState(NO_SUBSTITUTE_VALUE);
  const [mode, setMode] = useState<SubstitutionMode>('COMPLEMENTARY');

  const allocation = allocations.find((a) => a.allocationId === allocationId) ?? null;
  const isPermanent = mode === 'PERMANENT' && onSubmitPermanent !== undefined;

  const slotOptions: SelectOption[] = allocations.map((a) => ({
    value: a.allocationId,
    label: `${weekdayName(a.weekday, i18n.language)} ${a.startTime}-${a.endTime}`,
  }));

  const dateOptions: SelectOption[] = allocation
    ? nextDatesOfWeekday(asOf, allocation.weekday, DATES_COUNT).map((d) => ({ value: d, label: formatDDMM(d) }))
    : [];

  const workerOptions = [
    ...(isPermanent ? [] : [{ value: NO_SUBSTITUTE_VALUE, label: t('admin.patients.detail.serviceTeam.substitution.noSubstitute') }]),
    ...selected.map((member) => ({
      value: member.workerId,
      label: workerLabel(t, member.workerId, member.displayName),
    })),
  ];

  function handleSlotChange(value: string): void {
    setAllocationId(value);
    setDate('');
  }

  function handleModeChange(next: SubstitutionMode): void {
    setMode(next);
    if (next === 'PERMANENT' && substituteWorkerId === NO_SUBSTITUTE_VALUE) setSubstituteWorkerId('');
  }

  function handleConfirm(): void {
    if (!allocationId || !date) return;
    if (isPermanent) {
      if (!substituteWorkerId) return;
      onSubmitPermanent?.(allocationId, substituteWorkerId, date);
      return;
    }
    onSubmit(allocationId, date, substituteWorkerId === NO_SUBSTITUTE_VALUE ? null : substituteWorkerId);
  }

  const canConfirm = Boolean(allocationId && date && (!isPermanent || substituteWorkerId));

  const title = t('admin.patients.detail.serviceTeam.substitution.title');
  const confirmLabel = t('admin.patients.detail.serviceTeam.substitution.confirm');

  const modeToggle = onSubmitPermanent ? (
    <div data-testid="substitution-mode" className="flex gap-4">
      <label className="flex items-center gap-2">
        <input
          type="radio"
          name="substitution-mode"
          checked={mode === 'COMPLEMENTARY'}
          onChange={() => handleModeChange('COMPLEMENTARY')}
          data-testid="substitution-mode-complementary"
        />
        <Text as="span" size="sm">
          {t('admin.patients.detail.serviceTeam.substitution.modeComplementary')}
        </Text>
      </label>
      <label className="flex items-center gap-2">
        <input
          type="radio"
          name="substitution-mode"
          checked={mode === 'PERMANENT'}
          onChange={() => handleModeChange('PERMANENT')}
          data-testid="substitution-mode-permanent"
        />
        <Text as="span" size="sm">
          {t('admin.patients.detail.serviceTeam.substitution.modePermanent')}
        </Text>
      </label>
    </div>
  ) : null;

  const fields = (
    <>
      <Select
        inputSize="compact"
        data-testid="substitution-slot"
        options={slotOptions}
        value={allocationId}
        onValueChange={handleSlotChange}
        placeholder={t('admin.patients.detail.serviceTeam.substitution.slot')}
      />

      <Select
        inputSize="compact"
        data-testid="substitution-date"
        options={dateOptions}
        value={date}
        onValueChange={setDate}
        disabled={!allocation}
        placeholder={t('admin.patients.detail.serviceTeam.substitution.date')}
      />

      <SearchableSelect
        data-testid="substitution-worker"
        inputSize="compact"
        options={workerOptions}
        value={substituteWorkerId}
        onChange={setSubstituteWorkerId}
        label={t('admin.patients.detail.serviceTeam.substitution.worker')}
      />

      <Text as="p" size="xs" color="secondary" data-testid="substitution-anacare-notice">
        {t('admin.patients.detail.serviceTeam.substitution.anaCareNotice')}
      </Text>
    </>
  );

  if (panel) {
    return (
      <SidePanelShell ariaLabel={title} onClose={onCancel} testId="substitution-modal">
        <div className="flex items-center justify-between w-full">
          <Heading level={1} as="h2" weight="semibold" color="primary">
            {title}
          </Heading>
          <Button variant="primary" size="md" className="w-[160px]" onClick={handleConfirm} disabled={!canConfirm} data-testid="substitution-confirm">
            {confirmLabel}
          </Button>
        </div>
        {modeToggle}
        {fields}
      </SidePanelShell>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" data-testid="substitution-modal">
      <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl flex flex-col gap-4">
        <Heading level={3} className="text-primary">
          {title}
        </Heading>
        {modeToggle}
        {fields}
        <div className="flex gap-3">
          <Button variant="outline" size="sm" onClick={onCancel} className="flex-1" data-testid="substitution-cancel">
            {t('admin.patients.detail.serviceTeam.substitution.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={handleConfirm} disabled={!canConfirm} className="flex-1" data-testid="substitution-confirm">
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
