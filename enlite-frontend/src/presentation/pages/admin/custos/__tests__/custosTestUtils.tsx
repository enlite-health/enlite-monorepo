/** Utilitários dos testes do painel de custos: i18n REAL (es + pt-BR dos JSON de produção) e uma fixture da direção A. */
import i18n from 'i18next';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import es from '@infrastructure/i18n/locales/es.json';
import type { CostAnomalyItem, CostOverview } from '@infrastructure/http/AdminCostsApiService';

export async function usarIdioma(lng: 'es' | 'pt-BR'): Promise<void> {
  i18n.addResourceBundle('pt-BR', 'translation', ptBR, true, true);
  i18n.addResourceBundle('es', 'translation', es, true, true);
  await i18n.changeLanguage(lng);
}

const dias = (ate: number, valores: number[]) =>
  valores.map((value, i) => ({ day: `2026-10-${String(ate - valores.length + 1 + i).padStart(2, '0')}`, value }));

export const GEOCODING: CostAnomalyItem = {
  kind: 'service', name: 'Geocoding API', dayValue: 41.2, median7: 3.1, factor: 13.3, isNew: false,
  series: dias(17, [3.1, 3.2, 3.3, 3.0, 3.1, 3.2, 3.1, 3.0, 3.1, 3.2, 3.1, 3.0, 18.6, 41.2]),
  detail: {
    monthSeries: dias(17, [2.9, 3.0, 3.2, 2.8, 3.1, 3.3, 2.9, 3.0, 3.1, 3.2, 2.9, 3.3, 3.0, 3.1, 3.0, 18.6, 41.2]),
    resources: [
      { resource: 'clickup-patient-sync-safety-net-job', dayValue: 35.35, median7: 0.3, monthTotal: 55.65 },
      { resource: 'worker-functions-api-prd', dayValue: 2.55, median7: 1.6, monthTotal: 27.74 },
      { resource: '__none__', dayValue: 0.3, median7: 0.1, monthTotal: 1.88 },
    ],
  },
};
export const MARIA: CostAnomalyItem = {
  kind: 'resource', name: 'assistants-service-maria-whatsapp-handler-prd', dayValue: 6.4, median7: 0, factor: null, isNew: true,
  series: dias(17, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6.4]),
};

export function overview(over: Partial<CostOverview> = {}): CostOverview {
  return {
    month: '2026-10', currency: 'USD', dataUntil: '2026-10-18T06:12:00Z', monthTotal: 1148.4, prevMonthToDate: 902.1, prevMonthTotal: 1611.3,
    forecast: { value: 2094.14, basis: 'linear', daysCounted: 17 },
    months: [
      { month: '2026-05', total: 1020.4 }, { month: '2026-06', total: 1145.9 }, { month: '2026-07', total: 1302.7 },
      { month: '2026-08', total: 1488 }, { month: '2026-09', total: 1611.3 }, { month: '2026-10', total: 1148.4 },
    ],
    byService: [
      { service: 'Cloud Run', total: 412.3 }, { service: 'Cloud SQL', total: 298.7 }, { service: 'Vertex AI', total: 176.4 },
      { service: 'Geocoding API', total: 105.6 }, { service: 'Cloud Storage', total: 58.2 },
    ],
    byResource: [
      { service: 'Cloud SQL', resource: 'enlite-ar-db', total: 298.7 },
      { service: 'Geocoding API', resource: 'clickup-patient-sync-safety-net-job', total: 55.65 },
      { service: 'Cloud Run', resource: 'assistants-service-maria-whatsapp-handler-prd', total: 6.4 },
      { service: '__none__', resource: '__none__', total: 19.8 },
    ],
    bySector: [{ sector: 'plataforma', total: 362 }, { sector: '__none__', total: 199.6 }, { sector: 'clinico', total: 96.3 }],
    byAiCaller: [
      { caller: 'enlite-triage-service', funcao: 'classificar-mensagem', total: 71.2, currency: 'USD', source: 'billing' },
      { caller: 'sol', funcao: 'gemini-api', total: 9.8, currency: 'USD', source: 'estimated' },
      { caller: '__none__', funcao: '__none__', total: 5.4, currency: 'USD', source: 'unattributed' },
    ],
    byProject: [{ project: 'enlite-prd', total: 861.3 }, { project: 'enlite-stg', total: 287.0 }, { project: '__none__', total: 0.1 }],
    availableMonths: ['2026-10', '2026-09', '2026-08'],
    anomalies: { status: 'ok', day: '2026-10-17', rule: { factor: 2, minDelta: 5, windowDays: 7 }, items: [GEOCODING, MARIA] },
    ...over,
  };
}
