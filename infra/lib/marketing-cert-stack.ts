import { Stack, type StackProps } from 'aws-cdk-lib';
import {
  aws_certificatemanager as acm,
  aws_route53 as route53,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { ACM_CERT_REGION, type KennookEnv } from './env.js';

/**
 * Sibling stack for the marketing site's ACM certificate. Lives in us-east-1
 * because CloudFront only accepts certs from that region — no exceptions, no
 * workarounds.
 *
 * Only instantiated for envs that publish a custom domain (i.e. prod). Dev
 * uses CloudFront's default `*.cloudfront.net` URL and skips this entirely.
 *
 * `crossRegionReferences: true` lets the marketing stack in us-west-2
 * consume `this.certificate` via a CDK-managed SSM parameter under the
 * hood — no manual coordination needed.
 */
export interface MarketingCertStackProps extends StackProps {
  env: KennookEnv;
}

export class MarketingCertStack extends Stack {
  public readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: MarketingCertStackProps) {
    super(scope, id, {
      ...props,
      env: { account: props.env.account, region: ACM_CERT_REGION },
      description: `KenNook marketing ACM certificate (${props.env.stackSuffix}) — us-east-1, required by CloudFront.`,
      crossRegionReferences: true,
      terminationProtection: props.env.hardenStateful,
    });

    if (props.env.marketingDomains.length === 0) {
      throw new Error(
        `MarketingCertStack instantiated for ${props.env.name} but env.marketingDomains is empty.`,
      );
    }

    // The hosted zone is owned by the SAME account (post-migration). Route 53
    // is global, so `fromLookup` reads it fine from this us-east-1 stack.
    const hostedZone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: props.env.hostedZoneName,
    });

    const [primary, ...sans] = props.env.marketingDomains;
    this.certificate = new acm.Certificate(this, 'Cert', {
      domainName: primary,
      subjectAlternativeNames: sans,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });
  }
}
