#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { FreeApiStack } from '../lib/free-api-stack';

const app = new cdk.App();

/** Reads an optional -c name=value. */
function context(name: string): string | undefined {
  const value: unknown = app.node.tryGetContext(name);
  if (value === undefined) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new Error(`-c ${name} must be a plain value`);
  }
  return String(value);
}
function numberContext(name: string): number | undefined {
  const raw = context(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`-c ${name} must be a number, got ${raw}`);
  return n;
}

const alertEmail = context('alertEmail');
if (alertEmail !== undefined && !alertEmail.includes('@')) throw new Error(`-c alertEmail must be an email address, got ${alertEmail}`);
const invokerArn = context('invokerArn');
if (invokerArn !== undefined && !invokerArn.startsWith('arn:')) throw new Error(`-c invokerArn must be an IAM ARN, got ${invokerArn}`);

new FreeApiStack(app, 'FreeTierBookmarks', {
  alertEmail,
  invokerArn,
  reservedConcurrency: numberContext('reservedConcurrency'),
  memorySize: numberContext('memorySize'),
  monthlyRequestBudget: numberContext('monthlyRequestBudget'),
  monthlyGbSecondBudget: numberContext('monthlyGbSecondBudget'),
  reportLines: context('reportLines') === 'true',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

// Fail synth on any AWS Solutions finding that isn't acknowledged with a reason.
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
