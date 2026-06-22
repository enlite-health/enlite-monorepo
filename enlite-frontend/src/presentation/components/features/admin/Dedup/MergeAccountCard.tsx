/**
 * MergeAccountCard
 *
 * Card showing one account's key data inside the Compare & Merge modal.
 * Highlighted when it's the current survivor selection.
 */

import { useTranslation } from 'react-i18next';
import { CheckCircle2 } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import type { DedupAccount } from '@domain/entities/DedupGroup';

interface MergeAccountCardProps {
  account: DedupAccount;
  isSurvivor: boolean;
  onSelectSurvivor: () => void;
}

// new Date() + toLocaleString never throw in V8 (invalid input → 'Invalid Date' string).
function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function MergeAccountCard({
  account,
  isSurvivor,
  onSelectSurvivor,
}: MergeAccountCardProps) {
  const { t } = useTranslation();

  return (
    <div
      className={`rounded-xl border p-4 flex flex-col gap-3 transition-all ${
        isSurvivor
          ? 'border-primary bg-primary/5 shadow-sm'
          : 'border-slate-200 bg-white'
      }`}
      data-testid={`merge-account-card-${account.id}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5 min-w-0">
          <Heading level={4} weight="semibold" color={isSurvivor ? 'primary' : undefined}>
            {account.email ?? t('admin.dedup.merge.noEmail', 'Sin email')}
          </Heading>
          <span
            className={`inline-flex w-fit px-2 py-0.5 rounded-full ${
              isSurvivor
                ? 'bg-primary/10 text-primary'
                : 'bg-slate-100 text-slate-600'
            }`}
          >
            <Text as="span" size="xs" weight="medium" color="inherit">
              {t(`admin.dedup.tier.${account.tier}`, { defaultValue: account.tier })}
            </Text>
          </span>
        </div>

        {isSurvivor ? (
          <div className="flex items-center gap-1 text-primary shrink-0">
            <CheckCircle2 className="w-5 h-5" />
            <Text as="span" size="xs" weight="semibold" color="primary">
              {t('admin.dedup.merge.survivor', 'Principal')}
            </Text>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={onSelectSurvivor}
          >
            {t('admin.dedup.merge.setSurvivor', 'Elegir como principal')}
          </Button>
        )}
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: t('admin.dedup.merge.wjaCount', 'Postulaciones'), value: account.wja_count },
          { label: t('admin.dedup.merge.docsCount', 'Documentos'), value: account.docs_count },
          { label: t('admin.dedup.merge.encuadresCount', 'Encuadres'), value: account.encuadres_count },
        ].map(({ label, value }) => (
          <div key={label} className="flex flex-col items-center bg-slate-50 rounded-lg p-2">
            <Text as="span" size="xs" color="muted">{label}</Text>
            <Text as="span" size="sm" weight="semibold">{value}</Text>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between">
        <Text as="span" size="xs" color="muted">
          {t('admin.dedup.merge.createdAt', 'Alta')}: {formatDate(account.created_at)}
        </Text>
        {account.login_real ? (
          <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
            <Text as="span" size="xs" weight="medium" color="inherit">
              {t('admin.dedup.merge.realLogin', 'Login real')}
            </Text>
          </span>
        ) : (
          <span className="bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full">
            <Text as="span" size="xs" weight="medium" color="inherit">
              {t('admin.dedup.merge.testLogin', 'Sin login real')}
            </Text>
          </span>
        )}
      </div>
    </div>
  );
}
