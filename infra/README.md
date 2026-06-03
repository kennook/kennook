# KenNook infra

AWS CDK (TypeScript) for KenNook cloud services. Lives alongside the app and
`marketing/` site as a pnpm workspace package.

## Layout

```
infra/
├── bin/
│   └── kennook-infra.ts   App entrypoint — instantiates stacks per env.
├── lib/
│   ├── env.ts             Account IDs, region, per-env metadata.
│   └── marketing-stack.ts Marketing site stack (kennook.com).
├── cdk.json               CDK config + feature flags.
├── package.json           Scripts: synth, diff:dev/prod, deploy:dev/prod.
└── tsconfig.json
```

## First-time setup (per AWS account, per region)

CDK bootstraps once per (account, region). The marketing stack lives in
**us-west-2**, the ACM cert sub-stack lives in **us-east-1** (CloudFront
requires that region for certs). Each env needs both.

Always invoke cdk through `pnpm exec` (or `pnpm --filter @kennook/infra exec`),
NOT a bare/global `cdk`: the app runs via `tsx bin/kennook-infra.ts` (see
`cdk.json`), and both `cdk` and `tsx` are workspace-local devDeps. A bare `cdk`
fails with `/bin/sh: tsx: command not found` (exit 127) because `node_modules/.bin`
isn't on PATH. `pnpm exec` / `pnpm run` put it there.

```bash
# Dev account
pnpm --filter @kennook/infra exec cdk bootstrap aws://719146259408/us-west-2 --profile kennook-dev
pnpm --filter @kennook/infra exec cdk bootstrap aws://719146259408/us-east-1 --profile kennook-dev

# Prod account
pnpm --filter @kennook/infra exec cdk bootstrap aws://045064752951/us-west-2 --profile kennook-prod
pnpm --filter @kennook/infra exec cdk bootstrap aws://045064752951/us-east-1 --profile kennook-prod
```

Symptom of a missing bootstrap during deploy:
`SSM parameter /cdk-bootstrap/hnb659fds/version not found. Has the environment been bootstrapped?`

## Day-to-day

```bash
pnpm --filter @kennook/infra synth          # render templates locally
pnpm --filter @kennook/infra diff:dev       # diff against dev account
pnpm --filter @kennook/infra deploy:dev     # deploy to dev
pnpm --filter @kennook/infra diff:prod      # diff against prod account
pnpm --filter @kennook/infra deploy:prod    # deploy to prod (broadening approval gate)
```

## Conventions

- One stack per (component, env). Stack IDs: `KenNook<Component>-<Env>`,
  e.g. `KenNookMarketing-Dev`.
- Stateful prod resources: `RemovalPolicy.RETAIN` + `deletionProtection`.
- Prod stacks: `terminationProtection: true` (set in stack constructor when
  `env.hardenStateful` is true).
- Always run `diff` before `deploy`. CI requires manual approval on prod
  `Replace` actions.

## GitHub Actions / OIDC setup (one-time per env)

The `KenNookGithubOidc-{Env}` stack creates an OIDC trust + deploy role
that the workflows in `.github/workflows/` assume. No long-lived secrets
in the repo — short-lived STS sessions via GitHub's OIDC token.

First-time bootstrap, **after** the workspace is fresh from clone:

```bash
# 1. Deploy the OIDC stacks (idempotent; re-run safely if anything changes).
pnpm --filter @kennook/infra exec cdk deploy KenNookGithubOidc-Dev --profile kennook-dev
pnpm --filter @kennook/infra exec cdk deploy KenNookGithubOidc-Prod --profile kennook-prod

# 2. Confirm the role ARNs match what the workflows expect:
#    arn:aws:iam::719146259408:role/KenNookGithubDeploy-Dev
#    arn:aws:iam::045064752951:role/KenNookGithubDeploy-Prod
```

Then in GitHub:
- **Branches**: ensure `develop` exists. The dev workflow triggers on push
  to `develop`; prod on push to `main`.
- **Environments** (repo Settings → Environments):
  - Create `development` (no rules needed — instant deploys).
  - Create `production` (no required reviewers for the solo-dev flow now;
    add reviewers later if/when the team grows).

The workflows then run on every push.

## Workflows

| File | Trigger | What it does |
|---|---|---|
| `.github/workflows/cdk-diff.yml` | PR touching `infra/`, `marketing/`, or workflow files | Builds marketing, runs `cdk diff` against dev, posts a sticky comment with the diff. |
| `.github/workflows/deploy-dev.yml` | Push to `develop` | Builds marketing, deploys all `*-Dev` stacks to the dev account via OIDC. |
| `.github/workflows/deploy-prod.yml` | Push to `main` | Builds marketing, deploys all `*-Prod` stacks via OIDC. Uses `--require-approval broadening` for an extra safety check on IAM-broadening diffs. |
