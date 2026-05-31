/**
 * Per-environment configuration for the KenNook CDK app.
 *
 * Account IDs are hard-coded from the IAM Identity Center / Organizations
 * setup (see project_kennook_aws_infra memory). Primary region is us-west-2
 * — Identity Center lives there and most resources will follow. CloudFront
 * ACM certificates MUST be in us-east-1, handled per-stack via `env`.
 */

export type EnvName = 'dev' | 'prod';

export interface KennookEnv {
  /** Short label used in stack IDs and tags. */
  name: EnvName;
  /** Suffix appended to stack IDs, e.g. `-Dev`, `-Prod`. */
  stackSuffix: 'Dev' | 'Prod';
  /** AWS account ID. */
  account: string;
  /** Primary region for the env's stacks. */
  region: 'us-west-2';
  /** Apex name of the Route 53 hosted zone for this env (the zone itself
   *  lives in the SAME account as the stack — see zone-migration.md). */
  hostedZoneName: string;
  /** Domain(s) the marketing site serves under. The first entry is the
   *  primary; the rest become subjectAlternativeNames on the ACM cert and
   *  additional CloudFront aliases. */
  marketingDomains: string[];
  /** Whether stateful resources should be locked down (RETAIN policies,
   *  deletion protection). True only in prod. */
  hardenStateful: boolean;
}

export const PRIMARY_REGION = 'us-west-2' as const;
/** Mandatory region for CloudFront ACM certificates. */
export const ACM_CERT_REGION = 'us-east-1' as const;

export const ENVS: Record<EnvName, KennookEnv> = {
  dev: {
    name: 'dev',
    stackSuffix: 'Dev',
    account: '719146259408',
    region: PRIMARY_REGION,
    hostedZoneName: 'kennook.dev',
    marketingDomains: ['kennook.dev', 'www.kennook.dev'],
    hardenStateful: false,
  },
  prod: {
    name: 'prod',
    stackSuffix: 'Prod',
    account: '045064752951',
    region: PRIMARY_REGION,
    hostedZoneName: 'kennook.com',
    marketingDomains: ['kennook.com', 'www.kennook.com'],
    hardenStateful: true,
  },
};
