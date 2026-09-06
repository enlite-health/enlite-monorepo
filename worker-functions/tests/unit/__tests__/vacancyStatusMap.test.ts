/**
 * vacancyStatusMap — Unit Tests
 *
 * Verifica que o mapa ClickUp → Enlite status retorna os pares corretos
 * para cada status canônico, incluindo variantes de idioma (PT/ES).
 */

import {
  mapClickUpVacancyStatus,
  CLICKUP_TO_VACANCY_STATUS,
} from '../../../src/modules/integration/infrastructure/clickup/mappings/vacancyStatusMap';

describe('mapClickUpVacancyStatus', () => {
  it('retorna null para status null', () => {
    expect(mapClickUpVacancyStatus(null)).toBeNull();
  });

  it('retorna null para status undefined', () => {
    expect(mapClickUpVacancyStatus(undefined)).toBeNull();
  });

  it('retorna null para string vazia', () => {
    expect(mapClickUpVacancyStatus('')).toBeNull();
  });

  it('retorna null para status desconhecido', () => {
    expect(mapClickUpVacancyStatus('un_status_que_no_existe')).toBeNull();
  });

  it('"Activo" (case-insensitive) → ACTIVE / ACTIVE', () => {
    expect(mapClickUpVacancyStatus('Activo')).toEqual({
      patientStatus: 'ACTIVE',
      jobPostingStatus: 'ACTIVE',
    });
    expect(mapClickUpVacancyStatus('ACTIVO')).toEqual({
      patientStatus: 'ACTIVE',
      jobPostingStatus: 'ACTIVE',
    });
    expect(mapClickUpVacancyStatus('activo')).toEqual({
      patientStatus: 'ACTIVE',
      jobPostingStatus: 'ACTIVE',
    });
  });

  it('"Activación pendiente" → ACTIVE / PENDING_ACTIVATION', () => {
    expect(mapClickUpVacancyStatus('Activación pendiente')).toEqual({
      patientStatus: 'ACTIVE',
      jobPostingStatus: 'PENDING_ACTIVATION',
    });
  });

  it('"Baja" → DISCHARGED / CLOSED (PatientStatus v2, spec 012: DISCONTINUED saiu)', () => {
    expect(mapClickUpVacancyStatus('Baja')).toEqual({
      patientStatus: 'DISCHARGED',
      jobPostingStatus: 'CLOSED',
    });
    expect(mapClickUpVacancyStatus('baja')).toEqual({
      patientStatus: 'DISCHARGED',
      jobPostingStatus: 'CLOSED',
    });
  });

  it('"Alta" → DISCHARGED / CLOSED', () => {
    expect(mapClickUpVacancyStatus('Alta')).toEqual({
      patientStatus: 'DISCHARGED',
      jobPostingStatus: 'CLOSED',
    });
  });

  it('"Suspendido Temporariamente" (PT) → SUSPENDED / SUSPENDED', () => {
    expect(mapClickUpVacancyStatus('Suspendido Temporariamente')).toEqual({
      patientStatus: 'SUSPENDED',
      jobPostingStatus: 'SUSPENDED',
    });
  });

  it('"Suspendido Temporalmente" (ES) → SUSPENDED / SUSPENDED', () => {
    expect(mapClickUpVacancyStatus('Suspendido Temporalmente')).toEqual({
      patientStatus: 'SUSPENDED',
      jobPostingStatus: 'SUSPENDED',
    });
  });

  it('"Equipe de resposta rápida" (PT) → ACTIVE / RAPID_RESPONSE', () => {
    expect(mapClickUpVacancyStatus('Equipe de resposta rápida')).toEqual({
      patientStatus: 'ACTIVE',
      jobPostingStatus: 'RAPID_RESPONSE',
    });
  });

  it('"Equipo de respuesta rapida" (ES, con "de") → ACTIVE / RAPID_RESPONSE', () => {
    expect(mapClickUpVacancyStatus('Equipo de respuesta rapida')).toEqual({
      patientStatus: 'ACTIVE',
      jobPostingStatus: 'RAPID_RESPONSE',
    });
  });

  it('"Equipo respuesta rápida" (ES, sin "de", con tilde) → ACTIVE / RAPID_RESPONSE', () => {
    expect(mapClickUpVacancyStatus('Equipo respuesta rápida')).toEqual({
      patientStatus: 'ACTIVE',
      jobPostingStatus: 'RAPID_RESPONSE',
    });
  });

  it('"Equipo respuesta rapida" (ES, sin "de", sin tilde) → ACTIVE / RAPID_RESPONSE', () => {
    expect(mapClickUpVacancyStatus('Equipo respuesta rapida')).toEqual({
      patientStatus: 'ACTIVE',
      jobPostingStatus: 'RAPID_RESPONSE',
    });
  });

  it('"admisión" (con tilde) → ADMISSION / null (sem vaga)', () => {
    expect(mapClickUpVacancyStatus('admisión')).toEqual({
      patientStatus: 'ADMISSION',
      jobPostingStatus: null,
    });
  });

  it('"Admisión" (capitalizado, con tilde) → ADMISSION / null', () => {
    expect(mapClickUpVacancyStatus('Admisión')).toEqual({
      patientStatus: 'ADMISSION',
      jobPostingStatus: null,
    });
  });

  it('"admision" (sin tilde) → ADMISSION / null', () => {
    expect(mapClickUpVacancyStatus('admision')).toEqual({
      patientStatus: 'ADMISSION',
      jobPostingStatus: null,
    });
  });

  it('"Reemplazo" → ACTIVE / SEARCHING_REPLACEMENT', () => {
    expect(mapClickUpVacancyStatus('Reemplazo')).toEqual({
      patientStatus: 'ACTIVE',
      jobPostingStatus: 'SEARCHING_REPLACEMENT',
    });
  });

  it('"Reemplazos" → ACTIVE / SEARCHING_REPLACEMENT', () => {
    expect(mapClickUpVacancyStatus('Reemplazos')).toEqual({
      patientStatus: 'ACTIVE',
      jobPostingStatus: 'SEARCHING_REPLACEMENT',
    });
  });

  it('"Busqueda" (sem tilde) → ACTIVE / SEARCHING', () => {
    expect(mapClickUpVacancyStatus('Busqueda')).toEqual({
      patientStatus: 'ACTIVE',
      jobPostingStatus: 'SEARCHING',
    });
  });

  it('"Búsqueda" (com tilde) → ACTIVE / SEARCHING', () => {
    expect(mapClickUpVacancyStatus('Búsqueda')).toEqual({
      patientStatus: 'ACTIVE',
      jobPostingStatus: 'SEARCHING',
    });
  });

  it('"Vacante Abierta" → ACTIVE / SEARCHING', () => {
    expect(mapClickUpVacancyStatus('Vacante Abierta')).toEqual({
      patientStatus: 'ACTIVE',
      jobPostingStatus: 'SEARCHING',
    });
  });

  it('"Vacante Abierto" (variante gênero) → ACTIVE / SEARCHING', () => {
    expect(mapClickUpVacancyStatus('Vacante Abierto')).toEqual({
      patientStatus: 'ACTIVE',
      jobPostingStatus: 'SEARCHING',
    });
  });

  it('"En espera" → ACTIVE / ON_HOLD', () => {
    expect(mapClickUpVacancyStatus('En espera')).toEqual({
      patientStatus: 'ACTIVE',
      jobPostingStatus: 'ON_HOLD',
    });
    expect(mapClickUpVacancyStatus('en espera')).toEqual({
      patientStatus: 'ACTIVE',
      jobPostingStatus: 'ON_HOLD',
    });
  });

  it('normaliza espaços em branco ao redor do status', () => {
    expect(mapClickUpVacancyStatus('  Baja  ')).toEqual({
      patientStatus: 'DISCHARGED',
      jobPostingStatus: 'CLOSED',
    });
  });

  describe('CLICKUP_TO_VACANCY_STATUS — cobertura da tabela canônica', () => {
    const EXPECTED_KEYS = [
      'activación pendiente',
      'activo',
      'admisión',
      'admision',
      'en espera',
      'equipe de resposta rápida',
      'equipo de respuesta rapida',
      'equipo respuesta rápida',
      'equipo respuesta rapida',
      'reemplazo',
      'reemplazos',
      'suspendido temporariamente',
      'suspendido temporalmente',
      'baja',
      'alta',
      'busqueda',
      'búsqueda',
      'vacante abierta',
      'vacante abierto',
    ];

    it(`contém todos os ${EXPECTED_KEYS.length} status canônicos esperados`, () => {
      for (const key of EXPECTED_KEYS) {
        expect(CLICKUP_TO_VACANCY_STATUS).toHaveProperty(key);
      }
    });

    it('patientStatus é sempre definido (nunca null/undefined) em todos os entries', () => {
      for (const [, val] of Object.entries(CLICKUP_TO_VACANCY_STATUS)) {
        expect(val.patientStatus).toBeTruthy();
      }
    });

    it('jobPostingStatus é string ou null (nunca undefined)', () => {
      for (const [, val] of Object.entries(CLICKUP_TO_VACANCY_STATUS)) {
        // jobPostingStatus may be null for ADMISSION entries — that is intentional
        expect(val.jobPostingStatus === null || typeof val.jobPostingStatus === 'string').toBe(true);
      }
    });

    it('apenas admisión/admision têm jobPostingStatus=null', () => {
      for (const [key, val] of Object.entries(CLICKUP_TO_VACANCY_STATUS)) {
        if (key === 'admisión' || key === 'admision') {
          expect(val.jobPostingStatus).toBeNull();
        } else {
          expect(val.jobPostingStatus).not.toBeNull();
        }
      }
    });

    it('patientStatus só usa valores canônicos do enum PatientStatus', () => {
      const VALID = ['PENDING_ADMISSION', 'ACTIVE', 'SUSPENDED', 'DISCHARGED', 'ADMISSION'];
      for (const [, val] of Object.entries(CLICKUP_TO_VACANCY_STATUS)) {
        expect(VALID).toContain(val.patientStatus);
      }
    });
  });
});
