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
import { GithubOidcStack } from '../lib/github-oidc-stack.js';
import { MarketingCertStack } from '../lib/marketing-cert-stack.js';
import { MarketingStack } from '../lib/marketing-stack.js';

const app = new App();

for (const env of Object.values(ENVS)) {
  const tag = (scope: object, component: string): void => {
    Tags.of(scope as never).add('Project', 'KenNook');
    Tags.of(scope as never).add('Environment', env.name);
    Tags.of(scope as never).add('Component', component);
  };

  // GitHub Actions OIDC role — standalone, doesn't depend on the marketing
  // resources. Deploy once per env (then GitHub Actions does the rest).
  const oidc = new GithubOidcStack(app, `KenNookGithubOidc-${env.stackSuffix}`, { env });
  tag(oidc, 'ci-cd');

  let certStack: MarketingCertStack | undefined;
  if (env.marketingDomains.length > 0) {
    certStack = new MarketingCertStack(app, `KenNookMarketingCert-${env.stackSuffix}`, {
      env,
    });
    tag(certStack, 'marketing');
  }

  const marketing = new MarketingStack(app, `KenNookMarketing-${env.stackSuffix}`, {
    env,
    certificate: certStack?.certificate,
  });
  tag(marketing, 'marketing');
  if (certStack) marketing.addDependency(certStack);
}
