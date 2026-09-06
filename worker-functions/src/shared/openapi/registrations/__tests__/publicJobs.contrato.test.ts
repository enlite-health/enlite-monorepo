/**
 * publicJobs.contrato.test.ts — a doc e a implementação declaram os MESMOS filtros?
 *
 * `PublicJobsFilters.ts` (domain, usado para PARSEAR) e `registrations/publicJobs.ts`
 * (OpenAPI, usado para DOCUMENTAR) mantêm a mesma lista de campos escrita **duas vezes**. O
 * comentário do segundo assumia o risco em voz alta: *"Custo aceito: 2 lugares com lista de
 * campos idêntica; review preventivo cobre."*
 *
 * Não cobriu. Medido em 25/08/2026: a doc declarava o campo clínico no **singular**
 * (`pathology`) e a resposta devolvia o **plural** (`pathologies`) — divergência que viveu
 * meses porque nenhuma régua comparava as duas listas. É a classe da D179: duas fontes
 * divergindo sem ninguém comparar.
 *
 * ⚠️ Este teste NÃO prova que os campos são os certos. Prova que as duas listas concordam —
 * que é exatamente o que "review preventivo" prometia e não entregava.
 *
 * 🔧 F1.5-CORREÇÃO C5 (D261, parecer do CTO): a régua original ('pathology'|'pathologies'|
 * 'diagnosis'|'diagnostico', comparação por IGUALDADE EXATA) tinha 2 gaps medidos:
 *   1. Só olhava os schemas de FILTRO (query) — nunca o de RESPOSTA. `PublicJobV1ItemSchema`
 *      (o item devolvido por `/api/public/v1/jobs`) podia ganhar `diagnoses`/`icd_code`/`cid`
 *      sem o teste acusar (a F2/F3 desta spec cogitam `diagnoses[]` na ficha do paciente — se
 *      esse campo um dia vazar para a resposta pública, a régua velha não veria).
 *   2. A lista de 4 palavras não cobre `diagnoses` (plural sem match exato — na verdade cobria
 *      por coincidência), `icd_code`/`icd_title`/`icd_uri`/`cid` — nenhum vocabulário de CID-11.
 * A régua nova troca IGUALDADE por um PADRÃO (`diagnos*|patolog*|patholog*|icd_*|icd*|cid`) e
 * roda contra filtro E resposta.
 */
import { PublicJobsFiltersSchema } from '../../../../modules/matching/domain/PublicJobsFilters';
import { PublicJobsV1QuerySchema, PublicJobV1ItemSchema } from '../publicJobs';

// C5 — cobre "diagnos" (diagnosis/diagnostico/diagnoses) | "patolog"/"patholog" | "icd" (icd_*) | "cid".
const FORBIDDEN_CLINICAL_OR_CID_PATTERN = /diagnos|patolog|patholog|icd|cid/i;

describe('contrato: OpenAPI x domain dos filtros publicos', () => {
  it('as duas listas de filtros declaram exatamente os mesmos campos', () => {
    const doDomain = Object.keys(PublicJobsFiltersSchema.shape).sort();
    const daDoc    = Object.keys(PublicJobsV1QuerySchema.shape).sort();

    expect(daDoc).toEqual(doDomain);
    // Contagem zero aprovaria no vacuo: se um dos schemas virar objeto vazio, o toEqual
    // acima passa comparando [] com [].
    expect(doDomain.length).toBeGreaterThan(0);
  });

  it('LEGADO — a lista antiga de 4 palavras (igualdade exata) segue sem falso-positivo nos filtros reais', () => {
    const todos = [
      ...Object.keys(PublicJobsFiltersSchema.shape),
      ...Object.keys(PublicJobsV1QuerySchema.shape),
    ];
    for (const proibido of ['pathology', 'pathologies', 'diagnosis', 'diagnostico']) {
      expect(todos).not.toContain(proibido);
    }
  });

  describe('C5 (D261) — régua ampliada: diagnos*|patolog*|patholog*|icd_*|icd*|cid, em FILTRO e RESPOSTA', () => {
    it('RED documentado: a lista antiga (igualdade exata, só 4 palavras) NÃO pega diagnoses/icd_*/cid — o gap medido na D261', () => {
      const camposDeRiscoQueAF2PoderiaIntroduzir = ['diagnoses', 'icd_code', 'icd_title', 'icd_uri', 'cid'];
      const listaAntiga = ['pathology', 'pathologies', 'diagnosis', 'diagnostico'];
      const pegosPelaListaAntiga = camposDeRiscoQueAF2PoderiaIntroduzir.filter((f) => listaAntiga.includes(f));

      // Isto NÃO é um teste que deveria passar — é a reprodução do defeito: a lista antiga,
      // por IGUALDADE EXATA com só 4 palavras, pega ZERO dos 5 campos de risco reais.
      expect(pegosPelaListaAntiga).toEqual([]);
    });

    it('GREEN: o padrão novo pega TODOS os campos de risco que a lista antiga deixava passar', () => {
      const camposDeRiscoQueAF2PoderiaIntroduzir = ['diagnoses', 'icd_code', 'icd_title', 'icd_uri', 'cid', 'id', 'title', 'country'];
      const pegos = camposDeRiscoQueAF2PoderiaIntroduzir.filter((f) => FORBIDDEN_CLINICAL_OR_CID_PATTERN.test(f));
      expect(pegos.sort()).toEqual(['cid', 'diagnoses', 'icd_code', 'icd_title', 'icd_uri'].sort());
      // campos legítimos (id, title, country) NUNCA são pegos — a régua não é ampla demais.
      expect(pegos).not.toContain('id');
      expect(pegos).not.toContain('title');
      expect(pegos).not.toContain('country');
    });

    it('os schemas de FILTRO reais (query) não violam a régua nova', () => {
      const todos = [
        ...Object.keys(PublicJobsFiltersSchema.shape),
        ...Object.keys(PublicJobsV1QuerySchema.shape),
      ];
      for (const campo of todos) {
        expect(campo).not.toMatch(FORBIDDEN_CLINICAL_OR_CID_PATTERN);
      }
    });

    it('o schema de RESPOSTA real (PublicJobV1ItemSchema, o item de /api/public/v1/jobs) não viola a régua nova — o GAP que a D261 mediu', () => {
      const campos = Object.keys(PublicJobV1ItemSchema.shape);
      expect(campos.length).toBeGreaterThan(0); // guarda contra objeto vazio aprovando no vácuo
      for (const campo of campos) {
        expect(campo).not.toMatch(FORBIDDEN_CLINICAL_OR_CID_PATTERN);
      }
    });
  });
});
