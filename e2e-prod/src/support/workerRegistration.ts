/**
 * workerRegistration.ts — helpers para COMPLETAR o cadastro de um worker de teste
 * até o status REGISTERED (usado pela FATIA 2 da jornada worker).
 *
 * Todos os corpos aqui são o MÍNIMO que satisfaz o gate de REGISTERED em prod,
 * ancorado no código real (ver report / worker-journey.regression.ts):
 *
 *  • Gate (trigger `fn_guard_registered_status`, migration 212): campos pessoais +
 *    worker_service_areas(address_line, radius_km) + ≥1 worker_availability +
 *    worker_documents. Para NÃO-AT (classe CUIDADOR) só exige 2 docs:
 *    identity_document + criminal_record. Por isso escolhemos profession='CAREGIVER'
 *    (valor não-AT válido pela constraint `valid_profession_values`, migration 064) —
 *    minimiza fixtures.
 *  • `sex` PRECISA normalizar para MALE/FEMALE (`normalizeSexValue`) senão
 *    sex_encrypted fica NULL e o gate barra — por isso 'Hombre' (→ MALE).
 *  • `phone` é OBRIGATÓRIO no gate; geramos um número AR único por run para não
 *    colidir com workers reais (colisão → 409 PHONE_NOT_AVAILABLE, falha limpa,
 *    zero efeito colateral).
 *  • O backend NÃO geocoda service-area: lat/lng são gravados como enviados; o gate
 *    só exige address_line + radius_km não-nulos.
 *
 * Upload de documento é fluxo de SIGNED URL (GCS), ancorado em
 * WorkerDocumentsMeController + GCSStorageService:
 *   1. POST /api/workers/me/documents/upload-url { docType, contentType } → { signedUrl, filePath }
 *   2. PUT <signedUrl> com os bytes e Content-Type IGUAL ao assinado (v4 amarra o content-type)
 *   3. POST /api/workers/me/documents/save { docType, filePath }
 * O save chama recalculateStatus — quando o último requisito é cumprido, o worker
 * transiciona para REGISTERED.
 */
import { expect, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** e2e-prod/fixtures/ — resolvido a partir deste arquivo (src/support → ../../fixtures). */
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

/**
 * Bytes de um documento fixture mínimo. O CONTEÚDO é irrelevante para o gate (que só
 * checa que a coluna da URL não é NULL) — o que importa é o Content-Type assinado no
 * upload. Usamos um PNG 1×1 real para ser um arquivo plausível.
 */
export function readTinyDocumentPng(): Buffer {
  return readFileSync(join(FIXTURES_DIR, 'tiny-document.png'));
}

/**
 * Número de celular AR único por run. `normalizePhoneAR` prepend '549' a 10 dígitos,
 * então '11' (CABA) + 8 dígitos do relógio → canônico 549XXXXXXXXXX de 13 dígitos,
 * praticamente sem chance de colidir com um worker real.
 */
export function uniqueArMobile(): string {
  const suffix = String(Date.now()).slice(-8);
  return `11${suffix}`;
}

/**
 * Corpo de PUT /api/workers/me/general-info (SavePersonalInfoUseCase). Todos os
 * campos exigidos pelo gate de REGISTERED. `phone` deve ser único por run.
 */
export function buildCaregiverGeneralInfo(phone: string): Record<string, unknown> {
  return {
    firstName: 'E2E',
    lastName: 'ProdWorker',
    sex: 'Hombre', // normaliza → MALE (obrigatório: sex_encrypted não-nulo)
    gender: 'Masculino',
    birthDate: '1990-01-01',
    documentType: 'DNI',
    documentNumber: `E2E-${Date.now()}`,
    phone,
    languages: ['Español'],
    profession: 'CAREGIVER', // não-AT → CUIDADOR → só 2 docs (constraint valid_profession_values)
    knowledgeLevel: 'INTERMEDIATE',
    titleCertificate: 'SI',
    yearsExperience: '5',
    experienceTypes: ['ELDERLY_CARE'],
    preferredTypes: ['ELDERLY_CARE'],
    preferredAgeRange: ['ADULT'],
    termsAccepted: true,
    privacyAccepted: true,
  };
}

/** Corpo de PUT /api/workers/me/service-area (address_line + radius_km são o gate). */
export function buildServiceArea(): Record<string, unknown> {
  return {
    address: 'Av. Corrientes 1234, CABA',
    serviceRadiusKm: 10,
    lat: -34.6037,
    lng: -58.3816,
    city: 'Buenos Aires',
  };
}

/**
 * Corpo de PUT /api/workers/me/availability. Um slot basta para o gate; respeita as
 * constraints (day_of_week 0-6, end_time > start_time).
 */
export function buildAvailability(): { availability: Record<string, unknown>[] } {
  return {
    availability: [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00', crossesMidnight: false }],
  };
}

/**
 * Completa o cadastro de um worker CAREGIVER (não-AT) até o gate de REGISTERED,
 * assumindo que o worker JÁ passou por signup + init + foi marcado is_test pelo admin.
 * Executa, em ordem, os 4 requisitos do gate (`fn_guard_registered_status`, mig 212):
 *   general-info → service-area → availability → 2 documentos (identity + criminal).
 * O 2º save de documento cumpre o gate e o `recalculateStatus` transiciona o worker
 * para REGISTERED. Assere cada passo (falha limpa e sem efeito colateral).
 *
 * Reusado pela FATIA 3 (postularse) — a FATIA 2 mantém sua versão inline (não é
 * alterada para não arriscar um teste verde). `phone` deve ser único por run
 * (`uniqueArMobile`); colisão → 409 PHONE_NOT_AVAILABLE, que a mensagem sinaliza.
 */
export async function completeCaregiverRegistration(
  workerCtx: APIRequestContext,
  phone: string,
): Promise<void> {
  const giRes = await workerCtx.put('/api/workers/me/general-info', {
    data: buildCaregiverGeneralInfo(phone),
  });
  expect(
    giRes.status(),
    'PUT general-info deve responder 200 (409 = telefone colidiu com worker real; rode de novo)',
  ).toBe(200);

  const saRes = await workerCtx.put('/api/workers/me/service-area', { data: buildServiceArea() });
  expect(saRes.status(), 'PUT service-area deve responder 200').toBe(200);

  const avRes = await workerCtx.put('/api/workers/me/availability', { data: buildAvailability() });
  expect(avRes.status(), 'PUT availability deve responder 200').toBe(200);

  const png = readTinyDocumentPng();
  await uploadWorkerDocument(workerCtx, 'identity_document', 'image/png', png);
  await uploadWorkerDocument(workerCtx, 'criminal_record', 'image/png', png);
}

interface UploadUrlBody {
  success: boolean;
  data: { signedUrl: string; filePath: string };
}

/**
 * Sobe um documento fixo do worker via o fluxo de signed URL (3 passos). Assere cada
 * passo. O PUT ao GCS usa o `fetch` global do Node (fora do Playwright) para manter a
 * signed URL efêmera fora do trace, espelhando a postura dos helpers de auth.
 *
 * @param docType  ex.: 'identity_document' | 'criminal_record' (ver VALID_DOC_TYPES no backend)
 * @param contentType  DEVE bater com o Content-Type do PUT (v4 amarra a assinatura)
 */
export async function uploadWorkerDocument(
  workerCtx: APIRequestContext,
  docType: string,
  contentType: string,
  bytes: Buffer,
): Promise<void> {
  const urlRes = await workerCtx.post('/api/workers/me/documents/upload-url', {
    data: { docType, contentType },
  });
  expect(urlRes.status(), `upload-url(${docType}) deve responder 200`).toBe(200);
  const urlBody = (await urlRes.json()) as UploadUrlBody;
  const { signedUrl, filePath } = urlBody.data;
  expect(signedUrl, `upload-url(${docType}) retorna signedUrl`).toBeTruthy();
  expect(filePath, `upload-url(${docType}) retorna filePath`).toBeTruthy();

  const put = await fetch(signedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: new Uint8Array(bytes),
  });
  if (!put.ok) {
    // Nunca logar a signed URL (efêmera, mas contém assinatura) — só o status.
    throw new Error(`[workerRegistration] PUT ao GCS falhou para ${docType}: HTTP ${put.status}`);
  }

  const saveRes = await workerCtx.post('/api/workers/me/documents/save', {
    data: { docType, filePath },
  });
  expect(saveRes.status(), `documents/save(${docType}) deve responder 200`).toBe(200);
}
