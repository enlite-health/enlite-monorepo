import {
  ASSISTANT_CHAT_CELLS,
  KNOWLEDGE_CELLS,
} from '@modules/identity/permissions';

/** Port: the cells the actor has (same resolution as `GetMyAuthzUseCase`). A failure rejects. */
export type ResolveActorCells = (uid: string) => Promise<readonly string[]>;

export interface AssistantReach {
  assistants: string[];
  knowledge: string[];
}

/** `assistant_<slug>:chat` -> `<slug>`; `knowledge_<compartment>:read` -> `<compartment>`. Name parsing only. */
function resourceWithoutPrefix(cell: string, prefix: string): string {
  const resource = cell.split(':')[0];
  return resource.startsWith(prefix) ? resource.slice(prefix.length) : resource;
}
const slugOf = (cell: string): string => resourceWithoutPrefix(cell, 'assistant_');
/** The compartment travels as an enum value (SCREAMING_SNAKE_CASE); lowercase lives only inside the cell name. */
export const compartmentOf = (cell: string): string => resourceWithoutPrefix(cell, 'knowledge_').toUpperCase();

/**
 * What the PERSON reaches: the catalog constants ∩ her cells, in the order of the constants.
 * A failure to resolve the cells propagates (the handler answers 500) — never an empty list.
 */
export class AssistantReachUseCase {
  constructor(private readonly resolveCells: ResolveActorCells) {}

  async execute(uid: string): Promise<AssistantReach> {
    const cells = await this.resolveCells(uid);
    const assistants: string[] = [];
    const knowledge: string[] = [];
    for (const cell of ASSISTANT_CHAT_CELLS) if (cells.includes(cell)) assistants.push(slugOf(cell));
    for (const knowledgeCell of KNOWLEDGE_CELLS) if (cells.includes(knowledgeCell)) knowledge.push(compartmentOf(knowledgeCell));
    return { assistants, knowledge };
  }
}
