/**
 * mapPageConfig — o que é DADO na página dos mapas (cores, opções, centro
 * padrão), separado da página para ela caber nas 400 linhas e para o teste
 * afirmar a tabela sem montar React.
 */
import type { TFunction } from 'i18next';
import type { MapCountry, PatientMapPoint, WorkerMapPoint } from '@infrastructure/http/AdminMapApiService';
import type { SelectOption } from '@presentation/components/atoms/Select';
import { getCountryOptions } from '../patientsData';
import type { CorridorLabels } from './CorridorPanel';
import type { ResultRow } from './mapResults';
import { WORKER_PROFESSIONS } from '@domain/entities/Worker';
import { PATIENT_STATUSES as PATIENT_STATUSES_V2 } from '@domain/entities/patientEnums';

/**
 * Onde o mapa nasce em cada país — trocar o país move o centro para cá.
 * AR: Obelisco (CABA) — a operação é AR (FATO-17 da ata de 22/07).
 * BR: Praça da Sé (São Paulo) — sem isto o mapa BR ficava preso em Buenos Aires.
 */
export const DEFAULT_CENTER_BY_COUNTRY: Record<MapCountry, { lat: number; lng: number }> = {
  AR: { lat: -34.6037, lng: -58.3816 },
  BR: { lat: -23.5505, lng: -46.6333 },
};
export const DEFAULT_COUNTRY: MapCountry = 'AR';

/** Comparação por valor — o centro anda por clique e vira objeto novo a cada vez. */
export function sameCenter(a: { lat: number; lng: number }, b: { lat: number; lng: number }): boolean {
  return a.lat === b.lat && a.lng === b.lng;
}
export const DEFAULT_CENTER = DEFAULT_CENTER_BY_COUNTRY[DEFAULT_COUNTRY];
/**
 * O raio nasce em 5 km. Era 25 km (FATO-17 da ata de 22/07) — a proposta do
 * Gabriel na tela; mas quem OPERA a tela é o Marcel, e na demonstração de
 * 02/09 ele reduziu para 5 km na hora ("Ponele 5 km para que menos personas",
 * ~1894). Vale o valor que o operador escolheu, não o que foi proposto: 25 km
 * em CABA devolve a operação inteira, e uma lista que não separa ninguém não
 * é um filtro. 25 km continua a um clique no seletor.
 */
export const DEFAULT_RADIUS_KM = 5;
export const RADIUS_OPTIONS_KM = [5, 10, 20, 25, 50] as const;

/**
 * Raio do seletor da ÂNCORA (passo 1), FIXO e independente do raio da tela.
 *
 * O escopo é obrigatório (lex C3), então o seletor precisa de um: usa o centro
 * padrão do país e o maior raio da lista. Amarrá-lo ao raio ESCOLHIDO seria
 * circular — com 5 km o operador teria de achar o paciente dentro de 5 km do
 * Obelisco para só então poder centrar nele. 50 km a partir do Obelisco cobre
 * a AMBA inteira, que é onde a operação está (FATO-17).
 *
 * ⚠️ TETO CONHECIDO: quem mora além de 50 km do centro do país, ou depois do
 * 500º ponto, não aparece no seletor. Enquanto a operação for AMBA isso não
 * morde; o conserto de verdade é busca por nome no servidor, e está na lista.
 */
export const ANCHOR_PICKER_RADIUS_KM = 50;

export const WORKER_STATUS_COLOR: Record<string, string> = {
  REGISTERED: '#16a34a',
  INCOMPLETE_REGISTER: '#d97706',
  DISABLED: '#6b7280',
};

/**
 * QA 🟡4: cores por status v2 (`@domain/entities/patientEnums`, decisão 2 do Gabriel,
 * 03/09/2026). `DISCONTINUED` saiu do vocabulário (migration 314 converteu as linhas em
 * DISCHARGED); ON_HOLD/SEARCHING/REPLACEMENT são clínicos novos e faltavam aqui — o mapa tinha
 * um vocabulário PRÓPRIO, desincronizado do resto da ficha (spec 012).
 */
export const PATIENT_STATUS_COLOR: Record<string, string> = {
  ACTIVE: '#16a34a',
  ADMISSION: '#2563eb',
  PENDING_ADMISSION: '#2563eb',
  SOLICITANTE: '#7c3aed',
  ON_HOLD: '#f59e0b',
  SEARCHING: '#0891b2',
  REPLACEMENT: '#db2777',
  SUSPENDED: '#ea580c',
  ALTA: '#0D9488', // alta (D430) — pin do mapa exige hex, como os vizinhos
  DISCHARGED: '#6b7280',
};

/** A fonte é a entidade de domínio — o mapa não mantém lista própria de profissões. */
export const PROFESSIONS = WORKER_PROFESSIONS;
/** Fonte viva: `patientEnums.ts` (v2) — não uma lista própria do mapa (QA 🟡4). */
export const PATIENT_STATUSES = PATIENT_STATUSES_V2;

export function workerStatusLabel(t: TFunction, status: string | null): string {
  if (!status) return t('admin.map.status.unknown', 'Sin estado');
  const fallback: Record<string, string> = { REGISTERED: 'Documentación completa', INCOMPLETE_REGISTER: 'Registro incompleto', DISABLED: 'Dado de baja' };
  return t(`admin.map.workerStatus.${status}`, fallback[status] ?? status);
}

export function patientStatusLabel(t: TFunction, status: string | null): string {
  if (!status) return t('admin.map.status.unknown', 'Sin estado');
  const fallback: Record<string, string> = {
    ACTIVE: 'Activo', ADMISSION: 'En admisión', PENDING_ADMISSION: 'Esperando financiero', SOLICITANTE: 'Solicitante',
    ON_HOLD: 'En espera', SEARCHING: 'Búsqueda', REPLACEMENT: 'Reemplazo',
    SUSPENDED: 'Suspendido', DISCHARGED: 'Alta',
  };
  return t(`admin.map.patientStatus.${status}`, fallback[status] ?? status);
}

export function professionLabel(t: TFunction, profession: string | null): string {
  if (!profession) return t('admin.map.profession.unknown', 'Sin profesión');
  const fallback: Record<string, string> = { AT: 'AT', CAREGIVER: 'Cuidador', NURSE: 'Enfermería', KINESIOLOGIST: 'Kinesiología', PSYCHOLOGIST: 'Psicología' };
  return t(`admin.map.profession.${profession}`, fallback[profession] ?? profession);
}

export function placeLabel(p: { city: string | null; neighborhood: string | null }): string {
  return [p.neighborhood, p.city].filter(Boolean).join(' · ');
}

export function distanceLabel(km: number | null): string {
  if (km === null) return '';
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/**
 * A linha secundária — profissão/status/lugar. UMA função para a lista e para
 * o balão do pino: quando eram dois trechos iguais em dois lugares, os dois
 * podiam divergir sem ninguém notar.
 */
export function workerDetails(t: TFunction, p: WorkerMapPoint): string {
  const place = placeLabel(p) || (p.lat === null ? t('admin.map.noLocation', 'sin ubicación') : '');
  return [professionLabel(t, p.profession), workerStatusLabel(t, p.status), place].filter(Boolean).join(' · ');
}

export function patientDetails(t: TFunction, p: PatientMapPoint): string {
  const place = placeLabel(p) || (p.lat === null ? t('admin.map.noLocation', 'sin ubicación') : '');
  const vac = p.openVacancies > 0 ? t('admin.map.openVacancies', { count: p.openVacancies, defaultValue: '{{count}} vacante(s) abierta(s)' }) : '';
  return [patientStatusLabel(t, p.status), place, vac].filter(Boolean).join(' · ');
}

/** Tooltip NATIVO do pino (o `title` do marcador), onde só cabe uma linha. */
export function workerPointTitle(t: TFunction, p: WorkerMapPoint): string {
  return [p.name, workerDetails(t, p)].filter(Boolean).join(' — ');
}

export function patientPointTitle(t: TFunction, p: PatientMapPoint): string {
  return [p.name, patientDetails(t, p)].filter(Boolean).join(' — ');
}

/**
 * Legenda das bolinhas — UMA entrada por COR, não por status: `ADMISSION` e
 * `PENDING_ADMISSION` são o mesmo azul (funil de admissão). Duas entradas com
 * a mesma cor não seriam legenda, seriam enigma.
 */
export function legendEntries(t: TFunction, kind: 'workers' | 'patients'): Array<{ color: string; label: string }> {
  // Percorre o PRÓPRIO mapa de cores (e não a lista de status): assim não
  // existe o caso "status sem cor" — que seria um ramo impossível de testar.
  const colors = kind === 'workers' ? WORKER_STATUS_COLOR : PATIENT_STATUS_COLOR;
  const label = kind === 'workers' ? workerStatusLabel : patientStatusLabel;

  const byColor = new Map<string, string[]>();
  for (const [status, color] of Object.entries(colors)) {
    byColor.set(color, [...(byColor.get(color) ?? []), label(t, status)]);
  }
  return [...byColor].map(([color, labels]) => ({ color, label: labels.join(' / ') }));
}

/**
 * Todo o texto do passo 1, por aba. Fica aqui, e não na página, porque é DADO:
 * a aba de prestadores ancora num paciente, a de pacientes num prestador, e a
 * única diferença entre os dois casos é a string (mais o `data-testid`, que é
 * o que o e2e usa para saber em qual dos dois está).
 */
export function anchorTextsFor(t: TFunction, kind: 'workers' | 'patients'): {
  labels: { loading: string; error: string; truncated: string };
  ui: { id: string; step: string; label: string; placeholder: string; searchPlaceholder: string; emptyTitle: string; emptyHint: string };
} {
  const labels = {
    loading: t('admin.map.anchorLoading', 'Buscando…'),
    error: t('admin.map.anchorError', 'No se pudo cargar la lista. Reintentá en unos segundos.'),
    truncated: t('admin.map.anchorTruncated', 'Hay más de los que entran en esta lista: escribí el nombre para filtrar.'),
  };
  const ui = kind === 'workers'
    ? {
      id: 'map-center-patient',
      step: t('admin.map.steps.anchorPatient', 'Elegí el paciente'),
      label: t('admin.map.centerOnPatient.label', 'Centrar en paciente'),
      placeholder: t('admin.map.centerOnPatient.placeholder', 'Centrar en un paciente…'),
      searchPlaceholder: t('admin.map.centerOnPatient.search', 'Buscar paciente…'),
      emptyTitle: t('admin.map.anchorEmpty.workersTitle', 'Elegí un paciente para empezar'),
      emptyHint: t('admin.map.anchorEmpty.workersHint', 'El mapa muestra los prestadores alrededor del paciente que elijas. Los filtros y la lista aparecen después.'),
    }
    : {
      id: 'map-center-worker',
      step: t('admin.map.steps.anchorWorker', 'Elegí el prestador'),
      label: t('admin.map.centerOnWorker.label', 'Centrar en prestador'),
      placeholder: t('admin.map.centerOnWorker.placeholder', 'Centrar en un prestador…'),
      searchPlaceholder: t('admin.map.centerOnWorker.search', 'Buscar prestador…'),
      emptyTitle: t('admin.map.anchorEmpty.patientsTitle', 'Elegí un prestador para empezar'),
      emptyHint: t('admin.map.anchorEmpty.patientsHint', 'El mapa muestra los pacientes alrededor del prestador que elijas. Los filtros y la lista aparecen después.'),
    };
  return { labels, ui };
}

/**
 * As opções dos seletores do passo 2. Ficam aqui, e não na página, porque são
 * DADO — e porque a página não cabia nas 400 linhas com elas dentro.
 */
export function filterOptionsFor(t: TFunction): {
  radiusOptions: SelectOption[];
  countryOptions: SelectOption[];
  docsOptions: SelectOption[];
  professionOptions: SelectOption[];
  patientStatusOptions: SelectOption[];
} {
  return {
    radiusOptions: RADIUS_OPTIONS_KM.map((km) => ({ value: String(km), label: `${km} km` })),
    countryOptions: getCountryOptions(t),
    docsOptions: [
      { value: 'all', label: t('admin.map.docs.all', 'Todos') },
      { value: 'complete', label: t('admin.map.docs.complete', 'Documentación completa') },
      { value: 'incomplete', label: t('admin.map.docs.incomplete', 'Registro incompleto') },
    ],
    professionOptions: [
      { value: '', label: t('admin.map.profession.all', 'Todas las profesiones') },
      ...PROFESSIONS.map((p) => ({ value: p, label: professionLabel(t, p) })),
    ],
    patientStatusOptions: [
      { value: '', label: t('admin.map.patientStatus.all', 'Todos los estados') },
      ...PATIENT_STATUSES.map((s) => ({ value: s, label: patientStatusLabel(t, s) })),
    ],
  };
}

/** Os textos do painel da rota. Fora do componente por causa do fast-refresh. */
export function corridorLabelsFor(t: TFunction): CorridorLabels {
  return {
    // Plural pelo i18next (`_one`/`_other`), não por "(es)" grudado: além de
    // ficar errado nas duas línguas, "1 combinación(es)" estourava a largura do
    // balão e truncava. Com `count`, o i18next escolhe a chave sozinho.
    options: (n) => t('admin.map.corridor.options', { count: n, defaultValue_one: '1 opción', defaultValue_other: '{{count}} opciones' }),
    loading: t('admin.map.corridor.loading', 'Buscando recorrido…'),
    error: t('admin.map.corridor.error', 'No se pudo calcular el recorrido.'),
    noRoute: t('admin.map.corridor.noRoute', 'No hay recorrido en transporte público entre estos dos puntos.'),
    noCoverage: t('admin.map.corridor.noCoverage', 'Falta la ubicación de uno de los dos — no podemos calcular el recorrido.'),
    direct: t('admin.map.corridor.direct', 'directo'),
    transfers: (n) => t('admin.map.corridor.transfers', { count: n, defaultValue_one: '1 combinación', defaultValue_other: '{{count}} combinaciones' }),
    total: (min) => t('admin.map.corridor.total', { defaultValue: '{{count}} min puerta a puerta', count: min }),
    walkLeg: (min, meters) => t('admin.map.corridor.walkLeg', { defaultValue: 'caminar {{min}} min ({{meters}} m)', min, meters }),
    straight: (b) => t('admin.map.corridor.straight', { defaultValue: 'en línea recta: ~{{count}} cuadras', count: b }),
  };
}

/**
 * Monta as linhas que a lista E o mapa consomem — o MESMO array, para os dois
 * não terem como discordar. É derivação de dado, não orquestração.
 */
export function buildResultRows(
  t: TFunction,
  kind: 'workers' | 'patients',
  workers: readonly WorkerMapPoint[],
  patients: readonly PatientMapPoint[],
): ResultRow[] {
  if (kind === 'workers') {
    return workers.map((p) => ({
      id: p.id, lat: p.lat, lng: p.lng, title: p.name, details: workerDetails(t, p),
      distance: distanceLabel(p.distanceKm) || null, tooltip: workerPointTitle(t, p),
      color: WORKER_STATUS_COLOR[p.status] ?? '#6b7280', href: `/admin/workers/${p.id}`,
    }));
  }
  // Um ponto por ENDEREÇO: o id da linha, do pino e da seleção é o mesmo.
  return patients.map((p) => ({
    id: p.addressId ?? p.id, patientId: p.id, lat: p.lat, lng: p.lng, title: p.name,
    details: patientDetails(t, p), distance: distanceLabel(p.distanceKm) || null,
    tooltip: patientPointTitle(t, p),
    color: PATIENT_STATUS_COLOR[p.status] ?? '#6b7280', href: `/admin/patients/${p.id}`,
  }));
}

