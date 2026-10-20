/**
 * Teste de CONTRATO back → front da ficha do paciente (spec 011, FR-A2).
 *
 * A fixture `fixtures/patient-detail.api.json` NÃO foi escrita à mão: é o `data`
 * de `GET /api/admin/patients/:id` da API real (docker `enlite-api`, Postgres
 * `enlite_e2e`), para um paciente SINTÉTICO semeado com 1 responsável,
 * 1 endereço, 1 profissional, 1 serviço contratado ATIVO, cobertura e e-mail.
 * Dados inventados — nenhum paciente real. Recaptura original: ver
 * `specs/011-admissao-a-bugs-dado/relatorio.md`.
 *
 * RECAPTURADA em 03/09 (QA-caça rodada 1, item conserto D255): `completeness`
 * ganhou `blocking`/`canActivate` (`PatientCompleteness.ts`, D255) — o `.strict()`
 * do schema reprovaria a chave nova sem recapturar. Paciente semeado
 * PENDING_ADMISSION com endereço + serviço ativo + cobertura + consentimento →
 * checklist COMPLETO (`missing:[]`), então `blocking:[]`/`ready:true`/
 * `canActivate:true` nesta fixture — os estados PARCIAIS (`missing` não vazio,
 * `blocking` com ADDRESS) já têm cobertura própria em
 * `AdminPatientsController.test.ts` (Cenário 1b) e `PatientCompleteness.test.ts`.
 *
 * RECAPTURADA de novo em 03/09 (spec 015, US-A6.1): `contractedServices[].providerAgeBand`
 * (migration 322) — mesmo mecanismo, imagem `enlite-api` rebuildada desta worktree (`docker exec
 * enlite-api grep -c providerAgeBand /app/dist/modules/case/infrastructure/
 * PatientDetailQueryHelper.js` → 1). Paciente/serviço semeados de novo (ids mudam a cada
 * recaptura); serviço nasce com `provider_age_band='AGE_30_45'` — é o valor que o teste abaixo
 * verifica chegar cru no contrato (a TELA é quem traduz, não o contrato).
 *
 * ATUALIZADA à mão em 19/10 (spec 058 Parte A, A2): o serviço perdeu `hourlyValue`/`contractType`/`taxCondition`/`hourlyValueRedacted`
 * e ganhou `asOf`/`payer`/`payerHistory`/`price`/`tax`/`coverageMatch`; a ficha perdeu `insuranceVerified`/`insuranceVerifiedEntries` e
 * ganhou `coverage` — o formato é o da resposta da A1 (rodada 4; provado lá por `058a-ficha-vs-rota`). A recaptura contra a API
 * real fica para o e2e de tela da rodada 9 (T110/T130-T135).
 *
 * O que este teste trava:
 *  - a entidade `PatientDetail` lê as chaves que a API manda (`name`, não
 *    `fullName`; `addressFormatted`, não `fullAddress`) — o `.strict()` do
 *    schema reprova chave a mais OU a menos;
 *  - o e-mail (`contactEmail`) e a cobertura (`insuranceInformed`) chegam na
 *    ficha para o paciente semeado com eles (A3/A4);
 *  - `completeness.blocking`/`canActivate` chegam no shape do D255.
 */
import { describe, it, expect } from 'vitest';
import type { PatientDetail, PatientClinicalSectionPayload } from '../PatientDetail';
import { patientDetailContractSchema, type PatientDetailContract } from '../patientDetailContract';
import fixture from './fixtures/patient-detail.api.json';

// Atribuível nas DUAS direções: campo a mais, a menos ou com outro tipo em
// qualquer um dos lados vira erro de compilação (o `tsc --noEmit` é gate).
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const contractIsEntity: MutuallyAssignable<PatientDetailContract, PatientDetail> = true;

describe('contrato PatientDetail — fixture capturada da API real', () => {
  it('o tipo do schema É a entidade (as duas direções)', () => {
    expect(contractIsEntity).toBe(true);
  });

  it('a resposta real da API passa no schema da entidade, sem chave a mais nem a menos', () => {
    const parsed = patientDetailContractSchema.safeParse(fixture);
    if (!parsed.success) {
      // Mostra o caminho de cada divergência — é a evidência do drift.
      throw new Error(JSON.stringify(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })), null, 2));
    }
    expect(parsed.success).toBe(true);
  });

  it('profissional e endereço vêm nas chaves que os cards leem', () => {
    const p = patientDetailContractSchema.parse(fixture);
    expect(p.professionals[0].name).toBe('Dra. Fixture Tratante');
    expect(p.addresses[0].addressFormatted).toBe('Av. Fixture 123, CABA, AR');
    expect(p.responsibles[0].source).toBe('web_form');
  });

  it('cobertura gravada em health_insurance_name aparece em insuranceInformed (A3) e o e-mail chega (A4)', () => {
    const p = patientDetailContractSchema.parse(fixture);
    expect(p.insuranceInformed).toBe('OSDE 210 (fixture)');
    expect(p.contactEmail).toBe('contrato.fixture.c5@example.test');
  });

  it('D255 (QA-caça rodada 1): completeness carrega blocking/canActivate — paciente semeado completo (missing:[]) → blocking:[] e canActivate:true', () => {
    const p = patientDetailContractSchema.parse(fixture);
    expect(p.completeness).toEqual({ missing: [], blocking: [], ready: true, canActivate: true });
  });

  it('serviço contratado ativo chega no card (bloco C) — 1 serviço, sem prestador alocado nesta fixture', () => {
    const p = patientDetailContractSchema.parse(fixture);
    expect(p.contractedServices).toHaveLength(1);
    expect(p.contractedServices[0].active).toBe(true);
    expect(p.contractedServices[0].serviceCode).toBe('AT');
  });

  it('spec 047 (F2): liveVacancy é allow-list de 4 chaves (campo a mais é recusado) e liveVacancyRedacted distingue "sem vaga" de "sem permissão"', () => {
    const vaga = { id: 'v1', caseNumber: 1234, caseOrdinal: 1, status: 'SEARCHING' };
    const comServico = (patch: Record<string, unknown>) => ({ ...fixture, contractedServices: [{ ...fixture.contractedServices[0], ...patch }] });
    const ok = patientDetailContractSchema.parse(comServico({ liveVacancy: vaga, liveVacancyRedacted: false }));
    expect(ok.contractedServices[0].liveVacancy).toEqual(vaga);
    const redigida = patientDetailContractSchema.parse(comServico({ liveVacancy: null, liveVacancyRedacted: true }));
    expect(redigida.contractedServices[0]).toMatchObject({ liveVacancy: null, liveVacancyRedacted: true });
    expect(() => patientDetailContractSchema.parse(comServico({ liveVacancy: { ...vaga, campoExtra: 1500 }, liveVacancyRedacted: false }))).toThrow();
    expect(() => patientDetailContractSchema.parse(comServico({ chaveAntiga: 'v1' }))).toThrow(); // `.strict()`: chave desconhecida é recusada
  });

  describe('spec 058 (A2): pagador, preço, imposto, divergência e cobertura no fio', () => {
    const comServico = (patch: Record<string, unknown>) => ({ ...fixture, contractedServices: [{ ...fixture.contractedServices[0], ...patch }] });
    const names = { providerCode: 'OSDE', providerName: 'OSDE', contractId: 'c1', contractName: 'Plan 210', payerKind: 'PREPAGA' };

    it('serviço VINCULADO: pagador com nomes, preço e imposto 0 (isento) chegam; o front não calcula "hoje" (asOf vem da resposta)', () => {
      const s = patientDetailContractSchema.parse(fixture).contractedServices[0];
      expect(s.asOf).toBe('2026-10-19');
      expect(s.payer).toMatchObject({ state: 'LINKED', isPrivate: false, validTo: null, names: { providerName: 'OSDE', payerKind: 'PREPAGA' } });
      expect(s.price).toEqual({ state: 'OK', hourlyRate: 1500, currency: 'ARS' });
      expect(s.tax).toEqual({ state: 'OK', taxRatePercent: 0 });
      expect(s.coverageMatch).toEqual({ state: 'MATCH' });
    });

    it('serviço SEM vínculo (todo serviço de hoje): NO_CONTRACT em pagador, preço e imposto', () => {
      const p = patientDetailContractSchema.parse(comServico({ payer: { state: 'NO_CONTRACT' }, payerHistory: [], price: { state: 'NO_CONTRACT' }, tax: { state: 'NO_CONTRACT' }, coverageMatch: { state: 'NO_PAYER' } }));
      expect(p.contractedServices[0].payer).toEqual({ state: 'NO_CONTRACT' });
    });

    it('REDAÇÃO por célula: sem `coverage` os nomes viram null e a divergência REDACTED; sem o valor, price REDACTED (imposto continua)', () => {
      const p = patientDetailContractSchema.parse(comServico({
        payer: { state: 'LINKED', isPrivate: true, validFrom: '2026-09-01', validTo: '2026-12-31', names: null },
        payerHistory: [{ linkId: 'l1', isPrivate: true, validFrom: '2026-09-01', validTo: null, names: null }],
        price: { state: 'REDACTED' },
        coverageMatch: { state: 'REDACTED' },
      }));
      expect(p.contractedServices[0].price).toEqual({ state: 'REDACTED' });
      expect(p.contractedServices[0].tax.state).toBe('OK');
      expect(p.contractedServices[0].coverageMatch.state).toBe('REDACTED');
    });

    it('os 7 estados da divergência são aceitos e um estado desconhecido é recusado', () => {
      for (const state of ['NO_PAYER', 'PRIVATE_PAYER', 'NO_COVERAGE', 'UNMAPPED_ONLY', 'MATCH', 'MISMATCH', 'REDACTED']) {
        expect(patientDetailContractSchema.safeParse(comServico({ coverageMatch: { state }, payer: { state: 'LINKED', isPrivate: false, validFrom: '2026-09-01', validTo: null, names } })).success).toBe(true);
      }
      expect(patientDetailContractSchema.safeParse(comServico({ coverageMatch: { state: 'TALVEZ' } })).success).toBe(false);
    });

    it('as chaves LEGADAS do serviço (valor-hora, tipo, IVA) são recusadas pelo `.strict()` — saíram do fio', () => {
      for (const legacy of [{ hourlyValue: 1500 }, { hourlyValueRedacted: false }, { contractType: 'OBRA_SOCIAL' }, { taxCondition: 'IVA_21' }]) {
        expect(patientDetailContractSchema.safeParse(comServico(legacy)).success).toBe(false);
      }
    });

    it('cobertura: `entries` com `code`+`name`+`mapped`+`source`; mapped:false tem code/name null; coverage:null = sem permissão', () => {
      const p = patientDetailContractSchema.parse(fixture);
      expect(p.coverage?.entries).toEqual([
        { code: 'OSDE', name: 'OSDE', mapped: true, source: 'admin_manual' },
        { code: null, name: null, mapped: false, source: 'clickup' },
      ]);
      expect(patientDetailContractSchema.parse({ ...fixture, coverage: null }).coverage).toBeNull();
      expect(patientDetailContractSchema.safeParse({ ...fixture, coverage: { display: null, displaySource: 'NONE', entries: [{ code: 'X', source: 'clickup' }] } }).success).toBe(false);
    });

    it('`insuranceVerified` / `insuranceVerifiedEntries` (legado da ficha) são recusados', () => {
      expect(patientDetailContractSchema.safeParse({ ...fixture, insuranceVerified: null }).success).toBe(false);
      expect(patientDetailContractSchema.safeParse({ ...fixture, insuranceVerifiedEntries: [] }).success).toBe(false);
    });
  });

  it('spec 015 (US-A6.1): providerAgeBand chega CRU no contrato — a tradução é responsabilidade da TELA, não do contrato', () => {
    const p = patientDetailContractSchema.parse(fixture);
    expect(p.contractedServices[0].providerAgeBand).toBe('AGE_30_45');
  });

  it('C5 (QA-caça, spec 016 F2): diagnoses[] chega na projeção REQ-21 (sem code/chapter/release) e diagnosesUnavailable:false quando o backend leu normalmente', () => {
    const p = patientDetailContractSchema.parse(fixture);
    expect(p.diagnosesUnavailable).toBe(false);
    // `diagnoses` é `T[] | null` (achado do gate revisao-pr, spec cid-na-vacante: `null` = sem
    // `patient_clinical:read`) — a fixture deste paciente sintético TEM a célula, então é
    // sempre array; a guarda é só para o `tsc` estreitar o tipo, não um caso novo do contrato.
    const diagnoses = p.diagnoses;
    if (!diagnoses) throw new Error('fixture esperada com diagnoses não-nulo (paciente com célula clínica)');
    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0]).toEqual({
      id: expect.any(String),
      uri: 'http://id.who.int/icd/release/11/2026-01/mms/437815624/unspecified',
      title: 'Trastorno del espectro autista, sin especificación',
      isPrimary: true,
      source: 'PANEL',
      active: true,
    });
    // Régua POSITIVA (REQ-21): nenhuma chave de vocabulário em NENHUM diagnóstico da fixture.
    for (const key of Object.keys(diagnoses[0])) {
      expect(['code', 'chapter', 'release', 'conceptCode', 'conceptGroup', 'catalogRelease']).not.toContain(key);
    }
  });
});

/**
 * F6 (gate `revisao-pr`, BAIXO) — `PatientClinicalSectionPayload` ainda declarava
 * `clinicalSpecialty`, chave que o `clinicalSectionSchema` `.strict()` do backend JÁ NÃO ACEITA:
 * quem confiasse no tipo escreveria um PATCH que volta 400. Nenhum chamador usa hoje — é chave
 * MORTA, e chave morta num payload é 400 latente, não enfeite.
 *
 * O portão desta remoção é o `tsc`, não o runtime: com a chave ainda declarada, o
 * `@ts-expect-error` abaixo fica SEM ERRO PARA SUPRIMIR e o `tsc --noEmit` reprova com
 * "Unused '@ts-expect-error' directive" (TS2578). Depois da remoção, o objeto é que passa a ser
 * inválido e a diretiva volta a ter função. Nos dois sentidos, o compilador morde.
 */
describe('F6 — PatientClinicalSectionPayload não declara chave que o backend recusa', () => {
  it('`clinicalSpecialty` não é aceita no payload da seção clínica (o `.strict()` do backend a rejeita)', () => {
    const payload: PatientClinicalSectionPayload = {
      diagnosis: 'x',
      // @ts-expect-error — chave MORTA: removida do payload porque o backend a recusa (F6).
      clinicalSpecialty: 'ASD',
    };
    expect(payload.diagnosis).toBe('x');
  });
});
