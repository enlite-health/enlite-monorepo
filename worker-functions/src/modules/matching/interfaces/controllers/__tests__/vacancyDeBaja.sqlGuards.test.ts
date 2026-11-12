/**
 * Spec 084 (F9/F10): os pontos com deny-list que deixavam DE_BAJA passar agora a excluem. O SQL é lido do arquivo
 * de produção (não de um dublê): se alguém voltar a `!= 'CLOSED'` puro, o teste cai. A prova com banco é o e2e.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../../../../..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('pontos que deixavam vaga DE_BAJA aparecer', () => {
  it('seletor de casos dos filtros (AdminWorkersAuxController.listCaseOptions) exclui DE_BAJA', () => {
    const t = read('modules/worker/interfaces/controllers/AdminWorkersAuxController.ts');
    expect(t).toContain("jp.status NOT IN ('CLOSED', 'DE_BAJA')");
    expect(t).not.toMatch(/jp\.status != 'CLOSED'/);
  });

  it('vagas por endereço (VacanciesAuxController.listByAddress) exclui DE_BAJA', () => {
    const t = read('modules/matching/interfaces/controllers/VacanciesAuxController.ts');
    expect(t).toContain("jp.status NOT IN ('CLOSED', 'DE_BAJA')");
    expect(t).not.toMatch(/jp\.status <> 'CLOSED'/);
  });

  it('Luz: worker.vacancies.list (WorkerApplicationRepository) exclui DE_BAJA da lista do prestador', () => {
    const t = read('modules/matching/infrastructure/WorkerApplicationRepository.ts');
    expect(t).toContain("AND jp.status != 'DE_BAJA'");
  });

  it('promoção de candidato bloqueado recusa vaga DE_BAJA', () => {
    const t = read('modules/matching/application/PromoteBlockedApplicationsUseCase.ts');
    expect(t).toMatch(/jp\.status === 'DE_BAJA'/);
  });

  it('o webhook marca e segura a resposta de vaga DE_BAJA (held_for_baja), sem WJA', () => {
    const t = read('modules/matching/application/ProcessTalentumPrescreening.ts');
    expect(t).toContain('held_for_baja = true');
    expect(t).toMatch(/vacancyIsDeBaja\(this\.pool/);
  });
});
