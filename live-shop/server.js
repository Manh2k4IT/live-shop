const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const compression = require("compression");
const { rateLimit } = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
let sharp = null;

try {
    sharp = require("sharp");
} catch (error) {
    sharp = null;
}

const app = express();

const requestJsonLimit = process.env.REQUEST_JSON_LIMIT || "256kb";
const compressionThresholdBytes = Math.max(256, Number(process.env.COMPRESSION_THRESHOLD_BYTES) || 1024);
const writeRateWindowMs = Math.max(1000, Number(process.env.WRITE_RATE_WINDOW_MS) || 10000);
const writeRateMax = Math.max(20, Number(process.env.WRITE_RATE_MAX) || 120);
const checkoutRateWindowMs = Math.max(1000, Number(process.env.CHECKOUT_RATE_WINDOW_MS) || 10000);
const checkoutRateMax = Math.max(5, Number(process.env.CHECKOUT_RATE_MAX) || 30);
const uploadMaxFileSizeMb = Math.max(1, Number(process.env.UPLOAD_MAX_FILE_SIZE_MB) || 12);
const uploadMaxFileSizeBytes = uploadMaxFileSizeMb * 1024 * 1024;
const shopPublicUrl = String(process.env.SHOP_PUBLIC_URL || "https://shop.gusa.vn").trim();
const imageOptimizeEnabled = String(process.env.IMAGE_OPTIMIZE_ENABLED || "true").toLowerCase() !== "false";
const imageMaxWidthPx = Math.max(640, Number(process.env.IMAGE_MAX_WIDTH_PX) || 1600);
const imageQuality = Math.min(95, Math.max(50, Number(process.env.IMAGE_QUALITY) || 82));
const imageOptimizeMinBytes = Math.max(50 * 1024, Number(process.env.IMAGE_OPTIMIZE_MIN_BYTES) || (300 * 1024));
const uploadsCacheMaxAgeSec = Math.max(60, Number(process.env.UPLOADS_CACHE_MAX_AGE_SEC) || (30 * 24 * 60 * 60));
const maxInflightRequests = Math.max(50, Number(process.env.MAX_INFLIGHT_REQUESTS) || 800);
const cartSessionCookieName = process.env.CART_SESSION_COOKIE || "live_shop_sid";
const cartSessionMaxAgeMs = Math.max(60_000, Number(process.env.CART_SESSION_MAX_AGE_MS) || (30 * 24 * 60 * 60 * 1000));
let inflightRequests = 0;

app.set("trust proxy", 1);

app.use(cors());
app.use(compression({ threshold: compressionThresholdBytes }));
app.use(express.json({ limit: requestJsonLimit }));
app.use(express.urlencoded({ extended: false, limit: requestJsonLimit }));

app.use((req, res, next) => {
    if (inflightRequests >= maxInflightRequests) {
        return res.status(503).json({ error: "Server đang quá tải, vui lòng thử lại" });
    }

    inflightRequests += 1;

    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        inflightRequests = Math.max(0, inflightRequests - 1);
    };

    res.on("finish", release);
    res.on("close", release);
    next();
});

function parseCookieHeader(headerValue) {
    const source = String(headerValue || "");
    if (!source) return {};

    return source.split(";").reduce((acc, pair) => {
        const [rawKey, ...rest] = pair.split("=");
        const key = String(rawKey || "").trim();
        if (!key) return acc;
        acc[key] = decodeURIComponent(rest.join("=") || "");
        return acc;
    }, {});
}

function createSessionId() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return crypto.randomBytes(16).toString("hex");
}

function normalizeSessionId(value) {
    const sid = String(value || "").trim();
    if (!sid) return "";
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(sid)) return "";
    return sid;
}

app.use((req, res, next) => {
    const cookies = parseCookieHeader(req.headers.cookie);
    let sessionId = normalizeSessionId(cookies[cartSessionCookieName]);

    if (!sessionId) {
        sessionId = createSessionId().replace(/[^a-zA-Z0-9_-]/g, "");
        const isSecure = Boolean(req.secure || String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https");
        const cookieParts = [
            `${cartSessionCookieName}=${encodeURIComponent(sessionId)}`,
            "Path=/",
            `Max-Age=${Math.floor(cartSessionMaxAgeMs / 1000)}`,
            "HttpOnly",
            "SameSite=Lax"
        ];

        if (isSecure) cookieParts.push("Secure");
        res.setHeader("Set-Cookie", cookieParts.join("; "));
    }

    req.sessionId = sessionId;
    next();
});

app.use(express.static("public"));

const writeLimiter = rateLimit({
    windowMs: writeRateWindowMs,
    max: writeRateMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Quá nhiều thao tác, vui lòng thử lại sau vài giây" }
});

const checkoutLimiter = rateLimit({
    windowMs: checkoutRateWindowMs,
    max: checkoutRateMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Bạn thao tác đặt hàng quá nhanh, vui lòng thử lại" }
});

app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
        return res.status(400).json({ error: "Dữ liệu JSON không hợp lệ" });
    }

    next(err);
});

/* ===========================
   Upload folder
=========================== */

const uploadDir = process.env.UPLOAD_DIR
    ? path.resolve(process.env.UPLOAD_DIR)
    : path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

app.use("/uploads", express.static(uploadDir, {
    maxAge: uploadsCacheMaxAgeSec * 1000,
    immutable: true,
    etag: true
}));

const OPTIMIZABLE_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

async function optimizeImageFile(filePath) {
    if (!imageOptimizeEnabled || !sharp) return { optimized: false, reason: "disabled" };

    const extension = path.extname(String(filePath || "")).toLowerCase();
    if (!OPTIMIZABLE_IMAGE_EXTENSIONS.has(extension)) return { optimized: false, reason: "unsupported" };

    const sourceStats = await fs.promises.stat(filePath);
    if (!sourceStats || sourceStats.size < imageOptimizeMinBytes) {
        return { optimized: false, reason: "too-small" };
    }

    const tempPath = `${filePath}.optimized`;
    const pipeline = sharp(filePath, { failOn: "none" })
        .rotate()
        .resize({
            width: imageMaxWidthPx,
            withoutEnlargement: true,
            fit: "inside"
        });

    if (extension === ".png") {
        pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
    } else if (extension === ".webp") {
        pipeline.webp({ quality: imageQuality, effort: 4 });
    } else {
        pipeline.jpeg({ quality: imageQuality, mozjpeg: true, progressive: true });
    }

    await pipeline.toFile(tempPath);

    const optimizedStats = await fs.promises.stat(tempPath);
    const shouldReplace = optimizedStats.size < sourceStats.size * 0.98;

    if (!shouldReplace) {
        await fs.promises.unlink(tempPath).catch(() => {});
        return { optimized: false, reason: "no-gain" };
    }

    await fs.promises.copyFile(tempPath, filePath);
    await fs.promises.unlink(tempPath).catch(() => {});
    return { optimized: true, beforeBytes: sourceStats.size, afterBytes: optimizedStats.size };
}

async function optimizeExistingUploadsInBackground() {
    if (!imageOptimizeEnabled || !sharp) return;

    let optimizedCount = 0;
    let totalSavedBytes = 0;

    try {
        const entries = await fs.promises.readdir(uploadDir, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const filePath = path.join(uploadDir, entry.name);

            try {
                const result = await optimizeImageFile(filePath);
                if (result.optimized) {
                    optimizedCount += 1;
                    totalSavedBytes += Math.max(0, Number(result.beforeBytes || 0) - Number(result.afterBytes || 0));
                }
            } catch (error) {
                // Skip invalid/corrupted files; do not interrupt server.
            }
        }
    } catch (error) {
        console.warn("Không thể tối ưu ảnh upload nền:", error.message);
        return;
    }

    if (optimizedCount > 0) {
        const savedMb = (totalSavedBytes / (1024 * 1024)).toFixed(2);
        console.log(`Đã tối ưu ${optimizedCount} ảnh upload, giảm khoảng ${savedMb}MB.`);
    }
}

/* ===========================
   HTTP + Socket
=========================== */

const server = http.createServer(app);
server.keepAliveTimeout = Math.max(5000, Number(process.env.KEEP_ALIVE_TIMEOUT_MS) || 60000);
server.headersTimeout = Math.max(server.keepAliveTimeout + 5000, Number(process.env.HEADERS_TIMEOUT_MS) || 65000);
server.requestTimeout = Math.max(5000, Number(process.env.REQUEST_TIMEOUT_MS) || 120000);

const io = new Server(server, {
    cors: {
        origin: "*"
    },
    transports: ["websocket", "polling"],
    pingInterval: Math.max(10000, Number(process.env.SOCKET_PING_INTERVAL_MS) || 25000),
    pingTimeout: Math.max(5000, Number(process.env.SOCKET_PING_TIMEOUT_MS) || 20000),
    maxHttpBufferSize: Math.max(1024, Number(process.env.SOCKET_MAX_BUFFER_BYTES) || (1 * 1024 * 1024))
});

/* ===========================
   Multer
=========================== */

const storage = multer.diskStorage({

    destination(req, file, cb) {

        cb(null, uploadDir);

    },

    filename(req, file, cb) {

        cb(
            null,
            Date.now() + path.extname(file.originalname)
        );

    }

});

const upload = multer({
    storage,
    limits: {
        fileSize: uploadMaxFileSizeBytes,
        files: 1
    }
});

/* ===========================
   DATA
=========================== */

const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, "data");
const stateFile = path.join(dataDir, "state.json");
const persistDebounceMs = Math.max(50, Number(process.env.PERSIST_DEBOUNCE_MS) || 200);
const broadcastDebounceMs = Math.max(20, Number(process.env.BROADCAST_DEBOUNCE_MS) || 100);

const DEFAULT_PRODUCTS = [

    {
        id: 1,
        name: "Áo Thun",
        sku: "SKU-AO-001",
        price: 200000,
        oldPrice: 260000,
        stock: 10,
        image: "",
        sortOrder: 1,
        hidden: false,
        category: "Áo"
    },

    {
        id: 2,
        name: "Quần Jean",
        sku: "SKU-QUAN-002",
        price: 350000,
        oldPrice: 450000,
        stock: 5,
        image: "",
        sortOrder: 2,
        hidden: false,
        category: "Quần"
    }

];

const DEFAULT_ORDERS = [

    {

        id: 1,

        customer: "Nguyễn Văn A",

        phone: "0901234567",

        address: "Đà Nẵng",

        total: 550000,

        status: "pending",


        items: [

            { name: "Áo Thun", qty: 1 }

        ]

    },

    {

        id: 2,

        customer: "Trần Thị B",

        phone: "0912345678",

        address: "Hà Nội",

        total: 700000,

        status: "confirmed",

        items: [

            { name: "Quần Jean", qty: 1 }

        ]

    }

];

const DEFAULT_SETTINGS = {
    shopLogo: "/uploads/logogusa.jpg",
    shopPublicUrl
};

function cloneData(value) {

    return JSON.parse(JSON.stringify(value));

}

let products = cloneData(DEFAULT_PRODUCTS);

let productsById = new Map();

let cart = [];

let orders = cloneData(DEFAULT_ORDERS);

let appSettings = cloneData(DEFAULT_SETTINGS);

let dataRevision = 0;
let persistTimer = null;
let persistInFlight = false;
let persistRetryRequested = false;
let broadcastTimer = null;
let pendingBroadcastRevision = 0;

function normalizeCartItemRecord(item) {

    if (!item || typeof item !== "object") return null;

    const sessionId = normalizeSessionId(item.sessionId) || "legacy";
    const updatedAtValue = Number(item.updatedAt);
    const updatedAt = Number.isFinite(updatedAtValue) && updatedAtValue > 0 ? Math.floor(updatedAtValue) : Date.now();

    return {
        ...item,
        sessionId,
        updatedAt
    };

}

function rebuildProductsIndex() {

    productsById = new Map(products.map((product) => [Number(product.id), product]));

}

function findProductById(id) {

    return productsById.get(Number(id));

}

function normalizeProductOrder() {

    products.forEach((product, index) => {

        product.name = normalizeTextValue(product.name, `Sản phẩm ${index + 1}`);
        product.sku = normalizeTextValue(product.sku, "");
        product.price = normalizeNumberValue(product.price, 0);
        product.oldPrice = normalizeNumberValue(product.oldPrice, product.price);
        product.stock = normalizeStockValue(product.stock, 0);
        product.image = normalizeTextValue(product.image, "");

        if (!Number.isFinite(Number(product.sortOrder))) {

            product.sortOrder = index + 1;

        }

        if (typeof product.hidden !== "boolean") {

            product.hidden = false;

        }

        if (typeof product.hiddenGlobal !== "boolean") {

            product.hiddenGlobal = false;

        }

        product.category = normalizeTextValue(product.category, "Khác");

        const normalizedImages = normalizeImageList(product.images || product.image);
        product.images = normalizedImages;
        if ((!product.image || !String(product.image).trim()) && normalizedImages.length) {
            product.image = normalizedImages[0];
        }

        const rawNames = normalizeVariantNames(product.variantNames);
        product.variantNames = normalizedImages.map((_, nameIndex) => rawNames[nameIndex] || `Màu ${nameIndex + 1}`);
        product.sizes = normalizeSizes(product.sizes);
        const normalizedVariantSizes = normalizeVariantSizes(product.variantSizes, normalizedImages.length);
        product.variantSizes = normalizedVariantSizes.map((row) => {
            const normalizedRow = normalizeSizes(row);
            return normalizedRow.length ? normalizedRow : product.sizes;
        });
        product.variantStocks = normalizeVariantStocks(product.variantStocks, normalizedImages.length);
        product.variantColorStocks = normalizeVariantStocks(product.variantColorStocks, normalizedImages.length);

        if (!product.variantColorStocks.some((qty) => Number.isFinite(Number(qty))) && product.variantStocks.some((qty) => Number.isFinite(Number(qty)))) {
            product.variantColorStocks = [...product.variantStocks];
        }

        if (!product.variantStocks.some((qty) => Number.isFinite(Number(qty))) && product.variantColorStocks.some((qty) => Number.isFinite(Number(qty)))) {
            product.variantStocks = [...product.variantColorStocks];
        }

        syncProductStockWithVariantStocks(product);

    });

    const categoryCounters = new Map();

    getOrderedProducts().forEach((product) => {

        const category = getProductCategory(product);
        const current = categoryCounters.get(category) || 0;
        const categoryOrder = Number(product.categorySortOrder);

        if (Number.isFinite(categoryOrder) && categoryOrder > 0) {

            categoryCounters.set(category, Math.max(current, categoryOrder));
            return;

        }

        const next = current + 1;
        product.categorySortOrder = next;
        categoryCounters.set(category, next);

    });

    rebuildProductsIndex();

}

function reconcileCartStockForProduct(productId) {

    const targetId = Number(productId);
    if (!Number.isFinite(targetId)) return false;

    const product = findProductById(targetId);

    let changed = false;

    const untouchedItems = [];
    const mergedByItemKey = new Map();

    cart.forEach((item) => {
        if (Number(item.id) !== targetId) {
            untouchedItems.push(item);
            return;
        }

        if (!product) {
            changed = true;
            return;
        }

        const normalizedImage = resolvePreferredVariantImage(product, item.image);
        const normalizedVariantName = resolvePreferredVariantName(product, normalizedImage, item.variantName, undefined);
        const normalizedVariantKey = buildVariantKey(normalizedVariantName, normalizedImage);
        const normalizedVariantIndex = getVariantIndex(product, normalizedImage, normalizedVariantName);
        const normalizedSize = resolveSelectedSizeByVariant(product, normalizedVariantIndex, item.selectedSize || "");
        const normalizedSizeKey = buildSizeKey(normalizedSize);
        const normalizedItemKey = buildCartItemKey(normalizedVariantKey, normalizedSizeKey);

        const stockCap = Math.max(0, Math.floor(Number(getVariantStockInfo(product, normalizedVariantIndex, normalizedSize).stock) || 0));
        const currentQty = Math.max(0, Math.floor(Number(item.qty) || 0));
        const cappedQty = Math.min(currentQty, stockCap);

        if (cappedQty <= 0) {
            changed = true;
            return;
        }

        const sessionId = normalizeSessionId(item.sessionId) || "legacy";
        const mergedKey = `${sessionId}::${normalizedItemKey}`;

        const existing = mergedByItemKey.get(mergedKey);
        if (existing) {
            existing.qty += cappedQty;
            existing.__stockCap = Math.max(existing.__stockCap, stockCap);
            changed = true;
            return;
        }

        if (
            String(item.itemKey || "") !== normalizedItemKey
            || String(item.variantKey || "") !== normalizedVariantKey
            || String(item.variantName || "") !== normalizedVariantName
            || String(item.image || "") !== normalizedImage
            || String(item.selectedSize || "") !== normalizedSize
        ) {
            changed = true;
        }

        mergedByItemKey.set(mergedKey, {
            ...item,
            sessionId,
            image: normalizedImage,
            variantName: normalizedVariantName,
            variantKey: normalizedVariantKey,
            selectedSize: normalizedSize,
            sizeKey: normalizedSizeKey,
            itemKey: normalizedItemKey,
            category: getProductCategory(product),
            qty: cappedQty,
            __stockCap: stockCap
        });
    });

    const normalizedItems = [...mergedByItemKey.values()]
        .map((item) => {
            const maxQty = Math.max(0, Math.floor(Number(item.__stockCap) || 0));
            const safeQty = Math.max(0, Math.floor(Number(item.qty) || 0));
            const qty = Math.min(safeQty, maxQty);
            if (qty !== safeQty) changed = true;

            const { __stockCap, ...rest } = item;
            return {
                ...rest,
                qty
            };
        })
        .filter((item) => Number(item.qty) > 0);

    cart = [...untouchedItems, ...normalizedItems];

    return changed;

}

function reconcileEntireCart() {

    const ids = [...new Set(cart.map((item) => Number(item.id)).filter((id) => Number.isFinite(id)))];
    return ids.some((id) => reconcileCartStockForProduct(id));

}
function getOrderedProducts() {

    return [...products].sort((a, b) => {

        const aOrder = Number.isFinite(Number(a.sortOrder)) ? Number(a.sortOrder) : Number.MAX_SAFE_INTEGER;
        const bOrder = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : Number.MAX_SAFE_INTEGER;

        return aOrder - bOrder || Number(a.id) - Number(b.id);

    });

}

function getOrderedProductsByCategory(category) {

    const normalizedCategory = normalizeCategoryName(category);

    return products
        .filter(product => getProductCategory(product) === normalizedCategory)
        .sort((a, b) => {

            const aOrder = Number.isFinite(Number(a.categorySortOrder)) ? Number(a.categorySortOrder) : Number.MAX_SAFE_INTEGER;
            const bOrder = Number.isFinite(Number(b.categorySortOrder)) ? Number(b.categorySortOrder) : Number.MAX_SAFE_INTEGER;

            if (aOrder !== bOrder) return aOrder - bOrder;

            const aGlobal = Number.isFinite(Number(a.sortOrder)) ? Number(a.sortOrder) : Number.MAX_SAFE_INTEGER;
            const bGlobal = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : Number.MAX_SAFE_INTEGER;

            return aGlobal - bGlobal || Number(a.id) - Number(b.id);

        });

}

function isHiddenInTotal(product) {

    return Boolean(product?.hiddenGlobal);

}

function isHiddenInCategory(product, category) {

    const normalizedCategory = normalizeCategoryName(category);
    if (!normalizedCategory) return isHiddenInTotal(product);

    if (isHiddenInTotal(product)) return true;
    if (getProductCategory(product) !== normalizedCategory) return false;

    return Boolean(product?.hidden);

}

function getVisibleProducts(category = "") {

    const normalizedCategory = normalizeCategoryName(category);

    const source = normalizedCategory ? getOrderedProductsByCategory(normalizedCategory) : getOrderedProducts();

    return source.filter(product => {

        if (normalizedCategory) {
            return getProductCategory(product) === normalizedCategory && !isHiddenInCategory(product, normalizedCategory);
        }

        return !isHiddenInTotal(product);

    });

}

function normalizeCategoryName(value) {

    const category = normalizeTextValue(value, "");
    const key = category
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/�/g, "")
        .toLowerCase()
        .trim();

    if (key === "ao" || key === "o") return "Áo";
    if (key === "quan") return "Quần";
    if (key === "chan vay" || key === "chanvay") return "Chân váy";
    if (key === "dam") return "Đầm";
    if (key === "khac") return "Khác";

    return category;

}

function repairBrokenVietnameseText(text) {

    let value = String(text || "").trim();
    if (!value) return "";

    if (/[ÃÂÊÔƯĐ]/.test(value)) {
        try {
            const decoded = Buffer.from(value, "latin1").toString("utf8").trim();
            if (decoded && !decoded.includes("�")) {
                value = decoded;
            }
        } catch (err) {
            // Keep original value when decode is not possible.
        }
    }

    value = value
        .replace(/�o/g, "Áo")
        .replace(/�O/g, "ÁO")
        .replace(/\b�o\b/g, "Áo")
        .replace(/\b�O\b/g, "ÁO")
        .replace(/\bM�u\b/g, "Màu")
        .replace(/\bm�u\b/g, "màu")
        .replace(/\bch�n\b/g, "chân")
        .replace(/\bCh�n\b/g, "Chân")
        .replace(/\bv�y\b/g, "váy")
        .replace(/\bV�y\b/g, "Váy")
        .replace(/\bqu�n\b/g, "quần")
        .replace(/\bQu�n\b/g, "Quần")
        .replace(/\b�\b/g, "");

    return value;

}

function normalizeTextValue(value, fallback = "") {

    if (Array.isArray(value)) {
        const first = value
            .map((item) => repairBrokenVietnameseText(item))
            .find(Boolean);
        return first || fallback;
    }

    if (value === undefined || value === null) return fallback;

    const text = repairBrokenVietnameseText(value);
    return text || fallback;

}

function normalizeNumberValue(value, fallback = 0) {

    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;

}

function normalizeStockValue(value, fallback = 0) {

    const number = normalizeNumberValue(value, fallback);
    return Math.max(0, Math.floor(number));

}

function normalizeImageList(value) {

    const list = Array.isArray(value)
        ? value
        : (typeof value === "string"
            ? value.split(/[,\n|]+/)
            : []);

    return list
        .map(item => String(item || "").trim())
        .filter(Boolean);

}

function normalizeVariantNames(value) {

    const list = Array.isArray(value)
        ? value
        : (typeof value === "string"
            ? value.split(/[,\n|]+/)
            : []);

    return list
        .map(item => normalizeTextValue(item, ""))
        .filter(Boolean);

}

function normalizeSizes(value) {

    const list = Array.isArray(value)
        ? value
        : (typeof value === "string"
            ? value.split(/[,\n|]+/)
            : []);

    const seen = new Set();
    const normalized = [];

    list
        .map(item => String(item || "").trim())
        .filter(Boolean)
        .forEach((item) => {
            const key = item.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            normalized.push(item);
        });

    return normalized;

}

function normalizeVariantSizes(value, variantCount = 0) {

    if (!value || typeof value !== "object") {
        return Array.from({ length: Math.max(0, Number(variantCount) || 0) }, () => []);
    }

    const source = Array.isArray(value)
        ? value
        : Object.keys(value)
            .sort((a, b) => Number(a) - Number(b))
            .map((key) => value[key]);

    const targetLength = Math.max(source.length, Number(variantCount) || 0);

    return Array.from({ length: targetLength }, (_, index) => {
        return normalizeSizes(source[index]);
    });

}

function normalizeVariantStocks(value, variantCount = 0) {

    const targetLength = Math.max(0, Number(variantCount) || 0);

    if (!value || typeof value !== "object") {
        return Array.from({ length: targetLength }, () => null);
    }

    const source = Array.isArray(value)
        ? value
        : Object.keys(value)
            .sort((a, b) => Number(a) - Number(b))
            .map((key) => value[key]);

    const normalizedLength = Math.max(source.length, targetLength);

    return Array.from({ length: normalizedLength }, (_, index) => {
        const row = source[index];
        if (Number.isFinite(Number(row))) {
            return Math.max(0, Math.floor(Number(row)));
        }

        if (row && typeof row === "object") {
            const total = Object.values(row).reduce((sum, qty) => {
                const n = Number(qty);
                if (!Number.isFinite(n) || n < 0) return sum;
                return sum + Math.floor(n);
            }, 0);
            return total;
        }

        return null;
    });

}

function syncProductStockWithVariantStocks(product, preferredTotalStock = null) {

    if (!product || typeof product !== "object") return;

    const variantCount = normalizeImageList(product?.images || product?.image).length;
    const normalizedStocks = normalizeVariantStocks(
        product?.variantColorStocks !== undefined ? product?.variantColorStocks : product?.variantStocks,
        variantCount
    );
    const hasExplicitColorStock = normalizedStocks.some((qty) => Number.isFinite(Number(qty)));
    const normalizedPreferred = preferredTotalStock === null || preferredTotalStock === undefined
        ? null
        : normalizeStockValue(preferredTotalStock, 0);

    if (!hasExplicitColorStock) {
        if (normalizedPreferred !== null) {
            product.stock = normalizedPreferred;
        } else {
            product.stock = normalizeStockValue(product.stock, 0);
        }
        return;
    }

    const stocks = normalizedStocks.map((qty) => Number.isFinite(Number(qty)) ? normalizeStockValue(qty, 0) : 0);
    const currentTotal = stocks.reduce((sum, qty) => sum + qty, 0);
    const targetTotal = normalizedPreferred !== null ? normalizedPreferred : currentTotal;

    if (currentTotal > 0 && targetTotal !== currentTotal) {
        const scaled = stocks.map((qty) => Math.floor((qty * targetTotal) / currentTotal));
        let remainder = targetTotal - scaled.reduce((sum, qty) => sum + qty, 0);

        const rankedIndexes = [...stocks.keys()]
            .sort((a, b) => stocks[b] - stocks[a] || a - b);

        while (remainder > 0 && rankedIndexes.length) {
            for (const idx of rankedIndexes) {
                if (remainder <= 0) break;
                scaled[idx] += 1;
                remainder -= 1;
            }
        }

        product.variantColorStocks = scaled;
        product.variantStocks = [...scaled];
        product.stock = targetTotal;
        return;
    }

    if (currentTotal <= 0 && targetTotal > 0 && stocks.length) {
        stocks[0] = targetTotal;
    }

    const finalTotal = stocks.reduce((sum, qty) => sum + qty, 0);
    product.variantColorStocks = stocks;
    product.variantStocks = [...stocks];
    product.stock = finalTotal;

}

function getVariantStockInfo(product, variantIndex, size) {

    const index = Math.max(0, Number(variantIndex) || 0);
    const variantCount = normalizeImageList(product?.images || product?.image).length;
    const stocks = normalizeVariantStocks(
        product?.variantColorStocks !== undefined ? product?.variantColorStocks : product?.variantStocks,
        variantCount
    );
    const colorStock = stocks[index];
    const totalStock = Math.max(0, Math.floor(Number(product?.stock) || 0));

    if (Number.isFinite(Number(colorStock))) {
        const normalizedColorStock = Math.max(0, Math.floor(Number(colorStock) || 0));
        return {
            stock: Math.min(normalizedColorStock, totalStock),
            explicit: true,
            key: ""
        };
    }

    return {
        stock: totalStock,
        explicit: false,
        key: ""
    };

}

function decrementVariantStock(product, variantIndex, size, qty) {

    const amount = Math.max(0, Math.floor(Number(qty) || 0));
    if (!amount) return;

    const index = Math.max(0, Number(variantIndex) || 0);
    const variantCount = normalizeImageList(product?.images || product?.image).length;
    const stocks = normalizeVariantStocks(
        product?.variantColorStocks !== undefined ? product?.variantColorStocks : product?.variantStocks,
        variantCount
    );
    const colorStock = stocks[index];

    if (Number.isFinite(Number(colorStock))) {
        stocks[index] = Math.max(0, Math.floor(Number(colorStock) || 0) - amount);
        product.variantStocks = stocks;
        product.variantColorStocks = [...stocks];
        product.stock = Math.max(0, Math.floor(Number(product.stock) || 0) - amount);
        return;
    }

    product.stock = Math.max(0, Math.floor(Number(product.stock) || 0) - amount);

}

function getVariantNameByImage(product, image) {

    if (!product) return "";

    const images = normalizeImageList(product.images || product.image);
    const names = normalizeVariantNames(product.variantNames);
    const targetImage = String(image || "").trim();

    if (!targetImage || !images.length) return "";

    const index = images.findIndex(item => item === targetImage);
    if (index < 0) return "";

    return names[index] || `Màu ${index + 1}`;

}

function resolveVariantName(product, requestedImage, requestedVariantName, requestedVariantIndex) {

    const directName = normalizeTextValue(requestedVariantName, "");
    if (directName) return directName;

    const images = normalizeImageList(product?.images || product?.image);
    const names = normalizeVariantNames(product?.variantNames);
    const indexFromRequest = Number(requestedVariantIndex);

    if (Number.isFinite(indexFromRequest) && indexFromRequest >= 0 && indexFromRequest < names.length) {
        return names[indexFromRequest] || "";
    }

    const imageValue = String(requestedImage || "").trim();
    if (!imageValue) return "";

    const indexByImage = images.findIndex(item => item === imageValue);
    if (indexByImage < 0) return "";

    return names[indexByImage] || `Màu ${indexByImage + 1}`;

}

function getVariantIndex(product, image, variantName) {

    const images = normalizeImageList(product?.images || product?.image);
    const names = normalizeVariantNames(product?.variantNames);
    const safeImage = String(image || "").trim();
    const safeName = String(variantName || "").trim();

    if (safeName) {
        const byName = names.findIndex((item) => String(item || "").trim().toLowerCase() === safeName.toLowerCase());
        if (byName >= 0) return byName;
    }

    if (safeImage) {
        const byImage = images.findIndex((item) => item === safeImage);
        if (byImage >= 0) return byImage;
    }

    return 0;

}

function resolvePreferredVariantImage(product, requestedImage) {

    const preferred = normalizeTextValue(requestedImage, "");
    if (preferred) return preferred;

    const primary = normalizeTextValue(product?.image, "");
    if (primary) return primary;

    const images = normalizeImageList(product?.images || product?.image);
    return images[0] || "";

}

function resolvePreferredVariantName(product, image, requestedVariantName, requestedVariantIndex) {

    const images = normalizeImageList(product?.images || product?.image);
    if (!images.length) return "";

    const resolved = resolveVariantName(product, image, requestedVariantName, requestedVariantIndex);
    if (resolved) return resolved;

    const names = normalizeVariantNames(product?.variantNames);
    if (names.length) return names[0];

    return "";

}

function buildVariantKey(name, image) {

    const safeName = String(name || "").trim();
    const safeImage = String(image || "").trim();

    if (safeName) return `name:${safeName}`;
    if (safeImage) return `img:${safeImage}`;
    return "default";

}

function buildSizeKey(size) {

    const safeSize = String(size || "").trim();
    return safeSize ? `size:${safeSize}` : "size:default";

}

function resolveSelectedSize(product, requestedSize) {

    const sizes = normalizeSizes(product?.sizes);
    const requested = String(requestedSize || "").trim();

    if (!sizes.length) return "";
    if (!requested) return sizes[0];

    const matched = sizes.find((size) => size.toLowerCase() === requested.toLowerCase());
    return matched || sizes[0];

}

function resolveSelectedSizeByVariant(product, variantIndex, requestedSize) {

    const index = Math.max(0, Number(variantIndex) || 0);
    const variantSizes = normalizeVariantSizes(product?.variantSizes, normalizeImageList(product?.images || product?.image).length);
    const rowSizes = normalizeSizes(variantSizes[index]);

    if (!rowSizes.length) {
        return resolveSelectedSize(product, requestedSize);
    }

    const requested = String(requestedSize || "").trim();
    if (!requested) return rowSizes[0];

    const matched = rowSizes.find((size) => size.toLowerCase() === requested.toLowerCase());
    return matched || rowSizes[0];

}

function getAvailableSizesByVariant(product, variantIndex) {

    const index = Math.max(0, Number(variantIndex) || 0);
    const variantSizes = normalizeVariantSizes(product?.variantSizes, normalizeImageList(product?.images || product?.image).length);
    const rowSizes = normalizeSizes(variantSizes[index]);

    if (rowSizes.length) return rowSizes;

    return normalizeSizes(product?.sizes);

}

function buildCartItemKey(variantKey, sizeKey) {

    return `${String(variantKey || "default")}__${String(sizeKey || "size:default")}`;

}

function getRequestedCategory(req) {

    return normalizeCategoryName(req.query?.category ?? req.body?.category);

}

function getProductCategory(product) {

    return normalizeTextValue(product?.category, "Khác");

}

function getNextSortOrder() {

    return products.reduce((max, product) => {

        const order = Number(product.sortOrder);

        return Number.isFinite(order) ? Math.max(max, order) : max;

    }, 0) + 1;

}

function getNextCategorySortOrder(category) {

    const normalizedCategory = normalizeCategoryName(category);

    return products.reduce((max, product) => {

        if (getProductCategory(product) !== normalizedCategory) return max;

        const order = Number(product.categorySortOrder);

        return Number.isFinite(order) ? Math.max(max, order) : max;

    }, 0) + 1;

}

function getSortedCart(category = "", sessionId = "") {

    const normalizedCategory = normalizeCategoryName(category);
    const normalizedSessionId = normalizeSessionId(sessionId);

    const orderedProducts = (normalizedCategory ? getOrderedProductsByCategory(normalizedCategory) : getOrderedProducts()).filter(product => {

        if (normalizedCategory) {

            if (isHiddenInCategory(product, normalizedCategory)) return false;
            return getProductCategory(product) === normalizedCategory;

        }

        return !isHiddenInTotal(product);

    });
    const productOrder = new Map(orderedProducts.map((product, index) => [product.id, index]));

    return [...cart]
        .filter(item => {
            if (normalizedSessionId && normalizeSessionId(item.sessionId) !== normalizedSessionId) return false;

            const product = findProductById(item.id);
            if (!product) return false;

            if (!normalizedCategory) return !isHiddenInTotal(product);

            if (isHiddenInCategory(product, normalizedCategory)) return false;
            return normalizeCategoryName(item.category) === normalizedCategory;

        })
        .sort((a, b) => {
            const aOrder = productOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
            const bOrder = productOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;

            return aOrder - bOrder || Number(a.id) - Number(b.id);

        })
        .map(item => {
            const product = findProductById(item.id);

            if (!product) return item;

            const itemImage = item.image || product.image;
            const itemVariantName = normalizeTextValue(item.variantName, "") || getVariantNameByImage(product, itemImage);
            const itemVariantKey = item.variantKey || buildVariantKey(itemVariantName, itemImage);
            const itemVariantIndex = getVariantIndex(product, itemImage, itemVariantName);
            const availableSizes = getAvailableSizesByVariant(product, itemVariantIndex);
            const fallbackSize = resolveSelectedSizeByVariant(product, itemVariantIndex, item.selectedSize);
            const selectedSize = item.selectedSize || fallbackSize;
            const sizeKey = item.sizeKey || buildSizeKey(selectedSize);
            const stockInfo = getVariantStockInfo(product, itemVariantIndex, selectedSize);
            const variantStocks = normalizeVariantStocks(product.variantStocks, normalizeImageList(product.images || product.image).length);
            const variantColorStocks = normalizeVariantStocks(product.variantColorStocks, normalizeImageList(product.images || product.image).length);

            return {
                ...item,
                name: normalizeTextValue(product.name, item.name || "Sản phẩm"),
                sku: item.sku || product.sku || "",
                category: getProductCategory(product),
                price: normalizeNumberValue(product.price, 0),
                oldPrice: normalizeNumberValue(product.oldPrice, normalizeNumberValue(product.price, 0)),
                image: itemImage,
                variantName: itemVariantName,
                variantKey: itemVariantKey,
                selectedSize: selectedSize,
                sizeKey: sizeKey,
                itemKey: item.itemKey || buildCartItemKey(
                    itemVariantKey,
                    sizeKey
                ),
                availableSizes,
                variantColorStocks,
                comboStock: stockInfo.stock
            };
            })
            .filter((item) => Number(item.comboStock) > 0);


}

async function writeStateFileOnce() {

    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    const nextState = {
        products,
        cart,
        orders,
            settings: appSettings,
        dataRevision
    };

    const tempFile = `${stateFile}.tmp`;
    await fs.promises.writeFile(tempFile, JSON.stringify(nextState, null, 2), "utf8");
    await fs.promises.rename(tempFile, stateFile);

}

async function flushPersistState() {

    if (persistInFlight) {
        persistRetryRequested = true;
        return;
    }

    persistInFlight = true;
    try {
        await writeStateFileOnce();
    } catch (error) {
        console.error("Không thể lưu dữ liệu state:", error.message);
    } finally {
        persistInFlight = false;
        if (persistRetryRequested) {
            persistRetryRequested = false;
            setImmediate(() => {
                flushPersistState().catch(err => {
                    console.error("Lỗi flush state:", err.message);
                });
            });
        }
    }

}

function schedulePersistState() {

    if (persistTimer) clearTimeout(persistTimer);

    persistTimer = setTimeout(() => {
        persistTimer = null;
        flushPersistState().catch(err => {
            console.error("Lỗi lưu state:", err.message);
        });
    }, persistDebounceMs);

}

function persistStateImmediate() {

    return flushPersistState();

}

function scheduleClientUpdateBroadcast() {

    if (broadcastTimer) return;

    broadcastTimer = setTimeout(() => {
        broadcastTimer = null;

        io.emit("update", {
            revision: pendingBroadcastRevision,
            ts: Date.now()
        });
    }, broadcastDebounceMs);

}

function loadPersistedState() {

    if (!fs.existsSync(stateFile)) return;

    try {
        const raw = fs.readFileSync(stateFile, "utf8");
        const parsed = JSON.parse(raw || "{}");

        products = Array.isArray(parsed.products) ? parsed.products : cloneData(DEFAULT_PRODUCTS);
        cart = Array.isArray(parsed.cart)
            ? parsed.cart.map(normalizeCartItemRecord).filter(Boolean)
            : [];
        orders = Array.isArray(parsed.orders) ? parsed.orders : cloneData(DEFAULT_ORDERS);
        appSettings = (parsed.settings && typeof parsed.settings === "object")
            ? {
                ...cloneData(DEFAULT_SETTINGS),
                ...parsed.settings
            }
            : cloneData(DEFAULT_SETTINGS);

        const revision = Number(parsed.dataRevision);
        dataRevision = Number.isFinite(revision) && revision >= 0 ? Math.floor(revision) : 0;
    } catch (error) {
        console.error("Không thể đọc dữ liệu state, dùng dữ liệu mặc định:", error.message);
        products = cloneData(DEFAULT_PRODUCTS);
        cart = [];
        orders = cloneData(DEFAULT_ORDERS);
        appSettings = cloneData(DEFAULT_SETTINGS);
        dataRevision = 0;
    }

}

loadPersistedState();
normalizeProductOrder();
reconcileEntireCart();
persistStateImmediate().catch(err => {
    console.error("Không thể lưu state ban đầu:", err.message);
});

/* ===========================
   Helper
=========================== */

function updateClient() {

    dataRevision += 1;

    pendingBroadcastRevision = dataRevision;
    schedulePersistState();
    scheduleClientUpdateBroadcast();

}

/* ===========================
   PRODUCT
=========================== */

app.get("/products", (req, res) => {

    const category = getRequestedCategory(req);
    const productsToSend = getVisibleProducts(category);

    res.json(productsToSend);

});

app.get("/", (req, res) => {

    res.redirect("/shop.html");

});

app.get("/cart", (req, res) => {

    res.redirect("/shop.html?view=cart#cart");

});

app.get("/gio-hang", (req, res) => {

    res.redirect("/shop.html?view=cart#cart");

});

app.get("/products/all", (req, res) => {

    const category = getRequestedCategory(req);
    const productsToSend = category
        ? getOrderedProductsByCategory(category)
        : getOrderedProducts();

    res.json(productsToSend);

});

app.get("/health", (req, res) => {

    const memory = process.memoryUsage();

    res.json({
        ok: true,
        ts: Date.now(),
        uptimeSec: Math.floor(process.uptime()),
        products: Array.isArray(products) ? products.length : 0,
        orders: Array.isArray(orders) ? orders.length : 0,
        inflightRequests,
        memRssMb: Math.round((memory.rss / (1024 * 1024)) * 10) / 10,
        memHeapUsedMb: Math.round((memory.heapUsed / (1024 * 1024)) * 10) / 10
    });

});

app.get("/settings", (req, res) => {

    res.json({
        shopLogo: String(appSettings?.shopLogo || DEFAULT_SETTINGS.shopLogo),
        shopPublicUrl: String(appSettings?.shopPublicUrl || DEFAULT_SETTINGS.shopPublicUrl || ""),
        uploadMaxFileSizeMb
    });

});

app.get("/orders", (req, res) => {

    res.json(orders);

});

app.use([
    "/order",
    "/product",
    "/settings",
    "/upload",
    "/add",
    "/change"
], writeLimiter);

app.put("/settings/logo", (req, res) => {

    const logoUrl = String(req.body?.logoUrl || "").trim();

    if (!logoUrl) {
        return res.status(400).json({ error: "Thiếu đường dẫn logo" });
    }

    if (!logoUrl.startsWith("/uploads/")) {
        return res.status(400).json({ error: "Logo phải là ảnh upload hợp lệ" });
    }

    appSettings.shopLogo = logoUrl;
    updateClient();

    res.json({
        success: true,
        shopLogo: appSettings.shopLogo
    });

});

app.use("/checkout", checkoutLimiter);

app.put("/order/:id", (req, res) => {

    const id = Number(req.params.id);

    const order = orders.find(x => x.id === id);

    if (!order) {

        return res.status(404).json({ error: "Không tìm thấy đơn hàng" });

    }

    const { status } = req.body;

    if (status) {

        order.status = status;

    }

    res.json(order);

});

app.delete("/order/:id", (req, res) => {

    const id = Number(req.params.id);

    const existed = orders.some(x => x.id === id);

    if (!existed) {

        return res.status(404).json({ error: "Không tìm thấy đơn hàng" });

    }

    orders = orders.filter(x => x.id !== id);

    res.json({ success: true });

});

app.post("/checkout", (req, res) => {

    const { customer, phone, address } = req.body;
    const category = getRequestedCategory(req);
    const sessionId = normalizeSessionId(req.sessionId);
    const checkoutItems = category
        ? cart.filter(item => normalizeSessionId(item.sessionId) === sessionId && normalizeCategoryName(item.category) === category)
        : cart.filter(item => normalizeSessionId(item.sessionId) === sessionId);

    if (!customer || !phone || !address) {

        return res.status(400).json({ error: "Vui lòng nhập đầy đủ thông tin" });

    }

    if (!checkoutItems.length) {

        return res.status(400).json({ error: "Giỏ hàng trống" });

    }

    const validItems = [];
    let skippedItems = 0;
    let adjustedItems = 0;

    for (const item of checkoutItems) {

        const product = findProductById(item.id);

        if (!product) {

            skippedItems += 1;
            continue;

        }

        const itemImage = item.image || product.image;
        const itemVariantName = item.variantName || getVariantNameByImage(product, itemImage);
        const itemVariantIndex = getVariantIndex(product, itemImage, itemVariantName);
        const itemSize = resolveSelectedSizeByVariant(product, itemVariantIndex, item.selectedSize || "");
        const stockInfo = getVariantStockInfo(product, itemVariantIndex, itemSize);

        if (stockInfo.stock <= 0) {

            skippedItems += 1;
            continue;

        }

        const safeQty = Math.min(item.qty, stockInfo.stock);
        if (safeQty !== item.qty) {
            adjustedItems += 1;
        }

        validItems.push({
            ...item,
            qty: safeQty,
            selectedSize: itemSize
        });

        decrementVariantStock(product, itemVariantIndex, itemSize, safeQty);

    }

    if (!validItems.length) {
        if (category) {
            cart = cart.filter(item => !(normalizeSessionId(item.sessionId) === sessionId && normalizeCategoryName(item.category) === category));
        } else {
            cart = cart.filter(item => normalizeSessionId(item.sessionId) !== sessionId);
        }
        updateClient();

        return res.status(400).json({
            error: skippedItems ? "Giỏ hàng không còn sản phẩm đủ tồn kho" : "Giỏ hàng trống"
        });
    }

    const total = validItems.reduce((sum, item) => sum + item.price * item.qty, 0);

    const newOrder = {

        id: Date.now(),

        customer,

        phone,

        address,
        total,
        status: "pending",
        createdAt: new Date().toISOString(),
        items: validItems.map(item => ({
            name: item.name,
            qty: item.qty,
            sku: item.sku || "",
            category: item.category || "",
            variantName: item.variantName || "",
            size: item.selectedSize || ""
        }))

    };

    orders.unshift(newOrder);
    if (category) {
        cart = cart.filter(item => !(normalizeSessionId(item.sessionId) === sessionId && normalizeCategoryName(item.category) === category));
    } else {
        cart = cart.filter(item => normalizeSessionId(item.sessionId) !== sessionId);
    }
    updateClient();

    res.json({
        ...newOrder,
        skippedItems,
        adjustedItems,
        message: skippedItems || adjustedItems
            ? `Đã bỏ qua ${skippedItems} sản phẩm hết hàng${adjustedItems ? ` và tự điều chỉnh ${adjustedItems} sản phẩm vượt tồn` : ""}`
            : ""
    });

});

app.post("/checkout/quick", (req, res) => {

    const { customer, phone, address, productId, variantIndex, variantName, size, qty } = req.body || {};
    const id = Number(productId);
    const requestedQty = Math.max(1, Math.floor(Number(qty) || 0));

    if (!customer || !phone || !address) {
        return res.status(400).json({ error: "Vui lòng nhập đầy đủ thông tin" });
    }

    if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "Sản phẩm không hợp lệ" });
    }

    const product = findProductById(id);
    if (!product) {
        return res.status(404).json({ error: "Sản phẩm không tồn tại" });
    }

    const firstImage = Array.isArray(product.images) && product.images.length ? product.images[0] : product.image || "";
    const effectiveVariantIndex = Number.isFinite(Number(variantIndex))
        ? Math.max(0, Math.floor(Number(variantIndex)))
        : getVariantIndex(product, firstImage, variantName);
    const effectiveImage = resolvePreferredVariantImage(product, firstImage);
    const effectiveVariantName = resolveVariantName(product, effectiveImage, variantName, effectiveVariantIndex)
        || getVariantNameByImage(product, effectiveImage)
        || String(variantName || "").trim();
    const effectiveSize = resolveSelectedSizeByVariant(product, effectiveVariantIndex, size || "");
    const stockInfo = getVariantStockInfo(product, effectiveVariantIndex, effectiveSize);

    if (stockInfo.stock <= 0) {
        return res.status(400).json({ error: `Sản phẩm ${product.name} đã hết tồn kho` });
    }

    const finalQty = Math.min(requestedQty, stockInfo.stock);
    if (finalQty <= 0) {
        return res.status(400).json({ error: `Sản phẩm ${product.name} không đủ tồn kho` });
    }

    decrementVariantStock(product, effectiveVariantIndex, effectiveSize, finalQty);

    const total = normalizeNumberValue(product.price, 0) * finalQty;
    const newOrder = {
        id: Date.now(),
        customer,
        phone,
        address,
        total,
        status: "pending",
        createdAt: new Date().toISOString(),
        items: [{
            name: product.name,
            qty: finalQty,
            sku: product.sku || "",
            category: getProductCategory(product),
            variantName: effectiveVariantName || "",
            size: effectiveSize || ""
        }]
    };

    orders.unshift(newOrder);
    updateClient();

    res.json({
        ...newOrder,
        message: "Đã tạo đơn đặt nhanh thành công"
    });

});

/* ===========================
   ADD PRODUCT
=========================== */

app.post("/product/add", (req, res) => {

    const body = req.body || {};
    const {

        name,
        price,

        oldPrice,

        stock,

        image,

        images,

        variantNames,

        sizes,

        variantSizes,

        variantStocks,

        variantColorStocks,

        category

    } = body;
    const nameValue = normalizeTextValue(name, "");
    const skuValue = normalizeTextValue(body.sku, "");
    const priceValue = normalizeNumberValue(price, 0);
    const oldPriceValue = oldPrice !== undefined && oldPrice !== "" ? normalizeNumberValue(oldPrice, priceValue) : priceValue;
    const stockValue = normalizeStockValue(stock, 0);

    if (!nameValue) {

        return res.status(400).json({

            error: "Thiếu tên sản phẩm"

        });

    }

    const categoryValue = normalizeTextValue(category, "Khác");
    const imageValue = normalizeTextValue(image, "");
    const imageList = normalizeImageList(images);
    const mergedImages = imageList.length
        ? imageList
        : (imageValue ? [imageValue] : []);
    const primaryImage = imageValue || mergedImages[0] || "";
    const rawVariantNames = normalizeVariantNames(variantNames);
    const normalizedVariantNames = mergedImages.map((_, index) => rawVariantNames[index] || `Màu ${index + 1}`);
    const normalizedSizes = normalizeSizes(sizes);
    const normalizedVariantSizes = normalizeVariantSizes(variantSizes, mergedImages.length).map((row) => {
        const normalizedRow = normalizeSizes(row);
        return normalizedRow.length ? normalizedRow : normalizedSizes;
    });
    const normalizedVariantStocks = normalizeVariantStocks(variantColorStocks !== undefined ? variantColorStocks : variantStocks, mergedImages.length);

    const product = {

        id: Date.now(),

        name: nameValue,
        sku: skuValue,
        price: priceValue,

        oldPrice: oldPriceValue,

        stock: stockValue,

        image: primaryImage,
        images: mergedImages,
        variantNames: normalizedVariantNames,
        sizes: normalizedSizes,
        variantSizes: normalizedVariantSizes,
        variantStocks: normalizedVariantStocks,
        variantColorStocks: normalizedVariantStocks,
        sortOrder: getNextSortOrder(),

        hidden: false,
        hiddenGlobal: false,
        category: categoryValue,
        categorySortOrder: getNextCategorySortOrder(categoryValue)

    };

    syncProductStockWithVariantStocks(product);

    products.push(product);
    rebuildProductsIndex();

    updateClient();

    res.json(product);

});

/* ===========================
   UPDATE PRODUCT
=========================== */

app.put("/product/:id", (req, res) => {

    const id = Number(req.params.id);

    const product = findProductById(id);

    if (!product) {

        return res.status(404).json({

            error: "Không tìm thấy"

        });

    }

    const oldCategory = getProductCategory(product);
    const body = req.body || {};
    const {

        name,
        price,

        oldPrice,

        stock,

        image,

        images,

        variantNames,

        sizes,

        variantSizes,

        variantStocks,

        variantColorStocks,

        category

    } = body;

    if (name !== undefined) product.name = normalizeTextValue(name, product.name || "");
    if (body.sku !== undefined) product.sku = normalizeTextValue(body.sku, product.sku || "");

    if (price !== undefined) product.price = normalizeNumberValue(price, product.price || 0);

    if (oldPrice !== undefined) {
        product.oldPrice = oldPrice === ""
            ? normalizeNumberValue(price, product.price || 0)
            : normalizeNumberValue(oldPrice, product.price || 0);
    }
    if (stock !== undefined) product.stock = normalizeStockValue(stock, product.stock || 0);

    if (image !== undefined) product.image = normalizeTextValue(image, product.image || "");
    if (images !== undefined) {
        const nextImages = normalizeImageList(images);
        const mergedImages = nextImages.length
            ? nextImages
            : normalizeImageList([product.image]);
        product.images = mergedImages;

        if ((!product.image || !String(product.image).trim()) && mergedImages.length) {
            product.image = mergedImages[0];
        }
    } else if (image !== undefined) {
        product.images = normalizeImageList([product.image, ...(product.images || [])]);
    }

    if (variantNames !== undefined || images !== undefined || image !== undefined) {
        const mergedImages = normalizeImageList(product.images || product.image);
        const rawNames = variantNames !== undefined
            ? normalizeVariantNames(variantNames)
            : normalizeVariantNames(product.variantNames);
        product.variantNames = mergedImages.map((_, index) => rawNames[index] || `Màu ${index + 1}`);
        product.variantSizes = normalizeVariantSizes(product.variantSizes, mergedImages.length).map((row) => {
            const normalizedRow = normalizeSizes(row);
            return normalizedRow.length ? normalizedRow : normalizeSizes(product.sizes);
        });
        product.variantStocks = normalizeVariantStocks(product.variantStocks, mergedImages.length);
        product.variantColorStocks = normalizeVariantStocks(product.variantColorStocks, mergedImages.length);
    }
    if (sizes !== undefined) {
        product.sizes = normalizeSizes(sizes);
    }
    if (variantSizes !== undefined) {
        const mergedImages = normalizeImageList(product.images || product.image);
        product.variantSizes = normalizeVariantSizes(variantSizes, mergedImages.length).map((row) => {
            const normalizedRow = normalizeSizes(row);
            return normalizedRow.length ? normalizedRow : normalizeSizes(product.sizes);
        });
    }
    if (variantStocks !== undefined) {
        const mergedImages = normalizeImageList(product.images || product.image);
        product.variantStocks = normalizeVariantStocks(variantStocks, mergedImages.length);
        product.variantColorStocks = [...product.variantStocks];
    }
    if (variantColorStocks !== undefined) {
        const mergedImages = normalizeImageList(product.images || product.image);
        product.variantColorStocks = normalizeVariantStocks(variantColorStocks, mergedImages.length);
        product.variantStocks = [...product.variantColorStocks];
    }

    syncProductStockWithVariantStocks(product);
    rebuildProductsIndex();

    if (category !== undefined) {
        const nextCategory = normalizeTextValue(category, "Khác");
        product.category = nextCategory;

        if (normalizeCategoryName(nextCategory) !== normalizeCategoryName(oldCategory)) {
            product.categorySortOrder = getNextCategorySortOrder(nextCategory);
        }
    }

    reconcileCartStockForProduct(product.id);

    updateClient();

    res.json(product);

});

app.post("/product/toggle-hidden", (req, res) => {

    const { id } = req.body || {};
    const requestedCategory = getRequestedCategory(req);
    const product = findProductById(id);

    if (!product) {

        return res.status(404).json({

            error: "Không tìm thấy sản phẩm"

        });

    }

    if (requestedCategory) {
        if (getProductCategory(product) !== requestedCategory) {
            return res.status(400).json({ error: "Danh mục không khớp" });
        }

        product.hidden = !product.hidden;
    } else {
        product.hiddenGlobal = !product.hiddenGlobal;
    }

    updateClient();

    res.json({

        success: true,

        hiddenState: requestedCategory ? product.hidden : product.hiddenGlobal,

        scope: requestedCategory ? "category" : "global",

        product

    });

});

app.post("/product/move", (req, res) => {

    const { id, direction } = req.body || {};
    const productId = Number(id);
    const orderedProducts = getOrderedProducts();
    const currentIndex = orderedProducts.findIndex(product => product.id === productId);

    if (currentIndex === -1) {

        return res.status(404).json({

            error: "Không tìm thấy sản phẩm"

        });

    }

    const targetIndex = direction === "up" ? currentIndex - 1 : direction === "down" ? currentIndex + 1 : -1;

    if (targetIndex < 0 || targetIndex >= orderedProducts.length) {

        return res.status(400).json({

            error: "Không thể di chuyển sản phẩm"

        });

    }

    const currentProduct = orderedProducts[currentIndex];
    const targetProduct = orderedProducts[targetIndex];
    const currentSortOrder = currentProduct.sortOrder;

    currentProduct.sortOrder = targetProduct.sortOrder;
    targetProduct.sortOrder = currentSortOrder;

    updateClient();

    res.json({

        success: true,

        products: getOrderedProducts()

    });

});

app.post("/product/reorder", (req, res) => {

    const requestedCategory = getRequestedCategory(req);

    const orderedIds = Array.isArray(req.body?.orderedIds)
        ? [...new Set(req.body.orderedIds.map(Number).filter(Number.isFinite))]
        : [];

    if (!orderedIds.length) {

        return res.status(400).json({

            error: "Danh sách sắp xếp không hợp lệ"

        });

    }

    if (requestedCategory) {

        const categoryProducts = getOrderedProductsByCategory(requestedCategory);

        if (!categoryProducts.length) {

            return res.status(400).json({

                error: "Không có sản phẩm trong danh mục để sắp xếp"

            });

        }

        const categoryProductIds = new Set(categoryProducts.map(product => product.id));
        const containsInvalidId = orderedIds.some(id => !categoryProductIds.has(id));

        if (containsInvalidId) {

            return res.status(400).json({

                error: "Danh sách sắp xếp không khớp danh mục hiện tại"

            });

        }

        const existingSortSlots = categoryProducts
            .map(product => Number(product.categorySortOrder))
            .filter(Number.isFinite)
            .sort((a, b) => a - b);

        const reorderedProducts = orderedIds
            .map(id => categoryProducts.find(product => product.id === id))
            .filter(Boolean);

        categoryProducts
            .filter(product => !orderedIds.includes(product.id))
            .forEach(product => reorderedProducts.push(product));

        reorderedProducts.forEach((product, index) => {

            product.categorySortOrder = existingSortSlots[index] ?? (existingSortSlots.length + index + 1);

        });

        updateClient();

        return res.json({

            success: true,

            products: getOrderedProducts()

        });

    }

    const productById = new Map(products.map(product => [product.id, product]));
    const nextOrder = new Map();

    orderedIds.forEach((id, index) => {

        nextOrder.set(id, index + 1);

    });

    const remainingProducts = products
        .filter(product => !nextOrder.has(product.id))
        .sort((a, b) => {

            const aOrder = Number.isFinite(Number(a.sortOrder)) ? Number(a.sortOrder) : Number.MAX_SAFE_INTEGER;
            const bOrder = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : Number.MAX_SAFE_INTEGER;

            return aOrder - bOrder || Number(a.id) - Number(b.id);

        });

    nextOrder.forEach((sortOrder, id) => {

        const product = productById.get(id);
        if (product) {

            product.sortOrder = sortOrder;

        }

    });

    remainingProducts.forEach((product, index) => {

        product.sortOrder = orderedIds.length + index + 1;

    });

    updateClient();

    res.json({

        success: true,

        products: getOrderedProducts()

    });

});

/* ===========================
   UPDATE STOCK
=========================== */

app.post("/product/stock", (req, res) => {

    const {

        id,

        stock

    } = req.body;

    const product = findProductById(id);

    if (!product) {

        return res.status(404).json({

            error: "Không tìm thấy"

        });

    }

    syncProductStockWithVariantStocks(product, stock);

    reconcileCartStockForProduct(product.id);

    updateClient();

    res.json({

        success: true

    });

});

/* ===========================
   DELETE PRODUCT
=========================== */

app.delete("/product/:id", (req, res) => {

    const id = Number(req.params.id);

    products = products.filter(

        p => p.id !== id

    );
    rebuildProductsIndex();

    cart = cart.filter(

        p => p.id !== id

    );

    updateClient();

    res.json({

        success: true

    });

});

/* ===========================
   UPLOAD
=========================== */

app.post("/upload",

(req, res) => {

    upload.single("image")(req, res, async (err) => {

        if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE") {
                return res.status(413).json({ error: `Ảnh quá lớn, vui lòng chọn file nhỏ hơn ${uploadMaxFileSizeMb}MB` });
            }

            return res.status(400).json({ error: "Upload không hợp lệ" });
        }

        if (err) {
            return res.status(500).json({ error: "Lỗi upload ảnh, vui lòng thử lại" });
        }

        if (!req.file) {

            return res.status(400).json({

                error: "Không có ảnh"

            });

        }

        const uploadedFilePath = req.file.path;
        let responseFilePath = uploadedFilePath;
        let responseFileName = req.file.filename;

        if (sharp) {
            try {
                const parsed = path.parse(req.file.filename);
                const webpFileName = `${parsed.name}.webp`;
                const webpFilePath = path.join(uploadDir, webpFileName);

                await sharp(uploadedFilePath, { failOn: "none" })
                    .rotate()
                    .resize({
                        width: imageMaxWidthPx,
                        withoutEnlargement: true,
                        fit: "inside"
                    })
                    .webp({ quality: imageQuality, effort: 4 })
                    .toFile(webpFilePath);

                await fs.promises.unlink(uploadedFilePath).catch(() => {});
                responseFilePath = webpFilePath;
                responseFileName = webpFileName;
            } catch (convertError) {
                console.warn("Không thể chuyển ảnh sang webp khi upload:", convertError.message);
            }
        }

        res.json({

            url: "/uploads/" + responseFileName

        });

        if (path.extname(responseFilePath).toLowerCase() !== ".webp") {
            // Do not block client save/update while optimizing large images.
            setImmediate(async () => {
                try {
                    await optimizeImageFile(responseFilePath);
                } catch (optimizationError) {
                    console.warn("Không thể tối ưu ảnh vừa upload:", optimizationError.message);
                }
            });
        }

    });

});

/* ===========================
   CART
=========================== */

app.get("/cart", (req, res) => {
    res.json(getSortedCart(getRequestedCategory(req), req.sessionId));

});

app.post("/add", (req, res) => {

    const {

        id,
        image: requestedImage,
        variantName: requestedVariantName,
        variantIndex: requestedVariantIndex,
        size: requestedSize

    } = req.body;
    const requestedCategory = getRequestedCategory(req);
    const sessionId = normalizeSessionId(req.sessionId);

    const product = findProductById(

        id

    );

    if (!product) {

        return res.json({

            error: "Không tồn tại"

        });

    }

    if (requestedCategory && getProductCategory(product) !== requestedCategory) {

        return res.status(400).json({

            error: "Danh mục không khớp"

        });

    }

    if (requestedCategory && isHiddenInCategory(product, requestedCategory)) {

        return res.status(400).json({

            error: "Sản phẩm đang ẩn"

        });

    }

    if (!requestedCategory && isHiddenInTotal(product)) {

        return res.status(400).json({

            error: "Sản phẩm đang ẩn"

        });

    }

    const productCategory = getProductCategory(product);
    const preferredImage = typeof requestedImage === "string" && requestedImage.trim()
        ? requestedImage.trim()
        : "";
    const effectiveImage = resolvePreferredVariantImage(product, preferredImage || product.image);
    const effectiveVariantName = resolvePreferredVariantName(product, effectiveImage, requestedVariantName, requestedVariantIndex);
    const effectiveVariantKey = buildVariantKey(effectiveVariantName, effectiveImage);
    const effectiveVariantIndex = getVariantIndex(product, effectiveImage, effectiveVariantName);
    const effectiveSize = resolveSelectedSizeByVariant(product, effectiveVariantIndex, requestedSize);
    const effectiveStockInfo = getVariantStockInfo(product, effectiveVariantIndex, effectiveSize);
    const effectiveSizeKey = buildSizeKey(effectiveSize);
    const effectiveItemKey = buildCartItemKey(effectiveVariantKey, effectiveSizeKey);
    const item = cart.find(

        x => x.id == id
            && normalizeSessionId(x.sessionId) === sessionId
            && normalizeCategoryName(x.category || productCategory) === productCategory
            && String(x.itemKey || buildCartItemKey(x.variantKey || "default", x.sizeKey || "size:default")) === effectiveItemKey

    );

    const requestedQty = item ? item.qty + 1 : 1;

    if (requestedQty > effectiveStockInfo.stock) {

        return res.status(400).json({

            error: "Không đủ tồn kho"

        });

    }

    if (item) {

        item.qty++;
        item.price = product.price;
        item.oldPrice = product.oldPrice ?? product.price;
        item.sku = product.sku || item.sku || "";
        item.category = getProductCategory(product);
        item.image = effectiveImage || item.image || product.image;
        item.variantName = effectiveVariantName || item.variantName || "";
        item.variantKey = effectiveVariantKey;
        item.selectedSize = effectiveSize;
        item.sizeKey = effectiveSizeKey;
        item.itemKey = effectiveItemKey;
        item.sessionId = sessionId;
        item.updatedAt = Date.now();

    } else {

        cart.push({

            id: product.id,

            name: product.name,
            sku: product.sku || "",
            category: getProductCategory(product),
            price: product.price,

            oldPrice: product.oldPrice ?? product.price,

            image: effectiveImage,
            variantName: effectiveVariantName,
            variantKey: effectiveVariantKey,
            selectedSize: effectiveSize,
            sizeKey: effectiveSizeKey,
            itemKey: effectiveItemKey,
            sessionId,
            updatedAt: Date.now(),

            qty: 1

        });

    }

    updateClient();

    res.json({

        success: true

    });

});

/* ===========================
   CHANGE CART
=========================== */

app.post("/change", (req, res) => {

    const {

        id,

        qty,

        image: requestedImage,

        variantName: requestedVariantName,

        variantKey: requestedVariantKey,

        size: requestedSize,

        sizeKey: requestedSizeKey,

        itemKey: requestedItemKey

    } = req.body;
    const requestedCategory = getRequestedCategory(req);
    const sessionId = normalizeSessionId(req.sessionId);

    const product = findProductById(id);

    if (!product) {

        return res.status(404).json({

            error: "Không tìm thấy sản phẩm"

        });

    }

    const productCategory = getProductCategory(product);

    if (requestedCategory && productCategory !== requestedCategory) {

        return res.status(400).json({

            error: "Danh mục không khớp"

        });

    }

    const matchedKey = String(requestedVariantKey || "").trim();
    const matchedSizeKey = String(requestedSizeKey || "").trim();
    const matchedItemKey = String(requestedItemKey || "").trim();

    const item = cart.find((x) => {
        if (!(x.id == id)) return false;
        if (normalizeSessionId(x.sessionId) !== sessionId) return false;
        if (normalizeCategoryName(x.category || productCategory) !== productCategory) return false;

        if (matchedItemKey) {
            return String(x.itemKey || buildCartItemKey(x.variantKey || "default", x.sizeKey || "size:default")) === matchedItemKey;
        }

        if (!matchedKey && !matchedSizeKey) return true;

        if (matchedSizeKey && String(x.sizeKey || "size:default") !== matchedSizeKey) return false;

        if (!matchedKey) return true;

        return String(x.variantKey || "default") === matchedKey;
    });

    if (!item) {

        return res.json({

            error: "Không tồn tại"

        });

    }

    const newQty = Number(qty);

    if (!Number.isFinite(newQty) || newQty < 0) {

        return res.status(400).json({

            error: "Số lượng không hợp lệ"

        });

    }

    item.price = product.price;
    item.oldPrice = product.oldPrice ?? product.price;
    item.sku = product.sku || item.sku || "";
    item.category = getProductCategory(product);

    const nextImage = typeof requestedImage === "string" && requestedImage.trim()
        ? requestedImage.trim()
        : item.image || product.image;
    const nextVariantName = resolveVariantName(product, nextImage, requestedVariantName, undefined) || item.variantName || "";
    const nextVariantKey = buildVariantKey(nextVariantName, nextImage);
    const nextVariantIndex = getVariantIndex(product, nextImage, nextVariantName);
    const nextSize = resolveSelectedSizeByVariant(product, nextVariantIndex, requestedSize || item.selectedSize || "");
    const nextStockInfo = getVariantStockInfo(product, nextVariantIndex, nextSize);
    const nextSizeKey = buildSizeKey(nextSize);
    const nextItemKey = buildCartItemKey(nextVariantKey, nextSizeKey);

    if (newQty > nextStockInfo.stock) {

        return res.status(400).json({

            error: "Không đủ tồn kho"

        });

    }

    if (newQty > 0) {
        const duplicateItem = cart.find((x) => {
            if (x === item) return false;
            if (!(x.id == id)) return false;
            if (normalizeSessionId(x.sessionId) !== sessionId) return false;
            if (normalizeCategoryName(x.category || productCategory) !== productCategory) return false;
            return String(x.itemKey || buildCartItemKey(x.variantKey || "default", x.sizeKey || "size:default")) === nextItemKey;
        });

        if (duplicateItem) {
            const mergedQty = duplicateItem.qty + newQty;

            if (mergedQty > nextStockInfo.stock) {
                return res.status(400).json({ error: "Không đủ tồn kho" });
            }

            duplicateItem.qty = mergedQty;
            duplicateItem.image = nextImage;
            duplicateItem.variantName = nextVariantName;
            duplicateItem.variantKey = nextVariantKey;
            duplicateItem.selectedSize = nextSize;
            duplicateItem.sizeKey = nextSizeKey;
            duplicateItem.itemKey = nextItemKey;
            duplicateItem.updatedAt = Date.now();
            cart = cart.filter((x) => x !== item);

            updateClient();
            return res.json({ success: true });
        }
    }

    item.image = nextImage;
    item.variantName = nextVariantName;
    item.variantKey = nextVariantKey;
    item.selectedSize = nextSize;
    item.sizeKey = nextSizeKey;
    item.itemKey = nextItemKey;
    item.qty = newQty;
    item.updatedAt = Date.now();

    if (item.qty <= 0) {

        cart = cart.filter(

            x => x !== item

        );

    }

    updateClient();

    res.json({

        success: true

    });

});

/* ===========================
   SOCKET
=========================== */

io.on("connection", socket => {

    socket.emit("update", {

        revision: dataRevision,

        ts: Date.now()

    });

});

/* ===========================
   SERVER
=========================== */

let currentPort = Number(process.env.PORT) || 3000;

function startServer(port) {
    server.listen(port, () => {
        currentPort = port;
        console.log("🚀 Server đang chạy:");
        console.log(`http://localhost:${port}/admin.html`);
        console.log(`http://localhost:${port}/shop.html`);
    });
}

server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
        const nextPort = currentPort + 1;
        console.warn(`Cổng ${currentPort} đang bị chiếm, đang thử ${nextPort}...`);
        currentPort = nextPort;
        startServer(nextPort);
    } else {
        console.error(err);
        process.exit(1);
    }
});

let shuttingDown = false;

async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`Nhận tín hiệu ${signal}, đang lưu dữ liệu và tắt server...`);

    try {
        if (persistTimer) {
            clearTimeout(persistTimer);
            persistTimer = null;
        }

        await persistStateImmediate();
    } catch (error) {
        console.error("Lỗi khi flush state lúc shutdown:", error.message);
    }

    server.close(() => {
        process.exit(0);
    });

    setTimeout(() => {
        process.exit(1);
    }, 5000).unref();
}

process.on("SIGINT", () => {
    gracefulShutdown("SIGINT");
});

process.on("SIGTERM", () => {
    gracefulShutdown("SIGTERM");
});

process.on("unhandledRejection", (reason) => {
    console.error("UnhandledRejection:", reason);
    gracefulShutdown("unhandledRejection");
});

process.on("uncaughtException", (error) => {
    console.error("UncaughtException:", error);
    gracefulShutdown("uncaughtException");
});

startServer(currentPort);
setImmediate(() => {
    optimizeExistingUploadsInBackground().catch((error) => {
        console.warn("Tối ưu ảnh nền thất bại:", error.message);
    });
});