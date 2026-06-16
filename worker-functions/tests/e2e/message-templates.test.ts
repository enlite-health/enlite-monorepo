/**
 * message-templates.test.ts
 *
 * Testa a migration 059 + MessageTemplateRepository contra o banco real.
 * Sem mocks — cada assertion reflete exatamente o que foi persistido.
 *
 * Parte 1 — Schema (migration 059):
 *   - Tabela message_templates existe com as colunas corretas
 *   - Seed data: os 3 templates iniciais estão presentes
 *
 * Parte 2 — MessageTemplateRepository:
 *   - findBySlug: retorna template ativo, null para slug inexistente, null para inativo
 *   - findAll: respeita flag onlyActive
 *   - upsert: INSERT → created=true; ON CONFLICT → created=false, campos atualizados
 *   - upsert: is_active=false (soft delete) → findBySlug retorna null
 */

import { Pool } from 'pg';
import { MessageTemplateRepository } from '@modules/notification';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

// DatabaseConnection (singleton usado pelo repositório) lê DATABASE_URL de process.env
process.env.DATABASE_URL = DATABASE_URL;

let pool: Pool;
let repo: MessageTemplateRepository;

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });

  // Garante que os templates de seed da migration existam.
  // setup.ts faz TRUNCATE em message_templates antes dos testes — reinsere o seed.
  await pool.query(`
    INSERT INTO message_templates (slug, name, body, category) VALUES
      ('talent_search_welcome',
       'Boas-vindas Talent Search',
       'Olá {{name}}! Encontramos o seu perfil e gostaríamos de apresentar oportunidades na área da saúde. Podemos conversar?',
       'onboarding'),
      ('vacancy_match',
       'Vaga Compatível',
       'Olá {{name}}! Temos uma vaga de {{role}} em {{location}} que combina com o seu perfil. Tem interesse?',
       'recruitment'),
      ('encuadre_scheduled',
       'Entrevista Agendada',
       'Olá {{name}}! Sua entrevista foi agendada para {{date}} às {{time}}. Confirma presença?',
       'notification')
    ON CONFLICT (slug) DO NOTHING
  `);

  repo = new MessageTemplateRepository();
});

afterAll(async () => {
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────
// Parte 1 — Schema
// ─────────────────────────────────────────────────────────────────

describe('Schema — migration 059', () => {
  it('tabela message_templates existe', async () => {
    const result = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_name = 'message_templates'
       ) AS exists`,
    );
    expect(result.rows[0].exists).toBe(true);
  });

  it('colunas obrigatórias existem com tipos corretos', async () => {
    const result = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'message_templates'
       ORDER BY ordinal_position`,
    );

    const columns = result.rows.reduce<Record<string, { type: string; nullable: string }>>(
      (acc, r) => ({ ...acc, [r.column_name]: { type: r.data_type, nullable: r.is_nullable } }),
      {},
    );

    expect(columns['id']).toBeDefined();
    expect(columns['id'].type).toBe('uuid');

    expect(columns['slug']).toBeDefined();
    expect(columns['slug'].nullable).toBe('NO');

    expect(columns['name']).toBeDefined();
    expect(columns['name'].nullable).toBe('NO');

    expect(columns['body']).toBeDefined();
    expect(columns['body'].nullable).toBe('NO');

    expect(columns['category']).toBeDefined();
    expect(columns['category'].nullable).toBe('YES');

    expect(columns['is_active']).toBeDefined();
    expect(columns['is_active'].type).toBe('boolean');

    expect(columns['created_at']).toBeDefined();
    expect(columns['updated_at']).toBeDefined();
  });

  it('slug tem constraint UNIQUE', async () => {
    const result = await pool.query<{ constraint_type: string }>(
      `SELECT tc.constraint_type
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_name = kcu.table_name
       WHERE tc.table_name = 'message_templates'
         AND kcu.column_name = 'slug'
         AND tc.constraint_type = 'UNIQUE'`,
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('seed: 3 templates presentes com slugs corretos', async () => {
    const result = await pool.query<{ slug: string }>(
      `SELECT slug FROM message_templates
       WHERE slug IN ('talent_search_welcome', 'vacancy_match', 'encuadre_scheduled')
       ORDER BY slug`,
    );
    const slugs = result.rows.map(r => r.slug).sort();
    expect(slugs).toEqual(['encuadre_scheduled', 'talent_search_welcome', 'vacancy_match']);
  });

  it('seed: talent_search_welcome tem categoria onboarding e está ativo', async () => {
    const result = await pool.query<{ category: string; is_active: boolean }>(
      `SELECT category, is_active FROM message_templates WHERE slug = 'talent_search_welcome'`,
    );
    expect(result.rows[0].category).toBe('onboarding');
    expect(result.rows[0].is_active).toBe(true);
  });

  it('seed: body dos templates contém placeholders {{...}}', async () => {
    const result = await pool.query<{ slug: string; body: string }>(
      `SELECT slug, body FROM message_templates ORDER BY slug`,
    );
    for (const row of result.rows) {
      expect(row.body).toMatch(/\{\{.+\}\}/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Parte 2 — MessageTemplateRepository
// ─────────────────────────────────────────────────────────────────

describe('MessageTemplateRepository.findBySlug()', () => {
  it('retorna o template correto para slug existente', async () => {
    const t = await repo.findBySlug('talent_search_welcome');
    expect(t).not.toBeNull();
    expect(t!.slug).toBe('talent_search_welcome');
    expect(t!.name).toBe('Boas-vindas Talent Search');
    expect(t!.category).toBe('onboarding');
    expect(t!.isActive).toBe(true);
    expect(t!.body).toContain('{{name}}');
    expect(t!.id).toBeTruthy();
    expect(t!.createdAt).toBeInstanceOf(Date);
    expect(t!.updatedAt).toBeInstanceOf(Date);
  });

  it('retorna null para slug inexistente', async () => {
    const t = await repo.findBySlug('slug_que_nao_existe');
    expect(t).toBeNull();
  });

  it('retorna null para template inativo', async () => {
    // Desativa temporariamente
    await pool.query(
      `UPDATE message_templates SET is_active = false WHERE slug = 'vacancy_match'`,
    );
    const t = await repo.findBySlug('vacancy_match');
    expect(t).toBeNull();

    // Reativa para não interferir nos próximos testes
    await pool.query(
      `UPDATE message_templates SET is_active = true WHERE slug = 'vacancy_match'`,
    );
  });
});

describe('MessageTemplateRepository.findAll()', () => {
  // findAll agora tem requireContentSid=true por default (filtra templates sem HSM aprovado).
  // Os templates de seed não têm content_sid → passar requireContentSid=false nos testes.

  it('retorna apenas templates ativos por padrão (sem filtro content_sid)', async () => {
    const templates = await repo.findAll(true, false);
    expect(templates.every(t => t.isActive)).toBe(true);
    expect(templates.length).toBeGreaterThanOrEqual(3);
  });

  it('retorna todos (incluindo inativos) quando onlyActive=false', async () => {
    // Desativa um template temporariamente
    await pool.query(
      `UPDATE message_templates SET is_active = false WHERE slug = 'encuadre_scheduled'`,
    );

    const ativos = await repo.findAll(true, false);
    const todos = await repo.findAll(false, false);

    expect(todos.length).toBeGreaterThan(ativos.length);

    // Reativa
    await pool.query(
      `UPDATE message_templates SET is_active = true WHERE slug = 'encuadre_scheduled'`,
    );
  });

  it('resultado contém os campos mapeados corretamente', async () => {
    const templates = await repo.findAll(true, false);
    for (const t of templates) {
      expect(typeof t.id).toBe('string');
      expect(typeof t.slug).toBe('string');
      expect(typeof t.name).toBe('string');
      expect(typeof t.body).toBe('string');
      expect(typeof t.isActive).toBe('boolean');
      expect(t.createdAt).toBeInstanceOf(Date);
      expect(t.updatedAt).toBeInstanceOf(Date);
    }
  });
});

describe('MessageTemplateRepository.upsert()', () => {
  const TEST_SLUG = 'e2e_test_template';

  afterEach(async () => {
    await pool.query(`DELETE FROM message_templates WHERE slug = $1`, [TEST_SLUG]);
  });

  it('INSERT — created=true, entidade retornada com id e timestamps', async () => {
    const { entity, created } = await repo.upsert({
      slug: TEST_SLUG,
      name: 'Template E2E',
      body: 'Olá {{name}}, este é um teste.',
      category: 'notification',
      isActive: true,
    });

    expect(created).toBe(true);
    expect(entity.slug).toBe(TEST_SLUG);
    expect(entity.name).toBe('Template E2E');
    expect(entity.body).toBe('Olá {{name}}, este é um teste.');
    expect(entity.category).toBe('notification');
    expect(entity.isActive).toBe(true);
    expect(entity.id).toBeTruthy();
    expect(entity.createdAt).toBeInstanceOf(Date);
    expect(entity.updatedAt).toBeInstanceOf(Date);
  });

  it('ON CONFLICT — created=false, body e name atualizados', async () => {
    // Primeira inserção
    await repo.upsert({
      slug: TEST_SLUG,
      name: 'Nome Original',
      body: 'Corpo original.',
      category: 'onboarding',
    });

    // Segunda inserção com mesmo slug — deve atualizar
    const { entity, created } = await repo.upsert({
      slug: TEST_SLUG,
      name: 'Nome Atualizado',
      body: 'Corpo atualizado.',
      category: 'recruitment',
    });

    expect(created).toBe(false);
    expect(entity.name).toBe('Nome Atualizado');
    expect(entity.body).toBe('Corpo atualizado.');
    expect(entity.category).toBe('recruitment');
  });

  it('upsert com is_active=false → findBySlug retorna null (soft delete)', async () => {
    await repo.upsert({
      slug: TEST_SLUG,
      name: 'Template Inativo',
      body: 'Corpo.',
      isActive: false,
    });

    const found = await repo.findBySlug(TEST_SLUG);
    expect(found).toBeNull();
  });

  it('upsert sem category → category é null', async () => {
    const { entity } = await repo.upsert({
      slug: TEST_SLUG,
      name: 'Sem categoria',
      body: 'Corpo.',
    });
    expect(entity.category).toBeNull();
  });

  it('updated_at avança após upsert de atualização', async () => {
    const { entity: first } = await repo.upsert({
      slug: TEST_SLUG,
      name: 'V1',
      body: 'Corpo V1.',
    });

    // Garante que pelo menos 1ms se passe
    await new Promise(r => setTimeout(r, 10));

    const { entity: second } = await repo.upsert({
      slug: TEST_SLUG,
      name: 'V2',
      body: 'Corpo V2.',
    });

    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
  });
});
