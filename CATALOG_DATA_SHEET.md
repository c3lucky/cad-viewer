# CAD Viewer Catalog Data Sheet

Generated: 2026-06-19

This sheet is the database seed/reference for the public CAD viewer catalog and HubSpot catalog manager card. It intentionally excludes pricing because public pricing must go through quote or internal order review.

## Source Endpoints

- Viewer: `https://20.40.253.16/cad-viewer/`
- Catalog metadata: `https://20.40.253.16/cad-viewer/mock-api/catalog.json`
- Inventory metadata: `https://20.40.253.16/cad-viewer/mock-api/inventory.json`
- Catalog viewer mesh list: `https://20.40.253.16/cad-viewer/mock-api/catalog-viewer-meshes.json`
- Mock order request response: `https://20.40.253.16/cad-viewer/mock-api/order-request.json`

## Dataset Summary

- Assembly ID: `226022-00`
- Catalog parts: 20
- Mesh list records: 20
- Inventory records: 19
- Pricing fields: intentionally omitted
- Primary key recommendation: `partNumber` for mesh matching, `sku` for ERP/inventory joins

## Suggested Database Tables

### `catalog_parts`

| Field | Type | Notes |
| --- | --- | --- |
| `part_number` | text primary key | Matches GLB mesh/node path when available. |
| `sku` | text indexed | ERP/inventory item key. |
| `title` | text | Customer-facing part name. |
| `description` | text | Customer-facing description. |
| `revision` | text nullable | CAD/PDM revision. |
| `material` | text nullable | Part material. |
| `finish` | text nullable | Part finish. |
| `quantity_in_assembly` | integer | Count used in the assembly. |
| `unit_of_measure` | text | Usually `EA`. |
| `orderable` | boolean | Controls whether users can collect/request the part. |
| `erp_item_id` | text nullable | ERP reference. |
| `pdm_file_id` | text nullable | CAD/PDM reference. |
| `configuration` | text nullable | CAD configuration name. |

### `inventory_status`

| Field | Type | Notes |
| --- | --- | --- |
| `sku` | text primary/foreign key | Joins to `catalog_parts.sku`. |
| `stock_status` | text | Display status such as `In stock`, `Low stock`, `Build to order`. |
| `available_quantity` | integer nullable | Public availability signal, not pricing. |
| `lead_time_days` | integer nullable | Expected lead time. |
| `warehouse` | text nullable | Inventory location. |

### `viewer_meshes`

| Field | Type | Notes |
| --- | --- | --- |
| `mesh_id` | text primary key | The selectable mesh ID/path from the viewer. |
| `occurrence_id` | text indexed | Stable occurrence key for repeated parts. |
| `part_number` | text foreign key | Joins to `catalog_parts.part_number`. |
| `viewer_url` | text | Link back into the viewer. |

## Catalog Records

| Occurrence ID | Mesh ID / Part Number | SKU | Title | Description | Revision | Material | Finish | Qty In Assembly | UOM | Orderable | ERP Item ID | PDM File ID | Configuration | Stock Status | Available Qty | Lead Time Days | Warehouse | Viewer URL |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 226022-00:001 | 02-1500017_9414T28 | 02-1500017 | Compression Spring | Replacement compression spring used in the actuator assembly. | B | Music wire | Plain | 4 | EA | Yes | ERP-02-1500017 | PDM-9414T28 | Default | In stock | 128 | 2 | Main | /cad-viewer/#mesh=02-1500017_9414T28 |
| 226022-00:002 | 14-2600102 | 14-2600102 | Mounting Plate | Machined plate for locating the pneumatic rail assembly. | A | Aluminum 6061-T6 | Clear anodized | 1 | EA | Yes | ERP-14-2600102 | PDM-14-2600102 | Default | Build to order | 0 | 14 | Machine Shop | /cad-viewer/#mesh=14-2600102 |
| 226022-00:003 | 12-2300413 | 12-2300413 | Guide Bracket | Customer-replaceable guide bracket for the main carriage. | C | Stainless steel 304 | Passivated | 2 | EA | Yes | ERP-12-2300413 | PDM-12-2300413 | Default | In stock | 23 | 3 | Main | /cad-viewer/#mesh=12-2300413 |
| 226022-00:004 | 12-1500544_Default<As Machined> | 12-1500544 | Machined Spacer | Precision spacer used for assembly alignment. | A | Aluminum 6061-T6 | As machined | 6 | EA | Yes | ERP-12-1500544 | PDM-12-1500544 | As Machined | Low stock | 5 | 5 | Main | /cad-viewer/#mesh=12-1500544_Default%3CAs%20Machined%3E |
| 226022-00:005 | 02-1301161 | 02-1301161 | Socket Head Cap Screw | Replacement socket head fastener used throughout the rail and cover assemblies. | A | Alloy steel | Black oxide | 41 | EA | Yes | ERP-02-1301161 | PDM-02-1301161 | Default | In stock | 420 | 1 | Main | /cad-viewer/#mesh=02-1301161 |
| 226022-00:006 | 02-0400188 | 02-0400188 | Flat Washer | Service washer for fastening stack-ups and cover plates. | A | Stainless steel | Passivated | 20 | EA | Yes | ERP-02-0400188 | PDM-02-0400188 | Default | In stock | 960 | 1 | Main | /cad-viewer/#mesh=02-0400188 |
| 226022-00:007 | 02-1900390 | 02-1900390 | Dowel Pin | Precision alignment pin for repeatable service positioning. | B | Hardened steel | Plain | 16 | EA | Yes | ERP-02-1900390 | PDM-02-1900390 | Default | In stock | 76 | 2 | Main | /cad-viewer/#mesh=02-1900390 |
| 226022-00:008 | 02-2000826 | 02-2000826 | Shoulder Screw | Precision shoulder screw used at moving guide interfaces. | A | Alloy steel | Black oxide | 16 | EA | Yes | ERP-02-2000826 | PDM-02-2000826 | Default | In stock | 64 | 2 | Main | /cad-viewer/#mesh=02-2000826 |
| 226022-00:009 | 01-1902147 | 01-1902147 | Side Cover | Replaceable side cover for protecting the actuator rail assembly. | C | Aluminum 6061-T6 | Clear anodized | 12 | EA | Yes | ERP-01-1902147 | PDM-01-1902147 | Default | Build to order | 0 | 12 | Machine Shop | /cad-viewer/#mesh=01-1902147 |
| 226022-00:010 | 12-1602868 | 12-1602868 | Bearing Block | Guide bearing support block for the carriage assembly. | B | Stainless steel 304 | Passivated | 12 | EA | Yes | ERP-12-1602868 | PDM-12-1602868 | Default | Low stock | 8 | 6 | Main | /cad-viewer/#mesh=12-1602868 |
| 226022-00:011 | 02-1400674 | 02-1400674 | Retaining Ring | Service retaining ring for shaft and pin retention. | A | Spring steel | Phosphate | 6 | EA | Yes | ERP-02-1400674 | PDM-02-1400674 | Default | In stock | 180 | 1 | Main | /cad-viewer/#mesh=02-1400674 |
| 226022-00:012 | 05-1500006 | 05-1500006 | Pneumatic Fitting | Push-to-connect fitting for actuator air lines. | A | Nickel-plated brass | Nickel plated | 6 | EA | Yes | ERP-05-1500006 | PDM-05-1500006 | Default | In stock | 34 | 2 | Main | /cad-viewer/#mesh=05-1500006 |
| 226022-00:013 | 01-1900022 | 01-1900022 | End Plate | Machined end plate for the actuator housing. | B | Aluminum 6061-T6 | Clear anodized | 5 | EA | Yes | ERP-01-1900022 | PDM-01-1900022 | Default | Build to order | 0 | 10 | Machine Shop | /cad-viewer/#mesh=01-1900022 |
| 226022-00:014 | 01-1902146 | 01-1902146 | Guard Plate | Replacement guard plate for the main carriage. | B | Aluminum 6061-T6 | Clear anodized | 5 | EA | Yes | ERP-01-1902146 | PDM-01-1902146 | Default | Low stock | 4 | 7 | Main | /cad-viewer/#mesh=01-1902146 |
| 226022-00:015 | 08-1601061 | 08-1601061 | Sensor Bracket | Adjustable bracket for actuator position sensing. | A | Stainless steel 304 | Passivated | 5 | EA | Yes | ERP-08-1601061 | PDM-08-1601061 | Default | In stock | 18 | 3 | Main | /cad-viewer/#mesh=08-1601061 |
| 226022-00:016 | 12-2300411 | 12-2300411 | Guide Rail Clamp | Customer-replaceable clamp for guide rail retention. | C | Stainless steel 304 | Passivated | 4 | EA | Yes | ERP-12-2300411 | PDM-12-2300411 | Default | In stock | 22 | 3 | Main | /cad-viewer/#mesh=12-2300411 |
| 226022-00:017 | 14-2100080 | 14-2100080 | Mounting Block | Machined block for locating customer-side tooling. | A | Aluminum 6061-T6 | Black anodized | 4 | EA | Yes | ERP-14-2100080 | PDM-14-2100080 | Default | Build to order | 0 | 14 | Machine Shop | /cad-viewer/#mesh=14-2100080 |
| 226022-00:018 | 01-1600055 | 01-1600055 | Service Cover Plate | Replacement cover plate for the 133-9601 subassembly. | B | Aluminum 6061-T6 | Clear anodized | 1 | EA | Yes | ERP-01-1600055 | PDM-01-1600055 | Default | In stock | 11 | 3 | Main | /cad-viewer/#mesh=01-1600055 |
| 226022-00:019 | 133-100-03-2/133-1010-03-2/133-1011-03-1/12-2600649-1 | 12-2600649-1 | Service Replacement Part | Customer-requested catalog part from the 133-100-03-2 assembly path. | TBD | TBD | TBD | 1 | EA | Yes | ERP-12-2600649-1 | PDM-12-2600649-1 | Default | Build to order | 0 | 14 | Machine Shop | /cad-viewer/#mesh=133-100-03-2%2F133-1010-03-2%2F133-1011-03-1%2F12-2600649-1 |
| 226022-00:020 | 01-1100015_90 | 01-1100015 | Base Frame Weldment | Main frame weldment. Contact support for service options. | D | Carbon steel | Powder coat | 1 | EA | No | ERP-01-1100015 | PDM-01-1100015 | 90 Degree | Inventory unknown |  |  |  | /cad-viewer/#mesh=01-1100015_90 |
