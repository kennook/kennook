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
requires that region for certs). Each env needs both:

```bash
# Dev account
cdk bootstrap aws://719146259408/us-west-2 --profile kennook-dev
cdk bootstrap aws://719146259408/us-east-1 --profile kennook-dev

# Prod account
cdk bootstrap aws://045064752951/us-west-2 --profile kennook-prod
cdk bootstrap aws://045064752951/us-east-1 --profile kennook-prod
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
