import * as path from 'node:path';
import { Stack, type StackProps } from 'aws-cdk-lib';
import {
  aws_certificatemanager as acm,
  aws_route53 as route53,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { OpenNextSite } from './constructs/opennext-site.js';
import type { KennookEnv } from './env.js';

/**
 * Marketing site stack — `kennook.com`.
 *
 * Composes the OpenNextSite construct against the env's domains/cert. Dev
 * runs with no custom domain (CloudFront default URL); prod gets the
 * cross-region ACM cert from MarketingCertStack and creates Route 53 alias
 * records in the migrated kennook.com hosted zone.
 *
 * Build prerequisite: `pnpm --filter @kennook/marketing build:all` must have
 * run before `cdk deploy` — the stack reads `.open-next/` for Lambda code
 * and asset uploads. The deployment fails clearly if the directory is
 * missing.
 */
export interface MarketingStackProps extends StackProps {
  env: KennookEnv;
  /** Required for prod (env.marketingDomains is non-empty). Cross-region
   *  reference from the us-east-1 cert stack. */
  certificate?: acm.ICertificate;
}

export class MarketingStack extends Stack {
  constructor(scope: Construct, id: string, props: MarketingStackProps) {
    super(scope, id, {
      ...props,
      env: { account: props.env.account, region: props.env.region },
      description: `KenNook marketing site (${props.env.stackSuffix}) — kennook.com, Next.js via OpenNext on AWS.`,
      terminationProtection: props.env.hardenStateful,
      // The cert lives in us-east-1; CDK uses SSM behind the scenes to wire
      // the reference cleanly.
      crossRegionReferences: props.env.marketingDomains.length > 0,
    });

    // Marketing site is built via `pnpm deploy` into a sibling `.marketing-
    // deploy/` directory at the repo root — a self-contained copy with a flat
    // node_modules so OpenNext can bundle Next.js's transitive deps (the pnpm
    // workspace layout puts them in .pnpm/ which OpenNext's bundler doesn't
    // traverse). The .open-next/ output we consume lives inside that dir.
    const siteSourcePath = path.join(__dirname, '..', '..', '.marketing-deploy');

    let hostedZone: route53.IHostedZone | undefined;
    if (props.env.marketingDomains.length > 0) {
      // Zone owned by THIS account (post-migration). `fromLookup` requires
      // CDK_DEFAULT_ACCOUNT / region context, which we set via env above.
      hostedZone = route53.HostedZone.fromLookup(this, 'Zone', {
        domainName: props.env.hostedZoneName,
      });

      if (!props.certificate) {
        throw new Error(
          `MarketingStack ${id}: certificate is required when marketingDomains is non-empty.`,
        );
      }
    }

    new OpenNextSite(this, 'Site', {
      siteSourcePath,
      domains: props.env.marketingDomains,
      certificate: props.certificate,
      hostedZone,
      hardenStateful: props.env.hardenStateful,
    });
  }
}
