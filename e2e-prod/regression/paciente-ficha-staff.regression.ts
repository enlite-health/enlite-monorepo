/**
 * paciente-ficha-staff.regression.ts — a JORNADA DO STAFF na ficha do paciente,
 * dirigida pela TELA, contra PRODUÇÃO real. (Spec 009, Fase 2.)
 *
 * ── O QUE ESTE SPEC PROVA (R6) ────────────────────────────────────────────────
 *  1. O DRAWER, e não só o endpoint, honra o Merge Patch (D211.1): o staff edita UM
 *     campo na tela e todo o resto do bloco clínico sobrevive — inclusive
 *     `clinicalSegments`, que NÃO EXISTE NO FORMULÁRIO. Esse campo é o cão de guarda
 *     desta suíte: um `?? null` reintroduzido no repositório o apaga sem que nenhuma
 *     asserção de tela note, porque ninguém olha para ele.
 *  2. O corpo que o drawer MANDA contém só a chave que mudou. É o mecanismo por trás
 *     de (1) — sem isto, "o resto sobreviveu" poderia ser sorte de o backend ignorar
 *     escritas, e não contrato.
 *  3. Texto longo com quebras de linha atravessa tela → banco → tela sem deformar, e a
 *     linha "Última edición" mostra o NOME do staff resolvido (nunca o uid).
 *  4. Carimbo de autoria é POR CAMPO: editar as instruções de emergência não move o
 *     carimbo das observações gerais.
 *  5. PRIVACIDADE — o texto clínico não aparece no Cloud Logging nem no corpo de erro.
 *     As duas metades têm CONTROLE POSITIVO, porque "procurei e não achei" é a mesma
 *     saída de "não olhei":
 *       · no log, o UUID do paciente É encontrado pela mesma busca que não encontra o
 *         texto — o instrumento está provado vivo no mesmo instante;
 *       · no erro, o corpo ECOA o valor de enum inválido que foi submetido junto, e
 *         mesmo assim não ecoa o texto clínico enviado no MESMO corpo.
 *
 * ── O QUE ESTE SPEC NÃO PROVA ─────────────────────────────────────────────────
 *  · Não prova a REDAÇÃO por permissão (`emergencyInstructionsRedacted`): a conta do
 *    monitor é admin e vê tudo. Provar o lado redigido exige um ator sem
 *    `patient_clinical:read` — frente do ABAC, engine off em prod (fora da Spec 009).
 *  · Não prova nada sobre paciente REAL: o fixture é criado, marcado `is_test` e
 *    purgado por este teste. Nenhum dado de pessoa real é lido, escrito ou comparado.
 *  · Não prova o resto da ficha (familiares, endereços, chat-ids) — só o card clínico.
 *
 * ── SEGURANÇA DO EFEITO COLATERAL ─────────────────────────────────────────────
 * Nenhum passo aqui é outbound. `POST /api/public/v1/leads` → `CreateLeadUseCase`
 * escreve o paciente nativo e NADA MAIS (sem outbox, sem Twilio, sem ClickUp — lido em
 * 30/08). O gate de mensageria (`RealAdmissionNotifier`) vive no agendamento, que este
 * spec não exercita. Por isso a Fase 2 não depende do guard `is_test` do OutboxProcessor.
 *
 * ── TEARDOWN ──────────────────────────────────────────────────────────────────
 * `DELETE /api/admin/patients/:id` — a purga sancionada, que recusa paciente real com
 * 409. A limpeza é PROVADA por releitura (404), nunca presumida.
 */
import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { newAdminApiContext, getAdminIdToken } from '../src/support/adminApi';
import { queryLogs } from '../src/support/cloudLogging';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_AUTH_FILE = path.join(__dirname, '..', '.auth', 'admin.json');

const STAMP = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const LEAD_EMAIL = `e2e-ficha-${STAMP}@enlite.import`;
/** Faixa obviamente sintética (55555 no meio) — nunca cai num celular real. */
const LEAD_PHONE = `+54 9 11 5555 ${STAMP.slice(-4)}`;

/** Valores SINTÉTICOS e identificáveis. Nada de pessoa real entra aqui. */
const SEED = {
  diagnosis: `E2E-DIAG-${STAMP}`,
  additionalComments: `E2E-OBS-INICIAL-${STAMP}`,
  emergencyInstructions: `E2E-EMERG-INICIAL-${STAMP}`,
  /**
   * Códigos do catálogo `device_types` (307), NÃO texto livre: `deviceType` escalar saiu do
   * payload na US-B4 e `patients.device_type` virou derivado por trigger (310). Chumbar 'HOME'
   * é deliberado — o catálogo muda sem deploy, então se este código sumir o PATCH devolve 422
   * e o teste falha dizendo exatamente isso, que é a resposta certa (o mundo mudou).
   * Medido em prod (07/09): HOME, SCHOOL, INSTITUTIONAL, INPATIENT, TRANSPORT.
   */
  deviceTypes: ['HOME'],
  /** ⚠️ NÃO existe campo para isto no drawer — é o cão de guarda do Merge Patch. */
  clinicalSegments: `E2E-SEG-FORA-DA-TELA-${STAMP}`,
  dependencyLevel: 'MILD',
  serviceType: ['CAREGIVER'],
  hasCud: true,
  hasJudicialProtection: false,
} as const;

const DIAGNOSIS_EDITADO = `E2E-DIAG-EDITADO-${STAMP}`;
/** Texto longo com quebras de linha e acento — o que o staff realmente digita. */
const OBS_LONGA = [
  `E2E-OBS-L1-${STAMP}`,
  `E2E-OBS-L2-${STAMP} com acentuação e vírgula, ponto.`,
  '',
  `E2E-OBS-L4-${STAMP} depois de uma linha em branco`,
].join('\n');
const EMERG_EDITADA = `E2E-EMERG-EDITADA-${STAMP}\nsegunda linha da instrução`;

type LeadBody = { data: { id: string } };
/** O GET devolve o paciente PLANO: `diagnosis`, `additionalComments` etc. no topo. */
interface PatientBody {
  data: {
    diagnosis?: string | null;
    additionalComments?: string | null;
    additionalCommentsUpdatedAt?: string | null;
    additionalCommentsUpdatedBy?: string | null;
    emergencyInstructions?: string | null;
    emergencyInstructionsUpdatedAt?: string | null;
    emergencyInstructionsUpdatedBy?: string | null;
    deviceType?: string | null;
    deviceTypes?: string[] | null;
    clinicalSegments?: string | null;
    dependencyLevel?: string | null;
    clinicalSpecialty?: string | null;
    serviceType?: string[] | null;
    hasCud?: boolean | null;
    hasJudicialProtection?: boolean | null;
  };
}

/** Estado que atravessa os passos do `describe.serial`. */
const ficha: {
  patientId?: string;
  adminUid?: string;
  autorNaApi?: string;
  obsCarimboAntesDaEmergencia?: string;
} = {};

/**
 * O uid do staff logado, lido do PRÓPRIO idToken (claim `user_id`/`sub`).
 * Existe para uma asserção só: provar que o que a API devolve como autor é o NOME
 * resolvido, e NÃO o uid (lex 29/08, item 3 — o uid não sai da API).
 */
function uidDoToken(idToken: string): string {
  const payload = idToken.split('.')[1];
  expect(payload, 'idToken tem 3 partes').toBeTruthy();
  const json = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as {
    user_id?: string;
    sub?: string;
  };
  const uid = json.user_id ?? json.sub;
  expect(uid, 'o idToken carrega o uid em user_id/sub').toBeTruthy();
  return uid!;
}

/** Lê a ficha pela API admin (fonte independente do que a tela pintou). */
async function lerFicha(ctx: APIRequestContext, id: string): Promise<PatientBody['data']> {
  const res = await ctx.get(`/api/admin/patients/${id}`);
  expect(res.status(), 'GET /api/admin/patients/:id responde 200').toBe(200);
  return ((await res.json()) as PatientBody).data;
}

/** Abre a ficha na TELA com a sessão admin e espera o card clínico renderizar. */
async function abrirFicha(browser: Browser): Promise<{ page: Page; fechar: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: ADMIN_AUTH_FILE });
  const page = await ctx.newPage();
  await page.goto(`/admin/patients/${ficha.patientId}`);
  await expect(page.getByTestId('edit-clinical-btn')).toBeVisible({ timeout: 30_000 });
  return { page, fechar: async () => { await ctx.close(); } };
}

/**
 * Abre o drawer, aplica `preencher`, salva e devolve o CORPO que o front mandou.
 *
 * Devolver o corpo é o ponto: a garantia do Merge Patch não é "o backend preservou",
 * é "o front mandou só o que mudou E o backend preservou o resto". Sem olhar o corpo,
 * as duas falhas ficam indistinguíveis.
 */
async function editarNoDrawer(
  page: Page,
  preencher: (page: Page) => Promise<void>,
): Promise<Record<string, unknown>> {
  await page.getByTestId('edit-clinical-btn').click();
  await expect(page.getByTestId('patient-clinical-edit-drawer')).toBeVisible();

  await preencher(page);

  const esperaRequest = page.waitForRequest(
    (r) => r.method() === 'PATCH' && r.url().includes(`/patients/${ficha.patientId}/clinical`),
  );
  const esperaResponse = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && r.url().includes(`/patients/${ficha.patientId}/clinical`),
  );
  await page.getByTestId('pce-save').click();
  const [req, res] = await Promise.all([esperaRequest, esperaResponse]);

  expect(res.status(), 'o PATCH do drawer responde 200').toBe(200);
  // O drawer fecha e a página refaz o GET (`onSaved={refetch}`) — esperar o card voltar
  // evita ler o DOM anterior ao refetch.
  await expect(page.getByTestId('patient-clinical-edit-drawer')).toBeHidden();
  return (req.postDataJSON() ?? {}) as Record<string, unknown>;
}

test.describe.serial('Spec 009 · Fase 2 — ficha do paciente pela tela do staff', () => {
  let adminCtx: APIRequestContext | undefined;

  test.beforeAll(async () => {
    test.skip(
      !process.env.E2E_ADMIN_EMAIL || !process.env.FIREBASE_API_KEY,
      'requer E2E_ADMIN_EMAIL + FIREBASE_API_KEY (writes autenticados em prod)',
    );
    adminCtx = await newAdminApiContext();
    ficha.adminUid = uidDoToken(await getAdminIdToken());
  });

  test.afterAll(async () => {
    // Rede de segurança: se um passo morreu antes da purga, não deixa fixture vivo.
    if (adminCtx && ficha.patientId) {
      try {
        await adminCtx.delete(`/api/admin/patients/${ficha.patientId}`);
      } catch {
        // best-effort
      }
    }
    await adminCtx?.dispose();
  });

  test('[@route:POST /api/public/v1/leads @depth:happy] 2.0 — fixture sintético nasce e é marcado is_test ANTES de qualquer outro passo', async () => {
    const leadRes = await adminCtx!.post('/api/public/v1/leads', {
      data: {
        serviceType: 'cuidadores',
        requesterType: 'patient',
        email: LEAD_EMAIL,
        phone: LEAD_PHONE,
        name: `E2E Ficha ${STAMP}`,
        country: 'AR',
        // `consent` é literal(true) e o schema é `.strict()` — é o que o form real manda.
        consent: true,
      },
    });
    expect(leadRes.status(), 'POST /api/public/v1/leads cria o paciente (201)').toBe(201);
    ficha.patientId = ((await leadRes.json()) as LeadBody).data.id;
    expect(ficha.patientId, 'o lead devolve o id do paciente').toBeTruthy();

    const flagRes = await adminCtx!.patch(`/api/admin/patients/${ficha.patientId}/test-flag`, {
      data: { isTest: true },
    });
    expect(flagRes.status(), 'PATCH /test-flag marca is_test (200)').toBe(200);
  });

  test('[@route:PATCH /api/admin/patients/:id/:section @depth:happy] 2.1 — o DRAWER edita um campo e o bloco clínico inteiro sobrevive, inclusive o que não está na tela', async ({ browser }) => {
    // Semeia o bloco INTEIRO pela API (setup por API, jornada por UI — regra da suíte).
    const seedRes = await adminCtx!.patch(`/api/admin/patients/${ficha.patientId}/clinical`, { data: SEED });
    expect(seedRes.status(), 'PATCH clinical semeia o bloco inteiro (200)').toBe(200);

    const antes = await lerFicha(adminCtx!, ficha.patientId!);
    expect(antes.clinicalSegments, 'o campo FORA DA TELA foi semeado').toBe(SEED.clinicalSegments);

    const { page, fechar } = await abrirFicha(browser);
    try {
      const corpo = await editarNoDrawer(page, async (p) => {
        await p.getByTestId('pce-diagnosis').fill(DIAGNOSIS_EDITADO);
      });

      // O MECANISMO: o drawer manda só o que mudou.
      expect(
        Object.keys(corpo).sort(),
        'o corpo do PATCH carrega SÓ a chave editada — é o que faz o Merge Patch valer na tela',
      ).toEqual(['diagnosis']);

      const depois = await lerFicha(adminCtx!, ficha.patientId!);
      expect(depois.diagnosis, 'o campo editado mudou').toBe(DIAGNOSIS_EDITADO);

      // O RESULTADO: nada mais foi tocado.
      expect(
        depois.clinicalSegments,
        'CÃO DE GUARDA — `clinicalSegments` não tem campo no drawer; se ele sumiu, o `?? null` voltou ao repositório (D211.1)',
      ).toBe(SEED.clinicalSegments);
      expect(depois.additionalComments, 'observações sobreviveram').toBe(SEED.additionalComments);
      expect(depois.emergencyInstructions, 'instruções de emergência sobreviveram').toBe(SEED.emergencyInstructions);
      expect(depois.deviceTypes, 'tipos de dispositivo sobreviveram').toEqual([...SEED.deviceTypes]);
      expect(depois.dependencyLevel, 'nível de dependência sobreviveu').toBe(SEED.dependencyLevel);
      // ⚠️ LACUNA NOMEADA: `clinicalSpecialty` saía daqui e não sai mais. O campo deixou de ser
      // escrevível por esta rota (spec 016 F2), então este spec não consegue mais semeá-lo — e
      // asserção sobre um valor que nasce `null` provaria `null === null`, que é verde decorativo.
      // A COLUNA continua viva e continua sendo tocada pelo `clinicalRepo.upsert`: se um `?? null`
      // voltar lá, este spec NÃO vai ver. Quem cobre isso é o teste de unidade do repositório.
      expect(depois.serviceType, 'serviços contratados sobreviveram').toEqual([...SEED.serviceType]);
      expect(depois.hasCud, 'flag CUD sobreviveu').toBe(SEED.hasCud);
      expect(depois.hasJudicialProtection, 'flag de proteção judicial sobreviveu').toBe(
        SEED.hasJudicialProtection,
      );
    } finally {
      await fechar();
    }
  });

  test('[@route:/admin/patients/:id @depth:happy] 2.2 — observações gerais: texto longo com quebras de linha e "Última edición" com o NOME do staff', async ({ browser }) => {
    const { page, fechar } = await abrirFicha(browser);
    try {
      const corpo = await editarNoDrawer(page, async (p) => {
        await p.getByTestId('pce-comments').fill(OBS_LONGA);
      });
      expect(Object.keys(corpo).sort(), 'só as observações foram enviadas').toEqual([
        'additionalComments',
      ]);

      // ── o texto atravessou tela → banco → tela sem deformar ──────────────────
      const naApi = await lerFicha(adminCtx!, ficha.patientId!);
      expect(naApi.additionalComments, 'o banco guardou o texto BYTE A BYTE, quebras inclusive').toBe(
        OBS_LONGA,
      );

      const naTela = await page.getByTestId('general-notes-text').innerText();
      for (const linha of OBS_LONGA.split('\n').filter(Boolean)) {
        expect(naTela, `a linha "${linha.slice(0, 24)}…" está na tela`).toContain(linha);
      }
      expect(
        naTela.replace(/\r\n/g, '\n'),
        'as quebras de linha sobreviveram na renderização (whitespace-pre-wrap), não viraram um parágrafo só',
      ).toMatch(/E2E-OBS-L1-\d+\s*\n[\s\S]*E2E-OBS-L2-/);

      // ── "Última edición": NOME resolvido, nunca o uid ────────────────────────
      const autor = naApi.additionalCommentsUpdatedBy;
      expect(autor, 'a API devolve a autoria da última edição').toBeTruthy();
      expect(
        autor,
        'a autoria é o NOME resolvido do staff, NUNCA o uid (o uid não sai da API — lex 29/08)',
      ).not.toBe(ficha.adminUid);
      expect(naApi.additionalCommentsUpdatedAt, 'a API devolve a data da última edição').toBeTruthy();
      ficha.autorNaApi = autor!;
      ficha.obsCarimboAntesDaEmergencia = naApi.additionalCommentsUpdatedAt!;

      const linhaEdicao = await page.getByTestId('general-notes-edited').innerText();
      expect(linhaEdicao, 'a linha "Última edición" na tela mostra o mesmo autor que a API').toContain(
        autor!,
      );
      expect(linhaEdicao, 'e a linha NÃO mostra o uid do staff').not.toContain(ficha.adminUid!);
    } finally {
      await fechar();
    }
  });

  test('[@route:GET /api/admin/patients/:id @depth:happy] 2.2b — o texto clínico não vaza: nem para o Cloud Logging, nem para o corpo de erro (com controle positivo nos dois)', async () => {
    // ── metade 1: LOG ────────────────────────────────────────────────────────
    // CONTROLE POSITIVO PRIMEIRO. A mesma consulta, na mesma janela, tem de ACHAR
    // algo — senão "0 ocorrências do texto clínico" seria só a busca não funcionando.
    const controle = await queryLogs({
      textQuery: ficha.patientId!,
      withinMinutes: 30,
      limit: 1,
    });
    expect(
      controle.length,
      'CONTROLE POSITIVO — a busca por texto livre no Cloud Logging está viva: ela ACHA o UUID do paciente',
    ).toBeGreaterThan(0);

    for (const segredo of [OBS_LONGA.split('\n')[0]!, SEED.emergencyInstructions, SEED.diagnosis]) {
      const achados = await queryLogs({ textQuery: segredo, withinMinutes: 30, limit: 1 });
      expect(
        achados.length,
        `texto clínico "${segredo.slice(0, 20)}…" NÃO pode aparecer no Cloud Logging (regra dura: texto clínico não sai do perímetro)`,
      ).toBe(0);
    }

    // ── metade 2: CORPO DE ERRO ──────────────────────────────────────────────
    // Um enum inválido NO MESMO corpo que carrega texto clínico. O 400 tem de ecoar o
    // enum (controle positivo: o corpo ECOA valores submetidos) e não o texto.
    const segredoNoErro = `E2E-SEGREDO-NO-ERRO-${STAMP}`;
    const erroRes = await adminCtx!.patch(`/api/admin/patients/${ficha.patientId}/clinical`, {
      data: { dependencyLevel: 'E2E-ENUM-INVALIDO', additionalComments: segredoNoErro },
    });
    expect(erroRes.status(), 'enum inválido é recusado na borda (400)').toBe(400);

    const corpoErro = await erroRes.text();
    expect(
      corpoErro,
      'CONTROLE POSITIVO — o corpo de erro ECOA o valor inválido submetido, então ele é capaz de ecoar entrada',
    ).toContain('E2E-ENUM-INVALIDO');
    expect(
      corpoErro,
      'e mesmo assim NÃO ecoa o texto clínico que veio no MESMO corpo',
    ).not.toContain(segredoNoErro);

    // O 400 recusou a requisição inteira: o texto do erro não pode ter sido gravado.
    const depoisDoErro = await lerFicha(adminCtx!, ficha.patientId!);
    expect(depoisDoErro.additionalComments, 'a requisição recusada não gravou nada').toBe(OBS_LONGA);
  });

  test('[@route:PATCH /api/admin/patients/:id/test-flag @depth:happy] 2.3 — instruções de emergência: grava, relê, e o carimbo de autoria é POR CAMPO', async ({ browser }) => {
    const { page, fechar } = await abrirFicha(browser);
    try {
      const corpo = await editarNoDrawer(page, async (p) => {
        await p.getByTestId('pce-emergency').fill(EMERG_EDITADA);
      });
      expect(Object.keys(corpo).sort(), 'só as instruções de emergência foram enviadas').toEqual([
        'emergencyInstructions',
      ]);

      const naApi = await lerFicha(adminCtx!, ficha.patientId!);
      expect(naApi.emergencyInstructions, 'o texto foi relido igual ao que foi gravado').toBe(
        EMERG_EDITADA,
      );
      expect(naApi.emergencyInstructionsUpdatedBy, 'a autoria do campo é o NOME do staff').toBe(
        ficha.autorNaApi,
      );
      expect(
        naApi.emergencyInstructionsUpdatedBy,
        'e nunca o uid',
      ).not.toBe(ficha.adminUid);
      expect(naApi.emergencyInstructionsUpdatedAt, 'a data de autoria foi carimbada').toBeTruthy();

      // A INVARIANTE DO CARIMBO: ele é do CAMPO, não do bloco. Se um dia o repositório
      // voltar a carimbar tudo a cada PATCH, "editado por" vira uma data que não
      // corresponde a ninguém ter editado aquele texto.
      expect(
        naApi.additionalCommentsUpdatedAt,
        'CARIMBO POR CAMPO — editar a emergência NÃO move o carimbo das observações gerais',
      ).toBe(ficha.obsCarimboAntesDaEmergencia);
      expect(naApi.additionalComments, 'e o texto das observações continua intacto').toBe(OBS_LONGA);

      const naTela = await page.getByTestId('emergency-instructions-text').innerText();
      expect(naTela, 'a tela mostra a instrução gravada').toContain(`E2E-EMERG-EDITADA-${STAMP}`);
      const linhaEdicao = await page.getByTestId('emergency-instructions-edited').innerText();
      expect(linhaEdicao, 'com a autoria resolvida ao lado').toContain(ficha.autorNaApi!);
    } finally {
      await fechar();
    }
  });

  test('[@route:DELETE /api/admin/patients/:id @depth:happy] 2.4 — a purga é PROVADA por releitura, não presumida', async () => {
    const purgeRes = await adminCtx!.delete(`/api/admin/patients/${ficha.patientId}`);
    expect(purgeRes.status(), 'DELETE /patients/:id purga o paciente is_test (200)').toBe(200);

    const goneRes = await adminCtx!.get(`/api/admin/patients/${ficha.patientId}`);
    expect(goneRes.status(), 'PROVA DA LIMPEZA — depois da purga o paciente responde 404').toBe(404);
    ficha.patientId = undefined;
  });
});
