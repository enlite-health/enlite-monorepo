import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, Loader2 } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@presentation/components/atoms/Table';
import { usePendingAddressReview } from '@hooks/admin/usePendingAddressReview';
import { ResolveAddressModal } from '@presentation/components/features/admin/VacancyAddressReview/ResolveAddressModal';
import type { ResolveAddressBody } from '@infrastructure/http/AdminVacancyAddressApiService';
import type { PendingAddressReviewItem } from '@domain/entities/PatientAddress';

function MatchTypeBadge({ type }: { type: PendingAddressReviewItem['audit_match_type'] }) {
  const { t } = useTranslation();
  const base = 'inline-flex items-center px-2 py-0.5 rounded-full';
  const inner = (label: string) => (
    <Text as="span" size="xs" weight="semibold" color="inherit">
      {label}
    </Text>
  );
  if (type === 'EXACT') {
    return (
      <span className={`${base} bg-green-100 text-green-700`}>
        {inner(t('admin.pendingAddressReview.matchType.EXACT'))}
      </span>
    );
  }
  if (type === 'FUZZY') {
    return (
      <span className={`${base} bg-yellow-100 text-yellow-700`}>
        {inner(t('admin.pendingAddressReview.matchType.FUZZY'))}
      </span>
    );
  }
  if (type === 'NONE') {
    return (
      <span className={`${base} bg-red-100 text-red-700`}>
        {inner(t('admin.pendingAddressReview.matchType.NONE'))}
      </span>
    );
  }
  return (
    <span className={`${base} bg-slate-100 text-slate-500`}>
      {inner(t('admin.pendingAddressReview.matchType.unknown'))}
    </span>
  );
}

export function PendingAddressReviewPage() {
  const { t } = useTranslation();
  const s = (k: string) => t(`admin.pendingAddressReview.${k}`);

  const { items, loading, error, activeItem, fetchItems, openReview, closeReview, resolve } =
    usePendingAddressReview();

  const [statusFilter, setStatusFilter] = useState('');
  const [resolving, setResolving] = useState(false);

  const handleFilterChange = (value: string) => {
    setStatusFilter(value);
    void fetchItems(value || undefined);
  };

  const handleResolve = async (body: ResolveAddressBody) => {
    setResolving(true);
    try {
      await resolve(body);
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <Heading level={2} weight="semibold" color="secondary">
          {s('title')}
        </Heading>
        <Text size="sm" color="muted">
          {s('subtitle')}
        </Text>
      </div>

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <Text as="span" size="sm" weight="medium" color="muted">
          {t('admin.pendingAddressReview.pendingCount', { count: items.length })}
        </Text>
        <select
          value={statusFilter}
          onChange={e => handleFilterChange(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-2 font-lexend text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          aria-label={s('filterStatus.all')}
        >
          <option value="">{s('filterStatus.all')}</option>
          <option value="SEARCHING">{s('filterStatus.SEARCHING')}</option>
          <option value="SEARCHING_REPLACEMENT">{s('filterStatus.SEARCHING_REPLACEMENT')}</option>
          <option value="RAPID_RESPONSE">{s('filterStatus.RAPID_RESPONSE')}</option>
          <option value="CLOSED">{s('filterStatus.CLOSED')}</option>
        </select>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3">
          <Text size="sm" color="inherit" className="text-red-700">
            {error}
          </Text>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <CheckCircle className="w-12 h-12 text-green-500" />
          <Heading level={3} weight="semibold" color="secondary">
            {s('noItems')}
          </Heading>
        </div>
      )}

      {!loading && items.length > 0 && (
        <div className="rounded-xl border border-gray-400 shadow-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableHead className="whitespace-nowrap">{s('columns.case')}</TableHead>
              <TableHead className="whitespace-nowrap">{s('columns.patient')}</TableHead>
              <TableHead className="whitespace-nowrap">{s('columns.legacyAddress')}</TableHead>
              <TableHead className="whitespace-nowrap">{s('columns.matchAudit')}</TableHead>
              <TableHead className="whitespace-nowrap">{s('columns.status')}</TableHead>
              <TableHead className="whitespace-nowrap">{s('columns.actions')}</TableHead>
            </TableHeader>
            <TableBody>
              {items.map(item => (
                <TableRow key={item.id} clickable={false} className="hover:bg-slate-50">
                  <TableCell weight="medium" className="whitespace-nowrap">
                    {item.title}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{item.patient_name}</TableCell>
                  <TableCell unwrapped className="max-w-[200px] truncate">
                    <Text as="span" size="sm" color="muted">
                      {item.legacy_address_hint ?? '—'}
                    </Text>
                  </TableCell>
                  <TableCell unwrapped className="whitespace-nowrap">
                    <MatchTypeBadge type={item.audit_match_type} />
                    {item.audit_confidence_score !== null && (
                      <Text as="span" size="xs" color="muted" className="ml-2">
                        ({Math.round(item.audit_confidence_score * 100)}%)
                      </Text>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{item.status}</TableCell>
                  <TableCell unwrapped className="whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => openReview(item)}
                      className="px-3 py-1.5 bg-primary rounded-lg hover:bg-primary/90 transition-colors"
                    >
                      <Text as="span" size="xs" weight="semibold" color="white">
                        {s('resolve')}
                      </Text>
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {activeItem && (
        <ResolveAddressModal
          item={activeItem}
          onConfirm={handleResolve}
          onClose={closeReview}
          isLoading={resolving}
        />
      )}
    </div>
  );
}
