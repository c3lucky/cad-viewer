# CAD Metadata Requirements for Public Parts Ordering

## Goal

Customers should be able to click a part in the public 3D model, see useful part
details, and order that exact part without manual lookup.

## Required CAD Export Behavior

The CAD export must preserve:

- Separate selectable parts. Do not export the assembly as one merged mesh.
- Assembly hierarchy. Subassemblies and child parts should remain structured.
- Stable part names. Mesh/node names should include the real part number or SKU.
- Stable occurrence IDs when the same part appears multiple times.
- Materials and basic visual appearance where possible.

Best web model format:

```text
GLB / glTF
```

Preferred output:

```text
226022-00.glb
226022-00-parts.json
```

## Required Part Metadata

Each orderable part should have a stable record with these fields:

```json
{
  "partNumber": "14-2600102",
  "sku": "14-2600102",
  "title": "Customer-facing part name",
  "description": "Short customer-facing description",
  "revision": "A",
  "material": "Aluminum 6061-T6",
  "finish": "Clear anodized",
  "quantityInAssembly": 2,
  "unitOfMeasure": "EA",
  "orderable": true,
  "replacementPartNumber": null,
  "erpItemId": "ERP-123456",
  "pdmFileId": "PDM-987654",
  "configuration": "Default",
  "thumbnail": null
}
```

Useful optional fields:

- `category`
- `manufacturer`
- `manufacturerPartNumber`
- `leadTimeDays`
- `minimumOrderQuantity`
- `compatibleAssemblies`
- `notes`
- `safetyStock`
- `weight`
- `dimensions`

Do not include internal-only or sensitive engineering data in the public metadata
unless it is intended for customers.

## Naming Rule

Every exported mesh/node should be traceable to metadata.

Preferred:

```text
mesh.name = partNumber
```

Acceptable:

```text
mesh.name = occurrenceId
```

Then the metadata file must include:

```json
{
  "occurrenceId": "ASM-001/14-2600102:2",
  "partNumber": "14-2600102"
}
```

Avoid generic exported names such as:

```text
Object001
Mesh_42
Body-1
ImportedPart
```

These require manual cleanup and break automated ordering.

## Suggested CAD/PDM Custom Properties

Ask CAD/PDM to maintain these properties on each part:

- Part Number
- Description
- Revision
- Material
- Finish
- ERP Item ID or SKU
- Orderable: Yes/No
- Replacement Part Number
- Unit of Measure
- Manufacturer Part Number, if purchased
- Customer Display Name, if different from internal name

## Automation Pipeline

Recommended flow:

```text
CAD/PDM assembly
  -> export GLB with separate named nodes
  -> export BOM/metadata JSON or CSV
  -> validate node names against metadata
  -> publish public viewer assets
  -> customer clicks part
  -> viewer sends partNumber/SKU to ordering API
  -> order/cart system handles price, availability, and checkout
```

The viewer should not hard-code price or inventory. Those values should come
from an API so they stay current.

## Validation Checklist

Before publishing a model:

- The GLB opens in the web viewer.
- Clicking each visible part returns a part number or occurrence ID.
- Every orderable part has a matching metadata record.
- Non-orderable parts are marked `orderable: false`.
- Duplicate instances map back to the same SKU when appropriate.
- Public metadata has been reviewed for sensitive information.

