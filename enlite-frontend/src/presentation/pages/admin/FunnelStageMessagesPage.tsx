import { useCallback, useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AdminFunnelStageMessagesApiService, type FunnelStageMessagesConfig, type FunnelStageMessageRow } from '@infrastructure/http/AdminFunnelStageMessagesApiService';
import { useAdminAuth } from '@presentation/hooks/useAdminAuth';
import { EnliteRole } from '@domain/entities/EnliteRole';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { Select, type SelectOption } from '@presentation/components/atoms/Select';
import { Checkbox } from '@presentation/components/atoms/Checkbox';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@presentation/components/atoms/Table';

/**
 * /admin/mensajes-por-etapa — DEC-12 / PEND-14 (planning 26/08).
 * Uma linha por etapa do Kanban: template (só os elegíveis), ligado/desligado,
 * quem editou. Leitura para o staff; escrita só para ADMIN (lex 29/08 C7).
 * QUALIFIED é built-in (convite de entrevista) e não se edita aqui.
 */
type RowState = { templateSlug: string; enabled: boolean; status: 'idle' | 'saving' | 'saved' | 'error'; error?: string };

/** Só é chamado com `updatedAt` presente; ISO inválido vira "Invalid Date" na tela (visível, não mascarado). */
function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function FunnelStageMessagesPage(): JSX.Element {
  const { t } = useTranslation();
  const { adminProfile } = useAdminAuth();
  const isAdmin = adminProfile?.role === EnliteRole.ADMIN;
  const [config, setConfig] = useState<FunnelStageMessagesConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const data = await AdminFunnelStageMessagesApiService.getFunnelStageMessages();
      setConfig(data);
      const next: Record<string, RowState> = {};
      for (const s of data.stages) next[s.stage] = { templateSlug: s.templateSlug ?? '', enabled: s.enabled, status: 'idle' };
      setRows(next);
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : 'error');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const patch = (stage: string, p: Partial<RowState>) => setRows((prev) => ({ ...prev, [stage]: { ...prev[stage], ...p, status: 'idle', error: undefined } }));

  const save = async (stage: string) => {
    const r = rows[stage];
    setRows((prev) => ({ ...prev, [stage]: { ...prev[stage], status: 'saving', error: undefined } }));
    try {
      await AdminFunnelStageMessagesApiService.updateFunnelStageMessage(stage, { templateSlug: r.templateSlug || null, enabled: r.enabled && !!r.templateSlug });
      setRows((prev) => ({ ...prev, [stage]: { ...prev[stage], enabled: r.enabled && !!r.templateSlug, status: 'saved' } }));
      const data = await AdminFunnelStageMessagesApiService.getFunnelStageMessages();
      setConfig(data);
    } catch (err: unknown) {
      setRows((prev) => ({ ...prev, [stage]: { ...prev[stage], status: 'error', error: err instanceof Error ? err.message : t('admin.funnelStageMessages.error') } }));
    }
  };

  const templateOptions: SelectOption[] = [
    { value: '', label: t('admin.funnelStageMessages.none') },
    ...(config?.templates ?? []).map((tp) => ({
      value: tp.slug,
      label: tp.eligible ? tp.slug : `${tp.slug} — ${t(`admin.funnelStageMessages.ineligible.${tp.reason ?? 'PLACEHOLDERS'}`)}`,
      disabled: !tp.eligible,
    })),
  ];

  // QUALIFIED e IN_DOUBT não são colunas do Kanban: nome próprio desta tela (nunca o enum cru)
  const stageLabel = (stage: string) => t(`admin.kanban.columns.${stage}`, t(`admin.funnelStageMessages.stages.${stage}`, stage));

  return (
    <PageContainer>
      <div className="mb-4">
        <Heading level={1}>{t('admin.funnelStageMessages.title')}</Heading>
        <Text size="sm" color="secondary">{t('admin.funnelStageMessages.subtitle')}</Text>
        <Text size="xs" color="secondary">{t('admin.funnelStageMessages.eligibleHint')}</Text>
        {/* Este aviso muda o que a pessoa PODE FAZER; o subtítulo e a dica acima
            não. Renderizados iguais (3 linhas cinzas de 12px), o único que
            importa some no meio dos outros dois. */}
        {!isAdmin && (
          <div
            className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2"
            data-testid="fsm-admin-only"
            role="status"
          >
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden />
            <Text size="sm" color="inherit" className="text-amber-900">{t('admin.funnelStageMessages.adminOnly')}</Text>
          </div>
        )}
      </div>

      {loadError && <div data-testid="fsm-load-error" className="mb-3 rounded-lg px-4 py-2 bg-red-50 border border-red-200"><Text size="sm" color="inherit" className="text-red-700">{loadError}</Text></div>}

      {config && (
        <Table data-testid="fsm-table">
          {/* Sem <TableRow> aqui: o TableHeader já emite o próprio <tr>. Envolver
              em outro produzia <tr> dentro de <tr>; o parser desfazia o
              aninhamento e o cabeçalho saía do cálculo de colunas da tabela —
              os títulos ficavam numa faixa de 349px sobre linhas de 1096px, sem
              nenhum alinhar com a sua coluna. */}
          <TableHeader>
            <TableHead>{t('admin.funnelStageMessages.stage')}</TableHead>
            <TableHead>{t('admin.funnelStageMessages.template')}</TableHead>
            <TableHead>{t('admin.funnelStageMessages.enabled')}</TableHead>
            <TableHead>{t('admin.funnelStageMessages.updatedBy')}</TableHead>
            <TableHead unwrapped><span /></TableHead>
          </TableHeader>
          <TableBody>
            {config.stages.map((s: FunnelStageMessageRow) => {
              // `rows` nasce junto de `config` (mesmo load, mesmo render): toda etapa tem linha.
              const r = rows[s.stage];
              const builtin = !!s.builtin;
              return (
                <TableRow key={s.stage} clickable={false} data-testid={`fsm-row-${s.stage}`}>
                  <TableCell weight="medium">{stageLabel(s.stage)}</TableCell>
                  <TableCell unwrapped>
                    {builtin ? (
                      <Text size="xs" color="secondary">{t('admin.funnelStageMessages.builtin')}</Text>
                    ) : (
                      <Select data-testid={`fsm-template-${s.stage}`} options={templateOptions} value={r.templateSlug} disabled={!isAdmin} onValueChange={(v) => patch(s.stage, { templateSlug: v, enabled: v ? r.enabled : false })} aria-label={t('admin.funnelStageMessages.template')} />
                    )}
                  </TableCell>
                  <TableCell unwrapped>
                    {!builtin && (
                      <Checkbox
                        data-testid={`fsm-enabled-${s.stage}`}
                        checked={r.enabled}
                        disabled={!isAdmin || !r.templateSlug}
                        onChange={(e) => patch(s.stage, { enabled: e.target.checked })}
                        aria-label={t('admin.funnelStageMessages.enabled')}
                        className={!isAdmin || !r.templateSlug ? 'opacity-40' : ''}
                      />
                    )}
                  </TableCell>
                  <TableCell unwrapped>
                    <Text size="xs" color="secondary">{s.updatedAt ? `${s.updatedBy ?? '—'} · ${formatWhen(s.updatedAt)}` : t('admin.funnelStageMessages.never')}</Text>
                  </TableCell>
                  <TableCell unwrapped align="right">
                    {!builtin && isAdmin && (
                      <span className="inline-flex items-center gap-2">
                        <Button variant="primary" size="sm" data-testid={`fsm-save-${s.stage}`} disabled={r.status === 'saving'} onClick={() => void save(s.stage)}>
                          {r.status === 'saving' ? t('admin.funnelStageMessages.saving') : t('admin.funnelStageMessages.save')}
                        </Button>
                        {r.status === 'saved' && <span className="text-green-700" data-testid={`fsm-saved-${s.stage}`}><Text as="span" size="xs" color="inherit">{t('admin.funnelStageMessages.saved')}</Text></span>}
                        {r.status === 'error' && <span className="text-red-600" data-testid={`fsm-error-${s.stage}`}><Text as="span" size="xs" color="inherit">{r.error}</Text></span>}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </PageContainer>
  );
}
