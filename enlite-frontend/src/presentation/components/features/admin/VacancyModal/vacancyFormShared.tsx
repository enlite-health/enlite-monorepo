/**
 * vacancyFormShared
 *
 * Shared CSS class strings used by VacancyFormLeftColumn and
 * VacancyFormRightColumn for elements that have no design-system equivalent:
 * textareas and read-only display cells.
 *
 * Everything else (inputs, selects, field groups/labels) is handled by
 * the design system: InputWithIcon, SelectField, FormField.
 */

// Textarea — no design system equivalent; matches InputWithIcon visual style
export const TEXTAREA_CLS =
  'w-full px-4 py-3 text-base font-medium text-gray-800 border-[1.5px] border-[#D9D9D9] rounded-[10px] focus:outline-none focus:border-primary transition-colors bg-white resize-none placeholder:text-gray-600';

// Read-only "—" display — matches InputWithIcon's min-h-[56px], same border.
// Background uses the same gray as the atom's disabled state (#f3f4f6) to signal
// "cannot edit" consistently across the form. Text is darker (gray-800) to keep
// readability on the gray background.
export const READONLY_CLS =
  'min-h-[56px] w-full px-4 py-3 text-base font-medium text-gray-800 border-[1.5px] border-[#D9D9D9] rounded-[10px] bg-[#f3f4f6] cursor-default flex items-center';

// Select used in custom-loading-state cases (case-select wrapper)
export const SELECT_CLS =
  'w-full font-lexend font-medium text-[#374151] text-sm leading-[150%] bg-transparent outline-none appearance-none pr-8 cursor-pointer';
