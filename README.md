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

```powershell
python -m http.server 8766 --bind 127.0.0.1
```

Open:

```text
http://127.0.0.1:8766/
```

The page will show a placeholder message until `models/226022-00.glb` exists.

## Public Hosting

For a truly public customer page, use a public static host such as Azure Static
Web Apps, Netlify, Cloudflare Pages, S3/CloudFront, or your normal website host.

SharePoint Online is not a good fit for anonymous public web pages. Microsoft
discontinued SharePoint Online public websites, and modern SharePoint is designed
around authenticated internal/guest access rather than anonymous customer-facing
web apps.
