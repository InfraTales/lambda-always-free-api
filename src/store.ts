/**
 * The bookmarks table. Every write is conditional, so a retry, a race or a stale client
 * can never overwrite or resurrect data by accident.
 *
 * Key design: pk = the caller's IAM ARN, sk = bookmark ID. One caller's bookmarks share
 * a partition, so listing them is one Query, newest first.
 */
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomBytes } from 'node:crypto';
import type { BookmarkInput } from './validate';

export interface Bookmark extends BookmarkInput {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface Item extends Bookmark {
  pk: string;
  sk: string;
}

export class NotFound extends Error {}
export class VersionConflict extends Error {
  constructor(readonly current: number) {
    super(`current version is ${current}`);
  }
}
export class IdCollision extends Error {}

/** Time first (base 36, sorts by creation), then 64 random bits. */
export function newId(now = Date.now()): string {
  return now.toString(36).padStart(9, '0') + randomBytes(8).toString('hex');
}

function toBookmark(item: object): Bookmark {
  const { id, url, title, tags, version, createdAt, updatedAt } = item as unknown as Item;
  return { id, url, title, tags, version, createdAt, updatedAt };
}

export interface Page {
  items: Bookmark[];
  /** The last key DynamoDB read, or undefined on the last page. */
  lastId?: string;
}

export class BookmarkStore {
  private readonly db: DynamoDBDocumentClient;

  constructor(
    private readonly table: string,
    client: DynamoDBClient = new DynamoDBClient({}),
    private readonly makeId: () => string = () => newId(),
  ) {
    this.db = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async create(owner: string, input: BookmarkInput, now = new Date().toISOString()): Promise<Bookmark> {
    const id = this.makeId();
    const item: Item = { pk: owner, sk: id, id, ...input, version: 1, createdAt: now, updatedAt: now };
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.table,
          Item: item,
          // Never overwrite. With 64 random bits a clash is very unlikely, but if it
          // happens the caller gets an error, not someone else's bookmark replaced.
          ConditionExpression: 'attribute_not_exists(sk)',
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) throw new IdCollision(id);
      throw err;
    }
    return toBookmark(item);
  }

  async get(owner: string, id: string): Promise<Bookmark> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: owner, sk: id } }));
    if (!res.Item) throw new NotFound(id);
    return toBookmark(res.Item);
  }

  async list(owner: string, limit: number, afterId?: string): Promise<Page> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'pk = :owner',
        ExpressionAttributeValues: { ':owner': owner },
        // The owner is always the caller, so a cursor can only move within their own items.
        ExclusiveStartKey: afterId ? { pk: owner, sk: afterId } : undefined,
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    const last = res.LastEvaluatedKey?.sk as string | undefined;
    return { items: (res.Items ?? []).map(toBookmark), lastId: last };
  }

  /** Replaces the fields only if the stored version still matches `expected`. */
  async update(owner: string, id: string, expected: number, input: BookmarkInput, now = new Date().toISOString()): Promise<Bookmark> {
    try {
      const res = await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: owner, sk: id },
          UpdateExpression: 'SET #url = :url, #title = :title, #tags = :tags, #updatedAt = :now, #version = #version + :one',
          ConditionExpression: '#version = :expected',
          ExpressionAttributeNames: { '#url': 'url', '#title': 'title', '#tags': 'tags', '#updatedAt': 'updatedAt', '#version': 'version' },
          ExpressionAttributeValues: { ':url': input.url, ':title': input.title, ':tags': input.tags, ':now': now, ':one': 1, ':expected': expected },
          // On a failed condition DynamoDB sends back the item as it is, so we can tell
          // "gone" from "someone else changed it" without a second read.
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
          ReturnValues: 'ALL_NEW',
        }),
      );
      return toBookmark(res.Attributes!);
    } catch (err) {
      throw this.explain(err, id);
    }
  }

  /** Deletes only if the item exists and, when given, still has version `expected`. */
  async delete(owner: string, id: string, expected?: number): Promise<void> {
    try {
      await this.db.send(
        new DeleteCommand({
          TableName: this.table,
          Key: { pk: owner, sk: id },
          ConditionExpression: expected === undefined ? 'attribute_exists(sk)' : '#version = :expected',
          ExpressionAttributeNames: expected === undefined ? undefined : { '#version': 'version' },
          ExpressionAttributeValues: expected === undefined ? undefined : { ':expected': expected },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
    } catch (err) {
      throw this.explain(err, id);
    }
  }

  private explain(err: unknown, id: string): unknown {
    if (!(err instanceof ConditionalCheckFailedException)) return err;
    // lib-dynamodb leaves the returned item in raw attribute-value form.
    const raw = err.Item?.version?.N;
    return raw === undefined ? new NotFound(id) : new VersionConflict(Number(raw));
  }
}
