import { parseEnvList } from '../envList';

describe('parseEnvList', () => {
  it.each([
    ['a,b,c', ['a', 'b', 'c']],
    ['a;b;c', ['a', 'b', 'c']],
    ['a b  c', ['a', 'b', 'c']],
    ['a, b ;c', ['a', 'b', 'c']],
    [' api.twilio.com;*.twilio.com;chatwoot.enlite.health ', ['api.twilio.com', '*.twilio.com', 'chatwoot.enlite.health']],
    ['triage-service;claude-code', ['triage-service', 'claude-code']],
    ['solo', ['solo']],
    ['', []],
    [undefined, []],
    [',;, ', []],
  ])('%p → %p', (raw, expected) => {
    expect(parseEnvList(raw)).toEqual(expected);
  });
});
