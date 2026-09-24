import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Loader2, Copy, Check, ExternalLink, MousePointerClick,
  Facebook, Instagram, Linkedin, Globe, MessageCircle,
} from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { formatCaseNumber } from '@domain/value-objects/caseNumberFormat';

const CHANNELS = ['facebook', 'instagram', 'whatsapp', 'linkedin', 'site'] as const;
type SocialChannel = (typeof CHANNELS)[number];

const CHANNEL_ICONS: Record<SocialChannel, React.ReactNode> = {
  facebook: <Facebook className="w-5 h-5 text-[#1877F2]" />,
  instagram: <Instagram className="w-5 h-5 text-[#E4405F]" />,
  whatsapp: <MessageCircle className="w-5 h-5 text-[#25D366]" />,
  linkedin: <Linkedin className="w-5 h-5 text-[#0A66C2]" />,
  site: <Globe className="w-5 h-5 text-[#737373]" />,
};

interface StoredLink {
  url: string;
  id: string;
}

interface Props {
  vacancyId: string;
  caseNumber: number | null;
  vacancyNumber: number | null;
  socialShortLinks: Record<string, string | StoredLink> | null;
  onRefresh: () => void;
}

export function VacancySocialLinksCard({
  vacancyId,
  caseNumber,
  vacancyNumber,
  socialShortLinks,
  onRefresh,
}: Props) {
  const { t } = useTranslation();
  const [links, setLinks] = useState<Record<string, StoredLink>>(normalizeLinks(socialShortLinks));
  const [stats, setStats] = useState<Record<string, number>>({});
  const [loadingChannel, setLoadingChannel] = useState<SocialChannel | null>(null);
  const [copiedChannel, setCopiedChannel] = useState<SocialChannel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);

  const fetchStats = useCallback(async () => {
    const hasLinks = Object.keys(links).length > 0;
    if (!hasLinks) return;
    try {
      setLoadingStats(true);
      const data = await AdminApiService.getSocialLinksStats(vacancyId);
      const clickMap: Record<string, number> = {};
      for (const [channel, info] of Object.entries(data)) {
        clickMap[channel] = info.clicks;
      }
      setStats(clickMap);
    } catch {
      // silently fail — stats are non-critical
    } finally {
      setLoadingStats(false);
    }
  }, [vacancyId, links]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const handleGenerate = async (channel: SocialChannel) => {
    if (caseNumber == null) return;
    try {
      setLoadingChannel(channel);
      setError(null);
      const result = await AdminApiService.generateSocialLink(vacancyId, channel);
      setLinks(normalizeLinks(result.social_short_links));
      setStats(prev => ({ ...prev, [channel]: 0 }));
      onRefresh();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('admin.vacancyDetail.socialLinksCard.generateError');
      setError(message);
    } finally {
      setLoadingChannel(null);
    }
  };

  const handleCopy = async (channel: SocialChannel) => {
    const link = links[channel];
    if (!link) return;
    await navigator.clipboard.writeText(link.url);
    setCopiedChannel(channel);
    setTimeout(() => setCopiedChannel(null), 2000);
  };

  const noCaseNumber = caseNumber == null;

  return (
    <div data-testid="vacancy-social-links-card" className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col gap-4">
      <div>
        <Heading level={3} weight="semibold" color="secondary">
          {t('admin.vacancyDetail.socialLinksCard.title')}
        </Heading>
        <Text size="sm" color="secondary" className="mt-1">
          {noCaseNumber
            ? t('admin.vacancyDetail.socialLinksCard.noCaseNumber')
            : t('admin.vacancyDetail.socialLinksCard.subtitle')}
        </Text>
      </div>

      {/*
        T062-resto (spec 027 Fase 6): o agente da T062 deliberadamente NÃO aplicou o helper
        aqui — prefixar "EN" antes da T066 geraria uma URL que 404ava (SLUG_REGEX só casava
        "caso{N}-{M}" sem prefixo). Com a T066, PublicVacancyController.SLUG_REGEX passou a
        aceitar `caso(?:EN)?(\d+)[-#](\d+)`, então este preview pode usar o helper — só o
        `caseNumber` ganha o prefixo condicional (formatCaseNumber); `vacancyNumber` e o
        separador "-" ficam como estão, iguais ao que ShortLinkService.buildAndCreate() de
        fato gera (achado registrado à parte: ele não usa o helper — fora de escopo aqui).
      */}
      {!noCaseNumber && (
        <div className="text-xs text-slate-400 bg-slate-50 rounded-lg px-3 py-2 font-mono truncate">
          https://app.enlite.health/vacantes/caso{formatCaseNumber(caseNumber)}-{vacancyNumber}
        </div>
      )}

      <div className="flex flex-col gap-3">
        {CHANNELS.map((channel) => {
          const link = links[channel];
          const shortUrl = link?.url ?? '';
          const isLoading = loadingChannel === channel;
          const isCopied = copiedChannel === channel;
          const clicks = stats[channel];
          const hasLink = !!shortUrl;
          const i18nKey = `admin.vacancyDetail.socialLinksCard.${channel}` as const;

          return (
            <div key={channel} className="flex items-center gap-3">
              <span className="shrink-0 w-6 flex justify-center">{CHANNEL_ICONS[channel]}</span>
              <span className="text-sm font-medium text-slate-700 w-24 shrink-0">
                {t(i18nKey)}
              </span>

              <input
                type="text"
                readOnly
                value={shortUrl}
                placeholder="—"
                className="flex-1 border border-[#D9D9D9] rounded-lg px-3 py-2 text-sm text-slate-700 bg-slate-50 focus:outline-none truncate"
              />

              {hasLink ? (
                <>
                  <button
                    onClick={() => handleCopy(channel)}
                    className="text-[#737373] hover:text-primary transition-colors shrink-0"
                    title={t('admin.vacancyDetail.socialLinksCard.copy')}
                  >
                    {isCopied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                  </button>
                  <a
                    href={shortUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#737373] hover:text-primary transition-colors shrink-0"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </a>
                  <div
                    className="flex items-center gap-1 text-xs text-slate-500 bg-slate-100 rounded-full px-2.5 py-1 shrink-0 min-w-[70px] justify-center"
                    title={t('admin.vacancyDetail.socialLinksCard.clicks')}
                  >
                    <MousePointerClick className="w-3.5 h-3.5" />
                    {loadingStats ? '…' : (clicks ?? 0)}
                  </div>
                </>
              ) : (
                // POST /vacancies/:id/social-links → generateSocialLink → vacancy:write.
                <ActionButton
                  resource="vacancy"
                  action="create"
                  variant="outline"
                  size="sm"
                  onClick={() => handleGenerate(channel)}
                  disabled={noCaseNumber || isLoading}
                  className="flex items-center gap-1.5 px-3 shrink-0"
                >
                  {isLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {isLoading
                    ? t('admin.vacancyDetail.socialLinksCard.generating')
                    : t('admin.vacancyDetail.socialLinksCard.generate')}
                </ActionButton>
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <div className="rounded-lg px-4 py-2.5 text-sm bg-red-50 text-red-700 border border-red-200">
          {error}
        </div>
      )}
    </div>
  );
}

/** Normaliza formato legado (string) e novo ({ url, id }) */
function normalizeLinks(raw: Record<string, string | StoredLink> | null): Record<string, StoredLink> {
  if (!raw) return {};
  const result: Record<string, StoredLink> = {};
  for (const [key, val] of Object.entries(raw)) {
    result[key] = typeof val === 'string' ? { url: val, id: '' } : val;
  }
  return result;
}
