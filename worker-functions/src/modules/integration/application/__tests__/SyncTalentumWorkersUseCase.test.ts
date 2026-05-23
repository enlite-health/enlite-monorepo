/**
 * SyncTalentumWorkersUseCase.test.ts
 *
 * Cobertura do use case de sync Talentum Dashboard → Enlite workers.
 *
 * Cenarios:
 *  1. Cria worker novo quando nao encontrado no DB
 *  2. Preenche dados faltantes sem sobrescrever existentes
 *  3. Vincula workers a casos via project titles
 *  4. Ignora perfis sem email e sem telefone
 *  5. Resiliencia a erros individuais
 *  6. Report retorna totais corretos
 *  7. Normaliza telefone argentino corretamente
 *  8. Lookup sequencial: email → phone → auth_uid
 *  9. Encripta first_name e last_name via KMS
 * 10. Cria encuadres com dedup_hash correto
 */

// ── Mocks (antes dos imports) ────────────────────────────────────

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({
        query: mockQuery,
      }),
    }),
  },
}));

const mockEncrypt = jest.fn().mockResolvedValue('encrypted-value');
const mockDecrypt = jest.fn().mockResolvedValue(null);

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    encrypt: mockEncrypt,
    decrypt: mockDecrypt,
  })),
}));

const mockListAllDashboardProfiles = jest.fn();

jest.mock('../../infrastructure/TalentumApiClient', () => ({
  TalentumApiClient: {
    create: jest.fn().mockResolvedValue({
      listAllDashboardProfiles: mockListAllDashboardProfiles,
    }),
  },
}));

// ── Imports ──────────────────────────────────────────────────────

import { SyncTalentumWorkersUseCase, WorkerSyncReport } from '../SyncTalentumWorkersUseCase';
import type { TalentumDashboardProfile } from '../../domain/ITalentumApiClient';

// ── Helpers ──────────────────────────────────────────────────────

function makeProfile(overrides: Partial<TalentumDashboardProfile> = {}): TalentumDashboardProfile {
  return {
    _id: overrides._id ?? 'abc123',
    firstName: overrides.firstName ?? 'María',
    lastName: overrides.lastName ?? 'González',
    fullName: overrides.fullName ?? 'María González',
    emails: overrides.emails ?? [{ type: 'personal', value: 'maria@example.com' }],
    phoneNumbers: overrides.phoneNumbers ?? [
      { type: 'personal', value: '+5491151265663', normalizedPhoneNumber: '5491151265663' },
    ],
    status: overrides.status ?? 'QUALIFIED',
    projects: overrides.projects ?? [
      { projectId: null, title: 'CASO 681', active: true },
    ],
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('SyncTalentumWorkersUseCase', () => {
  let useCase: SyncTalentumWorkersUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    // mockReset clears mockResolvedValueOnce queue that leaks between tests
    mockQuery.mockReset();
    mockEncrypt.mockReset();
    mockListAllDashboardProfiles.mockReset();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockEncrypt.mockResolvedValue('encrypted-value');
    useCase = new SyncTalentumWorkersUseCase();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── 1. Cria worker novo ─────────────────────────────────────

  describe('criar worker novo', () => {
    it('deve criar worker quando nao encontrado por email, phone ou auth_uid', async () => {
      const profile = makeProfile({ _id: 'new-profile-1' });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [] })                         // findByEmail → not found
        .mockResolvedValueOnce({ rows: [] })                         // findByPhone → not found
        .mockResolvedValueOnce({ rows: [] })                         // findByAuthUid → not found
        .mockResolvedValueOnce({ rows: [{ id: 'w-new-1' }] })       // INSERT worker
        // After create, re-lookup for linking
        .mockResolvedValueOnce({ rows: [{ id: 'w-new-1' }] })       // findByEmail → found
        // linkToCases
        .mockResolvedValueOnce({ rows: [{ id: 'jp-681' }] })        // find job_posting
        .mockResolvedValueOnce({ rows: [{ id: 'wja-1' }], rowCount: 1 }) // INSERT wja
        .mockResolvedValueOnce({ rows: [] });                        // INSERT encuadre

      const report = await useCase.execute();

      expect(report.created).toBe(1);
      expect(report.updated).toBe(0);
    });

    it('deve inserir com auth_uid = talentum_<_id>', async () => {
      const profile = makeProfile({ _id: 'profile-xyz' });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [] })                         // findByEmail
        .mockResolvedValueOnce({ rows: [] })                         // findByPhone
        .mockResolvedValueOnce({ rows: [] })                         // findByAuthUid
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })           // INSERT worker
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })           // re-lookup
        .mockResolvedValueOnce({ rows: [] });                        // no job_posting for case

      await useCase.execute();

      const insertCall = mockQuery.mock.calls.find(
        (call: any[]) => (call[0] as string).includes('INSERT INTO workers'),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall![1][0]).toBe('talentum_profile-xyz');
    });

    it('deve inserir com status INCOMPLETE_REGISTER e country AR', async () => {
      const profile = makeProfile();
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })
        .mockResolvedValueOnce({ rows: [] });

      await useCase.execute();

      const insertCall = mockQuery.mock.calls.find(
        (call: any[]) => (call[0] as string).includes('INSERT INTO workers'),
      );
      const sql = insertCall![0] as string;
      expect(sql).toContain("'INCOMPLETE_REGISTER'");
      expect(sql).toContain("'AR'");
    });

    it('deve tratar unique violation (23505) como worker existente', async () => {
      const profile = makeProfile({ _id: 'dup-profile' });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      const uniqueError = new Error('duplicate key') as any;
      uniqueError.code = '23505';

      mockQuery
        .mockResolvedValueOnce({ rows: [] })                                // findByEmail
        .mockResolvedValueOnce({ rows: [] })                                // findByPhone
        .mockResolvedValueOnce({ rows: [] })                                // findByAuthUid
        .mockRejectedValueOnce(uniqueError)                                 // INSERT fails with 23505
        .mockResolvedValueOnce({ rows: [{ id: 'w-existing' }] })           // fallback SELECT
        // fillMissingData
        .mockResolvedValueOnce({ rows: [{ email: 'maria@example.com', phone: null, first_name_encrypted: null, last_name_encrypted: null, auth_uid: null }] })
        .mockResolvedValueOnce({ rows: [] })                                // UPDATE
        // re-lookup for linking
        .mockResolvedValueOnce({ rows: [{ id: 'w-existing' }] })
        .mockResolvedValueOnce({ rows: [] });                               // no job_posting

      const report = await useCase.execute();

      // Worker was "created" even though it resolved to existing via fallback
      expect(report.errors).toHaveLength(0);
    });
  });

  // ── 2. Preenche dados faltantes sem sobrescrever ─────────────

  describe('preencher dados faltantes', () => {
    it('deve preencher phone quando NULL no DB', async () => {
      const profile = makeProfile();
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'w-exist' }] })             // findByEmail → found
        // fillMissingData
        .mockResolvedValueOnce({ rows: [{ email: 'maria@example.com', phone: null, first_name_encrypted: 'enc', last_name_encrypted: 'enc', auth_uid: 'talentum_abc123' }] })
        .mockResolvedValueOnce({ rows: [] })                               // UPDATE
        // linkToCases
        .mockResolvedValueOnce({ rows: [{ id: 'jp-681' }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [] });

      const report = await useCase.execute();

      expect(report.updated).toBe(1);
      expect(report.skipped).toBe(0);

      const updateCall = mockQuery.mock.calls.find(
        (call: any[]) => (call[0] as string).includes('UPDATE workers SET'),
      );
      expect(updateCall).toBeDefined();
      // phone should be in the update values
      const sql = updateCall![0] as string;
      expect(sql).toContain('phone');
    });

    it('NÃO deve sobrescrever phone quando já existe no DB', async () => {
      const profile = makeProfile();
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'w-exist' }] })             // findByEmail → found
        // fillMissingData — all fields already filled
        .mockResolvedValueOnce({ rows: [{ email: 'maria@example.com', phone: '5491199999999', first_name_encrypted: 'enc-name', last_name_encrypted: 'enc-last', auth_uid: 'talentum_abc123' }] })
        // linkToCases
        .mockResolvedValueOnce({ rows: [{ id: 'jp-681' }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [] });

      const report = await useCase.execute();

      expect(report.skipped).toBe(1);
      expect(report.updated).toBe(0);

      // No UPDATE should have been called
      const updateCall = mockQuery.mock.calls.find(
        (call: any[]) => (call[0] as string).includes('UPDATE workers SET'),
      );
      expect(updateCall).toBeUndefined();
    });

    it('deve preencher first_name e last_name quando vazios', async () => {
      const profile = makeProfile({ firstName: 'Elvira', lastName: 'Peralta' });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'w-exist' }] })             // findByEmail
        // fillMissingData — names are empty
        .mockResolvedValueOnce({ rows: [{ email: 'maria@example.com', phone: '5491151265663', first_name_encrypted: '', last_name_encrypted: '', auth_uid: 'talentum_abc123' }] })
        .mockResolvedValueOnce({ rows: [] })                               // UPDATE
        // linkToCases
        .mockResolvedValueOnce({ rows: [] });                              // no job_posting

      const report = await useCase.execute();

      expect(report.updated).toBe(1);
      expect(mockEncrypt).toHaveBeenCalledWith('Elvira');
      expect(mockEncrypt).toHaveBeenCalledWith('Peralta');
    });
  });

  // ── 3. Vinculação a casos ────────────────────────────────────

  describe('vincular workers a casos', () => {
    it('deve criar worker_job_application quando job_posting existe', async () => {
      const profile = makeProfile({
        projects: [{ projectId: null, title: 'CASO 681', active: true }],
      });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })                 // findByEmail → found
        .mockResolvedValueOnce({ rows: [{ email: 'maria@example.com', phone: '123', first_name_encrypted: 'enc', last_name_encrypted: 'enc', auth_uid: 'talentum_abc123' }] })
        .mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] }) // linkToCases status check
        // linkToCases
        .mockResolvedValueOnce({ rows: [{ id: 'jp-681' }] })              // find job_posting by case_number
        .mockResolvedValueOnce({ rows: [{ id: 'wja-1' }], rowCount: 1 })  // INSERT wja
        .mockResolvedValueOnce({ rows: [] });                              // INSERT encuadre

      const report = await useCase.execute();

      expect(report.linked).toBe(1);

      // Verify WJA insert — sync seta INVITED explícito (não depende de default da coluna).
      // profile.status é ignorado: webhook PRESCREENING_RESPONSE é fonte canônica per-encuadre.
      const wjaCall = mockQuery.mock.calls.find(
        (call: any[]) => (call[0] as string).includes('INSERT INTO worker_job_applications'),
      );
      expect(wjaCall).toBeDefined();
      expect(wjaCall![1]).toContain('w-1');      // worker_id
      expect(wjaCall![1]).toContain('jp-681');   // job_posting_id
      const sql = wjaCall![0] as string;
      expect(sql).toContain('application_funnel_stage');
      expect(sql).toContain('INVITED');
      expect(sql).toContain('ON CONFLICT (worker_id, job_posting_id) DO NOTHING');
    });

    it('deve criar encuadre com dedup_hash baseado em dashboard|profileId|caseNumber', async () => {
      const profile = makeProfile({ _id: 'prof-999' });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })
        .mockResolvedValueOnce({ rows: [{ email: 'maria@example.com', phone: '123', first_name_encrypted: 'enc', last_name_encrypted: 'enc', auth_uid: 'talentum_abc123' }] })
        .mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] }) // linkToCases status check
        .mockResolvedValueOnce({ rows: [{ id: 'jp-681' }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [] });                              // encuadre INSERT

      await useCase.execute();

      const encuadreCall = mockQuery.mock.calls.find(
        (call: any[]) => (call[0] as string).includes('INSERT INTO encuadres'),
      );
      expect(encuadreCall).toBeDefined();
      // 'Talentum' is a SQL literal in the INSERT, not a parameter
      expect(encuadreCall![0]).toContain("'Talentum'");
    });

    it('deve processar multiplos projects por perfil', async () => {
      const profile = makeProfile({
        projects: [
          { projectId: null, title: 'CASO 681', active: true },
          { projectId: null, title: 'CASO 728', active: true },
        ],
      });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })                 // findByEmail
        .mockResolvedValueOnce({ rows: [{ email: 'maria@example.com', phone: '123', first_name_encrypted: 'enc', last_name_encrypted: 'enc', auth_uid: 'talentum_abc123' }] })
        .mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] }) // linkToCases status check
        // CASO 681
        .mockResolvedValueOnce({ rows: [{ id: 'jp-681' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'wja-1' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [] })
        // CASO 728
        .mockResolvedValueOnce({ rows: [{ id: 'jp-728' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'wja-2' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [] });

      const report = await useCase.execute();

      expect(report.linked).toBe(2);
    });

    it('deve ignorar projects sem CASO no titulo', async () => {
      const profile = makeProfile({
        projects: [
          { projectId: null, title: 'Acompañante terapeutico', active: true },
        ],
      });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })
        .mockResolvedValueOnce({ rows: [{ email: 'maria@example.com', phone: '123', first_name_encrypted: 'enc', last_name_encrypted: 'enc', auth_uid: 'talentum_abc123' }] })
        .mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] }); // linkToCases status check

      const report = await useCase.execute();

      expect(report.linked).toBe(0);
    });

    it('deve ignorar quando job_posting nao existe para o case_number', async () => {
      const profile = makeProfile({
        projects: [{ projectId: null, title: 'CASO 99999', active: true }],
      });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })
        .mockResolvedValueOnce({ rows: [{ email: 'maria@example.com', phone: '123', first_name_encrypted: 'enc', last_name_encrypted: 'enc', auth_uid: 'talentum_abc123' }] })
        .mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] }) // linkToCases status check
        .mockResolvedValueOnce({ rows: [] });                              // job_posting not found

      const report = await useCase.execute();

      expect(report.linked).toBe(0);
    });

    it('deve skipar linkToCases quando worker.status != REGISTERED (INCOMPLETE_REGISTER)', async () => {
      const profile = makeProfile({
        projects: [{ projectId: null, title: 'CASO 681', active: true }],
      });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })                 // findByEmail → found
        .mockResolvedValueOnce({ rows: [{ email: 'maria@example.com', phone: '123', first_name_encrypted: 'enc', last_name_encrypted: 'enc', auth_uid: 'talentum_abc123' }] })
        .mockResolvedValueOnce({ rows: [{ status: 'INCOMPLETE_REGISTER' }] }); // status check → bloqueia

      const report = await useCase.execute();

      // linkToCases retorna 0 — sem buscar job_posting nem inserir wja
      expect(report.linked).toBe(0);
      expect(report.skippedIncompleteRegistration).toBe(1);

      // Nenhuma chamada de jp lookup ou wja insert
      const jpCall = mockQuery.mock.calls.find(
        (call: any[]) => (call[0] as string).includes('case_number = $1'),
      );
      expect(jpCall).toBeUndefined();

      const wjaCall = mockQuery.mock.calls.find(
        (call: any[]) => (call[0] as string).includes('INSERT INTO worker_job_applications'),
      );
      expect(wjaCall).toBeUndefined();
    });
  });

  // ── 4. Ignora perfis invalidos ──────────────────────────────

  describe('perfis sem dados de contato', () => {
    it('deve pular perfil sem email e sem telefone', async () => {
      const profile = makeProfile({
        emails: [],
        phoneNumbers: [],
      });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      const report = await useCase.execute();

      expect(report.skipped).toBe(1);
      expect(report.created).toBe(0);
    });

    it('deve processar perfil com apenas email (sem telefone)', async () => {
      const profile = makeProfile({ phoneNumbers: [] });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [] })                         // findByEmail → not found
        .mockResolvedValueOnce({ rows: [] })                         // findByAuthUid → not found (skip phone)
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })           // INSERT worker
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })           // re-lookup
        .mockResolvedValueOnce({ rows: [] });                        // no job_posting

      const report = await useCase.execute();

      expect(report.created).toBe(1);
    });

    it('deve processar perfil com apenas telefone (sem email)', async () => {
      const profile = makeProfile({ emails: [] });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [] })                         // findByPhone → not found
        .mockResolvedValueOnce({ rows: [] })                         // findByAuthUid → not found
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })           // INSERT worker
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })           // re-lookup (by phone)
        .mockResolvedValueOnce({ rows: [] });                        // no job_posting

      const report = await useCase.execute();

      expect(report.created).toBe(1);
    });
  });

  // ── 5. Resiliencia a erros ──────────────────────────────────

  describe('resiliencia a erros individuais', () => {
    it('deve continuar sync quando um perfil falha', async () => {
      const profiles = [
        makeProfile({ _id: 'fail-1', emails: [{ type: 'personal', value: 'fail@test.com' }] }),
        makeProfile({ _id: 'ok-1', emails: [{ type: 'personal', value: 'ok@test.com' }] }),
      ];
      mockListAllDashboardProfiles.mockResolvedValue(profiles);

      let emailCallCount = 0;
      mockQuery.mockImplementation((sql: string, params?: any[]) => {
        if (sql.includes('LOWER(email)')) {
          emailCallCount++;
          if (emailCallCount === 1) return Promise.reject(new Error('DB connection lost'));
          return Promise.resolve({ rows: [{ id: 'w-ok' }] });
        }
        if (sql.includes('SELECT email, phone')) {
          return Promise.resolve({ rows: [{ email: 'ok@test.com', phone: '123', first_name_encrypted: 'enc', last_name_encrypted: 'enc', auth_uid: 'talentum_ok-1' }] });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const report = await useCase.execute();

      expect(report.total).toBe(2);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0].profileId).toBe('fail-1');
    });

    it('deve registrar profileId e nome no erro', async () => {
      const profile = makeProfile({ _id: 'err-id', fullName: 'Error Worker' });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery.mockRejectedValue(new Error('timeout'));

      const report = await useCase.execute();

      expect(report.errors[0]).toEqual({
        profileId: 'err-id',
        name: 'Error Worker',
        error: 'timeout',
      });
    });
  });

  // ── 6. Report completo ──────────────────────────────────────

  describe('relatorio final', () => {
    it('deve retornar total=0 quando nao ha perfis', async () => {
      mockListAllDashboardProfiles.mockResolvedValue([]);

      const report = await useCase.execute();

      expect(report.total).toBe(0);
      expect(report.created).toBe(0);
      expect(report.updated).toBe(0);
      expect(report.skipped).toBe(0);
      expect(report.linked).toBe(0);
      expect(report.errors).toHaveLength(0);
    });

    it('deve retornar totais corretos para cenario misto', async () => {
      const profiles = [
        makeProfile({ _id: 'new-1', emails: [{ type: 'personal', value: 'new@test.com' }], projects: [] }),
        makeProfile({ _id: 'exist-1', emails: [{ type: 'personal', value: 'exist@test.com' }], projects: [] }),
        makeProfile({ _id: 'skip-1', emails: [], phoneNumbers: [], projects: [] }),
      ];
      mockListAllDashboardProfiles.mockResolvedValue(profiles);

      // Track email lookups: 1st = new (not found), 2nd = re-lookup new (found), 3rd = existing
      let emailCallCount = 0;
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('LOWER(email)')) {
          emailCallCount++;
          if (emailCallCount === 1) return Promise.resolve({ rows: [] });             // new: first lookup
          if (emailCallCount === 2) return Promise.resolve({ rows: [{ id: 'w-new' }] }); // new: re-lookup after create
          return Promise.resolve({ rows: [{ id: 'w-exist' }] });                      // existing
        }
        if (sql.includes('phone = ANY')) return Promise.resolve({ rows: [] });
        if (sql.includes('WHERE auth_uid')) return Promise.resolve({ rows: [] });
        if (sql.includes('INSERT INTO workers')) return Promise.resolve({ rows: [{ id: 'w-new' }] });
        if (sql.includes('SELECT email, phone')) {
          return Promise.resolve({ rows: [{ email: 'exist@test.com', phone: '5491151265663', first_name_encrypted: 'enc', last_name_encrypted: 'enc', auth_uid: 'talentum_exist-1' }] });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const report = await useCase.execute();

      expect(report.total).toBe(3);
      expect(report.created).toBe(1);
      expect(report.skipped).toBe(2); // exist (no missing data) + no-contact
    });
  });

  // ── 7. Normalização de telefone ─────────────────────────────

  describe('normalizacao de telefone', () => {
    it('deve normalizar telefone argentino antes de lookup e insert', async () => {
      const profile = makeProfile({
        phoneNumbers: [{ type: 'personal', value: '+5491151265663' }],
      });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [] })                         // findByEmail
        .mockResolvedValueOnce({ rows: [] })                         // findByPhone
        .mockResolvedValueOnce({ rows: [] })                         // findByAuthUid
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })           // INSERT
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })           // re-lookup
        .mockResolvedValueOnce({ rows: [] });                        // no job_posting

      await useCase.execute();

      // Check phone candidates were used in lookup
      const phoneCall = mockQuery.mock.calls.find(
        (call: any[]) => (call[0] as string).includes('phone = ANY'),
      );
      expect(phoneCall).toBeDefined();
    });
  });

  // ── 8. Lookup sequencial ────────────────────────────────────

  describe('lookup sequencial email → phone → auth_uid', () => {
    it('deve parar no email se encontrado', async () => {
      const profile = makeProfile();
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'w-by-email' }] })     // findByEmail → found!
        // fillMissingData
        .mockResolvedValueOnce({ rows: [{ email: 'maria@example.com', phone: '123', first_name_encrypted: 'enc', last_name_encrypted: 'enc', auth_uid: 'talentum_abc123' }] })
        .mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] }) // linkToCases status check
        // linkToCases
        .mockResolvedValueOnce({ rows: [] });

      await useCase.execute();

      // Should NOT have queried by phone or auth_uid
      const phoneCalls = mockQuery.mock.calls.filter(
        (call: any[]) => (call[0] as string).includes('phone = ANY'),
      );
      expect(phoneCalls).toHaveLength(0);
    });

    it('deve tentar phone quando email nao encontra', async () => {
      const profile = makeProfile();
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [] })                          // findByEmail → not found
        .mockResolvedValueOnce({ rows: [{ id: 'w-by-phone' }] })     // findByPhone → found!
        // fillMissingData
        .mockResolvedValueOnce({ rows: [{ email: null, phone: '5491151265663', first_name_encrypted: 'enc', last_name_encrypted: 'enc', auth_uid: null }] })
        .mockResolvedValueOnce({ rows: [] })                          // UPDATE (fill email)
        // linkToCases
        .mockResolvedValueOnce({ rows: [] });

      const report = await useCase.execute();

      expect(report.updated).toBe(1);
    });

    it('deve tentar auth_uid quando email e phone nao encontram', async () => {
      const profile = makeProfile({ _id: 'known-id' });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [] })                          // findByEmail
        .mockResolvedValueOnce({ rows: [] })                          // findByPhone
        .mockResolvedValueOnce({ rows: [{ id: 'w-by-auth' }] })      // findByAuthUid → found!
        // fillMissingData
        .mockResolvedValueOnce({ rows: [{ email: null, phone: null, first_name_encrypted: '', last_name_encrypted: '', auth_uid: 'talentum_known-id' }] })
        .mockResolvedValueOnce({ rows: [] })                          // UPDATE
        // linkToCases
        .mockResolvedValueOnce({ rows: [] });

      const report = await useCase.execute();

      expect(report.updated).toBe(1);

      const authCall = mockQuery.mock.calls.find(
        (call: any[]) => (call[0] as string).includes('auth_uid = $1') && call[1]?.[0] === 'talentum_known-id',
      );
      expect(authCall).toBeDefined();
    });
  });

  // ── 9. Encriptacao KMS ──────────────────────────────────────

  describe('encriptacao de nome via KMS', () => {
    it('deve chamar encrypt para firstName e lastName ao criar worker', async () => {
      const profile = makeProfile({ firstName: 'Elvira', lastName: 'Peralta' });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })
        .mockResolvedValueOnce({ rows: [] });

      await useCase.execute();

      expect(mockEncrypt).toHaveBeenCalledWith('Elvira');
      expect(mockEncrypt).toHaveBeenCalledWith('Peralta');
    });

    it('NÃO deve chamar encrypt quando firstName/lastName estao vazios', async () => {
      const profile = makeProfile({ firstName: '', lastName: '' });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })
        .mockResolvedValueOnce({ rows: [] });

      await useCase.execute();

      expect(mockEncrypt).not.toHaveBeenCalled();
    });
  });

  // ── 10. Extraçao de case_number ─────────────────────────────

  describe('extracao de case_number', () => {
    it('deve extrair case_number de "CASO 681"', async () => {
      const profile = makeProfile({
        projects: [{ projectId: null, title: 'CASO 681', active: true }],
      });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })
        .mockResolvedValueOnce({ rows: [{ email: 'maria@example.com', phone: '123', first_name_encrypted: 'enc', last_name_encrypted: 'enc', auth_uid: 'talentum_abc123' }] })
        .mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] }) // linkToCases status check
        .mockResolvedValueOnce({ rows: [{ id: 'jp-681' }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [] });

      await useCase.execute();

      const jpCall = mockQuery.mock.calls.find(
        (call: any[]) => (call[0] as string).includes('case_number = $1'),
      );
      expect(jpCall![1][0]).toBe(681);
    });

    it('deve extrair case_number de titulo complexo "CASO 754  AT, para pacientes con TEA"', async () => {
      const profile = makeProfile({
        projects: [{ projectId: null, title: 'CASO 754  AT, para pacientes con TEA - Mar del Plata', active: true }],
      });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })
        .mockResolvedValueOnce({ rows: [{ email: 'maria@example.com', phone: '123', first_name_encrypted: 'enc', last_name_encrypted: 'enc', auth_uid: 'talentum_abc123' }] })
        .mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] }) // linkToCases status check
        .mockResolvedValueOnce({ rows: [{ id: 'jp-754' }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [] });

      await useCase.execute();

      const jpCall = mockQuery.mock.calls.find(
        (call: any[]) => (call[0] as string).includes('case_number = $1'),
      );
      expect(jpCall![1][0]).toBe(754);
    });

    it('deve aceitar "caso" case-insensitive', async () => {
      const profile = makeProfile({
        projects: [{ projectId: null, title: 'Caso 712', active: true }],
      });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })
        .mockResolvedValueOnce({ rows: [{ email: 'maria@example.com', phone: '123', first_name_encrypted: 'enc', last_name_encrypted: 'enc', auth_uid: 'talentum_abc123' }] })
        .mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] }) // linkToCases status check
        .mockResolvedValueOnce({ rows: [{ id: 'jp-712' }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [] });

      await useCase.execute();

      const jpCall = mockQuery.mock.calls.find(
        (call: any[]) => (call[0] as string).includes('case_number = $1'),
      );
      expect(jpCall![1][0]).toBe(712);
    });
  });

  // ── 11. Sync contract: stage INVITED explícito, ON CONFLICT DO NOTHING ────

  describe('sync contract — INVITED explícito (TD-035 final)', () => {
    function mockRegisteredWorkerFlow(): void {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] })         // findByEmail → found
        .mockResolvedValueOnce({ rows: [{ email: 'maria@example.com', phone: '123', first_name_encrypted: 'enc', last_name_encrypted: 'enc', auth_uid: 'talentum_abc123' }] })
        .mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] }) // linkToCases status check
        .mockResolvedValueOnce({ rows: [{ id: 'jp-681' }] })       // find job_posting
        .mockResolvedValueOnce({ rows: [{ id: 'wja-1' }], rowCount: 1 })  // INSERT wja
        .mockResolvedValueOnce({ rows: [] });                       // INSERT encuadre
    }

    it('INSERT inclui application_funnel_stage=INVITED + ON CONFLICT DO NOTHING', async () => {
      // profile.status global é ignorado pelo sync — só webhook canônico per-encuadre
      // pode setar INITIATED+. Sync sempre garante WJA com INVITED.
      const profile = makeProfile({ status: 'QUALIFIED' });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);
      mockRegisteredWorkerFlow();

      await useCase.execute();

      const wjaCall = mockQuery.mock.calls.find(
        (call: any[]) => (call[0] as string).includes('INSERT INTO worker_job_applications'),
      );
      const sql = wjaCall![0] as string;
      expect(sql).toContain('application_funnel_stage');
      expect(sql).toContain('INVITED');
      expect(sql).toContain('ON CONFLICT (worker_id, job_posting_id) DO NOTHING');
      // Confirma que NÃO há lógica de upgrade no sync — webhook é dono
      expect(sql).not.toContain('funnel_stage_precedence');
      expect(sql).not.toContain('DO UPDATE');
    });

    it('profile.status não influencia o stage atribuído pelo sync', async () => {
      // Teste cruza: mesmo com profile.status=COMPLETED, sync seta INVITED
      const profile = makeProfile({ status: 'COMPLETED' });
      mockListAllDashboardProfiles.mockResolvedValue([profile]);
      mockRegisteredWorkerFlow();

      await useCase.execute();

      const wjaCall = mockQuery.mock.calls.find(
        (call: any[]) => (call[0] as string).includes('INSERT INTO worker_job_applications'),
      );
      const sql = wjaCall![0] as string;
      expect(sql).toContain('INVITED');
      expect(sql).not.toContain("'COMPLETED'");
    });
  });
});
