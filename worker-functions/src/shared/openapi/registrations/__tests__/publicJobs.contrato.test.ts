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
 */
import { PublicJobsFiltersSchema } from '../../../../modules/matching/domain/PublicJobsFilters';
import { PublicJobsV1QuerySchema } from '../publicJobs';

describe('contrato: OpenAPI x domain dos filtros publicos', () => {
  it('as duas listas de filtros declaram exatamente os mesmos campos', () => {
    const doDomain = Object.keys(PublicJobsFiltersSchema.shape).sort();
    const daDoc    = Object.keys(PublicJobsV1QuerySchema.shape).sort();

    expect(daDoc).toEqual(doDomain);
    // Contagem zero aprovaria no vacuo: se um dos schemas virar objeto vazio, o toEqual
    // acima passa comparando [] com [].
    expect(doDomain.length).toBeGreaterThan(0);
  });

  it('nenhum dos dois declara filtro sobre dado clinico', () => {
    const todos = [
      ...Object.keys(PublicJobsFiltersSchema.shape),
      ...Object.keys(PublicJobsV1QuerySchema.shape),
    ];
    for (const proibido of ['pathology', 'pathologies', 'diagnosis', 'diagnostico']) {
      expect(todos).not.toContain(proibido);
    }
  });
});
