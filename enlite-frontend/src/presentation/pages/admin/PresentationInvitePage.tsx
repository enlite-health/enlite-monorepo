/**
 * PresentationInvitePage — /admin/invitacion-presentacion (REQ-09 / REQ-20, planning 26/08).
 * Config da reunião recorrente ("eterna", um a um): link + horário + template + ligado.
 * Quem tem `messaging:write` edita (auditado no backend); os demais só leem.
 * Contadores dos últimos 30 dias.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AdminPresentationInviteApiService, type PresentationInviteSettings, type PresentationInviteStats,
} from '@infrastructure/http/AdminPresentationInviteApiService';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { Label } from '@presentation/components/atoms/Label';

type SaveState = { status: 'idle' | 'saving' | 'saved' | 'error'; error?: string };

export function PresentationInvitePage() {
  const { t } = useTranslation();
  // PUT /presentation-invite/settings → messaging:write. Sem papel: a célula é
  // o freio, e com o engine desligado o gate deixa passar (D268).
  const { allowed: canWrite, denied: writeDenied } = useActionGate('messaging', 'update');
  const [settings, setSettings] = useState<PresentationInviteSettings | null>(null);
  const [stats, setStats] = useState<PresentationInviteStats | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState({ templateSlug: '', meetLink: '', scheduleLabel: '', enabled: false });
  const [save, setSave] = useState<SaveState>({ status: 'idle' });

  const load = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([AdminPresentationInviteApiService.getSettings(), AdminPresentationInviteApiService.stats()]);
      setSettings(s); setStats(st);
      setForm({ templateSlug: s.templateSlug ?? '', meetLink: s.meetLink ?? '', scheduleLabel: s.scheduleLabel ?? '', enabled: s.enabled });
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const canEnable = !!form.templateSlug && !!form.meetLink;
  const onSave = async () => {
    setSave({ status: 'saving' });
    try {
      await AdminPresentationInviteApiService.updateSettings({
        templateSlug: form.templateSlug || null, meetLink: form.meetLink || null, scheduleLabel: form.scheduleLabel || null,
        enabled: form.enabled && canEnable,
      });
      setSave({ status: 'saved' });
      await load();
    } catch (err) {
      setSave({ status: 'error', error: err instanceof Error ? err.message : t('admin.presentationInvite.error') });
    }
  };

  // Só se lê dentro de `{stats && …}` — o parâmetro evita o `?? 0` de um "stats null" que nunca chega aqui.
  const count = (rows: PresentationInviteStats['rows'], status: string) => rows.filter((r) => r.status === status).reduce((a, r) => a + r.count, 0);
  const bySource = (rows: PresentationInviteStats['rows'], source: string) => rows.filter((r) => r.status === 'queued' && r.source === source).reduce((a, r) => a + r.count, 0);

  return (
    <div className="p-6 max-w-4xl" data-testid="presentation-invite-page">
      <Heading level={1}>{t('admin.presentationInvite.title')}</Heading>
      <Text size="sm" color="secondary" className="mt-1">{t('admin.presentationInvite.subtitle')}</Text>
      {writeDenied && <div className="mt-1" data-testid="pi-no-write-access"><Text size="xs" color="secondary">{t('admin.presentationInvite.noWriteAccess')}</Text></div>}
      {loadError && <div className="mt-4" data-testid="pi-load-error"><Text size="sm" color="inherit" className="text-red-600">{loadError}</Text></div>}

      {settings && (
        <div className="mt-6 grid gap-4 rounded-xl border border-gray-200 bg-white p-5" data-testid="pi-form">
          <div>
            <Label htmlFor="pi-meet-link">{t('admin.presentationInvite.meetLink')}</Label>
            <input id="pi-meet-link" data-testid="pi-meet-link" type="url" disabled={!canWrite} value={form.meetLink}
              onChange={(e) => { setForm((f) => ({ ...f, meetLink: e.target.value })); setSave({ status: 'idle' }); }}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50" placeholder="https://meet.google.com/…" />
          </div>
          <div>
            <Label htmlFor="pi-schedule">{t('admin.presentationInvite.scheduleLabel')}</Label>
            <input id="pi-schedule" data-testid="pi-schedule-label" type="text" maxLength={200} disabled={!canWrite} value={form.scheduleLabel}
              onChange={(e) => { setForm((f) => ({ ...f, scheduleLabel: e.target.value })); setSave({ status: 'idle' }); }}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50" placeholder={t('admin.presentationInvite.scheduleLabelHint')} />
          </div>
          <div>
            <Label htmlFor="pi-template">{t('admin.presentationInvite.template')}</Label>
            <select id="pi-template" data-testid="pi-template" disabled={!canWrite} value={form.templateSlug}
              onChange={(e) => { setForm((f) => ({ ...f, templateSlug: e.target.value, enabled: f.enabled && !!e.target.value })); setSave({ status: 'idle' }); }}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50">
              <option value="">—</option>
              {settings.templates.map((tp) => (
                <option key={tp.slug} value={tp.slug} disabled={!tp.eligible && tp.reason !== 'INACTIVE'}>
                  {tp.slug}{tp.reason ? ` — ${t(`admin.presentationInvite.ineligible.${tp.reason}`)}` : ''}
                </option>
              ))}
            </select>
            <Text size="xs" color="secondary" className="mt-1">{t('admin.presentationInvite.templateHint')}</Text>
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" data-testid="pi-enabled" disabled={!canWrite || !canEnable} checked={form.enabled && canEnable}
              onChange={(e) => { setForm((f) => ({ ...f, enabled: e.target.checked })); setSave({ status: 'idle' }); }} />
            <Text as="span" size="sm">{t('admin.presentationInvite.enabled')}</Text>
          </label>
          <div className="flex items-center gap-3">
            {canWrite && <Button size="sm" data-testid="pi-save" disabled={save.status === 'saving'} onClick={onSave}>{t('admin.presentationInvite.save')}</Button>}
            {save.status === 'saved' && <span className="text-green-700" data-testid="pi-saved"><Text as="span" size="xs" color="inherit">{t('admin.presentationInvite.saved')}</Text></span>}
            {save.status === 'error' && <span className="text-red-600" data-testid="pi-error"><Text as="span" size="xs" color="inherit">{save.error}</Text></span>}
            <span data-testid="pi-last-edit"><Text as="span" size="xs" color="secondary">
              {t('admin.presentationInvite.lastEdit')}: {settings.updatedAt ? new Date(settings.updatedAt).toLocaleString('es-AR') : '—'}{settings.updatedBy ? ` ${t('admin.presentationInvite.by')} ${settings.updatedBy}` : ''}
            </Text></span>
          </div>
        </div>
      )}

      {stats && (
        <div className="mt-6 rounded-xl border border-gray-200 bg-white p-5" data-testid="pi-stats">
          <Heading level={3}>{t('admin.presentationInvite.stats.title')}</Heading>
          <div className="mt-3 grid grid-cols-3 gap-4">
            <div><Text size="xs" color="secondary">{t('admin.presentationInvite.stats.queued')}</Text><span data-testid="pi-stat-queued"><Text as="span" size="xl" weight="semibold">{count(stats.rows, 'queued')}</Text></span></div>
            <div><Text size="xs" color="secondary">{t('admin.presentationInvite.stats.skipped')}</Text><span data-testid="pi-stat-skipped"><Text as="span" size="xl" weight="semibold">{count(stats.rows, 'skipped')}</Text></span></div>
            <div><Text size="xs" color="secondary">{t('admin.presentationInvite.stats.attended')}</Text><span data-testid="pi-stat-attended"><Text as="span" size="xl" weight="semibold">{stats.attended}</Text></span></div>
          </div>
          <Text size="xs" color="secondary" className="mt-2">
            {t('admin.presentationInvite.stats.bySource')}: {t('admin.presentationInvite.stats.kanban')} {bySource(stats.rows, 'kanban')} · {t('admin.presentationInvite.stats.workers_list')} {bySource(stats.rows, 'workers_list')}
          </Text>
          <Text size="xs" color="secondary" className="mt-1">{t('admin.presentationInvite.stats.noPresenceSource')}</Text>
        </div>
      )}
    </div>
  );
}

export default PresentationInvitePage;
