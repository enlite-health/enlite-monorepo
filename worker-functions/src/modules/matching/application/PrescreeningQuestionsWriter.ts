/**
 * PrescreeningQuestionsWriter
 *
 * Extração do bloco "Questions persistence" de ProcessTalentumPrescreening
 * para manter ambos os arquivos abaixo do limite de 400 linhas.
 *
 * Responsabilidade única: persistir perguntas e respostas de um prescreening
 * Talentum (register questions + prescreening state) no banco, via
 * TalentumPrescreeningRepository.
 */

import { TalentumPrescreeningRepository } from '../infrastructure/TalentumPrescreeningRepository';
import { TalentumPrescreeningResponseParsed } from '@modules/integration';
import { TalentumResponseSource } from '../domain/TalentumPrescreening';

const TAG = '[PrescreeningQuestionsWriter]';

export class PrescreeningQuestionsWriter {
  constructor(
    private readonly prescreeningRepo: TalentumPrescreeningRepository,
  ) {}

  async persist(
    prescreeningId: string,
    payload: TalentumPrescreeningResponseParsed,
  ): Promise<void> {
    const regCount = payload.data.profile.registerQuestions.length;
    const stateCount = payload.data.response.state.length;
    console.log(`${TAG} persistQuestions | register=${regCount} | prescreening=${stateCount}`);

    await this.upsertQuestions(prescreeningId, payload.data.profile.registerQuestions, 'register');
    await this.upsertQuestions(prescreeningId, payload.data.response.state, 'prescreening');
  }

  private async upsertQuestions(
    prescreeningId: string,
    items: { questionId: string; question: string; answer: string; responseType?: string }[],
    source: TalentumResponseSource,
  ): Promise<void> {
    for (const item of items) {
      const { question } = await this.prescreeningRepo.upsertQuestion({
        questionId:   item.questionId,
        question:     item.question,
        responseType: item.responseType ?? '',
      });

      await this.prescreeningRepo.upsertResponse({
        prescreeningId,
        questionId:     question.id,
        answer:         item.answer || null,
        responseSource: source,
      });
    }
  }
}
