import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminPermissionsApiService, type CountryFeature } from '@infrastructure/http/AdminPermissionsApiService';
import { Heading, Text, Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Input, Label } from '@presentation/components/atoms';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { ActionButton, PanelErrorAlert } from '@presentation/components/features/access';
import { useCellAccess } from '@presentation/hooks/useCellAccess';
import { AccessGate, PANEL_RESOURCE } from './AccessGate';
import { panelErrorKey } from './panelErrors';

/** `/admin/access/features` — a matriz país × função. Ligar/desligar é `ActionButton`. */
export function CountryFeaturesPage(): JSX.Element {
  return (
    <AccessGate>
      <FeaturesMatrix />
    </AccessGate>
  );
}

function FeaturesMatrix(): JSX.Element {
  const { t } = useTranslation();
  const { canWrite } = useCellAccess(PANEL_RESOURCE);
  const [features, setFeatures] = useState<CountryFeature[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setFeatures(await AdminPermissionsApiService.listCountryFeatures());
    } catch {
      setError('admin.access.features.loadError');
    } finally {
      setIsLoading(false);
    }
  // `t` fora das deps de propósito: a chave é guardada e traduzida no render.
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = async (f: CountryFeature) => {
    setError(null);
    try {
      await AdminPermissionsApiService.setCountryFeature(f.country, f.featureKey, {
        enabled: !f.enabled,
        config: f.config,
        reason: reason.trim(),
      });
      await load();
    } catch (err) {
      setError(panelErrorKey(err));
    }
  };

  return (
    <div className="space-y-4">
      <Heading level={2} weight="semibold" color="primary">{t('admin.access.features.title')}</Heading>
      {canWrite && (
        <div className="max-w-md">
          <Label htmlFor="feat-reason">{t('admin.access.features.reason')}</Label>
          <Input id="feat-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('admin.access.group.reasonPlaceholder')} />
        </div>
      )}
      <PanelErrorAlert keyName={error} />
      {isLoading ? (
        <TableSkeleton />
      ) : (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden border border-gray-400">
          <Table>
            <TableHeader>
              <TableHead>{t('admin.access.features.country')}</TableHead>
              <TableHead>{t('admin.access.features.feature')}</TableHead>
              <TableHead>{t('admin.access.features.enabled')}</TableHead>
              <TableHead>{t('admin.access.features.source')}</TableHead>
              <TableHead>{t('admin.access.features.updatedAt')}</TableHead>
              <TableHead align="right" />
            </TableHeader>
            <TableBody>
              {features.map((f) => (
                <TableRow key={`${f.country}/${f.featureKey}`}>
                  <TableCell weight="medium">{f.country}</TableCell>
                  <TableCell><span className="font-mono text-xs">{f.featureKey}</span></TableCell>
                  <TableCell>{f.enabled ? '✓' : '—'}</TableCell>
                  <TableCell>{t(`admin.access.features.${f.source}`)}</TableCell>
                  <TableCell>{new Date(f.updatedAt).toLocaleDateString('es-AR')}</TableCell>
                  <TableCell unwrapped align="right">
                    <ActionButton resource={PANEL_RESOURCE} size="sm" variant="ghost" disabled={!reason.trim()} onClick={() => toggle(f)}>
                      {f.enabled ? t('admin.access.features.disable') : t('admin.access.features.enable')}
                    </ActionButton>
                  </TableCell>
                </TableRow>
              ))}
              {features.length === 0 && (
                <TableRow>
                  <TableCell unwrapped colSpan={6} className="px-6 py-8 text-center">
                    <Text as="span" size="sm" color="secondary">{t('admin.access.features.empty')}</Text>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
