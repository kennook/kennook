import type { OpenNextConfig } from '@opennextjs/aws/types/open-next';

/**
 * OpenNext build config for the KenNook marketing site.
 *
 * Single-region serverless deployment — the simplest topology that still
 * supports SSR, ISR, and API routes. The CDK side (`@kennook/infra`) reads
 * `.open-next/` and provisions:
 *
 *   - server function       → `.open-next/server-functions/default`
 *   - image optimization fn → `.open-next/image-optimization-function`
 *   - revalidation function → `.open-next/revalidation-function`
 *   - static assets          → `.open-next/assets`  (uploaded to S3)
 *   - ISR cache              → `.open-next/cache`   (uploaded to S3)
 *
 * S3-backed incremental cache is the default; we don't enable the DynamoDB
 * provider yet — that buys cross-instance ISR consistency we don't need at
 * marketing-site traffic levels.
 */
const config: OpenNextConfig = {
  default: {
    override: {
      // Standard Node.js Lambda runtime. (The alternative `aws-lambda-streaming`
      // wrapper enables response streaming — useful for long server components,
      // not needed for a marketing site today.)
      wrapper: 'aws-lambda',
      converter: 'aws-apigw-v2',
    },
  },
  // imageOptimization uses defaults — CDK sets the Lambda architecture
  // (ARM_64) directly when creating the function, so we don't need to
  // configure it here.
  buildCommand: 'next build',
};

export default config;
