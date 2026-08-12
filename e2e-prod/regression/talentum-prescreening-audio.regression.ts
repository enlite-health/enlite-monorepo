/**
 * talentum-prescreening-audio.regression.ts — Jornada REAL de publicação de vaga na
 * TALENTUM de produção, provando que o pré-screening nasce aceitando ÁUDIO.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Ticket 86ajfm80t — "Pre-Screening por áudio".
 * ─────────────────────────────────────────────────────────────────────────────
 * Bug original: pré-screenings criados via API só aceitavam texto; o bot da Talentum
 * respondia "Esta pregunta solamente puede ser contestada con text". Causa: o dado
 * chegava à Talentum com responseType só-texto. Correção: áudio é o DEFAULT em toda
 * fronteira (normalizePrescreeningResponseType) + forceAudio na geração por IA.
 *
 * Esta jornada prova a GARANTIA central em prod real, ponta-a-ponta, pelo NOSSO
 * caminho de publicação:
 *
 *   1. ADMIN cria uma VAGA is_test (referencia um paciente REAL; não cria/limpa paciente).
 *   2. ADMIN salva o pré-screening com UMA pergunta SEM responseType explícito — este é
 *      exatamente o cenário do bug (valor ausente/gerado, que DEVE cair no default áudio).
 *   3. ADMIN publica na Talentum (POST publish-talentum) — chamada REAL à Talentum.
 *   4. ADMIN lê talentum-status (fonte de verdade externa: o backend faz GET na Talentum)
 *      e assere audioEnabled=true → a vaga publicada aceita áudio DO LADO DA TALENTUM.
 *   5. TEARDOWN VERIFICADO: despublica (DELETE publish-talentum → apaga o projeto na
 *      Talentum) e prova que sumiu; depois cleanup do is_test e prova 404.
 *
 * Por que SEM responseType (e não ['text']): a semântica é "áudio por default, mas
 * respeita só-texto DELIBERADO". Salvar ['text'] e esperar áudio contradiria o design
 * (o outbound respeita a escolha explícita). O valor AUSENTE é o caminho do bug — é o
 * que precisa cair em ['text','audio']. É isso que esta jornada trava contra regressão.
 *
 * SEGURANÇA (efeito colateral zero em prod):
 *   • is_test segrega a vaga do matchmaking real (hard filter is_test) e o cleanup a apaga.
 *   • required_professions=['PSYCHOLOGIST'] + is_test → mesmo que o auto-invite (morto hoje)
 *     religasse, não casaria worker real. Ver project_e2e_test_vacancy_no_twilio_safety.
 *   • O projeto na Talentum é apagado no teardown (unpublish). Título auto-gerado
 *     ("CASO …") — resíduo possível SÓ se o processo morrer entre publish e unpublish
 *     (baixo; afterAll re-tenta). Não há marca [E2E] no lado Talentum: aceitável dado o
 *     unpublish verificado; se virar problema, expor um título marcável no publish.
 *
 * REGRAS DA SUÍTE (e2e-prod/CLAUDE.md): zero page.route/mock; web-first assertions;
 * teardown garantido; segredos nunca logados. Camada regression (writes + teardown).
 *
 * As tags de cobertura (route/depth) ficam no TÍTULO do teste (um colchete por rota).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { newAdminApiContext } from '../src/support/adminApi';

interface PatientsListBody {
  success: boolean;
  data: Array<{ id: string; caseNumber: number | null }>;
}
interface CreateVacancyBody {
  success: boolean;
  data: { id: string; title: string; is_test: boolean; status: string };
}
interface TalentumStatusBody {
  success: boolean;
  data: { published: boolean; exists: boolean; whatsappUrl?: string; audioEnabled?: boolean };
}

test.describe('Jornada Talentum — pré-screening publicado nasce com ÁUDIO (86ajfm80t)', () => {
  let adminCtx: APIRequestContext | undefined;
  let vacancyId: string | undefined;

  test.afterAll(async () => {
    // Teardown best-effort (afterAll NUNCA falha por limpeza) — rede de segurança do
    // teardown verificado no corpo do teste. Ordem OBRIGATÓRIA: unpublish (apaga o
    // projeto na Talentum) ANTES do cleanup (que apaga a linha da vaga com o projectId).
    // Tenta unpublish sempre que houver vacancyId — NÃO condiciona a `published`: um
    // timeout do cliente no publish pode ter deixado a vaga publicada server-side, e é
    // justamente esse caso que gera projeto órfão na Talentum se não despublicarmos.
    if (adminCtx && vacancyId) {
      try {
        await adminCtx.delete(`/api/admin/vacancies/${vacancyId}/publish-talentum`, { timeout: 60_000 });
      } catch {
        // best-effort — 400 se não estava publicada; erro de rede idem.
      }
    }
    if (adminCtx) {
      try {
        await adminCtx.post('/api/admin/test-fixtures/cleanup', { data: {} });
      } catch {
        // best-effort.
      }
    }
    await adminCtx?.dispose();
  });

  test('[@route:POST /api/admin/vacancies @depth:happy][@route:POST /api/admin/vacancies/:id/prescreening-config @depth:happy][@route:POST /api/admin/vacancies/:id/publish-talentum @depth:happy][@route:GET /api/admin/vacancies/:id/talentum-status @depth:happy][@route:DELETE /api/admin/vacancies/:id/publish-talentum @depth:happy] vaga is_test publicada na Talentum → todas as perguntas aceitam áudio; teardown apaga o projeto', async () => {
    // Guard: sem credenciais de admin esta jornada não roda (writes reais em prod + Talentum).
    test.skip(!process.env.E2E_ADMIN_EMAIL, 'requer E2E_ADMIN_EMAIL (writes autenticados em prod)');

    adminCtx = await newAdminApiContext();

    // ── PASSO 1: pegar um paciente real para referenciar a vaga is_test ──
    const patientsRes = await adminCtx.get('/api/admin/patients');
    expect(patientsRes.status(), 'GET /api/admin/patients deve responder 200').toBe(200);
    const [patient] = ((await patientsRes.json()) as PatientsListBody).data;
    if (!patient) {
      test.skip(true, 'prod não tem paciente para referenciar a vaga is_test');
      return;
    }

    // ── PASSO 2: criar a VAGA is_test (draft/PENDING_ACTIVATION) ──
    const createRes = await adminCtx.post('/api/admin/vacancies', {
      data: {
        case_number: patient.caseNumber ?? 0,
        patient_id: patient.id,
        is_test: true,
        required_professions: ['PSYCHOLOGIST'],
        worker_attributes: `E2E-AUDIO-${Date.now()}`,
        age_range_min: 25,
        age_range_max: 60,
        providers_needed: '1',
      },
    });
    expect(createRes.status(), 'POST /api/admin/vacancies cria a vaga is_test (201)').toBe(201);
    const createBody = (await createRes.json()) as CreateVacancyBody;
    vacancyId = createBody.data.id;
    expect(vacancyId, 'create retorna o id da vaga').toBeTruthy();
    expect(createBody.data.is_test, 'vaga persistida como is_test=true (segregada do matchmaking)').toBe(true);

    // ── PASSO 3: salvar o pré-screening com UMA pergunta SEM responseType ──
    // Omitir responseType é o cenário do bug: o backend DEVE cair no default áudio.
    const saveRes = await adminCtx.post(`/api/admin/vacancies/${vacancyId}/prescreening-config`, {
      data: {
        questions: [
          {
            question: '¿Tenés experiencia en el abordaje de pacientes con ideación suicida?',
            desiredResponse: 'Sí, con ejemplos concretos de manejo.',
            weight: 5,
            // responseType OMITIDO de propósito → deve nascer ['text','audio'].
          },
        ],
        faq: [],
      },
    });
    expect(saveRes.status(), 'POST prescreening-config deve responder 200').toBe(200);

    // ── PASSO 4: publicar na Talentum (chamada REAL) ──
    // Timeout generoso: o publish gera a descrição via Gemini (pode passar de 20s) +
    // cria o pré-screening na Talentum + faz o GET. Timeout curto aqui = risco de órfão
    // (cliente desiste enquanto o servidor conclui e cria o projeto na Talentum).
    const publishRes = await adminCtx.post(`/api/admin/vacancies/${vacancyId}/publish-talentum`, {
      timeout: 120_000,
    });
    expect(
      publishRes.status(),
      'POST publish-talentum deve responder 200 (502 = Talentum/IA indisponível; retry)',
    ).toBe(200);

    // ── PASSO 5: talentum-status — audioEnabled=true (fonte externa: GET na Talentum) ──
    const statusRes = await adminCtx.get(`/api/admin/vacancies/${vacancyId}/talentum-status`);
    expect(statusRes.status(), 'GET talentum-status deve responder 200').toBe(200);
    const statusData = ((await statusRes.json()) as TalentumStatusBody).data;
    expect(statusData.published, 'vaga publicada na Talentum').toBe(true);
    expect(statusData.exists, 'projeto existe na Talentum (GET ok)').toBe(true);

    // PROVA CENTRAL do ticket. Capability-gate (padrão #134): o campo audioEnabled só
    // existe depois do deploy do backend que o expõe. Presente → hard-assert; ausente →
    // anota capability-gate (a jornada de publish/teardown já foi provada) até o deploy.
    if ('audioEnabled' in statusData) {
      expect(
        statusData.audioEnabled,
        'TODAS as perguntas aceitam áudio na Talentum (pré-screening nasceu com áudio)',
      ).toBe(true);
    } else {
      test.info().annotations.push({
        type: 'capability-gate',
        description:
          'talentum-status ainda não expõe audioEnabled (backend não deployado). ' +
          'O hard-assert de áudio ativa automaticamente após o deploy.',
      });
    }

    // ── PASSO 6: TEARDOWN VERIFICADO — despublica (apaga na Talentum) e prova que sumiu ──
    const unpublishRes = await adminCtx.delete(`/api/admin/vacancies/${vacancyId}/publish-talentum`);
    expect(unpublishRes.status(), 'DELETE publish-talentum deve responder 200').toBe(200);

    const afterRes = await adminCtx.get(`/api/admin/vacancies/${vacancyId}/talentum-status`);
    expect(afterRes.status(), 'GET talentum-status pós-unpublish deve responder 200').toBe(200);
    const afterData = ((await afterRes.json()) as TalentumStatusBody).data;
    expect(afterData.published, 'após unpublish, a vaga não está mais publicada na Talentum').toBe(false);

    // ── PASSO 7: cleanup do is_test + prova de que a vaga foi apagada ──
    const cleanupRes = await adminCtx.post('/api/admin/test-fixtures/cleanup', { data: {} });
    expect(cleanupRes.status(), 'cleanup is_test deve responder 200').toBe(200);
    const goneRes = await adminCtx.get(`/api/admin/vacancies/${vacancyId}/talentum-status`);
    expect(goneRes.status(), 'após cleanup, a vaga is_test foi apagada (404)').toBe(404);
    vacancyId = undefined;
  });
});
