# Public Interactive CAD Parts Viewer

This project is the direction for a public customer page where users can click a
part in the 3D assembly and see part details in a side drawer.

## Why Not eDrawings for This

The exported eDrawings HTML is good for viewing, but it is a closed viewer. It
does not give this page reliable click events for individual parts or a clean API
for opening our own metadata drawer. For custom part selection, use a web-native
mesh format such as `glb`/`gltf`.

## Required Model Pipeline

Convert:

```text
../Bradys 3D CAD files/226022-00.STEP
```

To:

```text
models/226022-00.glb
```

Important conversion settings:

- Preserve assembly hierarchy.
- Preserve object names from the STEP `PRODUCT(...)` entries.
- Export separate meshes per part, not one merged mesh.
- Keep reasonable tessellation for web performance.

The STEP file contains 336 product entries, so the conversion should preserve
those names as mesh/node names where possible.

## Metadata

Update:

```text
models/parts.json
```

Each object should use the part number or mesh name as `partNumber`:

```json
{
  "partNumber": "14-2600102",
  "title": "14-2600102",
  "description": "Customer-facing detail",
  "material": "Aluminum",
  "finish": "Anodized",
  "quantity": 2,
  "revision": "A",
  "supplier": "Internal"
}
```

## Local Test

From this folder:

```bash
npm install
npm start
```

Open:

```text
http://127.0.0.1:8766/
```

Without a query string, the page loads the original default model:

```text
models/226022-00_COMP.glb
```

With a query string, the page resolves the viewer link through the backend:

```text
http://127.0.0.1:8766/?q=<hash_string>
```

The backend looks up `<hash_string>` through `GET /api/viewer-context?q=<hash_string>`.
When `DATABASE_URL` is configured, this lookup uses PostgreSQL. Without a
database, local development uses generated real mappings from:

```text
data/viewer-links.json
```

Regenerate that file from the mounted Azure File Share:

```bash
npm run links:generate
```

Example generated URLs:

```text
http://127.0.0.1:8766/?q=2be078698be8590f87b12917
http://127.0.0.1:8766/?q=eaa998ee3b7984773c5bf99d
```

## PostgreSQL Setup

Create the schema:

```bash
DATABASE_URL=postgres://cad_viewer:password@127.0.0.1:5432/cad_viewer npm run db:migrate
```

Seed viewer links from mounted project folders:

```bash
C3_PROJECTS=226001,226003,226007,226008,226009,226010,226022,226023,226024,226026,226027,226029 \
DATABASE_URL=postgres://cad_viewer:password@127.0.0.1:5432/cad_viewer \
npm run db:seed
```

The seeder scans each project under:

```text
/media/c3projectshare/<project>/3. Build Drawings/Mechanical/E-Dwgs
```

and stores the generated hash, project number, model file name, and GLB path in
the `viewer_links` table.

## HubSpot Model Summary Endpoint

HubSpot can request a safe JSON summary for a mapped GLB:

```text
GET /cad-viewer/api/hubspot/model-summary?check=<hash_string>
```

Example:

```text
https://20.40.253.16/cad-viewer/api/hubspot/model-summary?check=96d53f2557da0ad6350360f2
```

The endpoint returns project number, model file name, file size, last modified
date, and the public viewer URL. It does not return Azure credentials, server
filesystem roots, or raw share paths.

Set the HubSpot app client secret before enabling this endpoint publicly:

```bash
HUBSPOT_CLIENT_SECRET=<hubspot-app-client-secret>
PUBLIC_BASE_URL=https://20.40.253.16/cad-viewer
```

When `HUBSPOT_CLIENT_SECRET` is set, requests must include valid HubSpot
signature headers. The app accepts v3 app signatures:

```text
X-HubSpot-Signature-v3
X-HubSpot-Request-Timestamp
```

It also accepts the v2 `X-HubSpot-Signature` header used by HubSpot workflow
webhook actions.

## HubSpot Automation Webhook Receiver

Point a HubSpot automation webhook at:

```text
POST /cad-viewer/api/hubspot/webhook
```

Example public URL:

```text
https://20.40.253.16/cad-viewer/api/hubspot/webhook
```

The endpoint accepts the full HubSpot JSON request body and stores each request
as one JSON object per line in:

```text
data/hubspot-webhook-events.jsonl
```

Override that path with:

```bash
HUBSPOT_WEBHOOK_LOG_PATH=/var/log/cad-viewer/hubspot-webhook-events.jsonl
```

When `HUBSPOT_CLIENT_SECRET` is set, webhook requests must include a valid
HubSpot signature header. The app accepts both v3 app signatures and the v2
`X-HubSpot-Signature` header used by HubSpot workflow webhook actions. For local
development only, unsigned requests can be accepted by setting:

```bash
HUBSPOT_ALLOW_UNSIGNED=true
NODE_ENV=development
```

If `HUBSPOT_CLIENT_SECRET` is not configured, set `HUBSPOT_WEBHOOK_TOKEN` and
include it in the workflow webhook URL:

```text
POST /cad-viewer/api/hubspot/webhook?token=<shared-token>
```

This keeps workflow trigger logging unblocked without accepting arbitrary public
POST requests. Captured events mark `signature.skipped: true` and
`signature.tokenVerified: true`. Configure the HubSpot client secret later to
enforce HubSpot request signature validation instead.

Successful captures return `202 Accepted` with a generated event id.

To check whether a HubSpot workflow has reached this app, sign in to the admin
area and request the recent trigger log:

```text
GET /cad-viewer/api/admin/hubspot-webhook-events?limit=25
```

The newest accepted trigger is returned first. Each event includes the generated
event id, receive timestamp, request headers with sensitive values redacted, the
parsed JSON body, and the raw JSON body.

For a quick check without admin login, use the safe status endpoint:

```text
GET /cad-viewer/api/hubspot/webhook-status
```

It only reports whether any trigger has been captured and the latest event id and
timestamp. It also includes a property count and property key summary so workflow
payloads can be checked without exposing object property values publicly.

To include the latest property values, call the same endpoint with the shared
webhook token as a request header:

```bash
curl -H "token: <shared-token>" \
  https://20.40.253.16/cad-viewer/api/hubspot/webhook-status
```

For a browser dashboard of recent webhook logs, open:

```text
https://20.40.253.16/cad-viewer/webhook-dashboard.html
```

Enter the shared webhook token to load summarized rows. The dashboard focuses on
serial-number fields such as project id, serial number name, source name, HubSpot
object id, source object id, and HubSpot modified timestamp.

## Public Hosting

For a truly public customer page, use a public static host such as Azure Static
Web Apps, Netlify, Cloudflare Pages, S3/CloudFront, or your normal website host.

SharePoint Online is not a good fit for anonymous public web pages. Microsoft
discontinued SharePoint Online public websites, and modern SharePoint is designed
around authenticated internal/guest access rather than anonymous customer-facing
web apps.
