import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { FreeApiStack, type FreeApiStackProps, dailyThresholds } from '../../infra/lib/free-api-stack';

const env = { account: '123456789012', region: 'us-east-1' };
const synth = (props: FreeApiStackProps = {}) => Template.fromStack(new FreeApiStack(new cdk.App(), 'Test', { env, alertEmail: 'ops@example.com', ...props }));
const template = synth();
const only = (t: Template, type: string) => {
  const all = Object.values<any>(t.findResources(type));
  expect(all).toHaveLength(1);
  return all[0];
};
const alarm = (t: Template, logicalPrefix: string) => {
  const [entry] = Object.entries<any>(t.findResources('AWS::CloudWatch::Alarm')).filter(([id]) => id.startsWith(logicalPrefix));
  expect(entry).toBeDefined();
  return entry![1].Properties;
};

describe('the cost ceiling', () => {
  test('reserved concurrency caps the function at 2 copies by default', () => {
    expect(only(template, 'AWS::Lambda::Function').Properties.ReservedConcurrentExecutions).toBe(2);
  });

  test('reserved concurrency follows the prop and refuses nonsense', () => {
    expect(only(synth({ reservedConcurrency: 5 }), 'AWS::Lambda::Function').Properties.ReservedConcurrentExecutions).toBe(5);
    expect(() => synth({ reservedConcurrency: 0 })).toThrow(/reservedConcurrency/);
    expect(() => synth({ reservedConcurrency: 1.5 })).toThrow(/reservedConcurrency/);
  });

  test('a request can run for at most 5 seconds', () => {
    expect(only(template, 'AWS::Lambda::Function').Properties.Timeout).toBe(5);
  });

  test('the function is Node.js 24 on arm64 with 256 MB', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      MemorySize: 256,
      Handler: 'index.handler',
    });
  });

  test('no provisioned concurrency, which has no free tier', () => {
    expect(template.findResources('AWS::Lambda::Version')).toEqual({});
    expect(template.findResources('AWS::Lambda::Alias')).toEqual({});
    expect(JSON.stringify(template.toJSON())).not.toContain('ProvisionedConcurrency');
  });
});

describe('the front door', () => {
  test('the function URL needs a SigV4 signature', () => {
    template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM', InvokeMode: 'BUFFERED' });
  });

  test('nobody outside the account is granted access unless you name them', () => {
    expect(template.findResources('AWS::Lambda::Permission')).toEqual({});
  });

  test('a named invoker gets both permissions a function URL needs, limited to the URL', () => {
    const t = synth({ invokerArn: 'arn:aws:iam::123456789012:role/BookmarksClient' });
    const perms = Object.values<any>(t.findResources('AWS::Lambda::Permission')).map((p) => p.Properties);
    expect(perms).toHaveLength(2);
    expect(perms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Action: 'lambda:InvokeFunctionUrl', FunctionUrlAuthType: 'AWS_IAM', Principal: 'arn:aws:iam::123456789012:role/BookmarksClient' }),
        expect.objectContaining({ Action: 'lambda:InvokeFunction', InvokedViaFunctionUrl: true, Principal: 'arn:aws:iam::123456789012:role/BookmarksClient' }),
      ]),
    );
  });
});

describe('free-tier alarms', () => {
  test('the daily thresholds are 80% of 1/31 of the monthly free tier', () => {
    expect(dailyThresholds({ monthlyRequestBudget: 1_000_000, monthlyGbSecondBudget: 400_000, alarmAt: 0.8 })).toEqual({ requests: 25_806, gbSeconds: 10_322 });
  });

  test('requests: alarm when a day passes 25,806 invocations', () => {
    expect(alarm(template, 'RequestsPace')).toMatchObject({
      MetricName: 'Invocations',
      Namespace: 'AWS/Lambda',
      Statistic: 'Sum',
      Period: 86400,
      EvaluationPeriods: 1,
      Threshold: 25_806,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  test('compute: alarm when a day passes 10,322 GB-seconds (41,288,000 ms at 256 MB)', () => {
    expect(alarm(template, 'ComputePace')).toMatchObject({
      MetricName: 'Duration',
      Statistic: 'Sum',
      Period: 86400,
      Threshold: 41_288_000,
    });
  });

  test('the compute threshold scales with memory', () => {
    expect(alarm(synth({ memorySize: 512 }), 'ComputePace').Threshold).toBe(20_644_000);
  });

  test('a smaller budget share lowers the thresholds', () => {
    const t = synth({ monthlyRequestBudget: 500_000 });
    expect(alarm(t, 'RequestsPace').Threshold).toBe(12_903);
  });

  test('throttling alarms within 5 minutes', () => {
    expect(alarm(template, 'Throttled')).toMatchObject({ MetricName: 'Throttles', Period: 300, Threshold: 0, ComparisonOperator: 'GreaterThanThreshold' });
  });

  test('every alarm lists one metric directly, so all three stay in the 10 free alarm metrics', () => {
    const alarms = Object.values<any>(template.findResources('AWS::CloudWatch::Alarm')).map((a) => a.Properties);
    expect(alarms).toHaveLength(3);
    for (const a of alarms) {
      expect(a.Metrics).toBeUndefined();
      expect(a.MetricName).toEqual(expect.any(String));
    }
  });

  test('every alarm notifies the topic when it fires and when it clears', () => {
    const topic = { Ref: Object.keys(template.findResources('AWS::SNS::Topic'))[0] };
    for (const a of Object.values<any>(template.findResources('AWS::CloudWatch::Alarm'))) {
      expect(a.Properties.AlarmActions).toEqual([topic]);
      expect(a.Properties.OKActions).toEqual([topic]);
    }
    template.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.com' });
  });
});

describe('data and logs', () => {
  test('the table is provisioned at 5 read and 5 write units, with no auto scaling', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: Match.absent(),
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    });
    expect(template.findResources('AWS::ApplicationAutoScaling::ScalableTarget')).toEqual({});
  });

  test('capacity must fit in the 25 free units', () => {
    expect(() => synth({ writeCapacity: 26 })).toThrow(/1 to 25/);
  });

  test('the table survives a stack delete', () => {
    template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
  });

  test('logs are JSON, kept a week, and successful requests write no platform lines', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
    template.hasResourceProperties('AWS::Lambda::Function', {
      LoggingConfig: { LogFormat: 'JSON', ApplicationLogLevel: 'INFO', SystemLogLevel: 'WARN', LogGroup: Match.anyValue() },
    });
    expect(only(synth({ reportLines: true }), 'AWS::Lambda::Function').Properties.LoggingConfig.SystemLogLevel).toBe('INFO');
  });

  test('the function role can make the five calls the handler uses, on this table only', () => {
    const policy = only(template, 'AWS::IAM::Policy').Properties.PolicyDocument.Statement;
    const ddb = policy.find((s: any) => [s.Action].flat().some((a: string) => a.startsWith('dynamodb:')));
    expect([ddb.Action].flat().sort()).toEqual(['dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem']);
    expect(JSON.stringify(ddb.Resource)).toMatch(/Bookmarks/);
    const logs = policy.find((s: any) => [s.Action].flat().includes('logs:PutLogEvents'));
    expect(JSON.stringify(logs.Resource)).toMatch(/Logs/);
    expect(policy).toHaveLength(2);
  });
});

test('cdk-nag AWS Solutions finds nothing unacknowledged', () => {
  const app = new cdk.App({ outdir: fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-nag-')) });
  new FreeApiStack(app, 'Nag', { env });
  cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  const assembly = app.synth();
  const report = JSON.parse(fs.readFileSync(path.join(assembly.directory, 'validation-report.json'), 'utf8'));
  for (const plugin of report.pluginReports) expect(plugin.violations).toEqual([]);
});

test('synth stops with a clear message when the bundle is missing', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-bundle-'));
  expect(() => new FreeApiStack(new cdk.App(), 'NoBundle', { env, bundleDir: empty })).toThrow(/npm run bundle/);
});
