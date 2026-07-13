import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const shareRoot = path.resolve(process.env.C3_SHARE_ROOT || "/media/c3projectshare");
const outputPath = path.resolve(
  process.env.C3_PROJECT_CATALOG_PATH ||
    path.join(process.cwd(), "data/shared-project-catalog.json")
);

const projectDirectories = await listProjectDirectories(shareRoot);
const projects = [];

for (const projectNumber of projectDirectories) {
  const projectRoot = path.join(shareRoot, projectNumber);
  const files = await walkFiles(projectRoot);
  const glbFiles = files.filter((file) => file.toLowerCase().endsWith(".glb"));
  const easmFiles = files.filter((file) => file.toLowerCase().endsWith(".easm"));
  const drawingFiles = files.filter((file) => /\.(dwg|dwf|step|stp|sldprt)$/i.test(file));
  const salesFiles = files.filter((file) => file.includes(`${path.sep}1. Sales & Quote${path.sep}`));
  const engineeringFiles = files.filter((file) =>
    file.includes(`${path.sep}2. Engineering${path.sep}`)
  );
  const finalDocumentationFiles = files.filter((file) =>
    file.includes(`${path.sep}6. Final Documentation${path.sep}`)
  );

  const models = [];
  const easmSummaries = [];
  const inferredParts = new Map();

  for (const easmPath of easmFiles) {
    easmSummaries.push(await readEasmSummary(easmPath));
  }

  for (const glbPath of glbFiles) {
    const model = await readGlbSummary(glbPath);
    if (!model) continue;

    for (const name of model.sampleNodeNames.concat(model.partNumberSamples)) {
      const partNumber = inferPartNumber(name);
      if (partNumber) inferredParts.set(partNumber, (inferredParts.get(partNumber) || 0) + 1);
    }

    models.push(model);
  }

  projects.push({
    projectNumber,
    path: projectRoot,
    fileCount: files.length,
    fileTypes: countExtensions(files),
    modelCount: glbFiles.length,
    easmCount: easmFiles.length,
    easmFiles: easmSummaries,
    drawingCount: drawingFiles.length,
    salesFileCount: salesFiles.length,
    engineeringFileCount: engineeringFiles.length,
    finalDocumentationFileCount: finalDocumentationFiles.length,
    hasProjectChecklist: files.some((file) => path.basename(file) === "Project Checklist.xlsx"),
    hasProjectNumberFile: files.some((file) => path.basename(file) === "Project Number -.txt"),
    hasAssociatedWorkOrdersFile: files.some(
      (file) => path.basename(file) === "Associated Work Orders.txt"
    ),
    models,
    inferredPartNumberSamples: [...inferredParts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 30)
      .map(([partNumber, count]) => ({ partNumber, count })),
  });
}

const summary = {
  generatedAt: new Date().toISOString(),
  source: shareRoot,
  projectCount: projects.length,
  fileCount: projects.reduce((sum, project) => sum + project.fileCount, 0),
  modelCount: projects.reduce((sum, project) => sum + project.modelCount, 0),
  easmCount: projects.reduce((sum, project) => sum + project.easmCount, 0),
  drawingCount: projects.reduce((sum, project) => sum + project.drawingCount, 0),
  fileTypes: mergeTypeCounts(projects.map((project) => project.fileTypes)),
  projects,
};

await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
await fs.promises.writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);

console.log(`Scanned ${summary.projectCount} projects and ${summary.fileCount} files.`);
console.log(`Found ${summary.modelCount} GLB models, ${summary.easmCount} EASM files.`);
console.log(`Wrote ${outputPath}`);

async function listProjectDirectories(root) {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function walkFiles(root) {
  const results = [];
  const entries = await fs.promises.readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkFiles(fullPath)));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }

  return results;
}

async function readGlbSummary(filePath) {
  const buffer = await fs.promises.readFile(filePath);
  if (buffer.length < 20 || buffer.toString("ascii", 0, 4) !== "glTF") return null;

  const jsonLength = buffer.readUInt32LE(12);
  const chunkType = buffer.toString("ascii", 16, 20);
  if (chunkType !== "JSON") return null;

  const gltf = JSON.parse(buffer.toString("utf8", 20, 20 + jsonLength));
  const nodeNames = (gltf.nodes || []).map((node) => node.name).filter(Boolean);
  const meshNames = (gltf.meshes || []).map((mesh) => mesh.name).filter(Boolean);
  const uniqueNames = [...new Set([...nodeNames, ...meshNames])];
  const partNumberSamples = uniqueNames.map(inferPartNumber).filter(Boolean);
  const stats = await fs.promises.stat(filePath);

  return {
    fileName: path.basename(filePath),
    storagePath: filePath,
    relativePath: path.relative(shareRoot, filePath),
    fileSizeBytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    nodeCount: (gltf.nodes || []).length,
    meshCount: (gltf.meshes || []).length,
    namedObjectCount: uniqueNames.length,
    sampleNodeNames: uniqueNames.slice(0, 20),
    partNumberSamples: [...new Set(partNumberSamples)].slice(0, 40),
  };
}

async function readEasmSummary(filePath) {
  const stats = await fs.promises.stat(filePath);
  const archiveEntries = await listZipEntries(filePath);
  const materialsSummary = archiveEntries.some((entry) => entry.name === "materials.xml")
    ? await readEasmMaterialsSummary(filePath)
    : null;

  return {
    fileName: path.basename(filePath),
    storagePath: filePath,
    relativePath: path.relative(shareRoot, filePath),
    fileSizeBytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    archiveEntries,
    materials: materialsSummary,
  };
}

async function listZipEntries(filePath) {
  try {
    const { stdout } = await execFileAsync("unzip", ["-l", filePath], { maxBuffer: 1024 * 1024 });
    return stdout
      .split("\n")
      .map((line) => line.match(/^\s*(\d+)\s+\S+\s+\S+\s+(.+)$/))
      .filter(Boolean)
      .map((match) => ({
        name: match[2].trim(),
        sizeBytes: Number(match[1]),
      }));
  } catch (error) {
    return [
      {
        name: "[unreadable zip directory]",
        error: error.message,
      },
    ];
  }
}

async function readEasmMaterialsSummary(filePath) {
  try {
    const { stdout } = await execFileAsync("unzip", ["-p", filePath, "materials.xml"], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const entityCount = (stdout.match(/<Entity\b/g) || []).length;
    const materialNames = [...stdout.matchAll(/\bMaterialName="([^"]*)"/g)]
      .map((match) => match[1])
      .filter(Boolean);
    const colorSamples = [...stdout.matchAll(/<MaterialColor1\b([^>]*)\/>/g)]
      .map((match) => {
        const red = readXmlNumberAttribute(match[1], "red");
        const green = readXmlNumberAttribute(match[1], "green");
        const blue = readXmlNumberAttribute(match[1], "blue");
        return red == null || green == null || blue == null ? null : { red, green, blue };
      })
      .filter(Boolean);

    return {
      entityCount,
      materialNames: countTopValues(materialNames, 20),
      colorSamples: uniqueColors(colorSamples).slice(0, 20),
    };
  } catch (error) {
    return {
      error: error.message,
    };
  }
}

function readXmlNumberAttribute(source, name) {
  const match = source.match(new RegExp(`\\b${name}="([^"]+)"`));
  return match ? Number(match[1]) : null;
}

function countTopValues(values, limit) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function uniqueColors(colors) {
  const seen = new Set();
  return colors.filter((color) => {
    const key = `${color.red},${color.green},${color.blue}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferPartNumber(name) {
  const leaf = String(name).split("/").pop() || "";
  const normalized = String(name).includes("/") ? leaf.replace(/-(?!00\b)\d{1,2}$/g, "") : leaf;
  const match = normalized.match(/\b(?:\d{2,6}|[A-Z]{2,}\d*)-\d{3,6}(?:-\d{2,4})?\b/i);
  return match ? match[0].toUpperCase() : null;
}

function countExtensions(files) {
  const counts = {};
  for (const file of files) {
    const ext = path.extname(file).slice(1).toLowerCase() || "[none]";
    counts[ext] = (counts[ext] || 0) + 1;
  }
  return sortObject(counts);
}

function mergeTypeCounts(typeCounts) {
  const merged = {};
  for (const counts of typeCounts) {
    for (const [ext, count] of Object.entries(counts)) {
      merged[ext] = (merged[ext] || 0) + count;
    }
  }
  return sortObject(merged);
}

function sortObject(value) {
  return Object.fromEntries(
    Object.entries(value).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  );
}
