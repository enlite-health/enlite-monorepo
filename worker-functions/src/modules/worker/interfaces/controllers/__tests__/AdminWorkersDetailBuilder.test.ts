/**
 * AdminWorkersDetailBuilder — a ficha do prestador PROJETADA por container (D286 fase 2).
 *
 * A prova de cada container é o ESPIÃO no `decrypt` (C3 da F2): sem a célula, o campo cifrado
 * daquele container nunca chega ao KMS — não é "chegou e foi apagado". Para documentos e
 * encuadres a prova é a QUERY que não roda.
 */
import { NOME_REDIGIDO } from '@modules/identity/permissions';
import { buildWorkerDetailResponse } from '../AdminWorkersDetailBuilder';

const queries: string[] = [];
// Mutável por teste: cobre o ramo de comparator do sort() de encuadres
// (só é exercitado com 2+ linhas combinadas de WJA + bloqueadas).
let extraJobApplicationRow: Record<string, unknown> | null = null;
const mockQuery = jest.fn(async (sql: string) => {
  queries.push(sql);
  if (sql.includes('FROM worker_documents')) {
    return {
      rows: [{
        id: 'doc-1', resume_cv_url: 'cv.pdf', identity_document_url: 'dni.jpg', documents_status: 'approved',
        // additional_certificates_urls + document_validations não-vazios cobrem o
        // ramo do .map() de adicionais e o loop de Object.entries(rawValidations).
        additional_certificates_urls: ['extra-cert.pdf'],
        document_validations: { identity_document: { validated_by: 'admin@enlite.health', validated_at: '2025-01-01T00:00:00Z' } },
      }],
    };
  }
  if (sql.includes('FROM worker_service_areas') && sql.includes('LIMIT 1')) {
    return { rows: [{ address: 'Calle Falsa 123', city: 'Buenos Aires', work_zone: 'Palermo', interest_zone: 'Belgrano' }] };
  }
  if (sql.includes('FROM worker_service_areas')) {
    return { rows: [{ id: 'sa-1', address_line: 'Calle Falsa 123', latitude: '-34.6', longitude: '-58.4', radius_km: 10, city: 'Buenos Aires' }] };
  }
  if (sql.includes('FROM worker_availability')) return { rows: [{ id: 'av-1', day_of_week: 1, start_time: '08:00', end_time: '12:00', timezone: 'America/Argentina/Buenos_Aires', crosses_midnight: false }] };
  if (sql.includes('FROM worker_tags')) return { rows: [{ id: 'tag-1', name: 'VIP', color: '#000', description: null }] };
  // Encuadres (WorkerApplicationRepository / BlockedApplicationQueryRepository)
  if (sql.includes('FROM worker_blocked_applications')) return { rows: [] };
  if (sql.includes('FROM worker_job_applications')) {
    const base = {
      id: 'enc-1', job_posting_id: 'jp-1', funnel_stage: 'SELECTED', source: 'talentum', case_number: 42, vacancy_number: 1,
      vacancy_status: 'ACTIVE', patient_first_name: 'Juan', patient_last_name: 'Perez', resultado: null, interview_date: null,
      interview_time: null, recruiter_name: null, coordinator_name: null, rejection_reason: null, rejection_reason_category: null,
      attended: null, created_at: '2025-03-01T10:00:00Z',
    };
    return { rows: extraJobApplicationRow ? [base, extraJobApplicationRow] : [base] };
  }
  return { rows: [] };
});

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: (...a: unknown[]) => mockQuery(a[0] as string) }) }) },
}));
jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  reportError: jest.fn(),
}));

const decrypt = jest.fn(async (v: string | null) => (v ? v.replace('enc_', '') : null));
const enc = { decrypt } as unknown as import('@shared/security/KMSEncryptionService').KMSEncryptionService;
const gcs = { generateViewSignedUrl: jest.fn(async (p: string) => `signed:${p}`) } as unknown as import('../../../infrastructure/GCSStorageService').GCSStorageService;
const db = { query: mockQuery } as unknown as import('pg').Pool;

const ROW = {
  id: 'w-1', email: 'maria@example.com', phone: '+5491100000000', country: 'AR', timezone: 'America/Argentina/Buenos_Aires',
  status: 'REGISTERED', deleted_at: null, is_test: false, data_sources: ['candidatos'], document_type: 'DNI',
  profession: 'enfermeria', occupation: 'cuidador', hobbies: ['x'], diagnostic_preferences: [],
  first_name_encrypted: 'enc_Maria', last_name_encrypted: 'enc_Garcia', birth_date_encrypted: 'enc_1990-01-01',
  sex_encrypted: 'enc_F', gender_encrypted: 'enc_F', document_number_encrypted: 'enc_12345678',
  profile_photo_url_encrypted: 'enc_photo.jpg', languages_encrypted: 'enc_["es"]', whatsapp_phone_encrypted: 'enc_+549',
  linkedin_url_encrypted: 'enc_li', sexual_orientation_encrypted: 'enc_so', race_encrypted: 'enc_r',
  religion_encrypted: 'enc_rel', weight_kg_encrypted: 'enc_60', height_cm_encrypted: 'enc_170',
};

const CIFRADOS_DE_CONTATO = ['enc_Maria', 'enc_Garcia', 'enc_+549', 'enc_li'];
const CIFRADOS_DE_DOSSIE = ['enc_1990-01-01', 'enc_F', 'enc_12345678', 'enc_photo.jpg', 'enc_so', 'enc_r', 'enc_rel', 'enc_60', 'enc_170'];

function abertos(): string[] {
  return decrypt.mock.calls.map((c) => c[0] as string);
}

beforeEach(() => {
  queries.length = 0;
  decrypt.mockClear();
  mockQuery.mockClear();
  extraJobApplicationRow = null;
  (gcs.generateViewSignedUrl as jest.Mock).mockClear();
  (gcs.generateViewSignedUrl as jest.Mock).mockImplementation(async (p: string) => `signed:${p}`);
});

describe('cells = null (engine não decidiu) — a ficha inteira, como antes (D113)', () => {
  it('descriptografa tudo, roda todas as queries e NÃO emite marcador', async () => {
    const data = await buildWorkerDetailResponse(db, enc, gcs, ROW, null);
    expect(data.firstName).toBe('Maria');
    expect(data.documentNumber).toBe('12345678');
    expect(data.documents).toMatchObject({ resumeCvUrl: 'signed:cv.pdf' });
    expect(data.encuadres).toHaveLength(1);
    expect(data.encuadres[0].patientName).toBe('Juan Perez');
    expect(data.location.address).toBe('Calle Falsa 123');
    expect(data.redacted).toBeUndefined();
    expect(abertos()).toEqual(expect.arrayContaining([...CIFRADOS_DE_CONTATO, ...CIFRADOS_DE_DOSSIE]));
  });

  it('cells omitido é o mesmo que null', async () => {
    const data = await buildWorkerDetailResponse(db, enc, gcs, ROW);
    expect(data.redacted).toBeUndefined();
    expect(data.firstName).toBe('Maria');
  });
});

describe('só worker:read — o operacional sai, o resto NÃO chega ao KMS', () => {
  const CELLS = ['worker:read'];

  it('🔴 espião: nenhum cifrado de contato nem de dossiê é aberto; idiomas (profissional) sim', async () => {
    await buildWorkerDetailResponse(db, enc, gcs, ROW, CELLS);
    for (const c of [...CIFRADOS_DE_CONTATO, ...CIFRADOS_DE_DOSSIE]) expect(abertos()).not.toContain(c);
    expect(abertos()).toContain('enc_["es"]');
  });

  it('nome vem como NOME_REDIGIDO (trava, não rótulo — D181); e-mail, telefone, whatsapp, linkedin nulos', async () => {
    const data = await buildWorkerDetailResponse(db, enc, gcs, ROW, CELLS);
    expect(data.firstName).toBe(NOME_REDIGIDO);
    expect(data.lastName).toBeNull();
    expect(data.email).toBeNull();
    expect(data.phone).toBeNull();
    expect(data.whatsappPhone).toBeNull();
    expect(data.linkedinUrl).toBeNull();
  });

  it('dossiê nulo: DNI (tipo E número), nascimento, sexo, foto, raça, religião, orientação, peso, altura, LINHA de endereço', async () => {
    const data = await buildWorkerDetailResponse(db, enc, gcs, ROW, CELLS);
    for (const f of ['documentType', 'documentNumber', 'birthDate', 'sex', 'gender', 'profilePhotoUrl', 'race', 'religion', 'sexualOrientation', 'weightKg', 'heightCm']) {
      expect(data[f]).toBeNull();
    }
    // coordenada É endereço (lex P2), célula própria worker_address: o bloco de áreas sai null;
    // cidade/zona (critério de matching) ficam
    expect(data.location).toMatchObject({ address: null, city: 'Buenos Aires', workZone: 'Palermo' });
    expect(data.serviceAreas).toBeNull();
  });

  it('documentos: a query NEM RODA e nenhuma URL é assinada; encuadres: idem, e vem null (não [])', async () => {
    const data = await buildWorkerDetailResponse(db, enc, gcs, ROW, CELLS);
    expect(queries.some((q) => q.includes('FROM worker_documents'))).toBe(false);
    expect((gcs.generateViewSignedUrl as jest.Mock).mock.calls).toHaveLength(0);
    expect(data.documents).toBeNull();
    expect(data.encuadres).toBeNull();
    expect(queries.some((q) => q.includes('worker_job_applications') || q.includes('worker_blocked_applications'))).toBe(false);
  });

  it('o operacional continua inteiro: status, profissão, zonas, disponibilidade, etiquetas, conta de teste', async () => {
    const data = await buildWorkerDetailResponse(db, enc, gcs, ROW, CELLS);
    expect(data).toMatchObject({
      id: 'w-1', status: 'REGISTERED', profession: 'enfermeria', occupation: 'cuidador', isTest: false, isMatchable: true,
      languages: ['es'], country: 'AR',
    });
    expect(data.availability).toHaveLength(1);
    expect(data.tags).toEqual([{ id: 'tag-1', name: 'VIP', color: '#000', description: undefined }]);
  });

  it('marcador CONSTANTE: os 5 containers redigidos, com ou sem conteúdo', async () => {
    const data = await buildWorkerDetailResponse(db, enc, gcs, ROW, CELLS);
    expect(data.redacted).toEqual({ contact: true, dossier: true, address: true, documents: true, encuadres: true });
    const semNada = await buildWorkerDetailResponse(db, enc, gcs, { ...ROW, first_name_encrypted: null, document_number_encrypted: null }, CELLS);
    expect(semNada.redacted).toEqual({ contact: true, dossier: true, address: true, documents: true, encuadres: true });
  });
});

describe('um container de cada vez', () => {
  it('worker_contact:read abre nome/e-mail/telefone e NADA do dossiê', async () => {
    const data = await buildWorkerDetailResponse(db, enc, gcs, ROW, ['worker:read', 'worker_contact:read']);
    expect(data).toMatchObject({ firstName: 'Maria', lastName: 'Garcia', email: 'maria@example.com', phone: '+5491100000000', whatsappPhone: '+549', linkedinUrl: 'li' });
    expect(data.documentNumber).toBeNull();
    for (const c of CIFRADOS_DE_DOSSIE) expect(abertos()).not.toContain(c);
    expect(data.redacted).toEqual({ dossier: true, address: true, documents: true, encuadres: true });
  });

  it('worker_pii:read abre o dossiê mas NÃO o endereço (célula própria) nem o nome (contato é outra chave)', async () => {
    const data = await buildWorkerDetailResponse(db, enc, gcs, ROW, ['worker:read', 'worker_pii:read']);
    expect(data).toMatchObject({ documentType: 'DNI', documentNumber: '12345678', birthDate: '1990-01-01', race: 'r', heightCm: '170' });
    expect(data.location.address).toBeNull();
    expect(data.serviceAreas).toBeNull();
    expect(data.firstName).toBe(NOME_REDIGIDO);
    for (const c of CIFRADOS_DE_CONTATO) expect(abertos()).not.toContain(c);
    expect(data.redacted).toEqual({ contact: true, address: true, documents: true, encuadres: true });
  });

  it('worker_address:read abre linha, coordenada e raio — e nada do dossiê (a mesma célula do mapa)', async () => {
    const data = await buildWorkerDetailResponse(db, enc, gcs, ROW, ['worker:read', 'worker_address:read']);
    expect(data.location.address).toBe('Calle Falsa 123');
    expect(data.serviceAreas[0]).toMatchObject({ address: 'Calle Falsa 123', lat: -34.6, lng: -58.4, serviceRadiusKm: 10 });
    expect(data.documentNumber).toBeNull();
    for (const c of CIFRADOS_DE_DOSSIE) expect(abertos()).not.toContain(c);
    expect(data.redacted).toEqual({ contact: true, dossier: true, documents: true, encuadres: true });
  });

  it('worker_document:read roda a query e assina as URLs', async () => {
    const data = await buildWorkerDetailResponse(db, enc, gcs, ROW, ['worker:read', 'worker_document:read']);
    expect(data.documents).toMatchObject({ resumeCvUrl: 'signed:cv.pdf', identityDocumentUrl: 'signed:dni.jpg', documentsStatus: 'approved' });
    expect(data.redacted).toEqual({ contact: true, dossier: true, address: true, encuadres: true });
  });

  it('match:read devolve os encuadres — e o nome do PACIENTE segue patient_identity:read, não a célula do prestador', async () => {
    const semIdentidade = await buildWorkerDetailResponse(db, enc, gcs, ROW, ['worker:read', 'match:read']);
    expect(semIdentidade.encuadres).toHaveLength(1);
    expect(semIdentidade.encuadres[0]).toMatchObject({ caseNumber: 42, patientName: NOME_REDIGIDO });
    expect(semIdentidade.redacted).toEqual({ contact: true, dossier: true, address: true, documents: true });

    const comIdentidade = await buildWorkerDetailResponse(db, enc, gcs, ROW, ['worker:read', 'match:read', 'patient_identity:read']);
    expect(comIdentidade.encuadres[0].patientName).toBe('Juan Perez');
  });

  it('com as 5 células de container (sem null) a resposta é a mesma da ficha inteira', async () => {
    const tudo = await buildWorkerDetailResponse(db, enc, gcs, ROW, null);
    const porCelula = await buildWorkerDetailResponse(db, enc, gcs, ROW, [
      'worker:read', 'worker_contact:read', 'worker_pii:read', 'worker_address:read', 'worker_document:read', 'match:read', 'patient_identity:read',
    ]);
    expect(porCelula).toEqual(tudo);
  });
});

describe('hotfix 13/09 (extensão) — toSignedUrl agora exige workerId e nunca loga o filePath', () => {
  it('passa o workerId do próprio worker (w.id) para generateViewSignedUrl em cada documento', async () => {
    await buildWorkerDetailResponse(db, enc, gcs, ROW, null);
    const calledWith = (gcs.generateViewSignedUrl as jest.Mock).mock.calls;
    expect(calledWith.length).toBeGreaterThan(0);
    for (const [, workerIdArg] of calledWith) {
      expect(workerIdArg).toBe(ROW.id);
    }
  });

  it('assina documentos adicionais (additionalCertificatesUrls) e propaga document_validations', async () => {
    const data = await buildWorkerDetailResponse(db, enc, gcs, ROW, null);
    expect(data.documents.additionalCertificatesUrls).toEqual(['signed:extra-cert.pdf']);
    expect(data.documents.documentValidations).toEqual({
      identity_document: { validatedBy: 'admin@enlite.health', validatedAt: '2025-01-01T00:00:00Z' },
    });
  });

  it('quando generateViewSignedUrl falha para um documento (Error), esse campo vem null e o log NUNCA carrega filePath nem err.message — só workerId e o nome da classe do erro (R4, rodada 2)', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (gcs.generateViewSignedUrl as jest.Mock).mockImplementation(async (p: string) => {
      if (p === 'cv.pdf') throw new Error('gcs down — object workers/w-1/resume_cv/leaked.pdf not found');
      return `signed:${p}`;
    });
    const data = await buildWorkerDetailResponse(db, enc, gcs, ROW, null);
    expect(data.documents.resumeCvUrl).toBeNull();
    expect(data.documents.identityDocumentUrl).toBe('signed:dni.jpg');
    const loggedArgs = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(loggedArgs).not.toContain('cv.pdf');
    expect(loggedArgs).not.toContain('gcs down');
    expect(loggedArgs).not.toContain('leaked.pdf');
    expect(loggedArgs).toContain('w-1');
    expect(loggedArgs).toContain('Error');
    errorSpy.mockRestore();
  });

  it('quando o erro rejeitado NÃO é um Error, loga só o typeof — nunca o valor bruto (ramo "else" do ternário, R4)', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (gcs.generateViewSignedUrl as jest.Mock).mockImplementation(async (p: string) => {
      if (p === 'cv.pdf') throw 'boom-nao-e-error-instance';
      return `signed:${p}`;
    });
    const data = await buildWorkerDetailResponse(db, enc, gcs, ROW, null);
    expect(data.documents.resumeCvUrl).toBeNull();
    const loggedArgs = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(loggedArgs).not.toContain('boom-nao-e-error-instance');
    expect(loggedArgs).toContain('string');
    errorSpy.mockRestore();
  });

  it('doc sem additional_certificates_urls nem document_validations usa os fallbacks ([] e null)', async () => {
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'doc-2', resume_cv_url: 'cv.pdf', identity_document_url: 'dni.jpg', documents_status: 'approved' }],
    }));
    const data = await buildWorkerDetailResponse(db, enc, gcs, ROW, null);
    expect(data.documents.additionalCertificatesUrls).toEqual([]);
    expect(data.documents.documentValidations).toEqual({});
  });

  it('2+ encuadres (WJA + bloqueada) exercitam o comparator do sort() por createdAt desc', async () => {
    extraJobApplicationRow = {
      id: 'enc-2', job_posting_id: 'jp-2', funnel_stage: 'REJECTED', source: 'talentum', case_number: 43, vacancy_number: 2,
      vacancy_status: 'CLOSED', patient_first_name: 'Ana', patient_last_name: 'Lopez', resultado: null, interview_date: null,
      interview_time: null, recruiter_name: null, coordinator_name: null, rejection_reason: null, rejection_reason_category: null,
      attended: null, created_at: '2025-01-01T10:00:00Z',
    };
    const data = await buildWorkerDetailResponse(db, enc, gcs, ROW, null);
    expect(data.encuadres).toHaveLength(2);
    // created_at mais recente (2025-03) primeiro — prova que o comparator RODOU, não só existiu.
    expect(data.encuadres[0].caseNumber).toBe(42);
    expect(data.encuadres[1].caseNumber).toBe(43);
  });
});
