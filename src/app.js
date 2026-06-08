import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

const MODEL_URL = "./models/226022-00.optimized.glb?v=20260608-optimized";
const DATA_ENDPOINTS = {
  catalog: "./mock-api/catalog.json",
  pricing: "./mock-api/pricing.json",
  inventory: "./mock-api/inventory.json",
};

const viewer = document.querySelector("#viewer");
const drawer = document.querySelector("#drawer");
const resetButton = document.querySelector("#reset-view");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf3f6f8);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
camera.position.set(240, 180, 260);

const renderer = new THREE.WebGLRenderer({
  antialias: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewer.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

scene.add(new THREE.HemisphereLight(0xffffff, 0x6c7885, 2.2));

const keyLight = new THREE.DirectionalLight(0xffffff, 2.5);
keyLight.position.set(180, 260, 180);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xffffff, 0.85);
fillLight.position.set(-220, 120, -180);
scene.add(fillLight);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const pickableMeshes = [];
const originalMaterials = new Map();
let selectedMesh = null;
let partData = {
  catalogByPartNumber: new Map(),
  priceBySku: new Map(),
  inventoryBySku: new Map(),
  sources: [],
};

init();

async function init() {
  resize();
  window.addEventListener("resize", resize);
  renderer.domElement.addEventListener("pointerdown", handlePick);
  resetButton.addEventListener("click", frameScene);

  partData = await loadPartData();
  await loadModel();
  animate();
}

async function loadPartData() {
  const [catalog, pricing, inventory] = await Promise.all([
    fetchJson(DATA_ENDPOINTS.catalog),
    fetchJson(DATA_ENDPOINTS.pricing),
    fetchJson(DATA_ENDPOINTS.inventory),
  ]);

  return {
    catalogByPartNumber: new Map(
      (catalog.parts || []).map((part) => [part.partNumber, part])
    ),
    priceBySku: new Map((pricing.prices || []).map((price) => [price.sku, price])),
    inventoryBySku: new Map(
      (inventory.locations || []).map((item) => [item.sku, item])
    ),
    currency: pricing.currency || "USD",
    sources: [catalog.source, pricing.source, inventory.source].filter(Boolean),
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function loadModel() {
  showMessage("Loading model...");

  try {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(MODEL_URL);
    const model = gltf.scene;

    model.traverse((node) => {
      if (!node.isMesh) return;

      node.castShadow = true;
      node.receiveShadow = true;
      node.userData.partNumber = getPartKey(node);
      pickableMeshes.push(node);
    });

    scene.add(model);
    clearMessage();
    frameScene();
  } catch (error) {
    console.warn(error);
    showMessage(
      "Model file not found yet. Convert the STEP assembly to models/226022-00.glb, preserving part names, then reload this page."
    );
  }
}

function getPartKey(mesh) {
  return (
    mesh.userData.partNumber ||
    mesh.userData.name ||
    mesh.name ||
    mesh.parent?.name ||
    "Unknown Part"
  );
}

function handlePick(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(scene.children, true)[0];
  if (!hit) return;

  const mesh = findPickableMesh(hit.object);
  if (!mesh) return;

  selectMesh(mesh);
}

function findPickableMesh(object) {
  while (object && !object.isMesh) {
    object = object.parent;
  }

  if (!object || !object.isMesh) return null;
  if (!pickableMeshes.includes(object)) {
    pickableMeshes.push(object);
    object.userData.partNumber = getPartKey(object);
  }

  return object;
}

function selectMesh(mesh) {
  if (selectedMesh && originalMaterials.has(selectedMesh)) {
    selectedMesh.material = originalMaterials.get(selectedMesh);
  }

  selectedMesh = mesh;
  originalMaterials.set(mesh, mesh.material);
  mesh.material = mesh.material.clone();

  if ("emissive" in mesh.material) {
    mesh.material.emissive = new THREE.Color(0x1a8fbb);
    mesh.material.emissiveIntensity = 0.28;
  }

  renderDrawer(mesh.userData.partNumber);
}

function renderDrawer(partNumber) {
  const catalog = partData.catalogByPartNumber.get(partNumber) || {
    partNumber,
    sku: partNumber,
    title: partNumber,
    description:
      "No catalog metadata matched this mesh name. The production pipeline should map this node to a PDM/ERP part record.",
    material: "TBD",
    finish: "TBD",
    quantityInAssembly: "TBD",
    orderable: false,
  };
  const price = partData.priceBySku.get(catalog.sku);
  const inventory = partData.inventoryBySku.get(catalog.sku);
  const canOrder = catalog.orderable && price && inventory;

  drawer.innerHTML = `
    <div class="drawer-body">
      <span class="part-number">${escapeHtml(catalog.partNumber)}</span>
      <h2>${escapeHtml(catalog.title || catalog.partNumber)}</h2>
      <p>${escapeHtml(catalog.description || "")}</p>

      <div class="status-strip">
        ${statusPill(catalog.orderable ? "Orderable" : "Contact support", catalog.orderable)}
        ${statusPill(inventory?.stockStatus || "Inventory unknown", Boolean(inventory))}
      </div>

      <div class="detail-list">
        ${detailRow("SKU / ERP item", catalog.sku || catalog.erpItemId)}
        ${detailRow("Material", catalog.material)}
        ${detailRow("Finish", catalog.finish)}
        ${detailRow("Revision", catalog.revision)}
        ${detailRow("Quantity in assembly", catalog.quantityInAssembly)}
        ${detailRow("Unit price", formatPrice(price, partData.currency))}
        ${detailRow("Available quantity", inventory?.availableQuantity)}
        ${detailRow("Lead time", inventory ? `${inventory.leadTimeDays} days` : null)}
        ${detailRow("Warehouse", inventory?.warehouse)}
        ${detailRow("PDM file ID", catalog.pdmFileId)}
      </div>

      <section class="data-sources">
        <h3>Data pulled from</h3>
        ${partData.sources.map((source) => `<span>${escapeHtml(source)}</span>`).join("")}
      </section>
    </div>

    <footer class="drawer-footer">
      <label for="order-qty">Quantity</label>
      <input id="order-qty" type="number" min="1" value="1" ${canOrder ? "" : "disabled"} />
      <button id="quote-button" class="quote-button" type="button" ${canOrder ? "" : "disabled"}>
        Get A Quote
      </button>
      <button id="order-button" class="order-button" type="button" ${canOrder ? "" : "disabled"}>
        Order Now
      </button>
      <p class="order-note">
        ${escapeHtml(getOrderNote(catalog, price, inventory))}
      </p>
    </footer>
  `;

  drawer.querySelector("#quote-button")?.addEventListener("click", () => {
    const payload = createOrderPayload(catalog);
    console.info("Mock quote API payload", payload);
    drawer.querySelector(".order-note").textContent =
      "Mock quote request created. Production will send this SKU and quantity to the quote API.";
  });

  drawer.querySelector("#order-button")?.addEventListener("click", () => {
    const payload = createOrderPayload(catalog);
    console.info("Mock order API payload", payload);
    drawer.querySelector(".order-note").textContent =
      "Mock order line created. Production will send this SKU and quantity to the cart API.";
  });
}

function createOrderPayload(catalog) {
  const quantity = Number(drawer.querySelector("#order-qty")?.value || 1);

  return {
      assemblyId: "226022-00",
      partNumber: catalog.partNumber,
      sku: catalog.sku,
      quantity,
  };
}

function statusPill(label, positive) {
  return `<span class="status-pill ${positive ? "positive" : "neutral"}">${escapeHtml(label)}</span>`;
}

function formatPrice(price, currency) {
  if (!price) return null;

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(price.unitPrice);
}

function getOrderNote(catalog, price, inventory) {
  if (!catalog.orderable) return "This item is marked non-orderable in PDM/CAD metadata.";
  if (!price) return "No ERP price was returned for this SKU.";
  if (!inventory) return "No inventory record was returned for this SKU.";

  return "Ready for mock quote. Production will send this SKU and quantity to the ordering API.";
}

function detailRow(label, value) {
  if (!value) return "";

  return `
    <div class="detail-row">
      <div class="detail-label">${escapeHtml(label)}</div>
      <div class="detail-value">${escapeHtml(String(value))}</div>
    </div>
  `;
}

function frameScene() {
  const box = new THREE.Box3().setFromObject(scene);
  if (box.isEmpty()) return;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.75 || 100;

  camera.position.copy(center).add(new THREE.Vector3(radius, radius * 0.7, radius));
  camera.near = Math.max(radius / 1000, 0.1);
  camera.far = radius * 20;
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.update();
}

function resize() {
  const { clientWidth, clientHeight } = viewer;
  camera.aspect = clientWidth / Math.max(clientHeight, 1);
  camera.updateProjectionMatrix();
  renderer.setSize(clientWidth, clientHeight, false);
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

function showMessage(text) {
  clearMessage();
  const message = document.createElement("div");
  message.className = "viewer-message";
  message.innerHTML = `<div>${escapeHtml(text)}</div>`;
  viewer.appendChild(message);
}

function clearMessage() {
  viewer.querySelector(".viewer-message")?.remove();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
