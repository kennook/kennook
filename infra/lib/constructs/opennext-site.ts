import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Duration,
  Fn,
  RemovalPolicy,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_certificatemanager as acm,
  aws_lambda as lambda,
  aws_lambda_event_sources as eventsrc,
  aws_route53 as route53,
  aws_route53_targets as r53targets,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_sqs as sqs,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * OpenNext-on-AWS site.
 *
 * Provisions the four moving parts that a serverless Next.js deployment
 * needs, plus the CloudFront distribution that routes between them:
 *
 *   • S3 bucket — static assets + ISR cache files. Private; CloudFront has
 *     OAC access. The cache prefix is a folder inside the same bucket so we
 *     don't need a second bucket for it.
 *   • Server Lambda — SSR + API routes + middleware. Function URL is the
 *     default CloudFront origin.
 *   • Image-optimization Lambda — `/_next/image*`. arm64 for faster cold
 *     starts.
 *   • Revalidation Lambda + SQS — ISR cache invalidation. The server Lambda
 *     sends messages to SQS when a path needs revalidating; this Lambda
 *     consumes them and rebuilds the cache entry.
 *
 * If `domains[]` is non-empty, the distribution gets those as aliases and
 * Route 53 A/AAAA records get created in `hostedZone`. The ACM cert must be
 * provided (CloudFront requires us-east-1, so prod's cert is built in a
 * sibling stack).
 *
 * Consumes the output of `open-next build` from `siteSourcePath`. The build
 * must have been run before `cdk deploy`; CDK doesn't trigger it.
 */
export interface OpenNextSiteProps {
  /** Absolute path to the Next.js project (where `.open-next/` lives after
   *  `open-next build`). */
  siteSourcePath: string;
  /** Public domains to alias on CloudFront. Empty → CloudFront default URL
   *  only (used in dev). */
  domains?: string[];
  /** Required if `domains[]` is non-empty. ACM cert in us-east-1 covering
   *  every entry in `domains[]`. */
  certificate?: acm.ICertificate;
  /** Required if `domains[]` is non-empty. Route 53 zone where A/AAAA
   *  aliases get created. */
  hostedZone?: route53.IHostedZone;
  /** Prod: prevent accidental destruction of data resources. Dev: false so
   *  `cdk destroy` cleans up. */
  hardenStateful: boolean;
}

export class OpenNextSite extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: OpenNextSiteProps) {
    super(scope, id);

    if (props.domains?.length && !(props.certificate && props.hostedZone)) {
      throw new Error(
        'OpenNextSite: certificate and hostedZone are required when domains[] is non-empty.',
      );
    }

    const openNextOut = path.join(props.siteSourcePath, '.open-next');

    // ── S3: static assets + ISR cache ────────────────────────────────────
    // Single bucket with two prefixes: `_assets/*` holds the build output
    // (served via CloudFront); `_cache/*` is OpenNext's ISR cache. The
    // server Lambda gets read/write on the cache prefix; CloudFront only
    // reads from assets.
    this.bucket = new s3.Bucket(this, 'AssetsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: props.hardenStateful,
      removalPolicy: props.hardenStateful ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !props.hardenStateful,
    });

    // ── SQS: revalidation queue ──────────────────────────────────────────
    // FIFO with content-based dedup — collapses duplicate revalidation
    // requests for the same path that arrive close together (Next pages
    // being viewed by multiple clients while stale).
    const revalidationQueue = new sqs.Queue(this, 'RevalidationQueue', {
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: Duration.seconds(30),
      retentionPeriod: Duration.days(1),
    });

    // ── Lambda: server (SSR + API + middleware) ──────────────────────────
    const serverFn = new lambda.Function(this, 'ServerFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(openNextOut, 'server-functions/default')),
      memorySize: 1024,
      timeout: Duration.seconds(30),
      architecture: lambda.Architecture.ARM_64,
      environment: {
        CACHE_BUCKET_NAME: this.bucket.bucketName,
        CACHE_BUCKET_KEY_PREFIX: '_cache',
        CACHE_BUCKET_REGION: this.bucket.env.region,
        REVALIDATION_QUEUE_URL: revalidationQueue.queueUrl,
        REVALIDATION_QUEUE_REGION: revalidationQueue.env.region,
      },
    });
    this.bucket.grantReadWrite(serverFn, '_cache/*');
    revalidationQueue.grantSendMessages(serverFn);

    const serverFnUrl = serverFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // ── Lambda: image optimization ───────────────────────────────────────
    const imageFn = new lambda.Function(this, 'ImageFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(openNextOut, 'image-optimization-function')),
      memorySize: 1536, // sharp benefits from more memory
      timeout: Duration.seconds(25),
      architecture: lambda.Architecture.ARM_64,
      environment: {
        BUCKET_NAME: this.bucket.bucketName,
        BUCKET_KEY_PREFIX: '_assets',
      },
    });
    this.bucket.grantRead(imageFn, '_assets/*');

    const imageFnUrl = imageFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // ── Lambda: revalidation worker ──────────────────────────────────────
    const revalidationFn = new lambda.Function(this, 'RevalidationFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(openNextOut, 'revalidation-function')),
      memorySize: 512,
      timeout: Duration.seconds(25),
      architecture: lambda.Architecture.ARM_64,
    });
    revalidationFn.addEventSource(
      new eventsrc.SqsEventSource(revalidationQueue, { batchSize: 5 }),
    );

    // ── CloudFront distribution ──────────────────────────────────────────
    // Behaviors:
    //   1. Default        → server Lambda (everything not matched below)
    //   2. /_next/static* → S3 (immutable, hashed-filename assets)
    //   3. /_next/image*  → image Lambda
    //   4. /version.json  → S3, caching DISABLED (the self-hosted-update
    //      manifest; must be served from the bucket, not the server Lambda,
    //      and must reflect a new release immediately — no CDN staleness).
    // OTHER public/ files still fall through to the default behavior and hit
    // the server Lambda → 404 (e.g. /favicon.ico). Low-traffic-acceptable for
    // now; the real fix is to glob public/ at synth time and add per-path S3
    // behaviors. version.json is special-cased because the upgrade flow depends
    // on it.

    // Function URLs come back as `https://<id>.lambda-url.<region>.on.aws/` —
    // CloudFront's origin domain wants just the hostname. We can't strip with
    // String.prototype.replace because at synth time these URLs are CDK
    // tokens, not real strings. Use the CloudFormation intrinsic Fn.split +
    // Fn.select to do it at deploy time. Split by '/' gives ['https:', '',
    // '<host>', ''], index 2 is the host.
    const serverOrigin = new origins.HttpOrigin(
      Fn.select(2, Fn.split('/', serverFnUrl.url)),
      { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY },
    );
    const imageOrigin = new origins.HttpOrigin(
      Fn.select(2, Fn.split('/', imageFnUrl.url)),
      { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY },
    );
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket, {
      originPath: '/_assets',
    });

    // Server behavior: forward all viewer headers (Next reads them), don't
    // cache by default — server response Cache-Control headers drive it.
    const serverBehavior: cloudfront.BehaviorOptions = {
      origin: serverOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      compress: true,
    };

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: serverBehavior,
      additionalBehaviors: {
        '_next/static/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
        },
        // The update manifest: served straight from S3, never cached at the
        // edge so a fresh release is visible to self-hosted servers right away
        // (the app already caches the check ~1h server-side).
        'version.json': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          compress: true,
        },
        '_next/image*': {
          origin: imageOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          compress: true,
        },
      },
      domainNames: props.domains?.length ? props.domains : undefined,
      certificate: props.domains?.length ? props.certificate : undefined,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // North America + Europe
      defaultRootObject: '',
      errorResponses: [
        // Next handles 404/500 itself via app/not-found.tsx and error.tsx —
        // don't let CloudFront override with its own pages.
      ],
    });

    // ── Deploy assets + cache to S3 ──────────────────────────────────────
    // Two source folders, two destination prefixes. `prune: false` so CDK
    // doesn't delete keys outside the prefix it just wrote.
    new s3deploy.BucketDeployment(this, 'DeployAssets', {
      sources: [s3deploy.Source.asset(path.join(openNextOut, 'assets'))],
      destinationBucket: this.bucket,
      destinationKeyPrefix: '_assets',
      distribution: this.distribution,
      distributionPaths: ['/_next/static/*', '/_next/image*'],
      prune: false,
      // Static assets can have long cache lifetimes — the filenames are
      // content-hashed by Next so any change ships under a new key.
      cacheControl: [s3deploy.CacheControl.fromString('public, max-age=31536000, immutable')],
    });

    // ISR cache deployment is conditional: sites with no
    // incremental-static-regeneration pages (e.g. our current landing
    // placeholder) emit an empty `.open-next/cache/` directory, and
    // BucketDeployment errors out on a zero-byte source. Skip cleanly when
    // there's nothing to upload; OpenNext seeds it from the server function
    // at first request if needed later.
    const cacheDir = path.join(openNextOut, 'cache');
    if (fs.existsSync(cacheDir) && fs.readdirSync(cacheDir).length > 0) {
      new s3deploy.BucketDeployment(this, 'DeployCache', {
        sources: [s3deploy.Source.asset(cacheDir)],
        destinationBucket: this.bucket,
        destinationKeyPrefix: '_cache',
        prune: false,
      });
    }

    // ── Route 53 aliases (only when domains[] is set) ────────────────────
    if (props.domains?.length && props.hostedZone) {
      const target = route53.RecordTarget.fromAlias(
        new r53targets.CloudFrontTarget(this.distribution),
      );
      for (const domain of props.domains) {
        new route53.ARecord(this, `Alias-${domain}-A`, {
          zone: props.hostedZone,
          recordName: domain === props.hostedZone.zoneName ? undefined : domain,
          target,
        });
        new route53.AaaaRecord(this, `Alias-${domain}-AAAA`, {
          zone: props.hostedZone,
          recordName: domain === props.hostedZone.zoneName ? undefined : domain,
          target,
        });
      }
    }
  }
}

