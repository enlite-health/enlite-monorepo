/**
 * AdminMapPage — /admin/mapa · os DOIS mapas (DEC-14): prestadores e pacientes.
 *
 * O que o recrutador faz aqui (REQ-04, Javier): vê onde estão os prestadores
 * perto de um paciente, filtra por distância, por província/localidade e por
 * "documentação completa" — INCLUINDO quem não terminou o registro — e abre
 * o perfil para convidar. A lista lateral mostra os mesmos pontos do mapa
 * (e quem não tem coordenada, que o mapa não consegue mostrar).
 *
 * Escopo sempre presente (lex C3): raio a partir de um centro, que nasce no
 * centro padrão do PAÍS (CABA para AR, São Paulo para BR) e muda por clique
 * no mapa ou escolhendo um paciente. Sem geocoding, sem endereço digitado
 * (lex C7). País é filtro de primeira classe (C4).
 *
 * Só a aba visível busca: a outra fica parada até ser aberta, e o seletor
 * "centrar en paciente" só busca depois que alguém o toca — abrir a página
 * custa UMA request, não três.
 */
import { useCallback, useMemo, useState, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Select, type SelectOption } from '@presentation/components/atoms/Select';
import { Button } from '@presentation/components/atoms/Button';
import { PointsMap, type MapPoint } from '@presentation/components/molecules/PointsMap/PointsMap';
import { usePatientsMapPoints, useWorkersMapPoints } from '@hooks/admin/useMapPoints';
import type { MapCountry, PatientsMapFilters, WorkersMapFilters } from '@infrastructure/http/AdminMapApiService';
import { getCountryOptions } from '../patientsData';
import {
  DEFAULT_CENTER, DEFAULT_CENTER_BY_COUNTRY, DEFAULT_COUNTRY, DEFAULT_RADIUS_KM, PATIENT_STATUSES, PATIENT_STATUS_COLOR,
  PROFESSIONS, RADIUS_OPTIONS_KM, WORKER_STATUS_COLOR, distanceLabel, patientPointTitle, patientStatusLabel, placeLabel,
  professionLabel, workerPointTitle, workerStatusLabel,
} from './mapPageConfig';

type Kind = 'workers' | 'patients';
type Docs = 'all' | 'complete' | 'incomplete';

/** Clicar no nome abre a ficha — sem também selecionar a linha. */
const stopRowSelect = (e: MouseEvent): void => e.stopPropagation();

export function AdminMapPage(): JSX.Element {
  const { t } = useTranslation();
  const [kind, setKind] = useState<Kind>('workers');
  const [country, setCountry] = useState<MapCountry>(DEFAULT_COUNTRY);
  const [center, setCenter] = useState(DEFAULT_CENTER);
  const [radiusKm, setRadiusKm] = useState<number>(DEFAULT_RADIUS_KM);
  const [docs, setDocs] = useState<Docs>('all');
  const [profession, setProfession] = useState<string>('');
  const [patientStatus, setPatientStatus] = useState<string>('');
  const [onlyOpenVacancies, setOnlyOpenVacancies] = useState(false);
  const [centerPatientId, setCenterPatientId] = useState<string>('');
  const [pickerTouched, setPickerTouched] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const workersFilters = useMemo<WorkersMapFilters>(() => ({
    country,
    center,
    radius_km: radiusKm,
    ...(docs !== 'all' ? { docs_complete: docs } : {}),
    ...(profession ? { profession: [profession] } : {}),
  }), [country, center, radiusKm, docs, profession]);

  const patientsFilters = useMemo<PatientsMapFilters>(() => ({
    country,
    center,
    radius_km: radiusKm,
    ...(patientStatus ? { status: [patientStatus] } : {}),
    ...(onlyOpenVacancies ? { with_open_vacancies: true } : {}),
  }), [country, center, radiusKm, patientStatus, onlyOpenVacancies]);

  // Seletor "centrar en paciente" (aba de prestadores): os pacientes do MESMO
  // centro e raio que o mapa mostra — o que o recrutador vê é o que ele pode
  // escolher. Escopo obrigatório, então nunca "todos".
  const pickerFilters = useMemo<PatientsMapFilters>(() => ({ country, center, radius_km: radiusKm }), [country, center, radiusKm]);

  const workers = useWorkersMapPoints(workersFilters, kind === 'workers');
  const patients = usePatientsMapPoints(patientsFilters, kind === 'patients');
  const picker = usePatientsMapPoints(pickerFilters, kind === 'workers' && pickerTouched);

  const active = kind === 'workers' ? workers : patients;

  const onCenterChange = useCallback((c: { lat: number; lng: number }) => {
    setCenter(c);
    setCenterPatientId('');
    setSelectedId(null);
  }, []);

  const onCountryChange = (v: string): void => {
    const next = v as MapCountry;
    setCountry(next);
    // Cada país tem o seu centro: BR não pode nascer em Buenos Aires.
    onCenterChange(DEFAULT_CENTER_BY_COUNTRY[next]);
  };

  const onPickPatient = (id: string): void => {
    setCenterPatientId(id);
    const p = picker.points.find((x) => x.id === id || x.addressId === id);
    if (p && p.lat !== null && p.lng !== null) {
      setCenter({ lat: p.lat, lng: p.lng });
      setSelectedId(null);
    }
  };

  const mapPoints = useMemo<MapPoint[]>(() => {
    if (kind === 'workers') {
      return workers.points.map((p) => ({
        id: p.id, lat: p.lat, lng: p.lng, title: workerPointTitle(t, p),
        color: WORKER_STATUS_COLOR[p.status] ?? '#6b7280', href: `/admin/workers/${p.id}`,
      }));
    }
    return patients.points.map((p) => ({
      id: p.addressId ?? p.id, lat: p.lat, lng: p.lng, title: patientPointTitle(t, p),
      color: PATIENT_STATUS_COLOR[p.status] ?? '#6b7280', href: `/admin/patients/${p.id}`,
    }));
  }, [kind, workers.points, patients.points, t]);

  const radiusOptions: SelectOption[] = RADIUS_OPTIONS_KM.map((km) => ({ value: String(km), label: `${km} km` }));
  const countryOptions: SelectOption[] = getCountryOptions(t);
  const docsOptions: SelectOption[] = [
    { value: 'all', label: t('admin.map.docs.all', 'Todos') },
    { value: 'complete', label: t('admin.map.docs.complete', 'Documentación completa') },
    { value: 'incomplete', label: t('admin.map.docs.incomplete', 'Registro incompleto') },
  ];
  const professionOptions: SelectOption[] = [{ value: '', label: t('admin.map.profession.all', 'Todas las profesiones') }, ...PROFESSIONS.map((p) => ({ value: p, label: professionLabel(t, p) }))];
  const patientStatusOptions: SelectOption[] = [{ value: '', label: t('admin.map.patientStatus.all', 'Todos los estados') }, ...PATIENT_STATUSES.map((s) => ({ value: s, label: patientStatusLabel(t, s) }))];
  // Só quem tem coordenada COMPLETA pode virar centro.
  const patientPickerOptions: SelectOption[] = [
    { value: '', label: t('admin.map.centerOnPatient.placeholder', 'Centrar en un paciente…') },
    ...picker.points.filter((p) => p.lat !== null && p.lng !== null).map((p) => {
      const place = placeLabel(p);
      return { value: p.addressId ?? p.id, label: place ? `${p.name} · ${place}` : p.name };
    }),
  ];

  const tabClass = (k: Kind): string =>
    `px-4 py-2 rounded-t-md border-b-2 ${kind === k ? 'border-primary text-primary' : 'border-transparent text-gray-600 hover:text-gray-900'}`;

  return (
    <PageContainer>
      <div className="flex items-center justify-between mb-4">
        <div>
          <Heading level={1}>{t('admin.map.title', 'Mapa')}</Heading>
          <Text size="sm" color="secondary">
            {t('admin.map.subtitle', 'Prestadores y pacientes sobre el mapa. Hacé clic en el mapa para mover el centro del radio.')}
          </Text>
        </div>
        <Button variant="outline" onClick={() => active.refetch()} data-testid="map-refresh" aria-label={t('admin.map.refresh', 'Actualizar')}>
          <RefreshCw size={16} />
        </Button>
      </div>

      <div className="flex gap-1 border-b border-gray-200 mb-4" role="tablist">
        <button type="button" role="tab" aria-selected={kind === 'workers'} className={tabClass('workers')} data-testid="map-tab-workers" onClick={() => { setKind('workers'); setSelectedId(null); }}>
          <Text as="span" size="sm" weight="semibold" color="inherit">{t('admin.map.tabs.workers', 'Prestadores')}</Text>
        </button>
        <button type="button" role="tab" aria-selected={kind === 'patients'} className={tabClass('patients')} data-testid="map-tab-patients" onClick={() => { setKind('patients'); setSelectedId(null); }}>
          <Text as="span" size="sm" weight="semibold" color="inherit">{t('admin.map.tabs.patients', 'Pacientes')}</Text>
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4">
        <aside className="flex flex-col gap-3 min-w-0">
          <div className="grid grid-cols-2 gap-2">
            <Select data-testid="map-country" options={countryOptions} value={country} onValueChange={onCountryChange} aria-label={t('admin.map.country', 'País')} />
            <Select data-testid="map-radius" options={radiusOptions} value={String(radiusKm)} onValueChange={(v) => setRadiusKm(Number(v))} aria-label={t('admin.map.radius', 'Radio')} />
          </div>

          {kind === 'workers' ? (
            <>
              <Select data-testid="map-center-patient" options={patientPickerOptions} value={centerPatientId} onValueChange={onPickPatient} onFocus={() => setPickerTouched(true)} aria-label={t('admin.map.centerOnPatient.label', 'Centrar en paciente')} />
              <Select data-testid="map-docs" options={docsOptions} value={docs} onValueChange={(v) => setDocs(v as Docs)} aria-label={t('admin.map.docs.label', 'Documentación')} />
              <Select data-testid="map-profession" options={professionOptions} value={profession} onValueChange={setProfession} aria-label={t('admin.map.profession.label', 'Profesión')} />
            </>
          ) : (
            <>
              <Select data-testid="map-patient-status" options={patientStatusOptions} value={patientStatus} onValueChange={setPatientStatus} aria-label={t('admin.map.patientStatus.label', 'Estado')} />
              <label className="flex items-center gap-2">
                <input type="checkbox" data-testid="map-open-vacancies" checked={onlyOpenVacancies} onChange={(e) => setOnlyOpenVacancies(e.target.checked)} />
                <Text as="span" size="sm">{t('admin.map.onlyOpenVacancies', 'Solo con vacantes abiertas')}</Text>
              </label>
            </>
          )}

          <div className="rounded-md bg-gray-50 border border-gray-200 px-3 py-2" data-testid="map-counts">
          <Text as="div" size="sm" color="primary">
            {active.isLoading ? (
              <span data-testid="map-loading">{t('admin.map.loading', 'Cargando…')}</span>
            ) : active.error ? (
              <span className="text-red-600" data-testid="map-error">{active.error}</span>
            ) : (
              <>
                <strong data-testid="map-total">{active.total}</strong>{' '}
                {t('admin.map.inRadius', { defaultValue: 'en {{km}} km', km: radiusKm })}
                {active.withoutCoordinates > 0 && (
                  <span className="text-amber-700" data-testid="map-without-coords">
                    {' · '}{t('admin.map.withoutCoordinates', { defaultValue: '{{count}} sin ubicación', count: active.withoutCoordinates })}
                  </span>
                )}
                {active.truncated && (
                  <span className="text-red-600" data-testid="map-truncated">{' · '}{t('admin.map.truncated', 'lista cortada — achicá el radio')}</span>
                )}
              </>
            )}
          </Text>
          </div>

          <ul className="divide-y divide-gray-100 border border-gray-200 rounded-md max-h-[440px] overflow-y-auto" data-testid="map-list">
            {kind === 'workers'
              ? workers.points.map((p) => (
                <li key={p.id} data-testid="map-list-item" data-point-id={p.id} data-has-coords={p.lat !== null} className={`px-3 py-2 cursor-pointer ${selectedId === p.id ? 'bg-blue-50' : 'hover:bg-gray-50'}`} onClick={() => setSelectedId(p.id)}>
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: WORKER_STATUS_COLOR[p.status] ?? '#6b7280' }} />
                    <Link to={`/admin/workers/${p.id}`} className="hover:underline truncate" onClick={stopRowSelect}><Text as="span" size="sm" weight="medium" color="primary">{p.name}</Text></Link>
                    {p.distanceKm !== null && <Text as="span" size="xs" color="secondary" className="ml-auto shrink-0">{distanceLabel(p.distanceKm)}</Text>}
                  </div>
                  <Text as="div" size="xs" color="secondary" className="truncate">
                    {[professionLabel(t, p.profession), workerStatusLabel(t, p.status), placeLabel(p) || (p.lat === null ? t('admin.map.noLocation', 'sin ubicación') : '')].filter(Boolean).join(' · ')}
                  </Text>
                </li>
              ))
              : patients.points.map((p) => {
                // Um ponto por ENDEREÇO: o id da linha, do pino e da seleção é o mesmo.
                const pointId = p.addressId ?? p.id;
                return (
                  <li key={pointId} data-testid="map-list-item" data-point-id={pointId} data-patient-id={p.id} data-has-coords={p.lat !== null} className={`px-3 py-2 cursor-pointer ${selectedId === pointId ? 'bg-blue-50' : 'hover:bg-gray-50'}`} onClick={() => setSelectedId(pointId)}>
                    <div className="flex items-center gap-2">
                      <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: PATIENT_STATUS_COLOR[p.status] ?? '#6b7280' }} />
                      <Link to={`/admin/patients/${p.id}`} className="hover:underline truncate" onClick={stopRowSelect}><Text as="span" size="sm" weight="medium" color="primary">{p.name}</Text></Link>
                      {p.distanceKm !== null && <Text as="span" size="xs" color="secondary" className="ml-auto shrink-0">{distanceLabel(p.distanceKm)}</Text>}
                    </div>
                    <Text as="div" size="xs" color="secondary" className="truncate">
                      {[patientStatusLabel(t, p.status), placeLabel(p) || (p.lat === null ? t('admin.map.noLocation', 'sin ubicación') : ''), p.openVacancies > 0 ? t('admin.map.openVacancies', { count: p.openVacancies, defaultValue: '{{count}} vacante(s) abierta(s)' }) : ''].filter(Boolean).join(' · ')}
                    </Text>
                  </li>
                );
              })}
            {!active.isLoading && !active.error && active.points.length === 0 && (
              <li className="px-3 py-4" data-testid="map-empty"><Text size="sm" color="secondary">{t('admin.map.empty', 'Nadie en este radio. Probá un radio mayor o mové el centro.')}</Text></li>
            )}
          </ul>
        </aside>

        <PointsMap
          points={mapPoints}
          center={center}
          radiusKm={radiusKm}
          onCenterChange={onCenterChange}
          selectedId={selectedId}
          onSelect={setSelectedId}
          placeholderText={t('admin.map.unavailable', 'El mapa no está disponible (sin clave de Google Maps). La lista sigue funcionando.')}
        />
      </div>
    </PageContainer>
  );
}
