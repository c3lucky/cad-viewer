import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

const MODEL_URLS = [
  "./models/226022-00_COMP.glb?v=20260617-comp",
  "./models/226022-00.glb?v=20260612-fallback",
];
const DATA_ENDPOINTS = {
  catalog: "./mock-api/catalog.json",
  inventory: "./mock-api/inventory.json",
};

const viewer = document.querySelector("#viewer");
const drawer = document.querySelector("#drawer");
const resetButton = document.querySelector("#reset-view");
let basketButton = null;
let checkoutPage = null;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
camera.position.set(240, 180, 260);

const renderer = new THREE.WebGLRenderer({
  alpha: true,
  antialias: false,
  powerPreference: "high-performance",
});
renderer.setClearColor(0x000000, 0);
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
let needsRender = true;
let partData = {
  catalogByPartNumber: new Map(),
  inventoryBySku: new Map(),
  sources: [],
};
const collectionItems = [];

init();

async function init() {
  setupBasketUi();
  showModelSkeleton("Preparing 3D assembly");
  renderDrawerSkeleton();
  resize();
  window.addEventListener("resize", () => {
    resize();
    requestRender();
  });
  window.addEventListener("hashchange", syncRoute);
  renderer.domElement.addEventListener("pointerdown", handlePick);
  resetButton?.addEventListener("click", () => {
    frameScene();
    requestRender();
  });

  try {
    partData = await loadPartData();
    await loadModel();
    if (!selectedMesh) renderEmptyDrawer();
  } catch (error) {
    console.error("Unable to initialize the viewer.", error);
    showMessage(`Unable to load viewer data: ${error.message}`);
    renderDrawerError(error);
  }
  controls.addEventListener("change", requestRender);
  syncRoute();
  animate();
}

function requestRender() {
  needsRender = true;
}

async function loadPartData() {
  const [catalog, inventory] = await Promise.all([
    fetchJson(DATA_ENDPOINTS.catalog),
    fetchJson(DATA_ENDPOINTS.inventory),
  ]);

  return {
    catalogByPartNumber: new Map(
      (catalog.parts || []).map((part) => [part.partNumber, part])
    ),
    inventoryBySku: new Map(
      (inventory.locations || []).map((item) => [item.sku, item])
    ),
    sources: [catalog.source, inventory.source].filter(Boolean),
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function loadModel() {
  showModelSkeleton("Loading 3D assembly");

  try {
    const gltf = await loadFirstAvailableModel();
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
    requestRender();
  } catch (error) {
    console.error("Unable to load the 3D model.", error);
    showMessage(`Unable to load the 3D model: ${error.message}`);
    throw error;
  }
}

async function loadFirstAvailableModel() {
  const errors = [];
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath(
    "https://unpkg.com/three@0.165.0/examples/jsm/libs/draco/"
  );

  for (const url of MODEL_URLS) {
    try {
      const loader = new GLTFLoader();
      loader.setDRACOLoader(dracoLoader);
      loader.setMeshoptDecoder(MeshoptDecoder);
      return await loader.loadAsync(url);
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
      console.warn(`Model load failed for ${url}`, error);
    }
  }

  throw new Error(errors.join("; "));
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

function renderDrawerSkeleton() {
  drawer.innerHTML = `
    <div class="drawer-body drawer-skeleton" aria-hidden="true">
      <span class="skeleton skeleton-chip"></span>
      <span class="skeleton skeleton-title"></span>
      <span class="skeleton skeleton-copy"></span>
      <span class="skeleton skeleton-copy short"></span>
      <div class="skeleton-status">
        <span class="skeleton skeleton-pill"></span>
        <span class="skeleton skeleton-pill"></span>
      </div>
      <div class="skeleton-grid">
        <span class="skeleton skeleton-row"></span>
        <span class="skeleton skeleton-row"></span>
        <span class="skeleton skeleton-row"></span>
        <span class="skeleton skeleton-row"></span>
        <span class="skeleton skeleton-row"></span>
      </div>
    </div>
    <footer class="drawer-footer drawer-footer-skeleton" aria-hidden="true">
      <span class="skeleton skeleton-button"></span>
      <span class="skeleton skeleton-button"></span>
    </footer>
  `;
}

function renderEmptyDrawer() {
  drawer.innerHTML = `
    <div class="drawer-empty">
      <div class="empty-mark" aria-hidden="true">
        <span></span>
        <span></span>
      </div>
      <p class="eyebrow">Part Details</p>
      <h2>Select a part</h2>
      <p>Click any component in the assembly to view part information and collect parts for a quote or order request.</p>
      <div class="empty-hints" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
      </div>
    </div>
  `;
}

function renderDrawerError(error) {
  drawer.innerHTML = `
    <div class="drawer-empty">
      <p class="eyebrow">Details Unavailable</p>
      <h2>Unable to load part data</h2>
      <p>${escapeHtml(error.message)}</p>
    </div>
  `;
}

function renderDrawer(partNumber) {
  const catalog = resolveCatalog(partNumber);
  const inventory = partData.inventoryBySku.get(catalog.sku);
  const canCollect = catalog.orderable;
  const isCollected = collectionItems.some((item) => item.sku === catalog.sku);

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

    <footer class="drawer-footer collection-footer">
      <button id="collect-button" class="order-button" type="button" ${canCollect ? "" : "disabled"}>
        ${escapeHtml(isCollected ? "Add Another" : "Collect Part")}
      </button>
      <a href="#basket" class="basket-link">View Collection</a>
      <p class="order-note">${escapeHtml(getCollectionNote(catalog, inventory, isCollected))}</p>
    </footer>
  `;

  drawer.querySelector("#collect-button")?.addEventListener("click", () => {
    addCollectionItem(catalog, inventory);
    renderDrawer(catalog.partNumber);
  });
}

function resolveCatalog(partNumber) {
  if (partData.catalogByPartNumber.has(partNumber)) {
    return partData.catalogByPartNumber.get(partNumber);
  }

  const candidates = getPartCandidates(partNumber);
  for (const candidate of candidates) {
    if (partData.catalogByPartNumber.has(candidate)) {
      return partData.catalogByPartNumber.get(candidate);
    }
  }

  for (const catalog of partData.catalogByPartNumber.values()) {
    if (candidates.includes(catalog.sku) || candidates.includes(catalog.erpItemId)) {
      return catalog;
    }
  }

  return {
    partNumber,
    sku: partNumber,
    title: partNumber,
    description:
      "No catalog metadata matched this mesh name. This part may need review by the service team.",
    material: "TBD",
    finish: "TBD",
    quantityInAssembly: "TBD",
    orderable: false,
  };
}

function getPartCandidates(partNumber) {
  const segments = String(partNumber).split("/");
  const last = segments.at(-1) || partNumber;
  const withoutInstance = last.replace(/-\d+$/, "");
  const withoutConfig = withoutInstance.replace(/_.+$/, "");
  return [...new Set([partNumber, last, withoutInstance, withoutConfig])];
}

function setupBasketUi() {
  basketButton = document.createElement("a");
  basketButton.className = "basket-button";
  basketButton.href = "#basket";
  basketButton.textContent = "Collection";
  document.querySelector(".workspace")?.appendChild(basketButton);

  checkoutPage = document.createElement("section");
  checkoutPage.className = "checkout-page";
  checkoutPage.setAttribute("aria-label", "Part collection and requests");
  document.body.appendChild(checkoutPage);
  renderBasketButton();
  renderCheckoutPage();
}

function addCollectionItem(catalog, inventory) {
  const key = catalog.sku || catalog.partNumber;
  const existing = collectionItems.find((item) => item.key === key);

  if (existing) {
    existing.quantity += 1;
    existing.updatedAt = new Date().toISOString();
  } else {
    collectionItems.push({
      key,
      assemblyId: "226022-00",
      partNumber: catalog.partNumber,
      sku: catalog.sku,
      title: catalog.title || catalog.partNumber,
      quantity: 1,
      stockStatus: inventory?.stockStatus || "Inventory unknown",
      leadTimeDays: inventory?.leadTimeDays || null,
      updatedAt: new Date().toISOString(),
    });
  }

  renderBasketButton();
}

function renderBasketButton() {
  if (!basketButton) return;

  const count = collectionItems.reduce((total, item) => total + item.quantity, 0);
  basketButton.innerHTML = `
    <span>Collection</span>
    <strong>${escapeHtml(count)}</strong>
  `;
}

function syncRoute() {
  const isBasket = window.location.hash === "#basket";
  document.body.classList.toggle("show-checkout", isBasket);
  if (isBasket) renderCheckoutPage();
}

function renderCheckoutPage() {
  if (!checkoutPage) return;

  checkoutPage.innerHTML = `
    <div class="checkout-shell">
      <header class="checkout-header">
        <div>
          <p class="eyebrow">Collection</p>
          <h1>Collected Parts</h1>
        </div>
        <a href="#" class="text-button">Back To Viewer</a>
      </header>

      ${
        collectionItems.length
          ? `
            ${basketSection("Parts To Request", collectionItems)}

            <section class="checkout-summary">
              <div>
                <span>Unique parts</span>
                <strong>${escapeHtml(collectionItems.length)}</strong>
              </div>
              <div>
                <span>Total pieces</span>
                <strong>${escapeHtml(collectionItems.reduce((total, item) => total + item.quantity, 0))}</strong>
              </div>
              <div>
                <span>Pricing</span>
                <strong>Provided by quote</strong>
              </div>
            </section>

            <section class="quote-delivery">
              <div>
                <p class="eyebrow">Next Step</p>
                <h2>Request quote or place order</h2>
                <p>Send the collected parts to the quoting or ordering workflow. Pricing stays off the public viewer.</p>
              </div>
              <label for="customer-email">Customer email</label>
              <div class="quote-email-row">
                <input id="customer-email" type="email" placeholder="customer@example.com" />
                <button id="request-quote" class="quote-button" type="button">Request Quote</button>
                <button id="request-order" class="order-button" type="button">Place Order Request</button>
              </div>
              <p id="request-status" class="order-note">Collected parts will be packaged with item details, quantities, availability, and lead times.</p>
            </section>

            <section class="checkout-actions">
              <button id="clear-basket" type="button">Clear Collection</button>
            </section>
          `
          : `
            <section class="empty-basket">
              <p class="eyebrow">No Lines Added</p>
              <h2>Select parts in the CAD viewer, then collect them for quote or order.</h2>
              <a href="#" class="order-button">Return To Viewer</a>
            </section>
          `
      }
    </div>
  `;

  checkoutPage.querySelector("#request-quote")?.addEventListener("click", () => {
    submitCollectionRequest("quote");
  });

  checkoutPage.querySelector("#request-order")?.addEventListener("click", () => {
    submitCollectionRequest("order");
  });

  checkoutPage.querySelector("#clear-basket")?.addEventListener("click", () => {
    collectionItems.length = 0;
    renderBasketButton();
    renderCheckoutPage();
  });
}

function submitCollectionRequest(requestKind) {
  const emailInput = checkoutPage.querySelector("#customer-email");
  const status = checkoutPage.querySelector("#request-status");
  const customerEmail = emailInput?.value.trim();

  if (!customerEmail || !emailInput.checkValidity()) {
    status.textContent = "Enter a valid customer email before submitting the request.";
    emailInput?.focus();
    return;
  }

  const payload = createCollectionPayload(requestKind, customerEmail);
  console.info(`${requestKind} request payload`, payload);
  status.textContent =
    requestKind === "quote"
      ? `Quote request ${payload.requestNumber} submitted for ${customerEmail}.`
      : `Order request ${payload.requestNumber} submitted for ${customerEmail}.`;
}

function createCollectionPayload(requestKind, customerEmail) {
  return {
    requestKind,
    assemblyId: "226022-00",
    customerEmail,
    requestNumber: createRequestNumber(requestKind),
    lines: collectionItems.map(toCheckoutLine),
  };
}

function basketSection(title, items) {
  return `
    <section class="basket-section">
      <header>
        <h2>${escapeHtml(title)}</h2>
        <strong>${escapeHtml(items.length)} lines</strong>
      </header>
      ${
        items.length
          ? items.map(basketItem).join("")
          : `<p class="empty-section">No ${escapeHtml(title.toLowerCase())} yet.</p>`
      }
    </section>
  `;
}

function basketItem(item) {
  return `
    <article class="basket-item">
      <div>
        <span class="part-number">${escapeHtml(item.sku)}</span>
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.partNumber)}</p>
      </div>
      <dl>
        <div>
          <dt>Qty</dt>
          <dd>${escapeHtml(item.quantity)}</dd>
        </div>
        <div>
          <dt>Lead</dt>
          <dd>${escapeHtml(item.leadTimeDays ? `${item.leadTimeDays} days` : "TBD")}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>${escapeHtml(item.stockStatus)}</dd>
        </div>
      </dl>
    </article>
  `;
}

function toCheckoutLine(item) {
  return {
    assemblyId: item.assemblyId,
    partNumber: item.partNumber,
    sku: item.sku,
    quantity: item.quantity,
    stockStatus: item.stockStatus,
    leadTimeDays: item.leadTimeDays,
  };
}

function createRequestNumber(requestKind) {
  const stamp = new Date()
    .toISOString()
    .slice(2, 10)
    .replaceAll("-", "");
  const prefix = requestKind === "quote" ? "Q" : "O";
  return `${prefix}-${stamp}-${String(collectionItems.length).padStart(3, "0")}`;
}

function statusPill(label, positive) {
  return `<span class="status-pill ${positive ? "positive" : "neutral"}">${escapeHtml(label)}</span>`;
}

function getCollectionNote(catalog, inventory, isCollected) {
  if (!catalog.orderable) return "This item is marked non-orderable in PDM/CAD metadata.";
  if (!inventory) return "No inventory record was returned for this SKU. It can still be reviewed by sales.";
  if (isCollected) return "This part is already in the collection. Add another if more than one is needed.";

  return "Ready to collect. Pricing will be handled during quote or order review.";
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

  if (!needsRender) return;
  renderer.render(scene, camera);
  needsRender = false;
}

function showMessage(text) {
  clearMessage();
  const message = document.createElement("div");
  message.className = "viewer-message";
  message.innerHTML = `<div>${escapeHtml(text)}</div>`;
  viewer.appendChild(message);
}

function showModelSkeleton(label) {
  clearMessage();
  const message = document.createElement("div");
  message.className = "viewer-message viewer-loading";
  message.innerHTML = `
    <div class="model-skeleton">
      <div class="model-skeleton-stage" aria-hidden="true">
        <span class="model-axis x"></span>
        <span class="model-axis y"></span>
        <span class="model-part part-a"></span>
        <span class="model-part part-b"></span>
        <span class="model-part part-c"></span>
        <span class="model-part part-d"></span>
      </div>
      <div class="model-loading-copy">
        <span class="skeleton skeleton-chip"></span>
        <strong>${escapeHtml(label)}</strong>
        <span class="skeleton skeleton-copy"></span>
      </div>
    </div>
  `;
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
