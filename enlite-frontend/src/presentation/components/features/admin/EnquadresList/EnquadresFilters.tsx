/**
 * EnquadresFilters — filtros da lista global de enquadres (spec 076). Status, entrevistador e país aplicam na hora; Desde/Hasta e
 * a busca ficam em rascunho até "Aplicar" (ou Enter), que valida o período ANTES de qualquer chamada. O país só aparece quando o
 * escopo do ator tem mais de um. Desde/Hasta mostram o intervalo que o servidor resolveu quando a URL não tem datas.
 */
import { useState, type JSX, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@presentation/components/atoms/Button';
import { Combobox } from '@presentation/components/atoms/Combobox';
import { Input } from '@presentation/components/atoms/Input';
import { getScopedCountryOptions } from '@presentation/pages/admin/patientsData';
import type { EnquadreEventStatus } from '@domain/entities/EnquadreEvent';
import { ENQUADRE_STATUSES, validateRange, type EnquadresListFilters, type RangeErrorCode } from './enquadresListParams';

interface Props {
  filters: EnquadresListFilters;
  /** Intervalo que o servidor resolveu (semana atual quando a URL não tem datas). */
  shownRange: { from: string; to: string } | null;
  hosts: readonly string[];
  countries: readonly string[];
  onChange: (next: Partial<EnquadresListFilters>) => void;
}

const Field = ({ id, label, children }: { id: string; label: string; children: JSX.Element }): JSX.Element => (
  <div className="flex flex-col gap-1">
    <label htmlFor={id} className="text-sm font-medium text-slate-900">{label}</label>
    {children}
  </div>
);

export function EnquadresFilters({ filters, shownRange, hosts, countries, onChange }: Props): JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<{ from?: string; to?: string; q?: string }>({});
  const [rangeError, setRangeError] = useState<RangeErrorCode | null>(null);
  const from = draft.from ?? (filters.from || shownRange?.from || '');
  const to = draft.to ?? (filters.to || shownRange?.to || '');
  const q = draft.q ?? filters.q;

  const apply = (): void => {
    const err = validateRange(from, to);
    setRangeError(err);
    if (err) return;
    onChange({ from, to, q: q.trim(), page: 1 });
    setDraft({});
  };
  const onEnter = (ev: KeyboardEvent<HTMLInputElement>): void => { if (ev.key === 'Enter') apply(); };
  const hostOptions = [...new Set([...hosts, ...(filters.host ? [filters.host] : [])])].map((h) => ({ value: h, label: h }));

  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <Field id="enq-from" label={t('admin.enquadres.filters.from')}>
        <Input id="enq-from" type="date" inputSize="dense" value={from} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} onKeyDown={onEnter} data-testid="enquadres-filter-from" />
      </Field>
      <Field id="enq-to" label={t('admin.enquadres.filters.to')}>
        <Input id="enq-to" type="date" inputSize="dense" value={to} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} onKeyDown={onEnter} data-testid="enquadres-filter-to" />
      </Field>
      <Field id="enq-status" label={t('admin.enquadres.filters.status')}>
        <div className="w-56">
          <Combobox
            id="enq-status"
            multiple
            inputSize="dense"
            placeholder={t('admin.enquadres.filters.statusAll')}
            value={filters.status}
            onChange={(v) => onChange({ status: ENQUADRE_STATUSES.filter((s) => v.includes(s)) as EnquadreEventStatus[], page: 1 })}
            options={ENQUADRE_STATUSES.map((s) => ({ value: s, label: t(`admin.enquadres.status.${s}`) }))}
            data-testid="enquadres-filter-status"
          />
        </div>
      </Field>
      <Field id="enq-host" label={t('admin.enquadres.filters.host')}>
        <div className="w-56">
          <Combobox
            id="enq-host"
            inputSize="dense"
            value={filters.host}
            clearLabel={t('admin.enquadres.filters.hostAll')}
            onChange={(v) => onChange({ host: v, page: 1 })}
            options={hostOptions}
            data-clarity-mask="True"
            data-testid="enquadres-filter-host"
          />
        </div>
      </Field>
      {countries.length > 1 && (
        <Field id="enq-country" label={t('admin.enquadres.filters.country')}>
          <div className="w-44">
            <Combobox
              id="enq-country"
              inputSize="dense"
              value={filters.country}
              clearLabel={t('admin.enquadres.filters.countryAll')}
              onChange={(v) => onChange({ country: v, page: 1 })}
              options={getScopedCountryOptions(t, countries)}
              data-testid="enquadres-filter-country"
            />
          </div>
        </Field>
      )}
      <Field id="enq-search" label={t('admin.enquadres.filters.search')}>
        <Input id="enq-search" inputSize="dense" value={q} maxLength={50} placeholder={t('admin.enquadres.filters.searchPlaceholder')} onChange={(e) => setDraft((d) => ({ ...d, q: e.target.value }))} onKeyDown={onEnter} data-testid="enquadres-filter-search" />
      </Field>
      <Button variant="outline" size="sm" onClick={apply} data-testid="enquadres-filter-apply">{t('admin.enquadres.filters.apply')}</Button>
      {rangeError && (
        <p role="alert" className="w-full text-sm text-red-600" data-testid="enquadres-range-error">{t(`admin.enquadres.errors.${rangeError}`)}</p>
      )}
    </div>
  );
}
