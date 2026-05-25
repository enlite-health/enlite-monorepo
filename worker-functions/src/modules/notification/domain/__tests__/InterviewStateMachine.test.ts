import { canTransition, InterviewResponse } from '../InterviewStateMachine';

describe('InterviewStateMachine', () => {
  describe('canTransition', () => {
    it('allows pending → confirmed', () => {
      expect(canTransition('pending', 'confirmed')).toBe(true);
    });

    it('allows pending → declined', () => {
      expect(canTransition('pending', 'declined')).toBe(true);
    });

    it('allows confirmed → declined (worker pode cancelar)', () => {
      expect(canTransition('confirmed', 'declined')).toBe(true);
    });

    it('blocks declined → any (estado final)', () => {
      expect(canTransition('declined', 'pending')).toBe(false);
      expect(canTransition('declined', 'confirmed')).toBe(false);
      expect(canTransition('declined', 'declined')).toBe(false);
    });

    it('allows confirmed → confirmed (re-confirmacao via reminder)', () => {
      expect(canTransition('confirmed', 'confirmed')).toBe(true);
    });

    it('allows confirmed → awaiting_reschedule (reminder: No)', () => {
      expect(canTransition('confirmed', 'awaiting_reschedule')).toBe(true);
    });

    it('allows awaiting_reschedule → awaiting_reschedule (self-loop idempotente F7.b)', () => {
      expect(canTransition('awaiting_reschedule', 'awaiting_reschedule')).toBe(true);
    });

    it('allows awaiting_reschedule → declined (não quer reagendar)', () => {
      expect(canTransition('awaiting_reschedule', 'declined')).toBe(true);
    });

    it('allows awaiting_reason → declined (motivo capturado)', () => {
      expect(canTransition('awaiting_reason', 'declined')).toBe(true);
    });

    it('blocks confirmed → pending directly (REPROGRAM removido em F7.b)', () => {
      expect(canTransition('confirmed', 'pending')).toBe(false);
    });

    it('blocks awaiting_reschedule → pending (REPROGRAM removido em F7.b)', () => {
      expect(canTransition('awaiting_reschedule', 'pending')).toBe(false);
    });

    it('blocks awaiting_reschedule → confirmed', () => {
      expect(canTransition('awaiting_reschedule', 'confirmed')).toBe(false);
    });

    it('blocks awaiting_reason → confirmed', () => {
      expect(canTransition('awaiting_reason', 'confirmed')).toBe(false);
    });

    it('blocks awaiting_reason → pending', () => {
      expect(canTransition('awaiting_reason', 'pending')).toBe(false);
    });

    it('blocks no_response → any (estado final)', () => {
      expect(canTransition('no_response', 'pending')).toBe(false);
      expect(canTransition('no_response', 'confirmed')).toBe(false);
      expect(canTransition('no_response', 'declined')).toBe(false);
    });

    it('returns false for unknown states', () => {
      expect(canTransition('unknown', 'confirmed')).toBe(false);
      expect(canTransition('pending', 'unknown')).toBe(false);
    });
  });
});
