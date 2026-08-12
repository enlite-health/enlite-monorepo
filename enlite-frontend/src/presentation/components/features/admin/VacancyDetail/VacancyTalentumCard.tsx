import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Loader2,
  RefreshCw,
  Copy,
  Check,
  ExternalLink,
  AlertTriangle,
  Radio,
} from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Button } from '@presentation/components/atoms/Button';
import { AdminApiService } from '@infrastructure/http/AdminApiService';

interface VacancyTalentumCardProps {
  vacancyId: string;
  talentumProjectId: string | null;
  talentumWhatsappUrl: string | null;
  talentumSlug: string | null;
  talentumPublishedAt: string | null;
  talentumDescription: string | null;
  onRefresh: () => void;
}

export function VacancyTalentumCard({
  vacancyId,
  talentumProjectId,
  talentumWhatsappUrl,
  talentumSlug,
  talentumPublishedAt,
  talentumDescription,
  onRefresh,
}: VacancyTalentumCardProps) {
  const { t } = useTranslation();
  const tk = 'admin.vacancyDetail.talentumCard';

  const isPublished = !!talentumProjectId;

  const [questionsCount, setQuestionsCount] = useState<number | null>(null);
  const [description, setDescription] = useState(talentumDescription ?? '');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isUnpublishing, setIsUnpublishing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  useEffect(() => {
    setDescription(talentumDescription ?? '');
  }, [talentumDescription]);

  useEffect(() => {
    let cancelled = false;
    AdminApiService.getPrescreeningConfig(vacancyId)
      .then(data => {
        if (!cancelled) setQuestionsCount(data.questions?.length ?? 0);
      })
      .catch(() => {
        if (!cancelled) setQuestionsCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [vacancyId]);

  // A geração leva ~40s; avisa antes de recarregar/fechar pra não perder o
  // preview (que só persiste ao Guardar/Publicar) e não abortar o request.
  useEffect(() => {
    if (!isGenerating) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isGenerating]);

  const hasQuestions = questionsCount !== null && questionsCount > 0;
  const switchDisabled =
    isPublishing || isUnpublishing || (questionsCount !== null && !hasQuestions);

  const clearFeedback = useCallback(() => {
    setTimeout(() => setFeedback(null), 5000);
  }, []);

  const handleGenerateDescription = async () => {
    try {
      setIsGenerating(true);
      setFeedback(null);
      const result = await AdminApiService.generateAIContent(vacancyId);
      setDescription(result.description);
      onRefresh();
    } catch (err: unknown) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : t(`${tk}.generateError`),
      });
      clearFeedback();
    } finally {
      setIsGenerating(false);
    }
  };

  const handlePublish = async () => {
    if (!window.confirm(t(`${tk}.confirmPublish`))) return;
    try {
      setIsPublishing(true);
      setFeedback(null);
      await AdminApiService.publishToTalentum(vacancyId);
      setFeedback({ type: 'success', message: t(`${tk}.publishSuccess`) });
      clearFeedback();
      onRefresh();
    } catch (err: unknown) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : t(`${tk}.publishError`),
      });
      clearFeedback();
    } finally {
      setIsPublishing(false);
    }
  };

  const handleUnpublish = async () => {
    if (!window.confirm(t(`${tk}.confirmUnpublish`))) return;
    try {
      setIsUnpublishing(true);
      setFeedback(null);
      await AdminApiService.unpublishFromTalentum(vacancyId);
      setFeedback({ type: 'success', message: t(`${tk}.unpublishSuccess`) });
      clearFeedback();
      onRefresh();
    } catch (err: unknown) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : t(`${tk}.unpublishError`),
      });
      clearFeedback();
    } finally {
      setIsUnpublishing(false);
    }
  };

  const handleToggle = () => {
    if (isPublished) {
      handleUnpublish();
    } else {
      handlePublish();
    }
  };

  const handleCopy = async () => {
    if (!talentumWhatsappUrl) return;
    await navigator.clipboard.writeText(talentumWhatsappUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const publishedDate = talentumPublishedAt
    ? new Date(talentumPublishedAt).toLocaleString('es-AR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  return (
    <div data-testid="talentum-card" className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Radio className="w-5 h-5 text-[#737373]" />
          <Heading level={3} weight="semibold" color="secondary">
            {t(`${tk}.title`)}
          </Heading>
        </div>
        {isPublished && (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-green-100 text-green-700 text-sm font-medium">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            {t(`${tk}.active`)}
          </span>
        )}
      </div>

      {/* Published state: WhatsApp link + metadata */}
      {isPublished && talentumWhatsappUrl && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
              {t(`${tk}.whatsappLink`)}
            </span>
            <div className="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2">
              <span className="text-sm text-slate-700 truncate flex-1">
                {talentumWhatsappUrl}
              </span>
              <button
                onClick={handleCopy}
                className="shrink-0 p-1.5 rounded-md hover:bg-slate-200 transition-colors"
                title={t(`${tk}.copyLink`)}
              >
                {copied ? (
                  <Check className="w-4 h-4 text-green-600" />
                ) : (
                  <Copy className="w-4 h-4 text-slate-500" />
                )}
              </button>
              <a
                href={talentumWhatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 p-1.5 rounded-md hover:bg-slate-200 transition-colors"
                title={t(`${tk}.openWhatsApp`)}
              >
                <ExternalLink className="w-4 h-4 text-slate-500" />
              </a>
            </div>
            {copied && (
              <span className="text-xs text-green-600">{t(`${tk}.copied`)}</span>
            )}
          </div>

          <div className="grid grid-cols-3 gap-4">
            {talentumSlug && (
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                  {t(`${tk}.slug`)}
                </span>
                <span className="text-sm text-slate-700">#{talentumSlug}</span>
              </div>
            )}
            {publishedDate && (
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                  {t(`${tk}.publishedAt`)}
                </span>
                <span className="text-sm text-slate-700">{publishedDate}</span>
              </div>
            )}
            {questionsCount !== null && (
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                  {t(`${tk}.questionsCount`)}
                </span>
                <span className="text-sm text-slate-700">{questionsCount}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Unpublished state: description preview + regenerate */}
      {!isPublished && (
        <div className="flex flex-col gap-3">
          <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
            {t(`${tk}.description`)}
          </span>
          {isGenerating ? (
            <div
              role="status"
              aria-live="polite"
              className="bg-slate-50 rounded-lg px-4 py-3 flex flex-col gap-3"
            >
              <div className="flex items-center gap-2 text-sm font-medium text-primary">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{t(`${tk}.generating`)}</span>
              </div>
              <div className="flex flex-col gap-2 animate-pulse" aria-hidden="true">
                <div className="h-3 rounded bg-slate-200 w-full" />
                <div className="h-3 rounded bg-slate-200 w-11/12" />
                <div className="h-3 rounded bg-slate-200 w-4/5" />
                <div className="h-3 rounded bg-slate-200 w-2/3" />
              </div>
              <span className="flex items-start gap-1.5 text-xs text-amber-600">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                {t(`${tk}.generatingHint`)}
              </span>
            </div>
          ) : description ? (
            <div className="bg-slate-50 rounded-lg px-4 py-3 text-sm text-slate-700 whitespace-pre-line max-h-48 overflow-y-auto">
              {description}
            </div>
          ) : (
            <p className="text-sm text-slate-400">{t(`${tk}.noDescription`)}</p>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleGenerateDescription}
            disabled={isGenerating}
            className="flex items-center gap-2 w-fit"
          >
            {isGenerating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            {isGenerating ? t(`${tk}.generating`) : t(`${tk}.regenerate`)}
          </Button>
        </div>
      )}

      {/* Switch */}
      <div className="flex items-center justify-between pt-2 border-t border-slate-100">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-slate-700">
            {t(`${tk}.publishSwitch`)}
          </span>
          {!hasQuestions && questionsCount !== null && (
            <span className="flex items-center gap-1 text-xs text-amber-600">
              <AlertTriangle className="w-3 h-3" />
              {t(`${tk}.noQuestions`)}
            </span>
          )}
          {isPublished && (
            <span className="flex items-center gap-1 text-xs text-amber-600">
              <AlertTriangle className="w-3 h-3" />
              {t(`${tk}.confirmUnpublish`).split('.')[0]}
            </span>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isPublished}
          disabled={switchDisabled}
          onClick={handleToggle}
          className={`
            relative inline-flex h-6 w-11 items-center rounded-full transition-colors
            focus:outline-none focus:ring-2 focus:ring-primary/30
            ${isPublished ? 'bg-green-500' : 'bg-slate-300'}
            ${switchDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
          `}
        >
          {(isPublishing || isUnpublishing) ? (
            <Loader2 className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 animate-spin text-white" />
          ) : (
            <span
              className={`
                inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform
                ${isPublished ? 'translate-x-6' : 'translate-x-1'}
              `}
            />
          )}
        </button>
      </div>

      {/* Feedback */}
      {feedback && (
        <div
          className={`rounded-lg px-4 py-2.5 text-sm ${
            feedback.type === 'success'
              ? 'bg-green-50 text-green-700 border border-green-200'
              : 'bg-red-50 text-red-700 border border-red-200'
          }`}
        >
          {feedback.message}
        </div>
      )}
    </div>
  );
}
