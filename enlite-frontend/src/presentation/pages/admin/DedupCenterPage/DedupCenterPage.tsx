/**
 * DedupCenterPage
 *
 * Admin-only page: Centro de Duplicados.
 * Route: /admin/dedup
 *
 * Onda 2 scope:
 *   - Tab "Fila" — list of duplicate phone groups with merge/dismiss actions
 *   - Tab "Importados" — declared but disabled (Onda 4)
 *   - Modal "Comparar & Unificar" — compare accounts, pick survivor, execute merge
 *
 * Access guard: redirects to /admin if role !== ADMIN.
 *
 * Pattern mirrors BlockedAttemptsPage (orquestrador; lógica en hooks).
 */

import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { GitMerge, RefreshCw, AlertCircle } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { useAdminAuth } from '@presentation/hooks/useAdminAuth';
import { EnliteRole } from '@domain/entities/EnliteRole';
import { useDedupQueue } from '@hooks/admin/useDedupQueue';
import { AdminDedupApiService } from '@infrastructure/http/AdminDedupApiService';
import { DedupTabs, type DedupTab } from './DedupTabs';
import { DedupGroupList } from './DedupGroupList';
import { DedupBulkActionBar } from './DedupBulkActionBar';
import { MergeCompareModal } from '@presentation/components/features/admin/Dedup/MergeCompareModal';

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-4 animate-pulse" data-testid="dedup-skeleton">
      <div className="h-10 bg-slate-100 rounded-xl w-full" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-12 bg-slate-50 rounded w-full" />
      ))}
    </div>
  );
}

export function DedupCenterPage() {
  const navigate = useNavigate();
  const { adminProfile } = useAdminAuth();

  // ── Role guard ────────────────────────────────────────────────────────────────
  const isAdmin = adminProfile?.role === EnliteRole.ADMIN;

  useEffect(() => {
    if (adminProfile && !isAdmin) {
      navigate('/admin', { replace: true });
    }
  }, [adminProfile, isAdmin, navigate]);

  if (adminProfile && !isAdmin) return null;

  return <DedupCenterPageInner />;
}

/**
 * Inner component extracted to keep the role guard clean.
 * Only rendered when adminProfile is known.
 */
function DedupCenterPageInner() {
  const { t } = useTranslation();
  const d = (key: string) => t(`admin.dedup.${key}`);

  const [activeTab, setActiveTab] = useState<DedupTab>('queue');
  const [selectedPhones, setSelectedPhones] = useState<Set<string>>(new Set());
  const [mergePhone, setMergePhone] = useState<string | null>(null);
  const [isDismissingBulk, setIsDismissingBulk] = useState(false);

  const { groups, isLoading, error, refetch } = useDedupQueue();

  // ── Selection handlers ────────────────────────────────────────────────────────

  const handleToggleSelect = useCallback((phone: string) => {
    setSelectedPhones((prev) => {
      const next = new Set(prev);
      if (next.has(phone)) next.delete(phone);
      else next.add(phone);
      return next;
    });
  }, []);

  const handleToggleSelectAll = useCallback(() => {
    setSelectedPhones((prev) => {
      if (prev.size === groups.length) return new Set();
      return new Set(groups.map((g) => g.phone_normalized));
    });
  }, [groups]);

  // ── Dismiss single ────────────────────────────────────────────────────────────

  const handleDismiss = useCallback(
    async (phone: string) => {
      try {
        await AdminDedupApiService.dismiss({ phoneNormalized: phone });
        refetch();
      } catch {
        // Errors surfaced via refetch failure
      }
    },
    [refetch],
  );

  // ── Dismiss bulk ──────────────────────────────────────────────────────────────

  const handleDismissSelected = useCallback(async () => {
    setIsDismissingBulk(true);
    try {
      await Promise.allSettled(
        [...selectedPhones].map((phone) =>
          AdminDedupApiService.dismiss({ phoneNormalized: phone }),
        ),
      );
      setSelectedPhones(new Set());
      refetch();
    } finally {
      setIsDismissingBulk(false);
    }
  }, [selectedPhones, refetch]);

  return (
    <PageContainer>
      {/* ── Header ─────────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <GitMerge className="w-7 h-7 text-primary" />
          <div>
            <Heading level={1} weight="semibold" color="primary">
              {d('title')}
            </Heading>
            <Text size="sm" color="muted" as="span">
              {d('subtitle')}
            </Text>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refetch}
          disabled={isLoading}
          aria-label={d('refresh')}
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          {d('refresh')}
        </Button>
      </div>

      {/* ── Tabs ───────────────────────────────────────────────────────────────── */}
      <div className="mb-6">
        <DedupTabs activeTab={activeTab} onTabChange={setActiveTab} />
      </div>

      {/* ── Loading ────────────────────────────────────────────────────────────── */}
      {isLoading && <LoadingSkeleton />}

      {/* ── Error ──────────────────────────────────────────────────────────────── */}
      {!isLoading && error && (
        <div
          className="flex flex-col items-center gap-4 py-16 text-center"
          data-testid="dedup-error"
        >
          <AlertCircle className="w-12 h-12 text-red-400" />
          <Heading level={3} color="tertiary">
            {d('loadError')}
          </Heading>
          <Text size="sm" color="muted">{error}</Text>
          <Button variant="outline" size="sm" onClick={refetch}>
            {d('retry')}
          </Button>
        </div>
      )}

      {/* ── Content ────────────────────────────────────────────────────────────── */}
      {!isLoading && !error && (
        <div data-testid="dedup-content">
          {activeTab === 'queue' && (
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
              {/* Bulk action bar */}
              <DedupBulkActionBar
                selectedCount={selectedPhones.size}
                onDismissSelected={handleDismissSelected}
                onClearSelection={() => setSelectedPhones(new Set())}
                isLoading={isDismissingBulk}
              />

              {/* Group list (includes empty state internally) */}
              <DedupGroupList
                groups={groups}
                selectedPhones={selectedPhones}
                onToggleSelect={handleToggleSelect}
                onToggleSelectAll={handleToggleSelectAll}
                onOpenMerge={setMergePhone}
                onDismiss={handleDismiss}
              />
            </div>
          )}
        </div>
      )}

      {/* ── Merge modal ────────────────────────────────────────────────────────── */}
      {mergePhone && (
        <MergeCompareModal
          phoneNormalized={mergePhone}
          onClose={() => setMergePhone(null)}
          onMergeSuccess={() => {
            setMergePhone(null);
            refetch();
          }}
        />
      )}
    </PageContainer>
  );
}
