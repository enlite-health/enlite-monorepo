import type { FunnelBucket } from '@domain/entities/Funnel';

export const FUNNEL_TABS: Array<{
  key: FunnelBucket;
  i18nKey: string;
}> = [
  { key: 'INVITED', i18nKey: 'admin.vacancyDetail.funnelTabs.invited' },
  { key: 'POSTULATED', i18nKey: 'admin.vacancyDetail.funnelTabs.postulated' },
  { key: 'PRE_SELECTED', i18nKey: 'admin.vacancyDetail.funnelTabs.preSelected' },
  { key: 'REJECTED', i18nKey: 'admin.vacancyDetail.funnelTabs.rejected' },
  { key: 'WITHDREW', i18nKey: 'admin.vacancyDetail.funnelTabs.withdrew' },
];
