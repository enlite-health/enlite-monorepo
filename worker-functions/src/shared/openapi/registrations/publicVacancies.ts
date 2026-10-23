import { registry, z } from '../registry';
import { ErrorResponseSchema, UuidParam } from '../schemas/common';

// Spec 067 FR-14/17: lista de PERMISSÃO da resposta (PublicVacancyController). `can_apply` substitui o link da Talentum,
// que NÃO sai mais desta rota pública. Os campos clínicos do paciente nunca entram (só `diagnosisLabel`, título CID-11).
export const PublicVacancyDetailSchema = registry.register(
  'PublicVacancyDetail',
  z
    .object({
      success: z.literal(true),
      data: z.object({
        id: z.string().uuid(),
        case_number: z.number().nullable(),
        vacancy_number: z.number().nullable(),
        title: z.string().nullable(),
        status: z.string(),
        is_disabled: z.boolean(),
        service_type: z.string().nullable(),
        required_professions: z.array(z.string()).nullable(),
        required_sex: z.string().nullable(),
        age_range_min: z.number().nullable(),
        age_range_max: z.number().nullable(),
        worker_attributes: z.string().nullable(),
        schedule: z.unknown(),
        schedule_days_hours: z.string().nullable(),
        salary_text: z.string().nullable(),
        talentum_description: z.string().nullable(),
        can_apply: z.boolean().openapi({
          description: 'A vaga aceita postulação (tem pré-screening da Talentum). O link NÃO sai desta rota: vem só no 200 de track-channel.',
        }),
        patient_zone: z.string().nullable(),
        country: z.string().nullable(),
        created_at: z.string().nullable(),
        diagnosisLabel: z.string().nullable(),
      }),
    })
    .openapi({ description: 'Detalhe público da vaga.' }),
);

registry.registerPath({
  method: 'get',
  path: '/api/vacancies/{id}',
  tags: ['Public · Vacancies'],
  summary: 'Detalhe de vaga por link público',
  description:
    'Retorna dados públicos de uma vaga acessíveis via link de divulgação. ' +
    'Não exige autenticação. Não expõe dados de PII do paciente.',
  security: [],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Dados públicos da vaga.', content: { 'application/json': { schema: PublicVacancyDetailSchema } } },
    404: { description: 'Vaga não encontrada.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
