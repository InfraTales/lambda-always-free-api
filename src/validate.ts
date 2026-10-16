/**
 * Input rules for a bookmark. The limits keep a typical item under 1 KB, which is one
 * DynamoDB write unit, and the largest possible item under 4 KB.
 */

export const LIMITS = {
  /** Bytes. Anything bigger is refused before we parse it. */
  body: 4096,
  url: 2048,
  title: 200,
  tags: 5,
  tag: 30,
} as const;

export interface BookmarkInput {
  url: string;
  title: string;
  tags: string[];
}

export class ValidationError extends Error {}

const TAG = /^[a-z0-9][a-z0-9-]*$/;

export function parseBookmark(body: unknown): BookmarkInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('body must be a JSON object');
  }
  const { url, title, tags, ...rest } = body as Record<string, unknown>;
  const unknownFields = Object.keys(rest);
  if (unknownFields.length > 0) throw new ValidationError(`unknown field: ${unknownFields[0]}`);

  if (typeof url !== 'string' || url.length === 0 || url.length > LIMITS.url) {
    throw new ValidationError(`url must be a string of 1 to ${LIMITS.url} characters`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError('url is not a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ValidationError('url must start with http:// or https://');
  }

  const cleanTitle = title === undefined ? '' : title;
  if (typeof cleanTitle !== 'string' || cleanTitle.length > LIMITS.title) {
    throw new ValidationError(`title must be a string of up to ${LIMITS.title} characters`);
  }

  const cleanTags = tags === undefined ? [] : tags;
  if (!Array.isArray(cleanTags) || cleanTags.length > LIMITS.tags) {
    throw new ValidationError(`tags must be a list of up to ${LIMITS.tags} items`);
  }
  for (const tag of cleanTags) {
    if (typeof tag !== 'string' || tag.length > LIMITS.tag || !TAG.test(tag)) {
      throw new ValidationError(`each tag must be lowercase letters, digits or dashes, up to ${LIMITS.tag} characters`);
    }
  }

  return { url, title: cleanTitle.trim(), tags: [...new Set(cleanTags as string[])] };
}

/** Bookmark IDs are 9 base-36 time characters plus 16 hex characters. */
export const ID_PATTERN = /^[0-9a-z]{9}[0-9a-f]{16}$/;

/** Parses an `If-Match` value like `"3"` or `3`. */
export function parseVersion(header: string | undefined): number | undefined {
  if (header === undefined) return undefined;
  const match = /^\s*(?:W\/)?"?(\d{1,9})"?\s*$/.exec(header);
  if (!match) throw new ValidationError('If-Match must be the version number from the ETag header');
  return Number(match[1]);
}
