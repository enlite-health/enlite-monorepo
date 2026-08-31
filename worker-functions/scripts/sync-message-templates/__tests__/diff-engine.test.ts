/**
 * diff-engine.test.ts — a FIAÇÃO do sync, que escreve `message_templates` em
 * produção. Puro: sem rede, sem banco.
 *
 * Por que existe: a regra de extração (`twilioContentBody.ts`) está a 100%, mas
 * quem decide QUAL das duas funções vai para QUAL coluna é este arquivo. Trocar
 * as duas de lugar recoloca o sentinela `[Template não-textual …]` em
 * `body_twilio` — que é exatamente o defeito que a tela mostrou ao staff como
 * "assim a cuidadora recebe" — e, sem este teste, nada ficava vermelho.
 *
 * A regra que ele trava, em uma linha:
 *   `body` (legado, NOT NULL, contrato de envio) PODE receber sentinela.
 *   `body_twilio` (exibição) recebe TEXTO REAL ou `null`. Nunca sentinela.
 */
import { computePlan, type ApprovedTwilioEntry } from '../diff-engine';
import type { DbTemplateRow } from '../db';
import { NON_TEXTUAL_SENTINEL } from '../../../src/modules/notification/infrastructure/twilioContentBody';

const content = (over: Partial<ApprovedTwilioEntry['content']> = {}): ApprovedTwilioEntry['content'] => ({
  sid: 'HX1', friendly_name: 'tpl_um', language: 'es', variables: null,
  types: { 'twilio/text': { body: 'Hola {{1}}' } },
  date_created: '2026-01-01', date_updated: '2026-01-01', ...over,
});
const aprovado = (over: Partial<ApprovedTwilioEntry['content']> = {}): ApprovedTwilioEntry =>
  ({ content: content(over), approval: { status: 'approved', category: 'UTILITY' } });

const dbRow = (over: Partial<DbTemplateRow> = {}): DbTemplateRow => ({
  id: 'id-1', slug: 'tpl_um', name: 'tpl_um', body: 'Hola {{worker_name}}', body_twilio: null,
  category: 'UTILITY', is_active: true, content_sid: 'HX1', ...over,
});

describe('computePlan — qual texto vai para qual coluna', () => {
  it('INSERT: Content com texto → o mesmo texto nas duas colunas', () => {
    const { inserts } = computePlan([aprovado()], []);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ slug: 'tpl_um', body: 'Hola {{1}}', bodyTwilio: 'Hola {{1}}' });
  });

  it('INSERT: Content SÓ com título → `body` recebe o título; `body_twilio` fica NULL', () => {
    const { inserts } = computePlan([aprovado({ types: { 'twilio/card': { title: 'Só um título' } } })], []);
    expect(inserts[0].body).toBe('Só um título');
    expect(inserts[0].bodyTwilio).toBeNull();
  });

  it('INSERT: Content sem texto nenhum → o SENTINELA vai só para `body`, nunca para `body_twilio`', () => {
    const { inserts } = computePlan([aprovado({ types: { 'twilio/card': {} } })], []);
    expect(inserts[0].body).toBe(NON_TEXTUAL_SENTINEL);
    expect(inserts[0].bodyTwilio).toBeNull();
    // a asserção que impede o B2 de renascer por aqui:
    expect(inserts[0].bodyTwilio).not.toBe(NON_TEXTUAL_SENTINEL);
  });

  it('UPDATE: `body_twilio` divergente é sobrescrito com o texto aprovado; `body` NUNCA entra no plano', () => {
    const { updates } = computePlan([aprovado()], [dbRow({ body_twilio: 'texto velho' })]);
    expect(updates).toHaveLength(1);
    expect(updates[0].fields.body_twilio).toBe('Hola {{1}}');
    expect(updates[0].fields).not.toHaveProperty('body');
    expect(updates[0].bodyDiverges).toBe(true); // `body` nomeado × aprovado posicional
  });

  it('UPDATE: Content que perdeu o texto faz `body_twilio` VOLTAR a null — não vira sentinela', () => {
    const { updates } = computePlan(
      [aprovado({ types: { 'twilio/card': {} } })],
      [dbRow({ body_twilio: 'tinha texto antes' })],
    );
    expect(updates[0].fields.body_twilio).toBeNull();
  });

  it('UPDATE: nada a mudar → nenhum plano (não escreve por escrever)', () => {
    const { updates } = computePlan([aprovado()], [dbRow({ body: 'Hola {{1}}', body_twilio: 'Hola {{1}}' })]);
    expect(updates).toHaveLength(0);
  });

  it('DELETE: linha do banco sem correspondente aprovado entra no plano com o motivo', () => {
    const { deletes } = computePlan([], [dbRow({ slug: 'orfao', content_sid: 'HXsumiu' })]);
    expect(deletes).toEqual([expect.objectContaining({ slug: 'orfao', reason: expect.stringContaining('HXsumiu') })]);
  });

  it('DELETE: linha sem content_sid e sem match por friendly_name — o caso da reserva do REQ-09', () => {
    const { deletes } = computePlan([], [dbRow({ slug: 'reserva', content_sid: null })]);
    expect(deletes[0].reason).toContain('sem content_sid');
  });

  it('match por friendly_name quando o content_sid ainda não está gravado', () => {
    const { updates, inserts } = computePlan([aprovado()], [dbRow({ content_sid: null })]);
    expect(inserts).toHaveLength(0);
    expect(updates[0].fields.content_sid).toBe('HX1');
  });

  it('template inativo no banco volta a ativo quando a Twilio o aprova', () => {
    const { updates } = computePlan([aprovado()], [dbRow({ is_active: false })]);
    expect(updates[0].fields.is_active).toBe(true);
  });
});
