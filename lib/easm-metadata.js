import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const partNumberPattern = /\b(?:\d{2,6}|[A-Z]{2,}\d*)-\d{2,7}(?:-\d{1,4})?\b/i;

export async function readEasmCatalog(easmPath) {
  const eModel = await readZipEntry(easmPath, "eModel");
  const blocks = extractZlibBlocks(eModel);
  const text = blocks.map((block) => extractReadableText(block.data)).join("\n");
  const components = parseComponentLines(text);
  const partMap = new Map();

  for (const component of components) {
    if (!component.partNumber) continue;

    const existing = partMap.get(component.partNumber) || {
      partNumber: component.partNumber,
      sku: component.partNumber,
      title: component.description || component.partNumber,
      description: component.description || "",
      material: "",
      finish: "",
      revision: "",
      quantityInAssembly: 0,
      orderable: true,
      source: "EASM",
      aliases: [],
      occurrences: [],
    };

    existing.quantityInAssembly += 1;
    existing.occurrences.push({
      name: component.name,
      displayName: component.displayName,
      path: component.componentPath,
    });
    existing.aliases.push(...component.aliases);

    if (!existing.description && component.description) {
      existing.description = component.description;
      existing.title = component.description;
    }

    partMap.set(component.partNumber, existing);
  }

  const parts = [...partMap.values()].sort((a, b) => a.partNumber.localeCompare(b.partNumber));
  for (const part of parts) {
    part.aliases = [...new Set(part.aliases.filter(Boolean))].sort();
  }

  return {
    source: `EASM metadata: ${path.basename(easmPath)}`,
    generatedAt: new Date().toISOString(),
    fileName: path.basename(easmPath),
    compressedBlockCount: blocks.length,
    componentCount: components.length,
    partCount: parts.length,
    parts,
  };
}

async function readZipEntry(zipPath, entryName) {
  const { stdout } = await execFileAsync("unzip", ["-p", zipPath, entryName], {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

function extractZlibBlocks(buffer) {
  const blocks = [];

  for (let offset = 0; offset < buffer.length - 2; offset += 1) {
    const byte = buffer[offset];
    const next = buffer[offset + 1];
    if (byte !== 0x78 || ![0x01, 0x5e, 0x9c, 0xda].includes(next)) continue;

    try {
      const data = zlib.inflateSync(buffer.subarray(offset), {
        finishFlush: zlib.constants.Z_SYNC_FLUSH,
      });
      if (data.length > 32) blocks.push({ offset, data });
    } catch {
      // Ignore coincidental bytes that look like zlib stream headers.
    }
  }

  return blocks;
}

function extractReadableText(buffer) {
  return [...buffer.toString("latin1").matchAll(/[ -~]{3,}/g)]
    .map((match) => match[0])
    .join("\n");
}

function parseComponentLines(text) {
  return text
    .split("\n")
    .filter((line) => line.includes("componentdescription=") && line.includes("mbd_comp_name="))
    .map(parseComponentLine)
    .filter(Boolean);
}

function parseComponentLine(line) {
  const fields = parseKeyValueLine(line);
  const name = fields.name || "";
  const displayName = fields["display name"] || fields.fulldescriptionname || name;
  const partNumber =
    getPartNumber(fields.fulldescriptionname) ||
    getPartNumber(displayName) ||
    getPartNumber(name) ||
    getPartNumber(fields.mbd_comp_name);

  if (!partNumber) return null;

  return {
    name,
    displayName,
    partNumber,
    description: cleanDescription(fields.componentdescription || displayName || partNumber),
    componentPath: fields.mbd_comp_name || "",
    componentReference: fields.componentreference || "",
    aliases: buildAliases({
      partNumber,
      name,
      displayName,
      fullDescriptionName: fields.fulldescriptionname || "",
      componentPath: fields.mbd_comp_name || "",
    }),
  };
}

function buildAliases(component) {
  const ownPathSegment = component.componentPath.split("/").at(-1) || "";
  const values = [
    component.partNumber,
    component.name,
    component.displayName,
    component.fullDescriptionName,
    component.componentPath,
    ownPathSegment,
    ownPathSegment.split("@")[0],
  ];

  return [...new Set(values.flatMap(getLookupCandidates).filter(Boolean))];
}

function parseKeyValueLine(line) {
  const fields = {};
  const keys = [
    "name",
    "mbd_comp_name",
    "fulldescriptionname",
    "display name",
    "componentdescription",
    "componentreference",
  ];

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const startToken = `${key}=`;
    const start = line.indexOf(startToken);
    if (start === -1) continue;

    const valueStart = start + startToken.length;
    const nextKey = keys
      .slice(index + 1)
      .map((candidate) => line.indexOf(`,${candidate}=`, valueStart))
      .filter((position) => position !== -1)
      .sort((a, b) => a - b)[0];
    const rawValue = line.slice(valueStart, nextKey === undefined ? undefined : nextKey);
    fields[key] = stripValue(rawValue);
  }

  return fields;
}

function stripValue(value) {
  const trimmed = String(value || "").trim().replace(/,$/, "");
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) return trimmed.slice(1, -1);
  return trimmed;
}

function getPartNumber(value) {
  const withoutInstance = String(value || "")
    .replace(/\([^)]*\)/g, "")
    .replace(/<\d+>/g, "")
    .replace(/-\d+$/g, "");
  return withoutInstance.match(partNumberPattern)?.[0]?.toUpperCase() || "";
}

function getLookupCandidates(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];

  const leaf = raw.split("/").at(-1) || raw;
  const beforeAt = leaf.split("@")[0] || leaf;
  const withoutAngleInstance = beforeAt.replace(/<\d+>/g, "");
  const withoutParenText = withoutAngleInstance.replace(/\([^)]*\)/g, "");
  const withoutDashInstance =
    (withoutParenText.match(/-/g) || []).length > 1
      ? withoutParenText.replace(/-\d+$/g, "")
      : withoutParenText;
  const withoutConfig = withoutDashInstance.replace(/_.+$/, "");
  const inferred = getPartNumber(withoutConfig);

  return [
    raw,
    leaf,
    beforeAt,
    withoutAngleInstance,
    withoutParenText,
    withoutDashInstance,
    withoutConfig,
    inferred,
  ].map((candidate) => candidate.trim());
}

function cleanDescription(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}
