# Migrating a Route 53 hosted zone: mgmt → member account

Both KenNook domains were registered in the **management** account (which is
where Route 53 Domains lives). Each domain's hosted **zone** also defaults
to mgmt, but we want each zone in the matching member account so the CDK
stack there can manage records natively.

| Domain        | Registered in | Zone target     | Profile         |
|---------------|---------------|-----------------|-----------------|
| `kennook.com` | mgmt          | KenNook-Prod    | `kennook-prod`  |
| `kennook.dev` | mgmt          | KenNook-Dev     | `kennook-dev`   |

The registration stays in mgmt (centralized billing); only the **zone**
moves. Run this whole document **once per domain** — they're independent.

Below, `$ZONE` is the domain you're migrating (e.g. `kennook.com`),
`$TARGET_PROFILE` is the destination account's SSO profile
(`kennook-prod` or `kennook-dev`), and `$MGMT_ZONE_ID` / `$NEW_ZONE_ID`
are the Route 53 zone IDs before and after.

## Prerequisites

- SSO logged in to both `kennook-mgmt` and `$TARGET_PROFILE`.
- A way to verify DNS resolution from a real public resolver (e.g. `dig
  @1.1.1.1 $ZONE NS`).
- A maintenance window — the NS swap propagates over minutes; during that
  time some resolvers see the old NS, some the new. Both authoritative
  with the same records, so the site stays up.

## Step 1 — lower TTLs (a few days ahead)

```bash
aws route53 list-resource-record-sets \
  --hosted-zone-id $MGMT_ZONE_ID \
  --profile kennook-mgmt
```

For every non-NS, non-SOA record, lower TTL to `60` seconds. This caps how
long stale resolvers can hold the old answers post-migration. NS records can
stay at the registrar default.

Wait for the prior TTL to expire (usually 24-48h). If TTLs are already 300
or less, skip this step.

## Step 2 — export current records

```bash
aws route53 list-resource-record-sets \
  --hosted-zone-id $MGMT_ZONE_ID \
  --profile kennook-mgmt \
  --output json > $ZONE-records.json
```

Keep this file as the rollback artifact. Review it: confirm nothing
unexpected (old experiments, forgotten subdomains).

## Step 3 — create the zone in the target account

```bash
aws route53 create-hosted-zone \
  --name $ZONE \
  --caller-reference "$ZONE-migration-$(date +%s)" \
  --hosted-zone-config Comment="$ZONE primary zone — managed via CDK",PrivateZone=false \
  --profile $TARGET_PROFILE
```

Note the new zone ID and its four assigned NS records — you'll need them
for Step 5.

## Step 4 — replay records into the new zone

Strip `NS` and `SOA` from `$ZONE-records.json` (the new zone has its own).
A quick `jq`:

```bash
jq '{Changes: [.ResourceRecordSets[]
      | select(.Type != "NS" and .Type != "SOA")
      | {Action: "UPSERT", ResourceRecordSet: .}]}' \
   $ZONE-records.json > $ZONE-changes.json

aws route53 change-resource-record-sets \
  --hosted-zone-id $NEW_ZONE_ID \
  --change-batch file://$ZONE-changes.json \
  --profile $TARGET_PROFILE
```

Verify directly against one of the new NS records BEFORE the public swap:

```bash
dig @<one-of-the-new-NS-records> $ZONE ANY
```

Should return everything you just wrote.

## Step 5 — flip NS at the registrar (the cutover)

In Route 53 Domains (mgmt account) → Registered domains → `$ZONE` → Update
name servers. Replace the four NS values with the new zone's NS records
(from Step 3). Save.

AWS pushes the NS update to the registry within a few minutes.

## Step 6 — verify propagation

```bash
# Public resolvers — should return the new NS within ~5-15 minutes:
dig @1.1.1.1 $ZONE NS +short
dig @8.8.8.8 $ZONE NS +short
dig @9.9.9.9 $ZONE NS +short

# Confirm record resolution works through the public chain:
dig $ZONE +short
dig www.$ZONE +short
```

## Step 7 — retire the mgmt zone

Wait at least 48h after Step 5 (lets laggard resolver caches expire).

```bash
aws route53 delete-hosted-zone \
  --id $MGMT_ZONE_ID \
  --profile kennook-mgmt
```

Deletes the *zone*, not the *domain registration*. Registration stays in
mgmt.

## Rollback

If something goes wrong after Step 5: re-update the registrar NS records
back to the mgmt zone's NS values (the mgmt zone isn't deleted until Step
7, so it's still live). DNS reverses the same way it flipped.

The exported `$ZONE-records.json` from Step 2 lets you also recreate the
records elsewhere if needed.
