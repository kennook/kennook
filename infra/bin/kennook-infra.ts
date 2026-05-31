#!/usr/bin/env tsx
/**
 * KenNook CDK app entrypoint.
 *
 * For each env: optionally create a us-east-1 cert sub-stack (only when the
 * env declares custom domains), then the us-west-2 marketing stack that
 * consumes the cert via cross-region reference. Dev declares no domains, so
 * its cert stack is skipped — CloudFront serves on its default URL.
 *
 * Deploy commands route to the right account via SSO profile:
 *   pnpm --filter @kennook/infra deploy:dev   # uses kennook-dev profile
 *   pnpm --filter @kennook/infra deploy:prod  # uses kennook-prod, broadening gate
 */

import { App, Tags } from 'aws-cdk-lib';
import { ENVS } from '../lib/env.js';
import { MarketingCertStack } from '../lib/marketing-cert-stack.js';
import { MarketingStack } from '../lib/marketing-stack.js';

const app = new App();

for (const env of Object.values(ENVS)) {
  const tag = (scope: object): void => {
    Tags.of(scope as never).add('Project', 'KenNook');
    Tags.of(scope as never).add('Environment', env.name);
    Tags.of(scope as never).add('Component', 'marketing');
  };

  let certStack: MarketingCertStack | undefined;
  if (env.marketingDomains.length > 0) {
    certStack = new MarketingCertStack(app, `KenNookMarketingCert-${env.stackSuffix}`, {
      env,
    });
    tag(certStack);
  }

  const marketing = new MarketingStack(app, `KenNookMarketing-${env.stackSuffix}`, {
    env,
    certificate: certStack?.certificate,
  });
  tag(marketing);
  if (certStack) marketing.addDependency(certStack);
}
