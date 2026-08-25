import { registry, z } from '../registry';

export const ErrorResponseSchema = registry.register(
  'ErrorResponse',
  z
    .object({
      success: z.literal(false).openapi({
        description: 'Sempre `false` em erros — discriminador do envelope.',
      }),
      error: z.string().openapi({
        description:
          'Mensagem curta legível por humano descrevendo a falha.',
        example: 'Invalid query params',
      }),
      code: z
        .string()
        .optional()
        .openapi({
          description:
            'Código ESTÁVEL da falha, quando o endpoint o publica. É o único discriminador dos três '
            + '409 do painel de acessos (`duplicate_name`, `system_group`, `last_manager`) — a frase '
            + 'de `error` é para humano e pode mudar; este não. Achado pelo gate `revisao-pr`: a tela '
            + 'dependia de um campo que o contrato não declarava.',
          example: 'last_manager',
        }),
      details: z
        .unknown()
        .optional()
        .openapi({
          description:
            'Detalhes adicionais — geralmente `fieldErrors` do Zod com `{ campo: [msg] }`.',
        }),
    })
    .openapi({
      description:
        'Envelope padrão de erro. Retornado em 4xx/5xx por toda a API.',
    }),
);

export function successResponseSchema<TName extends string, TItem extends z.ZodTypeAny>(
  name: TName,
  dataSchema: TItem,
  description?: string,
) {
  return registry.register(
    name,
    z
      .object({
        success: z.literal(true),
        data: dataSchema,
      })
      .openapi({
        description: description ?? `Resposta de sucesso contendo um(a) ${name}.`,
      }),
  );
}

export function paginatedResponseSchema<TName extends string, TItem extends z.ZodTypeAny>(
  name: TName,
  itemSchema: TItem,
  description?: string,
) {
  return registry.register(
    name,
    z
      .object({
        success: z.literal(true),
        data: z.array(itemSchema),
        total: z.number().int().nonnegative().openapi({
          description: 'Total de registros que casam com o filtro (sem paginação).',
          example: 1234,
        }),
      })
      .openapi({
        description:
          description ??
          `Resposta paginada de ${name}. Total reflete o universo filtrado, não a página.`,
      }),
  );
}

export const UuidParam = z.string().uuid().openapi({
  description: 'Identificador UUID v4.',
  example: '6f7c1d4a-9b2e-4c8a-9d5e-1f3b8a2c7e91',
});

export const PaginationQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .openapi({ description: 'Máximo de itens (default 20, teto 100).', example: 20 }),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .default(0)
    .openapi({ description: 'Quantos itens pular (zero-based).', example: 0 }),
});

export const OkMessage = registry.register(
  'OkMessage',
  z
    .object({
      success: z.literal(true),
      message: z.string().openapi({ example: 'ok' }),
    })
    .openapi({ description: 'Confirmação simples de operação.' }),
);
