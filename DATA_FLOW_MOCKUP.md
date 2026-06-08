# Mock Data Flow

The public viewer now mocks the future production integrations with static JSON
files. The JavaScript uses `fetch()` against these files exactly like it would
call real APIs later.

## Current Mock Sources

```text
mock-api/catalog.json
mock-api/pricing.json
mock-api/inventory.json
mock-api/order-preview.json
```

## Production Equivalent

```text
Customer clicks GLB mesh
  -> mesh.name / occurrenceId
  -> PDM/CAD metadata API resolves partNumber + SKU
  -> ERP pricing API returns current price
  -> ERP inventory API returns stock and lead time
  -> drawer renders customer-facing details
  -> Add to Quote sends SKU + quantity to ecommerce/cart API
```

## Integration Contract

The viewer needs a stable ID from the GLB mesh:

```text
mesh.name = partNumber
```

or:

```text
mesh.name = occurrenceId
```

If the mesh uses `occurrenceId`, the catalog API must map it back to a SKU.

## Future API Shape

Catalog:

```http
GET /api/assemblies/226022-00/parts/{meshId}
```

Pricing:

```http
GET /api/pricing/{sku}
```

Inventory:

```http
GET /api/inventory/{sku}
```

Cart:

```http
POST /api/cart/items
```

Payload:

```json
{
  "assemblyId": "226022-00",
  "partNumber": "14-2600102",
  "sku": "14-2600102",
  "quantity": 1
}
```

