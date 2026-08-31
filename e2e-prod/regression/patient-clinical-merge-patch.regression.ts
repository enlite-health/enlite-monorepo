/**
 * patient-clinical-merge-patch.regression.ts — a invariante que impede PERDA SILENCIOSA
 * de dado clínico, contra PRODUÇÃO.
 *
 * O DEFEITO QUE ISTO GUARDA (D211.1, consertado em 9ea04a8a)
 *   `PatientClinicalRepository.upsert` montava `campo = $n` com `?? null` para TODOS os
 *   campos. O drawer manda só o que mudou — então editar apenas as "observações gerais"
 *   ZERAVA o diagnóstico. Ninguém vê acontecer: o campo some, o 200 volta, e o dado do
 *   paciente foi embora.
 *
 * O CONTRATO AGORA (RFC 7396 — JSON Merge Patch)
 *   chave AUSENTE  → não toca a coluna
 *   chave = null   → limpa a coluna
 *
 *   As DUAS metades são afirmadas aqui de propósito. Só a primeira "passaria" se alguém
 *   fizesse o endpoint ignorar tudo que chega — o que consertaria a perda de dado
 *   quebrando a edição. A segunda é o controle positivo dessa suspeita.
 *
 * POR QUE NO MONITOR DE PROD, e não só no e2e local
 *   O que quebra esta invariante é o SET dinâmico montado em runtime a partir das chaves
 *   presentes. Um ORM atualizado, um mapper novo (o sync do ClickUp entrega todas as
 *   chaves com null explícito — D167) ou uma refatoração do repositório reintroduzem o
 *   `?? null` sem que nenhum teste de unidade note. Aqui a afirmação é feita contra o
 *   banco de produção, pelo caminho HTTP real.
 *
 * DADO CLÍNICO: os valores usados são SINTÉTICOS e escritos por este teste num paciente
 * `is_test` que ele mesmo cria e purga. Nenhum dado de pessoa real é lido, escrito ou
 * comparado.
 *
 * TEARDOWN: `DELETE /api/admin/patients/:id` — a purga sancionada, que RECUSA paciente
 * real com 409 (PatientTestFixtureService). O teste PROVA a limpeza, não a presume.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { newAdminApiContext } from '../src/support/adminApi';

const STAMP = Date.now();
const LEAD_EMAIL = `e2e-mergepatch-${STAMP}@enlite.import`;
/** Número sintético; o lead não dispara mensagem (o gate de is_test é aplicado logo abaixo). */
const LEAD_PHONE = `+54911${String(STAMP).slice(-8)}`;

/** Valores sintéticos — nada de pessoa real. */
const DIAGNOSIS_SEED = `E2E-DIAG-${STAMP}`;
const COMMENTS_SEED = `E2E-OBS-INICIAL-${STAMP}`;
const COMMENTS_EDIT = `E2E-OBS-EDITADA-${STAMP}`;

type LeadBody = { data: { id: string } };
/** O GET devolve o paciente PLANO — `diagnosis`/`additionalComments` são de topo,
 *  não aninhados sob `clinical` (medido contra prod em 30/08). */
type PatientBody = { data: { diagnosis?: string | null; additionalComments?: string | null } };

test.describe('D211.1 — Merge Patch clínico: chave ausente NÃO apaga a coluna', () => {
  let adminCtx: APIRequestContext | undefined;
  let patientId: string | undefined;

  test.afterAll(async () => {
    // Best-effort: se o teste falhou antes do passo de purga, não deixa fixture para trás.
    if (adminCtx && patientId) {
      try {
        await adminCtx.delete(`/api/admin/patients/${patientId}`);
      } catch {
        // best-effort
      }
    }
    await adminCtx?.dispose();
  });

  test('[@route:PATCH /api/admin/patients/:id/:section @depth:happy] editar só as observações NÃO zera o diagnóstico; null explícito limpa', async () => {
    test.skip(
      !process.env.E2E_ADMIN_EMAIL || !process.env.FIREBASE_API_KEY,
      'requer E2E_ADMIN_EMAIL + FIREBASE_API_KEY (writes autenticados em prod)',
    );

    adminCtx = await newAdminApiContext();

    // ── 1. paciente sintético pelo caminho público real ────────────────────────
    const leadRes = await adminCtx.post('/api/public/v1/leads', {
      data: {
        serviceType: 'cuidadores',
        requesterType: 'patient',
        email: LEAD_EMAIL,
        phone: LEAD_PHONE,
        name: `E2E MergePatch ${STAMP}`,
        country: 'AR',
        // `consent` é literal(true) e o schema é .strict() — o formulário real manda isso.
        // É também por isso que o is_test do passo seguinte não pode atrasar.
        consent: true,
      },
    });
    expect(leadRes.status(), 'POST /api/public/v1/leads cria o paciente (201)').toBe(201);
    patientId = ((await leadRes.json()) as LeadBody).data.id;
    expect(patientId, 'o lead retorna o id do paciente').toBeTruthy();

    // ── 2. marca is_test IMEDIATAMENTE (mesma ordem crítica da patient-journey) ──
    const flagRes = await adminCtx.patch(`/api/admin/patients/${patientId}/test-flag`, {
      data: { isTest: true },
    });
    expect(flagRes.status(), 'PATCH /patients/:id/test-flag marca is_test (200)').toBe(200);

    // ── 3. semeia AMBOS os campos clínicos ────────────────────────────────────
    const seedRes = await adminCtx.patch(`/api/admin/patients/${patientId}/clinical`, {
      data: { diagnosis: DIAGNOSIS_SEED, additionalComments: COMMENTS_SEED },
    });
    expect(seedRes.status(), 'PATCH clinical semeia diagnóstico + observações (200)').toBe(200);

    const afterSeed = ((await (await adminCtx.get(`/api/admin/patients/${patientId}`)).json()) as PatientBody).data;
    expect(afterSeed.diagnosis, 'diagnóstico gravado').toBe(DIAGNOSIS_SEED);
    expect(afterSeed.additionalComments, 'observações gravadas').toBe(COMMENTS_SEED);

    // ── 4. O DEFEITO: edita SÓ as observações — a chave `diagnosis` vai AUSENTE ──
    // É exatamente o que o drawer faz ao salvar um campo só.
    const partialRes = await adminCtx.patch(`/api/admin/patients/${patientId}/clinical`, {
      data: { additionalComments: COMMENTS_EDIT },
    });
    expect(partialRes.status(), 'PATCH parcial responde 200').toBe(200);

    const afterPartial = ((await (await adminCtx.get(`/api/admin/patients/${patientId}`)).json()) as PatientBody).data;
    expect(
      afterPartial.diagnosis,
      'CHAVE AUSENTE NÃO TOCA A COLUNA — o diagnóstico sobreviveu à edição das observações (D211.1)',
    ).toBe(DIAGNOSIS_SEED);
    expect(afterPartial.additionalComments, 'as observações foram de fato atualizadas').toBe(COMMENTS_EDIT);

    // ── 5. CONTROLE POSITIVO: null explícito PRECISA limpar ───────────────────
    // Sem isto, "não apagar nada" passaria mesmo se o endpoint ignorasse toda escrita.
    const clearRes = await adminCtx.patch(`/api/admin/patients/${patientId}/clinical`, {
      data: { diagnosis: null },
    });
    expect(clearRes.status(), 'PATCH com null explícito responde 200').toBe(200);

    const afterClear = ((await (await adminCtx.get(`/api/admin/patients/${patientId}`)).json()) as PatientBody).data;
    expect(
      afterClear.diagnosis ?? null,
      'NULL EXPLÍCITO LIMPA — o endpoint não está apenas ignorando escritas',
    ).toBeNull();
    expect(
      afterClear.additionalComments,
      'e a chave ausente continuou intocada na mesma chamada',
    ).toBe(COMMENTS_EDIT);

    // ── 6. purga PROVADA ──────────────────────────────────────────────────────
    const purgeRes = await adminCtx.delete(`/api/admin/patients/${patientId}`);
    expect(purgeRes.status(), 'DELETE /patients/:id purga o paciente is_test (200)').toBe(200);

    const goneRes = await adminCtx.get(`/api/admin/patients/${patientId}`);
    expect(goneRes.status(), 'após a purga o paciente sumiu (404)').toBe(404);
    patientId = undefined;
  });
});
