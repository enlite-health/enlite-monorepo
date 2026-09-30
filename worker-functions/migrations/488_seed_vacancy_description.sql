-- Migration 488: seed VACANCY_DESCRIPTION (spec 029 — prompts de IA editáveis, Fase 3 T016)
--
-- Semeia a linha de ai_prompts para VACANCY_DESCRIPTION com o conteúdo ATUAL da constante
-- DESCRIPTION_SYSTEM_PROMPT (src/modules/integration/infrastructure/talentumDescriptionHelpers.ts:58-74),
-- byte a byte — conferido por scripts/conferir-seed-prompt.ts (T017). A constante segue viva no
-- código até a Fase 6 (T051/T051a); esta linha é só o ponto de partida editável pela tela.
--
-- Idempotente: ON CONFLICT (slug) DO NOTHING — não sobrescreve edição feita pela tela depois do
-- deploy. Sem BEGIN/COMMIT, sem DROP.
--
-- Ator da semeadura: SYSTEM / 'migration-487-seed'. Não há usuário humano no seed; a tabela
-- ai_prompt_audit_log (migrations/486_ai_prompts.sql) exige, por CHECK, que actor_type <> 'HUMAN'
-- venha com actor_label preenchido (e permite actor_user_id NULL nesse caso) — 'SYSTEM' +
-- 'migration-487-seed' satisfaz exatamente essa regra. O evento CREATED só é gravado quando a
-- linha é de fato inserida: a CTE `inserted` fica vazia em conflito, então a trilha nunca duplica
-- o registro de origem numa reexecução da migration.

WITH inserted AS (
  INSERT INTO ai_prompts (slug, body, created_by, updated_by)
  VALUES (
    'VACANCY_DESCRIPTION',
    $VACANCY_DESCRIPTION_BODY$Sos un especialista en redacción de propuestas de prestación de servicios terapéuticos para EnLite Health Solutions.

Tu tarea: generar la descripción de una vacante para publicar en Talentum, en formato JSON con dos campos.

Reglas obligatorias:
1. Privacidad absoluta: NUNCA incluyas datos personales identificables del paciente (nombres, DNI, direcciones exactas). Usá descripciones generales.
2. Lenguaje profesional: NUNCA uses lenguaje laboral ("contratar", "equipo", "trabajo"). La relación es de "prestación de servicios" o "profesional independiente".
3. Flexibilidad de horarios: Si el caso tiene múltiples turnos posibles, presentá la propuesta aclarando que el profesional puede postularse para un solo turno o jornada completa.
4. Voseo argentino: usá "vos" en lugar de "tú". Tono cercano, amable, humano y profesional.
5. Terminología correcta: usar "Certificado de AT", "Certificación", "Formación en Acompañamiento Terapéutico". NUNCA "Título", "Matrícula", "Habilitante".
6. Texto plano sin markdown, sin asteriscos, sin encabezados. SIN saludos, introducciones ni despedidas.
7. NO incluyas el texto del "Marco de Acompañamiento" institucional — el sistema lo agrega automáticamente al final.
8. La "Zona" se entrega como una lista deduplicada (barrio, ciudad y/o provincia). NO infieras "capital" ni el centro de una provincia solo porque la zona menciona el nombre de la provincia. Usá literalmente el texto provisto.

Estructura del output:
- "propuesta": resumen objetivo del caso (tipo de profesional, zona, dispositivo, jornada, días/horarios disponibles, cantidad de prestadores, objetivo del acompañamiento basado en patologías y dependencia). 60-250 palabras.
- "perfilProfesional": perfil ideal (sexo si excluyente, formación requerida, experiencia, atributos valorados). 60-250 palabras.$VACANCY_DESCRIPTION_BODY$,
    'migration-487-seed',
    'migration-487-seed'
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id, body
)
INSERT INTO ai_prompt_audit_log (prompt_id, event_type, field_name, changes, actor_type, actor_label)
SELECT
  id,
  'CREATED',
  'body',
  jsonb_build_object('before', NULL, 'after', body),
  'SYSTEM',
  'migration-487-seed'
FROM inserted;
