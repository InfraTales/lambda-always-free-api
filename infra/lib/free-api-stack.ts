import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { FREE_TIER } from '../../model/free-tier';

export const BUNDLE_DIR = path.join(__dirname, '..', '..', 'build', 'lambda');

/** The longest month. A day under 1/31 of the budget keeps every month under it. */
const DAYS_IN_LONGEST_MONTH = 31;

export interface FreeApiStackProps extends cdk.StackProps {
  /** Where the bundled handler lives. Tests point this elsewhere. */
  bundleDir?: string;
  /** Email for alarm notifications. Optional. */
  alertEmail?: string;
  /** IAM principal ARN allowed to call the function URL, besides account admins. Optional. */
  invokerArn?: string;
  /**
   * The most copies of the function that may run at once. This is the hard cap on how
   * much compute the function can bill: reservedConcurrency x memory x seconds in a month.
   */
  reservedConcurrency?: number;
  /** Megabytes. */
  memorySize?: number;
  /** Log Lambda's START and REPORT lines for every request. Off by default to keep logs near zero. */
  reportLines?: boolean;
  /**
   * The share of the account's free Lambda allowance this API may use. Other functions in
   * the account draw from the same 1M requests and 400,000 GB-seconds.
   */
  monthlyRequestBudget?: number;
  monthlyGbSecondBudget?: number;
  /** Alarm when a day's usage reaches this fraction of the daily share. */
  alarmAt?: number;
  /** Provisioned DynamoDB capacity. The account gets 25 of each free per Region, shared by all tables. */
  readCapacity?: number;
  writeCapacity?: number;
}

/** Daily thresholds for the pace alarms, worked out from the monthly budgets. */
export function dailyThresholds(p: { monthlyRequestBudget: number; monthlyGbSecondBudget: number; alarmAt: number }) {
  return {
    requests: Math.floor((p.monthlyRequestBudget * p.alarmAt) / DAYS_IN_LONGEST_MONTH),
    gbSeconds: Math.floor((p.monthlyGbSecondBudget * p.alarmAt) / DAYS_IN_LONGEST_MONTH),
  };
}

export class FreeApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FreeApiStackProps = {}) {
    super(scope, id, props);

    const bundleDir = props.bundleDir ?? BUNDLE_DIR;
    if (!fs.existsSync(path.join(bundleDir, 'index.js'))) {
      throw new Error(`${bundleDir}/index.js is missing. Run "npm run bundle" first.`);
    }

    const reservedConcurrency = props.reservedConcurrency ?? 2;
    const memorySize = props.memorySize ?? 256;
    const readCapacity = props.readCapacity ?? 5;
    const writeCapacity = props.writeCapacity ?? 5;
    if (!Number.isInteger(reservedConcurrency) || reservedConcurrency < 1) {
      throw new Error('reservedConcurrency must be a whole number of 1 or more');
    }
    for (const units of [readCapacity, writeCapacity]) {
      if (!Number.isInteger(units) || units < 1 || units > FREE_TIER.dynamoDbCapacityUnits) {
        throw new Error(`readCapacity and writeCapacity must be whole numbers from 1 to ${FREE_TIER.dynamoDbCapacityUnits}`);
      }
    }
    const thresholds = dailyThresholds({
      monthlyRequestBudget: props.monthlyRequestBudget ?? FREE_TIER.lambdaRequests,
      monthlyGbSecondBudget: props.monthlyGbSecondBudget ?? FREE_TIER.lambdaGbSeconds,
      alarmAt: props.alarmAt ?? 0.8,
    });

    // ---------- data ----------
    // Provisioned at a small fixed size. The always-free DynamoDB capacity applies to
    // provisioned tables only, so on-demand would bill every request.
    const table = new dynamodb.Table(this, 'Bookmarks', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity,
      writeCapacity,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    cdk.Validations.of(table).acknowledge({
      id: 'AwsSolutions::AwsSolutions-DDB3',
      reason:
        'Point-in-time recovery bills $0.20 per GB-month from the first byte (Price List API, us-east-1), which breaks the $0 goal. ' +
        'The table is retained on stack delete; turn PITR on when the data matters more than the cost.',
    });

    // ---------- function ----------
    const logGroup = new logs.LogGroup(this, 'Logs', {
      // Logs count against the 5 GB of free CloudWatch Logs data. A week is enough to debug.
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const role = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Runs the bookmarks API function',
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [logGroup.logGroupArn],
      }),
    );
    // Only the five calls the handler makes. No Scan, no batch writes.
    table.grant(role, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query');

    const fn = new lambda.Function(this, 'Api', {
      description: 'Bookmarks API behind a function URL',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(bundleDir),
      memorySize,
      // Bounds the worst single request. DynamoDB answers in milliseconds.
      timeout: cdk.Duration.seconds(5),
      reservedConcurrentExecutions: reservedConcurrency,
      role,
      logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      // WARN drops the START line and the REPORT line of every successful request, so a
      // good request writes no log bytes at all. Failed requests still log. Turn REPORT
      // lines on for a day (reportLines: true) when you want billed duration and max memory.
      systemLogLevelV2: props.reportLines ? lambda.SystemLogLevel.INFO : lambda.SystemLogLevel.WARN,
      environment: {
        BOOKMARKS_TABLE: table.tableName,
        NODE_OPTIONS: '--enable-source-maps',
      },
    });

    // Lambda checks the SigV4 signature before the function runs. Unsigned calls get 403.
    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM, invokeMode: lambda.InvokeMode.BUFFERED });
    if (props.invokerArn) fn.grantInvokeUrl(new iam.ArnPrincipal(props.invokerArn));

    // ---------- alarms ----------
    // Three alarm metrics, out of the 10 that CloudWatch gives free each month.
    const topic = new sns.Topic(this, 'Alerts', { displayName: 'Bookmarks API free-tier alerts', enforceSSL: true });
    if (props.alertEmail) topic.addSubscription(new subs.EmailSubscription(props.alertEmail));
    const notify = new cwActions.SnsAction(topic);

    const day = cdk.Duration.days(1);
    const requestsPace = new cloudwatch.Alarm(this, 'RequestsPace', {
      alarmDescription: `More than ${thresholds.requests} requests in a day. At that pace the month uses over ${(props.alarmAt ?? 0.8) * 100}% of the free request budget.`,
      metric: fn.metricInvocations({ statistic: 'Sum', period: day }),
      threshold: thresholds.requests,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Duration is in milliseconds, so the GB-second threshold becomes milliseconds per day.
    // The alarm lists the metric directly. A metric math alarm wouldn't count toward the
    // 10 free alarm metrics.
    const computePace = new cloudwatch.Alarm(this, 'ComputePace', {
      alarmDescription: `More than ${thresholds.gbSeconds} GB-seconds in a day at ${memorySize} MB. At that pace the month uses over ${(props.alarmAt ?? 0.8) * 100}% of the free compute budget.`,
      metric: fn.metricDuration({ statistic: 'Sum', period: day }),
      threshold: Math.floor((thresholds.gbSeconds / (memorySize / 1024)) * 1000),
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Callers are getting 429s because the reserved concurrency cap is full.
    const throttled = new cloudwatch.Alarm(this, 'Throttled', {
      alarmDescription: 'Lambda refused requests because all reserved concurrency was in use.',
      metric: fn.metricThrottles({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    for (const alarm of [requestsPace, computePace, throttled]) {
      alarm.addAlarmAction(notify);
      alarm.addOkAction(notify);
    }

    new cdk.CfnOutput(this, 'Url', { value: url.url });
    new cdk.CfnOutput(this, 'FunctionName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'AlertTopicArn', { value: topic.topicArn });
  }
}
