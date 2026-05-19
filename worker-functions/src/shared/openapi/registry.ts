import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Must run before any `.openapi()` call on a Zod schema. Mutates the global
// zod prototype to add the `.openapi(metadata)` method.
extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

export { z };
