import { ID_PATTERN, ValidationError, parseBookmark, parseVersion } from '../../src/validate';
import { newId } from '../../src/store';

describe('parseBookmark', () => {
  test('accepts a URL with an optional title and tags, and drops duplicate tags', () => {
    expect(parseBookmark({ url: 'https://aws.amazon.com/lambda/', title: '  Lambda  ', tags: ['aws', 'aws', 'lambda'] })).toEqual({
      url: 'https://aws.amazon.com/lambda/',
      title: 'Lambda',
      tags: ['aws', 'lambda'],
    });
    expect(parseBookmark({ url: 'http://example.com' })).toEqual({ url: 'http://example.com', title: '', tags: [] });
  });

  test.each([
    ['not an object', 'x'],
    ['an array', []],
    ['no url', { title: 'x' }],
    ['a relative url', { url: '/lambda' }],
    ['a javascript: url', { url: 'javascript:alert(1)' }],
    ['a file: url', { url: 'file:///etc/passwd' }],
    ['a url over 2048 characters', { url: `https://example.com/${'a'.repeat(2048)}` }],
    ['a title over 200 characters', { url: 'https://example.com', title: 'a'.repeat(201) }],
    ['six tags', { url: 'https://example.com', tags: ['a', 'b', 'c', 'd', 'e', 'f'] }],
    ['an uppercase tag', { url: 'https://example.com', tags: ['AWS'] }],
    ['a tag over 30 characters', { url: 'https://example.com', tags: ['a'.repeat(31)] }],
    ['an unknown field', { url: 'https://example.com', owner: 'someone-else' }],
  ])('refuses %s', (_name, body) => {
    expect(() => parseBookmark(body)).toThrow(ValidationError);
  });
});

describe('parseVersion', () => {
  test('reads quoted, bare and weak ETags', () => {
    expect(parseVersion('"3"')).toBe(3);
    expect(parseVersion('3')).toBe(3);
    expect(parseVersion('W/"12"')).toBe(12);
    expect(parseVersion(undefined)).toBeUndefined();
  });

  test('refuses anything else', () => {
    expect(() => parseVersion('"abc"')).toThrow(ValidationError);
    expect(() => parseVersion('*')).toThrow(ValidationError);
  });
});

describe('ids', () => {
  test('match the id pattern and sort by creation time', () => {
    const a = newId(Date.UTC(2026, 9, 15));
    const b = newId(Date.UTC(2026, 9, 16));
    expect(a).toMatch(ID_PATTERN);
    expect(b).toMatch(ID_PATTERN);
    expect([b, a].sort()).toEqual([a, b]);
  });

  test('two ids in the same millisecond still differ', () => {
    const now = Date.now();
    expect(newId(now)).not.toBe(newId(now));
  });
});
