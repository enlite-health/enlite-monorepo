/**
 * BlockedAttemptsPage
 *
 * Admin page: workers who tried to apply but were blocked.
 * Route: /admin/recruitment/blocked-attempts
 *
 * Shows:
 *   1. Aggregate summary bar (total + breakdown by reason)
 *   2. Filters (reason, vacancy id)
 *   3. Paginated table with resolved worker name + vacancy title
 */

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useContainerAccess } from '@presentation/hooks/useCellAccess';
import { RefreshCw, AlertCircle, ShieldX } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@presentation/components/atoms/Table';
import { useBlockedAttempts } from '@hooks/admin/useBlockedAttempts';
import { BlockedAggregatesBar } from './BlockedAggregatesBar';
import { BlockedAttemptsFilters } from './BlockedAttemptsFilters';
import type { BlockedReason } from '@domain/entities/BlockedAttempt';
import type { ResolvedAttempt } from '@hooks/admin/useBlockedAttempts';

const PAGE_SIZE = 20;

const REASON_BADGE_COLORS: Record<string, string> = {
  registration_incomplete: 'bg-amber-100 text-amber-800',
  worker_disabled: 'bg-red-100 text-red-800',
  worker_not_found: 'bg-slate-100 text-slate-700',
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function LoadingSkeleton(): JSX.Element {
  return (
    <div className="flex flex-col gap-4 animate-pulse" data-testid="blocked-skeleton">
      <div className="flex gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 bg-slate-100 rounded-2xl flex-1" />
        ))}
      </div>
      <div className="h-10 bg-slate-100 rounded-xl w-full" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-10 bg-slate-50 rounded w-full" />
      ))}
    </div>
  );
}

interface MissingFieldsBadgesProps {
  fields: string[];
}

function MissingFieldsBadges({ fields }: MissingFieldsBadgesProps): JSX.Element {
  const { t } = useTranslation();
  if (fields.length === 0) return <span className="text-slate-400">—</span>;

  return (
    <div className="flex flex-wrap gap-1">
      {fields.map((f) => (
        <span
          key={f}
          className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full"
        >
          <Text as="span" size="xs" weight="medium" color="inherit">
            {t(`admin.blockedAttempts.missingField.${f}`, { defaultValue: f })}
          </Text>
        </span>
      ))}
    </div>
  );
}

interface AttemptRowProps {
  attempt: ResolvedAttempt;
}

function AttemptRow({ attempt }: AttemptRowProps): JSX.Element {
  const { t } = useTranslation();
  const ba = (key: string) => t(`admin.blockedAttempts.${key}`);

  const reasonColor =
    REASON_BADGE_COLORS[attempt.blockedReason] ?? 'bg-slate-100 text-slate-700';

  const workerLabel =
    attempt.workerName ??
    attempt.workerPhone ??
    t('admin.blockedAttempts.table.noName', { id: attempt.workerId.slice(0, 8) });
  const vacancyLabel =
    attempt.vacancyTitle ??
    (attempt.vacancyCaseNumber
      ? `Caso #${attempt.vacancyCaseNumber}`
      : ba('table.unknownVacancy'));

  return (
    <TableRow>
      <TableCell unwrapped>
        <Link
          to={`/admin/workers/${attempt.workerId}`}
          className="text-primary hover:underline"
        >
          <Text as="span" size="sm" weight="medium" color="primary">
            {workerLabel}
          </Text>
        </Link>
      </TableCell>

      <TableCell unwrapped>
        <Link
          to={`/admin/vacancies/${attempt.jobPostingId}`}
          className="text-primary hover:underline"
        >
          <Text as="span" size="sm" color="primary">
            {vacancyLabel}
          </Text>
        </Link>
      </TableCell>

      <TableCell unwrapped>
        <span className={`inline-block px-2 py-0.5 rounded-full ${reasonColor}`}>
          <Text as="span" size="xs" weight="medium" color="inherit">
            {t(`admin.blockedAttempts.reason.${attempt.blockedReason}`, {
              defaultValue: attempt.blockedReason,
            })}
          </Text>
        </span>
      </TableCell>

      <TableCell unwrapped>
        <MissingFieldsBadges fields={attempt.missingFields} />
      </TableCell>

      <TableCell align="center">
        {attempt.attemptCount}
      </TableCell>

      <TableCell>
        {formatDate(attempt.lastAttemptedAt)}
      </TableCell>
    </TableRow>
  );
}

// ── Pagination controls ───────────────────────────────────────────────────────

interface PaginationBarProps {
  page: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
  onPrev: () => void;
  onNext: () => void;
}

function PaginationBar({
  page,
  totalPages,
  hasNext,
  hasPrev,
  onPrev,
  onNext,
}: PaginationBarProps): JSX.Element {
  const { t } = useTranslation();
  if (totalPages <= 1) return <></>;

  return (
    <div className="flex items-center justify-between mt-4">
      <Button
        variant="outline"
        size="sm"
        disabled={!hasPrev}
        onClick={onPrev}
      >
        {t('admin.blockedAttempts.pagination.previous')}
      </Button>
      <Text as="span" size="sm" color="muted">
        {t('admin.blockedAttempts.pagination.page', { page, total: totalPages })}
      </Text>
      <Button
        variant="outline"
        size="sm"
        disabled={!hasNext}
        onClick={onNext}
      >
        {t('admin.blockedAttempts.pagination.next')}
      </Button>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function BlockedAttemptsPage(): JSX.Element | null {
  const navigate = useNavigate();

  // ── Gate de container (mesmo padrão do DedupCenterPage) ─────────────────────
  // A célula da leitura que a tela faz: GET /recruitment/blocked-attempts →
  // recruitment:read. Só nega com o engine ligado (D268/D286).
  const { visible } = useContainerAccess('recruitment');

  useEffect(() => {
    if (!visible) navigate('/admin', { replace: true });
  }, [visible, navigate]);

  if (!visible) return null;

  return <BlockedAttemptsPageInner />;
}

/**
 * Inner component extracted to keep the access guard clean.
 */
function BlockedAttemptsPageInner(): JSX.Element {
  const { t } = useTranslation();
  const ba = (key: string) => t(`admin.blockedAttempts.${key}`);

  const [reason, setReason] = useState<BlockedReason | ''>('');
  const [vacancyId, setVacancyId] = useState('');
  const [page, setPage] = useState(1);

  const filters = {
    ...(reason ? { reason } : {}),
    ...(vacancyId.trim() ? { jobPostingId: vacancyId.trim() } : {}),
    page,
    limit: PAGE_SIZE,
  };

  const { attempts, aggregates, pagination, isLoading, error, refetch } =
    useBlockedAttempts(filters);

  const handleReasonChange = (r: BlockedReason | '') => {
    setReason(r);
    setPage(1);
  };

  const handleVacancyIdChange = (id: string) => {
    setVacancyId(id);
    setPage(1);
  };

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <ShieldX className="w-7 h-7 text-primary" />
          <div>
            <Heading level={1} weight="semibold" color="primary">
              {ba('title')}
            </Heading>
            <Text size="sm" color="muted" as="span">
              {ba('subtitle')}
            </Text>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refetch}
          disabled={isLoading}
          aria-label={ba('refresh')}
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          {ba('refresh')}
        </Button>
      </div>

      {/* Loading */}
      {isLoading && <LoadingSkeleton />}

      {/* Error */}
      {!isLoading && error && (
        <div
          className="flex flex-col items-center gap-4 py-16 text-center"
          data-testid="blocked-error"
        >
          <AlertCircle className="w-12 h-12 text-red-400" />
          <Heading level={3} color="tertiary">
            {ba('loadError')}
          </Heading>
          <Text size="sm" color="muted">
            {error}
          </Text>
          <Button variant="outline" size="sm" onClick={refetch}>
            {ba('retry')}
          </Button>
        </div>
      )}

      {/* Content */}
      {!isLoading && !error && (
        <div data-testid="blocked-content">
          {/* Aggregates */}
          <BlockedAggregatesBar aggregates={aggregates} />

          {/* Filters */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 mb-4">
            <BlockedAttemptsFilters
              reason={reason}
              vacancyId={vacancyId}
              onReasonChange={handleReasonChange}
              onVacancyIdChange={handleVacancyIdChange}
            />
          </div>

          {/* Table */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
            {attempts.length === 0 ? (
              <div
                className="flex flex-col items-center gap-3 py-16 text-center"
                data-testid="blocked-empty"
              >
                <ShieldX className="w-12 h-12 text-slate-300" />
                <Heading level={3} color="tertiary" weight="medium">
                  {ba('noAttempts')}
                </Heading>
                <Text size="sm" color="muted">
                  {ba('noAttemptsDesc')}
                </Text>
              </div>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableHead>{ba('table.worker')}</TableHead>
                    <TableHead>{ba('table.vacancy')}</TableHead>
                    <TableHead>{ba('table.reason')}</TableHead>
                    <TableHead>{ba('table.missingFields')}</TableHead>
                    <TableHead align="center">{ba('table.attempts')}</TableHead>
                    <TableHead>{ba('table.lastAttempt')}</TableHead>
                  </TableHeader>
                  <TableBody>
                    {attempts.map((attempt) => (
                      <AttemptRow key={attempt.id} attempt={attempt} />
                    ))}
                  </TableBody>
                </Table>

                <PaginationBar
                  page={pagination.page}
                  totalPages={pagination.totalPages}
                  hasNext={pagination.hasNext}
                  hasPrev={pagination.hasPrev}
                  onPrev={() => setPage((p) => Math.max(1, p - 1))}
                  onNext={() => setPage((p) => p + 1)}
                />
              </>
            )}
          </div>
        </div>
      )}
    </PageContainer>
  );
}
