import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import {
  aws_iam as iam,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { GITHUB_REPO, type KennookEnv } from './env.js';

/**
 * GitHub Actions OIDC trust for an env's AWS account.
 *
 * Creates:
 *   • An OIDC provider for `token.actions.githubusercontent.com` (one per
 *     account; CDK errors if you instantiate this twice in the same account).
 *   • A deploy role that GitHub Actions assume via OIDC — no long-lived
 *     secrets, no static credentials in the repo.
 *
 * The trust policy accepts multiple `sub` patterns because GitHub generates
 * DIFFERENT sub claims for different workflow shapes:
 *   • Workflow with `environment: NAME` declared → `repo:O/R:environment:NAME`.
 *   • Push without environment → `repo:O/R:ref:refs/heads/BRANCH`.
 *   • Pull request trigger → `repo:O/R:pull_request`.
 * If you only allow one form, every other shape of workflow gets rejected
 * with "Not authorized to perform sts:AssumeRoleWithWebIdentity" — even when
 * the role exists and the repo/branch look right.
 *
 * The dev role also accepts `:pull_request` so `cdk-diff.yml` can run from
 * PRs. The prod role does NOT — prod only deploys on direct push to main.
 *
 * Permissions are kept tight: the role only gains `sts:AssumeRole` on the
 * four CDK bootstrap roles in this account. CDK's own bootstrap stack holds
 * the actual deploy/publish IAM. Net: this role is the GitHub-facing
 * indirection, the bootstrap roles do the real work.
 */
export interface GithubOidcStackProps extends StackProps {
  env: KennookEnv;
}

export class GithubOidcStack extends Stack {
  public readonly deployRoleArn: string;

  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, {
      ...props,
      env: { account: props.env.account, region: props.env.region },
      description: `GitHub Actions OIDC trust + deploy role (${props.env.stackSuffix}).`,
      terminationProtection: props.env.hardenStateful,
    });

    const provider = new iam.OpenIdConnectProvider(this, 'GitHubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    // All `sub` claim shapes this role accepts. See class comment for why
    // multiple forms are needed.
    const subjectPatterns: string[] = [
      // deploy-{dev,prod}.yml — both declare `environment:` so GitHub uses the
      // env-based sub claim.
      `repo:${GITHUB_REPO}:environment:${props.env.githubEnvironmentName}`,
      // Branch-based form: belt-and-suspenders for workflow_dispatch or any
      // future workflow that pushes from the trusted branch without an env.
      `repo:${GITHUB_REPO}:ref:refs/heads/${props.env.trustedBranch}`,
    ];
    if (props.env.name === 'dev') {
      // cdk-diff.yml runs on PRs; GitHub sends `:pull_request` then.
      subjectPatterns.push(`repo:${GITHUB_REPO}:pull_request`);
    }

    const deployRole = new iam.Role(this, 'DeployRole', {
      roleName: `KenNookGithubDeploy-${props.env.stackSuffix}`,
      description:
        `Assumed by GitHub Actions workflows for the ${props.env.name} env ` +
        `(repo ${GITHUB_REPO}, branch ${props.env.trustedBranch}, ` +
        `environment ${props.env.githubEnvironmentName}).`,
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': subjectPatterns,
        },
      }),
      maxSessionDuration: undefined, // default 1h is plenty for a deploy
    });

    // CDK uses four bootstrap roles per (account, region). The deploy role
    // can assume any of them in this account — the wildcard region lets us
    // share one OIDC stack across us-west-2 (marketing) AND us-east-1 (cert).
    const bootstrapRoleArn = (kind: string) =>
      `arn:aws:iam::${props.env.account}:role/cdk-hnb659fds-${kind}-role-${props.env.account}-*`;

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: [
          bootstrapRoleArn('deploy'),
          bootstrapRoleArn('file-publishing'),
          bootstrapRoleArn('image-publishing'),
          bootstrapRoleArn('lookup'),
        ],
      }),
    );

    this.deployRoleArn = deployRole.roleArn;

    new CfnOutput(this, 'DeployRoleArn', {
      value: deployRole.roleArn,
      description: 'Set this as the role-to-assume in the matching GitHub workflow.',
      exportName: `KenNookGithubDeployRole-${props.env.stackSuffix}`,
    });
  }
}
