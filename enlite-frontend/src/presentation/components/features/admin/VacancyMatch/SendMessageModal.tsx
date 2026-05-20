import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, ChevronDown } from 'lucide-react';
import { Typography } from '@presentation/components/atoms/Typography';
import { Button } from '@presentation/components/atoms/Button';
import { useMatchMessaging } from '@hooks/admin/useMatchMessaging';
import type { SavedCandidate, MessageTemplate } from '../../../../../types/match';

interface SendMessageModalProps {
  candidates: SavedCandidate[];
  vacancyId: string;
  onClose: () => void;
  onMessaged: (workerId: string, messagedAt: string) => void;
}

// Variables são montadas server-side em /api/admin/messaging/whatsapp/preview e
// /api/admin/messaging/whatsapp. O frontend não computa nem envia variáveis pra
// templates `ar_vacancy_match_*` — backend resolve worker_name (PII), vacancy_url
// e pending_documents a partir do workerId + jobPostingId.

export function SendMessageModal({
  candidates,
  vacancyId,
  onClose,
  onMessaged,
}: SendMessageModalProps) {
  const { t } = useTranslation();
  const {
    templates,
    isLoadingTemplates,
    isSending,
    progress,
    fetchTemplates,
    fetchPreview,
    sendBatch,
    resetProgress,
  } = useMatchMessaging(vacancyId);

  const [selectedSlug, setSelectedSlug] = useState('ar_vacancy_match_complete');
  const [showConfirmRenotify, setShowConfirmRenotify] = useState(false);
  const [previewText, setPreviewText] = useState<string>('');
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  useEffect(() => {
    if (templates.length > 0 && !templates.find(t => t.slug === selectedSlug)) {
      setSelectedSlug(templates[0].slug);
    }
  }, [templates, selectedSlug]);

  const selectedTemplate: MessageTemplate | undefined = templates.find(
    t => t.slug === selectedSlug,
  );

  // Preview server-side: pega o body exato (com PII resolvida) usando o
  // primeiro candidato da lista como base. Re-fetch quando template ou
  // candidato mudam.
  const previewWorkerId = candidates[0]?.workerId;
  useEffect(() => {
    if (!selectedTemplate || !previewWorkerId) {
      setPreviewText('');
      return;
    }
    let cancelled = false;
    setIsLoadingPreview(true);
    fetchPreview(previewWorkerId, selectedSlug)
      .then(rendered => {
        if (cancelled) return;
        setPreviewText(rendered ?? selectedTemplate.body);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingPreview(false);
      });
    return () => { cancelled = true; };
  }, [selectedSlug, previewWorkerId, selectedTemplate, fetchPreview]);

  const alreadyNotified = candidates.filter(c => c.messagedAt != null);
  const notYetNotified = candidates.filter(c => c.messagedAt == null);

  const started = progress.length > 0;
  const done = started && !isSending;
  const sentCount = progress.filter(p => p.status === 'sent').length;
  const errorCount = progress.filter(p => p.status === 'error').length;

  const handleConfirmSend = () => {
    if (alreadyNotified.length > 0 && !showConfirmRenotify) {
      setShowConfirmRenotify(true);
      return;
    }
    doSend();
  };

  const doSend = (subset?: SavedCandidate[]) => {
    // Para templates server-side (ar_vacancy_match_*) o backend ignora variables
    // e monta server-side. Mandamos {} pra preservar a assinatura do sendBatch.
    sendBatch(
      subset ?? candidates,
      selectedSlug,
      () => ({}),
      onMessaged,
    );
  };

  const handleClose = () => {
    resetProgress();
    setShowConfirmRenotify(false);
    onClose();
  };


  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <Typography variant="h3" weight="semibold" className="text-[#737373] font-poppins">
            {t('admin.messaging.title')}
          </Typography>
          <button
            onClick={handleClose}
            className="text-[#737373] hover:text-red-500 transition-colors text-xl leading-none"
            aria-label={t('common.close')}
          >
            ×
          </button>
        </div>

        {!started && (
          <>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-slate-700">{t('admin.messaging.templateLabel')}</label>
              {isLoadingTemplates ? (
                <div className="flex items-center gap-2 text-sm text-[#737373]">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('admin.messaging.loadingTemplates')}
                </div>
              ) : (
                <div className="relative">
                  <select
                    value={selectedSlug}
                    onChange={e => setSelectedSlug(e.target.value)}
                    className="w-full appearance-none border border-[#D9D9D9] rounded-lg px-3 py-2 text-sm text-slate-700 bg-white pr-8 focus:outline-none focus:ring-2 focus:ring-primary/30"
                  >
                    {templates.map(t => (
                      <option key={t.slug} value={t.slug}>
                        {t.name} ({t.slug})
                      </option>
                    ))}
                    {templates.length === 0 && (
                      <option value="vacancy_match">{t('admin.messaging.defaultTemplateLabel')}</option>
                    )}
                  </select>
                  <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#737373] pointer-events-none" />
                </div>
              )}
            </div>

            {selectedTemplate && (
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-slate-700">
                  {t('admin.messaging.previewLabel')}{candidates.length > 1 && candidates[0] && (
                    <span className="font-normal text-[#737373]">{t('admin.messaging.previewFor', { name: candidates[0].workerName })}</span>
                  )}
                </label>
                <div className="bg-[#F5F5F5] rounded-xl px-4 py-3 text-sm text-slate-700 whitespace-pre-wrap leading-relaxed border border-[#D9D9D9] min-h-[3rem]">
                  {isLoadingPreview ? (
                    <span className="inline-flex items-center gap-2 text-[#737373]">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {t('admin.messaging.loadingPreview', { defaultValue: 'Cargando vista previa…' })}
                    </span>
                  ) : (
                    previewText || selectedTemplate.body
                  )}
                </div>
              </div>
            )}

            <div className="text-sm text-slate-600">
              {candidates.length === 1 ? (
                <>
                  {t('admin.messaging.sendToOneBefore')}
                  <strong>{candidates[0].workerName}</strong>
                  {t('admin.messaging.sendToOneAfter')}
                </>
              ) : (
                <>{t('admin.messaging.selectedWorkers', { count: candidates.length })}</>
              )}
              {alreadyNotified.length > 0 && (
                <span className="ml-1 text-amber-700">
                  {' '}
                  {t('admin.messaging.alreadyNotified', { count: alreadyNotified.length })}
                </span>
              )}
            </div>

            {showConfirmRenotify && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
                {t('admin.messaging.alreadyReceivedMessage', { count: alreadyNotified.length })}
                {notYetNotified.length > 0 && (
                  <span> {t('admin.messaging.notYetReceived', { count: notYetNotified.length })}</span>
                )}
                <span> {t('admin.messaging.confirmResendQuestion')}</span>
              </div>
            )}

            <div className="flex justify-end gap-3">
              <Button variant="outline" size="sm" onClick={handleClose}>
                {t('common.cancel')}
              </Button>
              {showConfirmRenotify ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setShowConfirmRenotify(false); doSend(notYetNotified); }}
                    className="border-amber-300 text-amber-700 hover:bg-amber-50"
                  >
                    {t('admin.messaging.newOnly', { count: notYetNotified.length })}
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => doSend()}>
                    {t('admin.messaging.resendAll')}
                  </Button>
                </>
              ) : (
                <Button variant="primary" size="sm" onClick={handleConfirmSend}>
                  {t('admin.messaging.confirmSend')}
                </Button>
              )}
            </div>
          </>
        )}

        {started && (
          <div className="flex flex-col gap-2">
            {progress.map(p => (
              <div key={p.workerId} className="flex items-center justify-between text-sm">
                <span className="text-slate-700">{p.workerName}</span>
                <span
                  className={
                    p.status === 'sent'
                      ? 'text-green-600'
                      : p.status === 'error'
                      ? 'text-red-500'
                      : p.status === 'sending'
                      ? 'text-primary animate-pulse'
                      : 'text-[#737373]'
                  }
                >
                  {p.status === 'sent'
                    ? t('admin.messaging.statusSent')
                    : p.status === 'error'
                    ? `${t('admin.messaging.statusErrorPrefix')}${p.error ?? t('admin.messaging.statusErrorFallback')}`
                    : p.status === 'sending'
                    ? t('admin.messaging.statusSending')
                    : t('admin.messaging.statusWaiting')}
                </span>
              </div>
            ))}

            {isSending && (
              <div className="flex items-center gap-2 text-primary text-sm mt-1">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('admin.messaging.sending')}
              </div>
            )}

            {done && (
              <div className="mt-2 pt-3 border-t border-[#D9D9D9] flex items-center justify-between">
                <Typography variant="body" weight="medium" className="text-slate-700">
                  {t('admin.messaging.doneLabel')}{' '}
                  {t('admin.messaging.doneSent', { count: sentCount })},{' '}
                  {t('admin.messaging.doneErrors', { count: errorCount })}
                </Typography>
                <Button variant="outline" size="sm" onClick={handleClose}>
                  {t('common.close')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
