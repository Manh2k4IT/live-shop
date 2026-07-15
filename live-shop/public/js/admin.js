const API = window.location.origin && window.location.origin !== "null"
  ? window.location.origin
  : "http://localhost:3000";
const state = { products: [], orders: [] };
const DEFAULT_SHOP_LOGO = "/uploads/logogusa.jpg";
const DEFAULT_PUBLIC_SHOP_URL = "https://shop.gusa.vn";
const DEFAULT_UPLOAD_MAX_FILE_SIZE_MB = 12;
let productSortable = null;
const PRODUCT_CATEGORIES = ["Áo", "Quần", "Chân váy", "Đầm", "Khác"];
let variantRowsData = [];
let shopPublicUrl = DEFAULT_PUBLIC_SHOP_URL;
let uploadMaxFileSizeMb = DEFAULT_UPLOAD_MAX_FILE_SIZE_MB;

function sanitizeOrigin(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch (error) {
    return "";
  }
}

function getShopBaseOrigin() {
  const host = String(window.location.hostname || "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1") {
    return window.location.origin;
  }

  return sanitizeOrigin(shopPublicUrl) || window.location.origin;
}

function parseColorStockInput(value) {
  const qty = Number(String(value || "").trim());
  if (!Number.isFinite(qty) || qty < 0) return null;
  return Math.floor(qty);
}

function getFileIdentity(file) {
  return `${file.name}__${file.size}__${file.lastModified}`;
}

function updateVariantFilesHint() {
  const hint = document.getElementById("imagesFilesHint");
  if (!hint) return;

  const totalRows = variantRowsData.length;
  const withImage = variantRowsData.filter((row) => Boolean(row.file || row.existingUrl)).length;

  if (!totalRows) {
    hint.textContent = "Mỗi dòng gồm ảnh màu bên trái và tên màu bên phải";
    return;
  }

  hint.textContent = `Đã tạo ${totalRows} dòng màu, có ảnh ở ${withImage} dòng`;
}

function createVariantRowData(name = "", existingUrl = "", colorStock = null) {
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: String(name || "").trim(),
    existingUrl: String(existingUrl || "").trim(),
    colorStock: Number.isFinite(Number(colorStock)) ? Math.max(0, Math.floor(Number(colorStock))) : null,
    file: null
  };
}

function getVariantPreviewUrl(row) {
  if (row.file) return URL.createObjectURL(row.file);
  return row.existingUrl || "https://placehold.co/88x88?text=No+Image";
}

function cleanupVariantObjectUrls() {
  document.querySelectorAll(".variant-image-preview[data-object-url='true']").forEach((img) => {
    URL.revokeObjectURL(img.src);
  });
}

function syncVariantNamesByIndex() {
  variantRowsData.forEach((row, index) => {
    if (!row.name) {
      row.name = `Màu ${index + 1}`;
    }
  });
}

function getVariantRowsTotalStock() {
  return variantRowsData.reduce((sum, row) => {
    const qty = Number(row?.colorStock);
    if (!Number.isFinite(qty) || qty < 0) return sum;
    return sum + Math.floor(qty);
  }, 0);
}

function syncTotalStockInputFromRows() {
  const stockInput = document.getElementById("stock");
  if (!stockInput) return;

  const hasRowStock = variantRowsData.some((row) => Number.isFinite(Number(row?.colorStock)));
  if (!hasRowStock) return;

  stockInput.value = String(getVariantRowsTotalStock());
}

function renderVariantRows() {
  const container = document.getElementById("variantRows");
  if (!container) return;

  cleanupVariantObjectUrls();

  if (!variantRowsData.length) {
    container.innerHTML = '<div class="variant-empty">Chưa có màu nào. Bấm "Thêm màu" để tạo dòng mới.</div>';
    updateVariantFilesHint();
    syncTotalStockInputFromRows();
    return;
  }

  container.innerHTML = variantRowsData.map((row, index) => {
    const previewUrl = getVariantPreviewUrl(row);
    const isObjectUrl = row.file ? "true" : "false";
    return `
      <div class="variant-row" data-row-id="${row.id}">
        <div class="variant-row-image-col">
          <img class="variant-image-preview" data-object-url="${isObjectUrl}" src="${previewUrl}" alt="Ảnh màu ${index + 1}" loading="lazy" decoding="async" />
          <input type="file" class="variant-file-input" accept="image/*" onchange="onVariantFileChange('${row.id}', this)" />
        </div>
        <div class="variant-row-name-col">
          <input
            type="text"
            class="variant-name-input"
            value="${String(row.name || "").replace(/"/g, "&quot;")}"
            placeholder="Tên màu (vd: Đen)"
            oninput="onVariantNameInput('${row.id}', this.value)"
          />
          <input
            type="text"
            class="variant-stock-input"
            value="${Number.isFinite(Number(row.colorStock)) ? String(Math.max(0, Math.floor(Number(row.colorStock)))) : ""}"
            placeholder="Tồn cho màu này (vd: 7)"
            oninput="onVariantStocksInput('${row.id}', this.value)"
          />
        </div>
        <button type="button" class="variant-remove-btn" onclick="removeVariantRow('${row.id}')" title="Xóa dòng màu">✕</button>
      </div>
    `;
  }).join("");

  updateVariantFilesHint();
  syncTotalStockInputFromRows();
}

function addVariantRow(defaultName = "", existingUrl = "") {
  variantRowsData.push(createVariantRowData(defaultName, existingUrl));
  syncVariantNamesByIndex();
  renderVariantRows();
}

function removeVariantRow(rowId) {
  const before = variantRowsData.length;
  variantRowsData = variantRowsData.filter((row) => row.id !== rowId);
  if (before === variantRowsData.length) return;
  syncVariantNamesByIndex();
  renderVariantRows();
}

function onVariantFileChange(rowId, input) {
  const row = variantRowsData.find((item) => item.id === rowId);
  if (!row) return;

  const nextFile = input?.files?.[0] || null;
  if (!nextFile) return;

  row.file = nextFile;
  row.existingUrl = "";
  renderVariantRows();
}

function onVariantNameInput(rowId, value) {
  const row = variantRowsData.find((item) => item.id === rowId);
  if (!row) return;
  row.name = String(value || "").trimStart();
}

function onVariantStocksInput(rowId, value) {
  const row = variantRowsData.find((item) => item.id === rowId);
  if (!row) return;
  row.colorStock = parseColorStockInput(value);
  syncTotalStockInputFromRows();
}

function getAdminCategory() {
  const category = new URLSearchParams(window.location.search).get("category") || "";
  return category.trim();
}

function normalizeCategoryKey(value) {
  return String(value || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function getShopCategoryUrl(category) {
  const normalized = String(category || "").trim();
  const base = getShopBaseOrigin();
  return normalized
    ? `${base}/shop.html?category=${encodeURIComponent(normalized)}`
    : `${base}/shop.html`;
}

function getProductShopUrl(product) {
  const id = Number(product?.id);
  const base = getShopBaseOrigin();
  if (!Number.isFinite(id)) return `${base}/shop.html`;
  return `${base}/shop.html?productId=${encodeURIComponent(String(id))}`;
}

function updateCategoryNavActive() {
  const currentCategory = getAdminCategory();

  document.querySelectorAll(".nav-submenu-link").forEach((link) => {
    const linkUrl = new URL(link.href, window.location.href);
    const linkCategory = linkUrl.searchParams.get("category") || "";
    const normalizedLinkCategory = linkCategory.trim();
    const isActive = currentCategory
      ? normalizedLinkCategory === currentCategory
      : normalizedLinkCategory === "";

    link.classList.toggle("active", isActive);
  });
}

function setupCategoryNavLinks() {
  document.querySelectorAll(".nav-submenu-link").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const category = (link.dataset.category || "").trim();
      const targetUrl = category
        ? `/admin.html?category=${encodeURIComponent(category)}`
        : "/admin.html";

      window.location.assign(targetUrl);
    });
  });
}

function formatOrderTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
}

function getOrderSubtotal(order) {
  const subtotal = Number(order?.subtotal);
  if (Number.isFinite(subtotal) && subtotal >= 0) return subtotal;

  const total = Number(order?.total || 0);
  const shippingFee = Number(order?.shippingFee);
  if (Number.isFinite(shippingFee) && shippingFee >= 0) {
    return Math.max(0, total - shippingFee);
  }

  return Math.max(0, total);
}

function getOrderShippingFee(order) {
  const shippingFee = Number(order?.shippingFee);
  if (Number.isFinite(shippingFee) && shippingFee >= 0) return shippingFee;

  const subtotal = getOrderSubtotal(order);
  if (subtotal <= 0) return 0;
  return subtotal < 1000000 ? 30000 : 35000;
}

function getOrderGrandTotal(order) {
  const subtotal = getOrderSubtotal(order);
  const shippingFee = getOrderShippingFee(order);
  return subtotal + shippingFee;
}

function resetProductForm() {
  const currentCategory = getAdminCategory();
  const name = document.getElementById("name");
  const sku = document.getElementById("sku");
  const price = document.getElementById("price");
  const oldPrice = document.getElementById("oldPrice");
  const stock = document.getElementById("stock");
  const category = document.getElementById("category");
  const imageUrl = document.getElementById("imageUrl");
  const modalTitle = document.getElementById("modal-title");
  const saveBtn = document.querySelector(".btn-save");
  const productId = document.getElementById("productId");

  variantRowsData = [];

  if (productId) productId.value = "";
  if (name) name.value = "";
  if (sku) sku.value = "";
  if (price) price.value = "";
  if (oldPrice) oldPrice.value = "";
  if (stock) stock.value = "";
  if (category) category.value = PRODUCT_CATEGORIES.includes(currentCategory) ? currentCategory : PRODUCT_CATEGORIES[0];
  if (imageUrl) imageUrl.value = "";
  if (modalTitle) modalTitle.textContent = "➕ Thêm sản phẩm";
  if (saveBtn) saveBtn.textContent = "Lưu sản phẩm";
  addVariantRow();
  updateVariantFilesHint();
}

function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 1800);
}

function applyBrandLogo(logoUrl) {
  const logoEl = document.getElementById("adminBrandLogo");
  if (!logoEl) return;
  logoEl.src = String(logoUrl || DEFAULT_SHOP_LOGO);
}

async function loadBrandSettings() {
  try {
    const res = await fetch(API + "/settings");
    const data = await res.json();
    if (!res.ok) return;
    applyBrandLogo(data.shopLogo);
    shopPublicUrl = sanitizeOrigin(data.shopPublicUrl) || DEFAULT_PUBLIC_SHOP_URL;
    const serverLimit = Number(data.uploadMaxFileSizeMb);
    uploadMaxFileSizeMb = Number.isFinite(serverLimit) && serverLimit > 0
      ? Math.floor(serverLimit)
      : DEFAULT_UPLOAD_MAX_FILE_SIZE_MB;
  } catch (error) {
    applyBrandLogo(DEFAULT_SHOP_LOGO);
  }
}

function triggerLogoPicker() {
  const input = document.getElementById("adminLogoFile");
  if (input) input.click();
}

async function handleLogoFileChange(input) {
  const file = input?.files?.[0] || null;
  if (!file) return;

  try {
    const uploadedUrl = await uploadImage(file);
    const saveRes = await fetch(API + "/settings/logo", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logoUrl: uploadedUrl })
    });

    const saveData = await saveRes.json().catch(() => ({}));
    if (!saveRes.ok) {
      throw new Error(saveData.error || "Không thể cập nhật logo");
    }

    applyBrandLogo(saveData.shopLogo || uploadedUrl);
    showToast("Đã cập nhật logo");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Lỗi khi đổi logo");
  } finally {
    if (input) input.value = "";
  }
}

function exportOrdersExcel() {
  const orders = state.orders || [];
  if (!orders.length) {
    showToast("Không có đơn hàng để xuất");
    return;
  }

  const rows = orders.map((order) => ({
    "Tạm tính": getOrderSubtotal(order).toLocaleString("vi-VN") + "đ",
    "Phí ship": getOrderShippingFee(order).toLocaleString("vi-VN") + "đ",
    "Tổng thanh toán": getOrderGrandTotal(order).toLocaleString("vi-VN") + "đ",
    "Mã đơn": order.id || "",
    "Khách hàng": order.customer || "",
    "Số điện thoại": order.phone || "",
    "Địa chỉ": order.address || "",
    "Thời gian": formatOrderTime(order.createdAt),
    "Trạng thái": {
      pending: "Chờ xử lý",
      confirmed: "Đã xác nhận",
      done: "Hoàn tất"
    }[order.status] || order.status || "",
    "Sản phẩm": (order.items || []).map((item) => {
      const variantPart = item.variantName ? ` (${item.variantName}${item.size ? ` - ${item.size}` : ""})` : (item.size ? ` (${item.size})` : "");
      return `${item.name}${variantPart} x${item.qty}`;
    }).join("; ")
  }));

  const headers = Object.keys(rows[0]);
  const csvContent = [headers.join(",")].concat(rows.map((row) => headers.map((header) => `"${String(row[header]).replace(/"/g, '""')}"`).join(","))).join("\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "orders.csv";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  showToast("Đã xuất file Excel");
}

function exportOrdersPDF() {
  const orders = state.orders || [];
  if (!orders.length) {
    showToast("Không có đơn hàng để xuất");
    return;
  }

  const rows = orders.map((order) => [
    order.id || "",
    order.customer || "",
    order.phone || "",
    order.address || "",
    formatOrderTime(order.createdAt),
    getOrderShippingFee(order).toLocaleString("vi-VN") + "đ",
    getOrderGrandTotal(order).toLocaleString("vi-VN") + "đ",
    {
      pending: "Chờ xử lý",
      confirmed: "Đã xác nhận",
      done: "Hoàn tất"
    }[order.status] || order.status || "",
    (order.items || []).map((item) => {
      const variantPart = item.variantName ? ` (${item.variantName}${item.size ? ` - ${item.size}` : ""})` : (item.size ? ` (${item.size})` : "");
      return `${item.name}${variantPart} x${item.qty}`;
    }).join("; ")
  ]);

  const printWindow = window.open("", "", "width=900,height=700");
  if (!printWindow) {
    showToast("Trình duyệt chặn cửa sổ in");
    return;
  }

  const tableRows = rows.map((row) => `
    <tr>
      ${row.map((cell) => `<td>${String(cell).replace(/\n/g, "<br>")}</td>`).join("")}
    </tr>
  `).join("");

  printWindow.document.write(`
    <html>
      <head>
        <title>Danh sách đơn hàng</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 24px; color: #111; }
          h1 { font-size: 22px; margin-bottom: 12px; }
          table { width: 100%; border-collapse: collapse; font-size: 12px; }
          th, td { border: 1px solid #ccc; padding: 8px; text-align: left; vertical-align: top; }
          th { background: #f3f4f6; }
        </style>
      </head>
      <body>
        <h1>Danh sách đơn hàng</h1>
        <table>
          <thead>
            <tr>
              <th>Mã đơn</th>
              <th>Khách hàng</th>
              <th>SĐT</th>
              <th>Địa chỉ</th>
              <th>Thời gian</th>
              <th>Phí ship</th>
              <th>Tổng thanh toán</th>
              <th>Trạng thái</th>
              <th>Sản phẩm</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </body>
    </html>
  `);
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
  showToast("Đã mở bản xem trước PDF");
}

function openModal(product = null) {
  const modal = document.getElementById("modal");
  const modalTitle = document.getElementById("modal-title");
  const saveBtn = document.querySelector(".btn-save");
  const productId = document.getElementById("productId");
  const name = document.getElementById("name");
  const sku = document.getElementById("sku");
  const price = document.getElementById("price");
  const oldPrice = document.getElementById("oldPrice");
  const stock = document.getElementById("stock");
  const category = document.getElementById("category");
  const imageUrl = document.getElementById("imageUrl");

  if (modal) {
    modal.style.display = "flex";
    modal.classList.add("show");
  }

  if (product) {
    if (productId) productId.value = product.id;
    if (name) name.value = product.name || "";
    if (sku) sku.value = product.sku || "";
    if (price) price.value = product.price || "";
    if (oldPrice) oldPrice.value = product.oldPrice || "";
    if (stock) stock.value = product.stock || "";
    if (category) category.value = product.category || PRODUCT_CATEGORIES[0];
    if (imageUrl) imageUrl.value = product.image || "";
    variantRowsData = [];
    const images = Array.isArray(product.images)
      ? product.images.filter(Boolean)
      : (product.image ? [product.image] : []);
    const names = Array.isArray(product.variantNames)
      ? product.variantNames
      : images.map((_, index) => `Màu ${index + 1}`);
    const rowStocks = Array.isArray(product.variantColorStocks)
      ? product.variantColorStocks
      : (Array.isArray(product.variantStocks)
        ? product.variantStocks
        : []);
    const fallbackStock = Number(product.stock || 0);
    const rowCount = Math.max(images.length, names.length, 1);
    for (let index = 0; index < rowCount; index += 1) {
      const nameValue = String(names[index] || "").trim() || `Màu ${index + 1}`;
      const imageUrlValue = String(images[index] || "").trim();
      const rowStockValue = rowStocks[index];
      const stocksValue = Number.isFinite(Number(rowStockValue))
        ? Number(rowStockValue)
        : (rowStockValue && typeof rowStockValue === "object"
            ? Object.values(rowStockValue).reduce((sum, qty) => {
                const n = Number(qty);
                return Number.isFinite(n) ? sum + Math.max(0, Math.floor(n)) : sum;
              }, 0)
            : fallbackStock);
      variantRowsData.push(createVariantRowData(nameValue, imageUrlValue, stocksValue));
    }
    renderVariantRows();
    updateVariantFilesHint();
    syncTotalStockInputFromRows();
    if (modalTitle) modalTitle.textContent = "✏️ Sửa sản phẩm";
    if (saveBtn) saveBtn.textContent = "Cập nhật";
  } else {
    resetProductForm();
  }
}

function closeModal() {
  const modal = document.getElementById("modal");
  if (modal) {
    modal.style.display = "none";
    modal.classList.remove("show");
  }
  resetProductForm();
}

function previewImage() {
  const input = document.getElementById("imageFile");
  const preview = document.getElementById("preview");

  if (!input || !preview) return;

  const file = input.files && input.files[0];
  if (!file) {
    preview.src = document.getElementById("imageUrl")?.value || "https://placehold.co/250x250?text=Preview";
    return;
  }

  const reader = new FileReader();
  reader.onload = function (e) {
    preview.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function switchTab(tabName) {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });

  document.querySelectorAll(".view-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `${tabName}-view`);
  });
}

async function load() {
  const loading = document.getElementById("loading");
  const list = document.getElementById("list");
  const search = (document.getElementById("search")?.value || "").toLowerCase();
  const category = getAdminCategory();

  updateCategoryNavActive();

  if (loading) loading.style.display = "block";

  try {
    const productsUrl = category ? `${API}/products/all?category=${encodeURIComponent(category)}` : `${API}/products/all`;
    const res = await fetch(productsUrl);
    const data = await res.json();
    const normalizedCurrentCategory = normalizeCategoryKey(category);
    const sourceData = Array.isArray(data) ? data : [];
    const categoryScopedData = category
      ? sourceData.filter((p) => normalizeCategoryKey(p.category || "Khác") === normalizedCurrentCategory)
      : sourceData;
    state.products = categoryScopedData;

    const headerTitle = document.querySelector("#products-view .header h1");
    const headerDesc = document.querySelector("#products-view .header p");
    const addBtn = document.querySelector(".header .btn-add");
    const shopLink = document.getElementById("shop-link");
    if (headerTitle) {
      headerTitle.textContent = category ? `📦 Quản lý kho - ${category}` : "📦 Quản lý kho Livestream";
    }
    if (headerDesc) {
      headerDesc.textContent = category ? `Đang quản lý riêng danh mục ${category}` : "Quản lý sản phẩm nhanh cho phiên livestream";
    }
    if (addBtn) {
      addBtn.textContent = category ? `+ Thêm sản phẩm vào ${category}` : "+ Thêm sản phẩm";
    }
    if (shopLink) {
      shopLink.href = getShopCategoryUrl(category);
      shopLink.textContent = category ? `🛒 Giỏ hàng ${category}` : "🛒 Xem giỏ hàng";
    }

    const filtered = categoryScopedData.filter((p) => {
      const haystack = `${p.name || ""} ${p.sku || ""}`.toLowerCase();
      return haystack.includes(search);
    });

    let html = "";
    filtered.forEach((p) => {
      const status = p.stock <= 0 ? "Hết hàng" : p.stock <= 3 ? "Sắp hết" : "Còn hàng";
      const categoryLabel = p.category || "Khác";
      const isHidden = category ? Boolean(p.hidden) : Boolean(p.hiddenGlobal);
      const visibilityLabel = isHidden ? "Đang ẩn" : "Đang hiện";
      html += `
        <tr class="product-row ${isHidden ? "is-hidden" : ""}" data-product-id="${p.id}">
          <td class="drag-cell">
            <span class="drag-handle" data-product-id="${p.id}" title="Giữ và kéo để đổi thứ tự">☰</span>
          </td>
          <td><img src="${p.image || "https://placehold.co/80x80?text=No+Image"}" width="60" height="60" loading="lazy" decoding="async" style="object-fit:cover"></td>
          <td class="product-name-cell">
            <div class="product-name-wrap">
              <span class="product-title">${p.name}</span>
              <span class="product-sku">${visibilityLabel}</span>
              ${p.sku ? `<span class="product-sku">SKU: ${p.sku}</span>` : ""}
            </div>
          </td>
          <td>${categoryLabel}</td>
          <td>
            <div class="price-cell">
              <span class="price-live">${Number(p.price || 0).toLocaleString()}đ</span>
              ${p.oldPrice ? `<span class="price-old">${Number(p.oldPrice).toLocaleString()}đ</span>` : ""}
            </div>
          </td>
          <td>
            <div class="stock-inline">
              <input type="number" min="0" value="${p.stock}" id="stock-${p.id}" />
              <button onclick="updateStock(${p.id})">Cập nhật</button>
            </div>
          </td>
          <td>${status}</td>
          <td>
            <div class="action">
              <a class="product-link-btn" href="${getProductShopUrl(p)}" target="_blank" rel="noopener noreferrer" title="Mở link riêng sản phẩm">🔗</a>
              <button class="toggle-visibility ${isHidden ? "show" : "hide"}" onclick="toggleProductVisibility(${p.id})" title="${isHidden ? "Hiện sản phẩm" : "Ẩn sản phẩm"}">${isHidden ? "👁️" : "🙈"}</button>
              <button class="edit" onclick="editProduct(${p.id})" title="Sửa sản phẩm">✏️</button>
              <button class="delete" onclick="deleteProduct(${p.id})" title="Xóa sản phẩm">🗑️</button>
            </div>
          </td>
        </tr>
      `;
    });

    if (list) list.innerHTML = html || '<tr><td colspan="8">Không có sản phẩm</td></tr>';
    setupProductDragAndDrop();

    const totalProduct = document.getElementById("totalProduct");
    const totalStock = document.getElementById("totalStock");
    const lowStock = document.getElementById("lowStock");
    const outStock = document.getElementById("outStock");

    if (totalProduct) totalProduct.textContent = categoryScopedData.length;
    if (totalStock) totalStock.textContent = categoryScopedData.reduce((sum, p) => sum + Number(p.stock || 0), 0);
    if (lowStock) lowStock.textContent = categoryScopedData.filter((p) => p.stock > 0 && p.stock <= 3).length;
    if (outStock) outStock.textContent = categoryScopedData.filter((p) => Number(p.stock || 0) <= 0).length;
  } catch (error) {
    console.error(error);
    showToast("Lỗi khi tải dữ liệu");
  } finally {
    if (loading) loading.style.display = "none";
  }
}

async function refreshDashboard() {
  await Promise.all([load(), loadOrders()]);
}

async function uploadImage(file) {
  if (!file) return "";

  if (!String(file.type || "").toLowerCase().startsWith("image/")) {
    throw new Error("File đã chọn không phải ảnh hợp lệ");
  }

  const maxBytes = Math.max(1, Number(uploadMaxFileSizeMb) || DEFAULT_UPLOAD_MAX_FILE_SIZE_MB) * 1024 * 1024;
  if (Number(file.size || 0) > maxBytes) {
    const sizeMb = (Number(file.size || 0) / (1024 * 1024)).toFixed(2);
    throw new Error(`Ảnh \"${file.name || "không rõ tên"}\" nặng ${sizeMb}MB, vượt giới hạn ${uploadMaxFileSizeMb}MB`);
  }

  const formData = new FormData();
  formData.append("image", file);

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), 45000)
    : null;

  let res;
  try {
    res = await fetch(API + "/upload", {
      method: "POST",
      body: formData,
      signal: controller ? controller.signal : undefined
    });
  } catch (error) {
    if (controller && error?.name === "AbortError") {
      throw new Error("Upload ảnh quá lâu, vui lòng thử ảnh nhẹ hơn hoặc thử lại");
    }

    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (parseError) {
    data = { error: raw || "Phản hồi upload không hợp lệ" };
  }

  if (!res.ok) {
    throw new Error(data.error || "Không thể upload ảnh");
  }

  return data.url || "";
}

async function saveProduct() {
  const name = document.getElementById("name").value.trim();
  const sku = document.getElementById("sku").value.trim();
  const category = document.getElementById("category").value;
  const price = document.getElementById("price").value;
  const oldPrice = document.getElementById("oldPrice").value;
  const stock = document.getElementById("stock").value;
  const productId = document.getElementById("productId").value;
  const saveBtn = document.querySelector(".btn-save");

  if (!name) {
    showToast("Vui lòng nhập tên sản phẩm");
    return;
  }

  if (!category) {
    showToast("Vui lòng chọn danh mục");
    return;
  }

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.dataset.defaultText = saveBtn.textContent;
    saveBtn.textContent = "Đang lưu...";
  }

  try {
    const isEditing = Boolean(productId);

    const normalizedRows = variantRowsData
      .map((row, index) => ({
        ...row,
        name: String(row.name || "").trim() || `Màu ${index + 1}`,
        colorStock: Number.isFinite(Number(row.colorStock))
          ? Math.max(0, Math.floor(Number(row.colorStock)))
          : null
      }))
      .filter((row) => row.file || row.existingUrl);

    const uploadedVariantImages = await Promise.all(
      normalizedRows.map((row) => (row.file ? uploadImage(row.file) : Promise.resolve("")))
    );

    const existingProduct = isEditing
      ? state.products.find((item) => String(item.id) === String(productId))
      : null;

    const fallbackExistingImages = Array.isArray(existingProduct?.images)
      ? existingProduct.images.filter(Boolean)
      : (existingProduct?.image ? [existingProduct.image] : []);

    const firstUploadedVariantImage = uploadedVariantImages.find((url) => String(url || "").trim()) || "";
    const firstExistingVariantImage = normalizedRows.find((row) => String(row.existingUrl || "").trim())?.existingUrl || "";
    const baseVariantImage = firstUploadedVariantImage || firstExistingVariantImage || fallbackExistingImages[0] || "";

    const finalVariantRows = normalizedRows
      .map((row, index) => ({
        name: row.name,
        image: uploadedVariantImages[index] || row.existingUrl || fallbackExistingImages[index] || baseVariantImage,
        colorStock: Number.isFinite(Number(row.colorStock)) ? Math.max(0, Math.floor(Number(row.colorStock))) : null
      }));

    const images = finalVariantRows.length
      ? finalVariantRows.map((row) => row.image || baseVariantImage).filter(Boolean)
      : fallbackExistingImages;

    const variantNames = finalVariantRows.length
      ? finalVariantRows.map((row, index) => row.name || `Màu ${index + 1}`)
      : images.map((_, index) => `Màu ${index + 1}`);

    const variantSizes = images.map((_, index) => {
      const existingRow = Array.isArray(existingProduct?.variantSizes) ? existingProduct.variantSizes[index] : [];
      return Array.isArray(existingRow)
        ? existingRow.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
    });

    const variantColorStocks = finalVariantRows.length
      ? finalVariantRows.map((row) => (Number.isFinite(Number(row.colorStock)) ? Math.max(0, Math.floor(Number(row.colorStock))) : null))
      : images.map(() => null);

    const normalizedStock = Number(stock);
    const finalStock = Number.isFinite(normalizedStock) ? Math.max(0, Math.floor(normalizedStock)) : 0;
    const hasRowStock = variantColorStocks.some((qty) => Number.isFinite(Number(qty)));
    const summedRowStock = hasRowStock
      ? variantColorStocks.reduce((sum, qty) => sum + (Number.isFinite(Number(qty)) ? Math.max(0, Math.floor(Number(qty))) : 0), 0)
      : 0;
    const stockValueForSave = String(stock || "").trim() !== ""
      ? (hasRowStock ? summedRowStock : finalStock)
      : summedRowStock;

    const sizes = Array.isArray(existingProduct?.sizes)
      ? existingProduct.sizes.map((item) => String(item || "").trim()).filter(Boolean)
      : [];

    const finalImage = images[0] || "";

    const res = await fetch(API + (isEditing ? `/product/${productId}` : "/product/add"), {
      method: isEditing ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, sku, category, price, oldPrice, stock: stockValueForSave, image: finalImage, images, variantNames, sizes, variantSizes, variantColorStocks })
    });
    const data = await res.json();

    if (!res.ok && data.error) {
      showToast(data.error);
      return;
    }

    showToast(isEditing ? "Đã cập nhật sản phẩm" : "Đã thêm sản phẩm");
    closeModal();
    await load();
    loadOrders();
  } catch (error) {
    console.error(error);
    showToast(error.message || "Lỗi khi lưu sản phẩm");
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = saveBtn.dataset.defaultText || (productId ? "Cập nhật" : "Lưu sản phẩm");
      delete saveBtn.dataset.defaultText;
    }
  }
}

async function loadOrders() {
  try {
    const res = await fetch(API + "/orders");
    const data = await res.json();
    state.orders = data;

    const list = document.getElementById("order-list");
    const search = (document.getElementById("order-search")?.value || "").toLowerCase();
    const totalOrders = document.getElementById("totalOrders");
    const pendingOrders = document.getElementById("pendingOrders");
    const confirmedOrders = document.getElementById("confirmedOrders");
    const doneOrders = document.getElementById("doneOrders");

    const filteredOrders = data.filter((order) => {
      const haystack = `${order.customer || ""} ${order.phone || ""} ${order.address || ""} ${order.id || ""}`.toLowerCase();
      return haystack.includes(search);
    });

    if (list) {
      list.innerHTML = filteredOrders.map((order) => {
        const statusText = {
          pending: "Chờ xử lý",
          confirmed: "Đã xác nhận",
          done: "Hoàn tất"
        }[order.status] || order.status;
        const subtotal = getOrderSubtotal(order);
        const shippingFee = getOrderShippingFee(order);
        const grandTotal = getOrderGrandTotal(order);

        const itemSummary = (order.items || []).map((item) => {
          const variantPart = item.variantName ? ` (${item.variantName}${item.size ? ` - ${item.size}` : ""})` : (item.size ? ` (${item.size})` : "");
          return `<span class="order-item-pill">${item.name}${variantPart} x${item.qty}</span>`;
        }).join("");

        const skuSummary = [...new Set((order.items || [])
          .map((item) => String(item.sku || "").trim())
          .filter(Boolean))].join(" • ") || "Chưa có SKU";

        return `
          <tr>
            <td class="order-customer-cell">
              <div class="order-customer-top">
                <span class="order-customer-name">${order.customer || "Khách lẻ"}</span>
                <span class="order-sku-chip">SKU: ${skuSummary}</span>
              </div>
              <div class="order-items-wrap">${itemSummary || '<span class="order-item-pill">Không có sản phẩm</span>'}</div>
            </td>
            <td class="order-phone-cell">${order.phone || "—"}</td>
            <td class="order-address-cell">${order.address || "—"}</td>
            <td class="order-time-cell">${formatOrderTime(order.createdAt)}</td>
            <td class="order-total-cell">
              <div class="order-money-row"><span>Tạm tính</span><strong>${subtotal.toLocaleString()}đ</strong></div>
              <div class="order-money-row"><span>Phí ship</span><strong>${shippingFee.toLocaleString()}đ</strong></div>
              <div class="order-money-row grand"><span>Tổng thanh toán</span><strong>${grandTotal.toLocaleString()}đ</strong></div>
            </td>
            <td><span class="order-badge ${order.status}">${statusText}</span></td>
            <td>
              <div class="order-actions">
                <select class="order-status-select ${order.status}" data-current-status="${order.status}" onchange="handleOrderAction(${order.id}, this)">
                  <option value="pending" ${order.status === "pending" ? "selected" : ""}>⏳ Chờ xử lý</option>
                  <option value="confirmed" ${order.status === "confirmed" ? "selected" : ""}>✓ Đã xác nhận</option>
                  <option value="done" ${order.status === "done" ? "selected" : ""}>✅ Hoàn tất</option>
                  <option value="delete">🗑️ Xóa đơn</option>
                </select>
              </div>
            </td>
          </tr>
        `;
      }).join("");
    }

    if (totalOrders) totalOrders.textContent = data.length;
    if (pendingOrders) pendingOrders.textContent = data.filter((order) => order.status === "pending").length;
    if (confirmedOrders) confirmedOrders.textContent = data.filter((order) => order.status === "confirmed").length;
    if (doneOrders) doneOrders.textContent = data.filter((order) => order.status === "done").length;
  } catch (error) {
    console.error(error);
    showToast("Lỗi khi tải đơn hàng");
  }
}

async function handleOrderAction(id, selectEl) {
  const nextAction = selectEl?.value;
  const currentStatus = selectEl?.dataset?.currentStatus || "pending";

  if (!nextAction) return;

  if (nextAction === "delete") {
    const deleted = await deleteOrder(id);
    if (!deleted && selectEl) {
      selectEl.value = currentStatus;
    }
    return;
  }

  const updated = await updateOrderStatus(id, nextAction);
  if (updated && selectEl) {
    selectEl.dataset.currentStatus = nextAction;
  } else if (selectEl) {
    selectEl.value = currentStatus;
  }
}

async function updateOrderStatus(id, status) {
  try {
    const res = await fetch(API + `/order/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });

    if (!res.ok) {
      throw new Error("Không thể cập nhật trạng thái");
    }

    showToast("Đã cập nhật trạng thái đơn hàng");
    await refreshDashboard();
    return true;
  } catch (error) {
    console.error(error);
    showToast("Lỗi cập nhật đơn hàng");
    return false;
  }
}

async function deleteOrder(id) {
  if (!confirm("Bạn có chắc muốn xóa đơn hàng này?")) return false;

  try {
    const res = await fetch(API + `/order/${id}`, {
      method: "DELETE"
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok && data.error) {
      showToast(data.error);
      return false;
    }

    showToast("Đã xóa đơn hàng");
    await refreshDashboard();
    return true;
  } catch (error) {
    console.error(error);
    showToast("Lỗi khi xóa đơn hàng");
    return false;
  }
}

async function updateStock(id) {
  const input = document.getElementById(`stock-${id}`);
  const stock = Number(input?.value || 0);

  try {
    const res = await fetch(API + "/product/stock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, stock })
    });

    if (!res.ok) {
      throw new Error("Không thể cập nhật tồn kho");
    }

    showToast("Đã cập nhật tồn kho");
    await refreshDashboard();
  } catch (error) {
    console.error(error);
    showToast("Lỗi cập nhật tồn kho");
  }
}

function editProduct(id) {
  const product = state.products.find((item) => item.id === id);
  if (product) {
    openModal(product);
  }
}

async function deleteProduct(id) {
  if (!confirm("Bạn có chắc muốn xóa sản phẩm này?")) return;

  try {
    const res = await fetch(API + `/product/${id}`, {
      method: "DELETE"
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok && data.error) {
      showToast(data.error);
      return;
    }

    showToast("Đã xóa sản phẩm");
    await refreshDashboard();
  } catch (error) {
    console.error(error);
    showToast("Lỗi khi xóa sản phẩm");
  }
}

async function toggleProductVisibility(id) {
  const category = getAdminCategory();

  try {
    const res = await fetch(API + "/product/toggle-hidden", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, category })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      showToast(data.error || "Không thể đổi trạng thái hiển thị");
      return;
    }

    showToast(data.hiddenState ? "Đã ẩn sản phẩm" : "Đã hiện sản phẩm");
    await refreshDashboard();
  } catch (error) {
    console.error(error);
    showToast("Lỗi đổi trạng thái hiển thị");
  }
}

function setupProductDragAndDrop() {
  const list = document.getElementById("list");
  if (!list || typeof Sortable === "undefined") return;

  if (productSortable) {
    productSortable.destroy();
  }

  productSortable = new Sortable(list, {
    animation: 160,
    handle: ".drag-handle",
    draggable: ".product-row",
    ghostClass: "drag-ghost",
    chosenClass: "drag-chosen",
    dragClass: "drag-dragging",
    onEnd: async () => {
      const searchValue = (document.getElementById("search")?.value || "").trim();
      if (searchValue) {
        showToast("Hãy xóa từ khóa tìm kiếm trước khi sắp xếp");
        await refreshDashboard();
        return;
      }

      const orderedIds = Array.from(list.querySelectorAll(".product-row"))
        .map((row) => Number(row.dataset.productId))
        .filter(Number.isFinite);

      if (orderedIds.length) {
        await reorderProducts(orderedIds);
      }
    }
  });
}

async function reorderProducts(orderedIds) {
  const category = getAdminCategory();

  try {
    const res = await fetch(API + "/product/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedIds, category })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      showToast(data.error || "Không thể đổi thứ tự sản phẩm");
      return;
    }

    showToast("Đã cập nhật thứ tự sản phẩm");
    await refreshDashboard();
  } catch (error) {
    console.error(error);
    showToast("Lỗi đổi thứ tự sản phẩm");
  }
}

window.openModal = openModal;
window.closeModal = closeModal;
window.previewImage = previewImage;
window.addVariantRow = addVariantRow;
window.removeVariantRow = removeVariantRow;
window.onVariantFileChange = onVariantFileChange;
window.onVariantNameInput = onVariantNameInput;
window.onVariantStocksInput = onVariantStocksInput;
window.saveProduct = saveProduct;
window.load = load;
window.switchTab = switchTab;
window.updateOrderStatus = updateOrderStatus;
window.deleteOrder = deleteOrder;
window.updateStock = updateStock;
window.editProduct = editProduct;
window.deleteProduct = deleteProduct;
window.toggleProductVisibility = toggleProductVisibility;
window.exportOrdersPDF = exportOrdersPDF;
window.exportOrdersExcel = exportOrdersExcel;
window.triggerLogoPicker = triggerLogoPicker;
window.handleLogoFileChange = handleLogoFileChange;

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

setupCategoryNavLinks();

loadBrandSettings();
refreshDashboard();
setInterval(() => {
  loadOrders();
}, 5000);
