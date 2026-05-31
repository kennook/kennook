# KenNook marketing site

Public `kennook.com`. Next.js App Router, deployed to AWS via OpenNext + the
CDK in `infra/`.

## Local dev

```bash
pnpm --filter @kennook/marketing dev
```

Runs on `:3100` to avoid colliding with the app's `:3000` / `:3001`.

## Build

```bash
pnpm --filter @kennook/marketing build
```

The CDK marketing stack consumes the standard Next build output via OpenNext
— no custom export step here.
