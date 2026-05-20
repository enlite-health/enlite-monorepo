/**
 * RecruitmentHealthPage
 *
 * Mostra métricas dos fluxos de recrutamento automatizados:
 * - Convites automáticos nas últimas 24h
 * - Último bulk dispatch de cadastro incompleto
 * - Último bulk dispatch de Talentum incompleto
 *
 * Rota: /admin/recruitment/health
 */

import { useTranslation } from 'react-i18next';
import { RefreshCw, Activity, AlertCircle } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { useRecruitmentHealth } from '@hooks/admin/useRecruitmentHealth';
import type { BulkRun } from '@domain/entities/RecruitmentHealth';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string | null, fallback: string): string {
  if (!iso) return fallback;
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

interface MetricRowProps {
  label: string;
  value: string | number;
  danger?: boolean;
}

function MetricRow({ label, value, danger = false }: MetricRowProps): JSX.Element {
  return (
    <div className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0">
      <Text size="sm" color="muted" as="span">
        {label}
      </Text>
      <Text
        size="sm"
        weight="medium"
        color="inherit"
        as="span"
        className={danger ? 'text-red-600' : 'text-gray-800'}
      >
        {String(value)}
      </Text>
    </div>
  );
}

interface BulkRunCardProps {
  title: string;
  run: BulkRun;
  noRunsLabel: string;
  batchIdLabel: string;
  totalLabel: string;
  sentLabel: string;
  errorsLabel: string;
  startedAtLabel: string;
  finishedAtLabel: string;
  noValueFallback: string;
}

function BulkRunCard({
  title,
  run,
  noRunsLabel,
  batchIdLabel,
  totalLabel,
  sentLabel,
  errorsLabel,
  startedAtLabel,
  finishedAtLabel,
  noValueFallback,
}: BulkRunCardProps): JSX.Element {
  const isEmpty = run.batch_id === null;

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
      <Heading level={3} weight="semibold" color="tertiary" className="mb-4">
        {title}
      </Heading>

      {isEmpty ? (
        <Text size="sm" color="muted">
          {noRunsLabel}
        </Text>
      ) : (
        <div>
          <div className="mb-3">
            <Text size="xs" color="muted" as="span">
              {batchIdLabel}:{' '}
            </Text>
            <Text
              size="xs"
              weight="medium"
              color="inherit"
              as="span"
              className="font-mono text-gray-700 break-all"
              title={run.batch_id ?? ''}
            >
              {run.batch_id}
            </Text>
          </div>
          <MetricRow label={totalLabel} value={run.total} />
          <MetricRow label={sentLabel} value={run.sent} />
          <MetricRow label={errorsLabel} value={run.errors} danger={run.errors > 0} />
          <MetricRow
            label={startedAtLabel}
            value={formatTimestamp(run.started_at, noValueFallback)}
          />
          <MetricRow
            label={finishedAtLabel}
            value={formatTimestamp(run.finished_at, noValueFallback)}
          />
        </div>
      )}
    </div>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function HealthSkeleton(): JSX.Element {
  return (
    <div className="flex flex-col gap-6" data-testid="health-skeleton">
      {[0, 1, 2].map((i) => (
        <div key={i} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 animate-pulse">
          <div className="h-5 bg-slate-200 rounded w-1/2 mb-4" />
          <div className="space-y-3">
            {[0, 1, 2, 3].map((j) => (
              <div key={j} className="flex justify-between">
                <div className="h-4 bg-slate-100 rounded w-1/3" />
                <div className="h-4 bg-slate-100 rounded w-1/4" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function RecruitmentHealthPage(): JSX.Element {
  const { t } = useTranslation();
  const rh = (key: string) => t(`admin.recruitmentHealth.${key}`);

  const { data, isLoading, error, refetch } = useRecruitmentHealth();

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <Activity className="w-7 h-7 text-primary" />
          <Heading level={1} weight="semibold" color="primary">
            {rh('title')}
          </Heading>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refetch}
          disabled={isLoading}
          aria-label={rh('refresh')}
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          {rh('refresh')}
        </Button>
      </div>

      {/* Loading */}
      {isLoading && <HealthSkeleton />}

      {/* Error */}
      {!isLoading && error && (
        <div
          className="flex flex-col items-center gap-4 py-16 text-center"
          data-testid="health-error"
        >
          <AlertCircle className="w-12 h-12 text-red-400" />
          <Heading level={3} color="tertiary">
            {rh('loadError')}
          </Heading>
          <Text size="sm" color="muted">
            {error}
          </Text>
          <Button variant="outline" size="sm" onClick={refetch}>
            {rh('retry')}
          </Button>
        </div>
      )}

      {/* Content */}
      {!isLoading && !error && data && (
        <div className="flex flex-col gap-6" data-testid="health-content">
          {/* Card 1 — Auto-invite last 24h */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
            <Heading level={3} weight="semibold" color="tertiary" className="mb-4">
              {rh('autoInvite.title')}
            </Heading>
            <MetricRow
              label={rh('autoInvite.vacanciesCreated')}
              value={data.auto_invite_last_24h.vacancies_created}
            />
            <MetricRow
              label={rh('autoInvite.invitesEnqueued')}
              value={data.auto_invite_last_24h.invites_enqueued}
            />
            <MetricRow
              label={`${rh('autoInvite.sent')} / ${rh('autoInvite.delivered')}`}
              value={`${data.auto_invite_last_24h.invites_sent} / ${data.auto_invite_last_24h.invites_delivered}`}
            />
            <MetricRow
              label={rh('autoInvite.failed')}
              value={data.auto_invite_last_24h.invites_failed}
              danger={data.auto_invite_last_24h.invites_failed > 0}
            />
          </div>

          {/* Card 2 — Bulk incomplete */}
          <BulkRunCard
            title={rh('bulkIncomplete.title')}
            run={data.bulk_dispatch_incomplete_last_run}
            noRunsLabel={rh('noRuns')}
            batchIdLabel={rh('batchId')}
            totalLabel={rh('total')}
            sentLabel={rh('autoInvite.sent')}
            errorsLabel={rh('errors')}
            startedAtLabel={rh('startedAt')}
            finishedAtLabel={rh('finishedAt')}
            noValueFallback="—"
          />

          {/* Card 3 — Bulk Talentum */}
          <BulkRunCard
            title={rh('bulkTalentum.title')}
            run={data.bulk_dispatch_talentum_last_run}
            noRunsLabel={rh('noRuns')}
            batchIdLabel={rh('batchId')}
            totalLabel={rh('total')}
            sentLabel={rh('autoInvite.sent')}
            errorsLabel={rh('errors')}
            startedAtLabel={rh('startedAt')}
            finishedAtLabel={rh('finishedAt')}
            noValueFallback="—"
          />
        </div>
      )}
    </PageContainer>
  );
}
