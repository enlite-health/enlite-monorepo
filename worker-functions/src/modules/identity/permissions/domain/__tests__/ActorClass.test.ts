/**
 * C9 — a classe do ator, e a PARIDADE com o banco.
 *
 * ⚠️ O teste que importa aqui não é o de comportamento: é o de paridade. A
 * verdade do invariante é o trigger da migration 285; a lista em TypeScript
 * existe só para o painel não oferecer o que o banco vai recusar. Duas fontes
 * que divergem em silêncio é o D136 — e o jeito de não divergir é UMA delas ler
 * a outra, que é o que este arquivo faz: lê o SQL da migration, não uma cópia.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ACTOR_CLASSES,
  ACTOR_CLASS_PADRAO,
  CELULAS_VEDADAS_A_TERCEIRO,
  isActorClass,
  podeConceder,
  motivoDaVedacao,
} from '../ActorClass';

const MIGRATION = path.resolve(
  __dirname, '..', '..', '..', '..', '..', '..',
  'migrations', '285_actor_class_external_third_party.sql',
);

describe('C9 — paridade entre a lista do código e o trigger do banco', () => {
  it('a migration existe — sem ela a lista do código é decoração', () => {
    expect(fs.existsSync(MIGRATION)).toBe(true);
  });

  it('as células vedadas são AS MESMAS nos dois lados', () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    const corpo = sql.slice(
      sql.indexOf('celulas_vedadas_a_terceiro()'),
      sql.indexOf('REVOKE ALL ON FUNCTION iam.celulas_vedadas_a_terceiro'),
    );
    // Pega só o que está entre aspas simples dentro do ARRAY[...]
    const noBanco = new Set(
      [...corpo.matchAll(/'([a-z_]+:[a-z_]+)'/g)].map((m) => m[1]),
    );

    // Contagem zero é falha: se a extração quebrar, o teste ficaria verde
    // comparando dois conjuntos vazios.
    expect(noBanco.size).toBeGreaterThan(0);
    expect([...noBanco].sort()).toEqual([...CELULAS_VEDADAS_A_TERCEIRO].sort());
  });

  it('as duas classes do CHECK do banco são as mesmas do tipo', () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    const check = sql.slice(sql.indexOf('actor_class IN ('), sql.indexOf('actor_class IN (') + 120);
    for (const classe of ACTOR_CLASSES) {
      expect([classe, check.includes(`'${classe}'`)]).toEqual([classe, true]);
    }
  });

  it('TODA referência a tabela do IAM é qualificada com `iam.` — as views mordem', () => {
    // ⚠️ A migration 274 moveu estas tabelas para o schema `iam` E DEIXOU VIEWS
    // de compatibilidade em `public` com os MESMOS nomes. Sem qualificar,
    // `ALTER TABLE permission_groups` resolve para a VIEW e o Postgres recusa
    // ("not supported for views"). Foi assim que a 1ª versão desta migration
    // quebrou o e2e — e o meu teste isolado não pegou porque eu criei o fixture
    // com tabelas reais nesse nome, confirmando a minha suposição.
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    const semComentarios = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

    for (const tabela of ['permission_groups', 'group_permissions', 'permissions']) {
      // Casa o nome NÃO precedido de `iam.` nem de outra palavra/ponto.
      const nu = new RegExp(`(?<![\\w.])${tabela}(?![\\w])`, 'g');
      const ocorrencias = [...semComentarios.matchAll(nu)];
      expect([tabela, ocorrencias.map((m) => m[0])]).toEqual([tabela, []]);
    }
  });

  it('o trigger guarda as DUAS direções — conceder célula E virar externo', () => {
    // Guardar só uma deixa a porta aberta pela outra, que é justamente o
    // caminho de quem quer "aproveitar um grupo que já existe".
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    // ⚠️ Regex com a TABELA, não `toContain` do nome: `toContain` casa
    // substring, então renomear o trigger para `veda_virar_externo_DESLIGADO`
    // passaria — foi o que a sabotagem S19 mostrou.
    expect(sql).toMatch(
      /CREATE TRIGGER veda_celula_a_terceiro\s+BEFORE INSERT OR UPDATE ON iam\.group_permissions/,
    );
    expect(sql).toMatch(
      /CREATE TRIGGER veda_virar_externo\s+BEFORE UPDATE ON iam\.permission_groups/,
    );
  });
});

describe('C9 — a decisão em si', () => {
  it('terceiro não recebe nenhuma das vedadas', () => {
    for (const c of CELULAS_VEDADAS_A_TERCEIRO) {
      expect([c, podeConceder('EXTERNAL_THIRD_PARTY', c)]).toEqual([c, false]);
    }
  });

  it('terceiro RECEBE o que não é vedado — a classe não é uma parede', () => {
    for (const c of ['funnel:read', 'vacancy:read', 'worker:read']) {
      expect([c, podeConceder('EXTERNAL_THIRD_PARTY', c)]).toEqual([c, true]);
    }
  });

  it('INTERNAL não é "pode tudo": é "esta regra não se aplica"', () => {
    // Quem decide o que o grupo interno recebe continua sendo a célula.
    expect(podeConceder('INTERNAL', 'worker_pii:read')).toBe(true);
    expect(podeConceder('INTERNAL', 'patient:delete')).toBe(true);
  });

  it('o default é INTERNAL — grupo novo não nasce sem poder receber célula', () => {
    expect(ACTOR_CLASS_PADRAO).toBe('INTERNAL');
  });

  it('a tela recebe motivo escrito, não só um checkbox desabilitado', () => {
    const m = motivoDaVedacao('EXTERNAL_THIRD_PARTY', 'worker_pii:read');
    expect(m).toContain('cessão');
    expect(motivoDaVedacao('EXTERNAL_THIRD_PARTY', 'funnel:read')).toBeNull();
    expect(motivoDaVedacao('INTERNAL', 'worker_pii:read')).toBeNull();
  });

  it('classe desconhecida não é aceita — nem string parecida', () => {
    expect(isActorClass('EXTERNAL_THIRD_PARTY')).toBe(true);
    expect(isActorClass('INTERNAL')).toBe(true);
    expect(isActorClass('EXTERNAL')).toBe(false);
    expect(isActorClass('PARCEIRO')).toBe(false);
    expect(isActorClass(null)).toBe(false);
  });
});
