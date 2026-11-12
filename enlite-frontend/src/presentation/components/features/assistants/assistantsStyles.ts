/** Shared look of the assistants widget bubbles (Maria tab and "Luz (prueba)" tab). */

// Assistant bubble: inherits the 12.5px / #262626 of the bubble, tight gap between blocks and items.
export const ASSISTANT_MARKDOWN_CLASS = "break-words [&>*+*]:mt-2 [&_li+li]:mt-1";

export function bubbleClass(fromPerson: boolean): string {
  return `max-w-[86%] break-words rounded-[14px] px-[11px] py-[9px] ${
    fromPerson
      ? "justify-self-end whitespace-pre-wrap rounded-br-[4px] bg-primary text-white"
      : "justify-self-start rounded-bl-[4px] bg-gray-200 text-[#262626]"
  }`;
}
