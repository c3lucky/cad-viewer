import path from "node:path";
import { readEasmCatalog } from "../lib/easm-metadata.js";

const inputPath = process.argv[2];

if (!inputPath) {
  console.error("Usage: node scripts/extract-easm-metadata.js <file.easm>");
  process.exit(1);
}

const catalog = await readEasmCatalog(path.resolve(inputPath));
console.log(JSON.stringify(catalog, null, 2));
