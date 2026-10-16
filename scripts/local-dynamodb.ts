/**
 * Helpers for DynamoDB Local. The app never knows it's talking to it: the standard
 * AWS_ENDPOINT_URL_DYNAMODB variable points the SDK there.
 */
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';

export const LOCAL_ENDPOINT = process.env.AWS_ENDPOINT_URL_DYNAMODB ?? 'http://localhost:8012';

/** Settings a child process (or this one) needs to reach DynamoDB Local. */
export const localEnv = {
  AWS_ENDPOINT_URL_DYNAMODB: LOCAL_ENDPOINT,
  AWS_REGION: 'us-east-1',
  // DynamoDB Local accepts any credentials. These are AWS's documented placeholders.
  AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

export function localClient(): DynamoDBClient {
  return new DynamoDBClient({
    endpoint: LOCAL_ENDPOINT,
    region: localEnv.AWS_REGION,
    credentials: { accessKeyId: localEnv.AWS_ACCESS_KEY_ID, secretAccessKey: localEnv.AWS_SECRET_ACCESS_KEY },
  });
}

/** Same key schema and capacity as the stack's table. */
export async function createTable(client: DynamoDBClient, name: string): Promise<void> {
  await client.send(
    new CreateTableCommand({
      TableName: name,
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
    }),
  );
}

export async function dropTable(client: DynamoDBClient, name: string): Promise<void> {
  await client.send(new DeleteTableCommand({ TableName: name })).catch(() => undefined);
}
