import axios from "axios";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import session from "express-session";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  consumeNextUrl,
  currentUser,
  generateRandomPassword,
  hashPassword,
  requireAuth,
  verifyPassword
} from "./auth.js";
import { config, paths, publicConfig } from "./config.js";
import { findProduct, getActiveProducts, getProductsByCategory, pool, query } from "./db.js";
import { paymentForm, verifyCheckMacValue } from "./ecpay.js";
import { ensurePanelUser, getPanelUserByEmail, listPanelNodes, resetPanelUserPassword, verifyPanelCredentials } from "./pterodactyl.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const sessionMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
const paymentMethods = {
  cvs_711: { label: "7-11 超商代碼", choosePayment: "CVS", chooseSubPayment: "IBON", feeKey: "cvs" },
  cvs_family: { label: "全家超商代碼", choosePayment: "CVS", chooseSubPayment: "FAMILY", feeKey: "cvs" },
  cvs_hilife: { label: "萊爾富超商代碼", choosePayment: "CVS", chooseSubPayment: "HILIFE", feeKey: "cvs" }
};
const productCategories = ["Minecraft伺服器", "Discord Bot"];
const orderStatuses = [
  { value: "pending", label: "未繳費" },
  { value: "paid", label: "已繳費" },
  { value: "manual", label: "開通中" },
  { value: "provisioned", label: "已完成" },
  { value: "failed", label: "取消" }
];
const statusLabels = Object.fromEntries(orderStatuses.map((status) => [status.value, status.label]));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: config.session.secret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: "lax", maxAge: sessionMaxAgeMs }
}));

app.use(async (req, res, next) => {
  try {
    const user = await currentUser(req);
    if (user) user.isAdmin = await isPanelAdmin(user.email, req);
    const cart = await buildCart(req);
    res.locals.config = publicConfig();
    res.locals.cart = cart;
    res.locals.user = user;
    res.locals.productCategories = productCategories;
    res.locals.paymentMethods = paymentMethods;
    next();
  } catch (error) {
    next(error);
  }
});

app.get("/", async (req, res, next) => {
  try {
    const products = await getActiveProducts();
    res.render("home", { products });
  } catch (error) {
    next(error);
  }
});

app.get("/products/:category", async (req, res, next) => {
  try {
    const category = decodeURIComponent(req.params.category);
    if (!productCategories.includes(category)) return res.status(404).render("error", { message: "找不到產品分類。" });
    const products = await getProductsByCategory(category);
    res.render("category", { category, products });
  } catch (error) {
    next(error);
  }
});

app.get("/product/:productId", async (req, res, next) => {
  try {
    const product = await findProduct(req.params.productId);
    if (!product) return res.status(404).render("error", { message: "找不到方案。" });
    res.render("product-detail", { product, error: null });
  } catch (error) {
    next(error);
  }
});

app.post("/cart/add/:productId", async (req, res, next) => {
  try {
    const product = await findProduct(req.params.productId);
    if (!product) return res.status(404).render("error", { message: "找不到方案。" });
    const quantity = Math.max(1, Math.min(10, Number.parseInt(req.body.quantity || "1", 10) || 1));
    const cart = getSessionCart(req);
    const productId = Number(product.id);
    const existing = cart.items.find((item) => Number(item.productId) === productId);
    if (existing) existing.quantity = Math.min(10, existing.quantity + quantity);
    else cart.items.push({ productId, quantity });
    req.session.cart = cart;
    res.redirect("/cart");
  } catch (error) {
    next(error);
  }
});

app.get("/cart", async (req, res, next) => {
  try {
    res.render("cart", { error: null, success: null });
  } catch (error) {
    next(error);
  }
});

app.post("/cart/coupon", async (req, res, next) => {
  try {
    const code = String(req.body.coupon || "").trim().toUpperCase();
    const cart = getSessionCart(req);
    if (!code) {
      delete cart.couponCode;
      req.session.cart = cart;
      res.locals.cart = await buildCart(req);
      return res.render("cart", { error: null, success: "優惠代碼已移除。" });
    }

    const coupon = await findCoupon(code);
    if (!coupon) {
      res.locals.cart = await buildCart(req);
      return res.status(400).render("cart", { error: "優惠代碼無效或已停用。", success: null });
    }
    cart.couponCode = coupon.code;
    req.session.cart = cart;
    res.locals.cart = await buildCart(req);
    res.render("cart", { error: null, success: `已套用優惠代碼 ${coupon.code}。` });
  } catch (error) {
    next(error);
  }
});

app.post("/cart/payment", async (req, res, next) => {
  try {
    setPaymentMethod(req, req.body.paymentMethod);
    const cart = await buildCart(req);
    if (wantsJson(req)) return res.json(cartPayload(cart));
    res.locals.cart = cart;
    res.render("cart", { error: null, success: null });
  } catch (error) {
    next(error);
  }
});

app.post("/cart/quantity/:productId", async (req, res, next) => {
  const cart = getSessionCart(req);
  const productId = Number(req.params.productId);
  const item = cart.items.find((entry) => Number(entry.productId) === productId);
  if (!item) return res.redirect("/cart");

  const action = String(req.body.action || "");
  if (action === "increment") item.quantity = Math.min(10, item.quantity + 1);
  if (action === "decrement") item.quantity = Math.max(1, item.quantity - 1);
  req.session.cart = cart;
  try {
    const updatedCart = await buildCart(req);
    if (wantsJson(req)) return res.json(cartPayload(updatedCart));
    res.redirect("/cart");
  } catch (error) {
    next(error);
  }
});

app.post("/cart/remove/:productId", (req, res) => {
  const cart = getSessionCart(req);
  cart.items = cart.items.filter((item) => Number(item.productId) !== Number(req.params.productId));
  req.session.cart = cart;
  res.redirect("/cart");
});

app.get("/checkout", requireAuth, async (req, res) => {
  const cart = await buildCart(req);
  if (cart.items.length === 0) return res.redirect("/cart");
  res.locals.cart = cart;
  res.render("checkout", { error: null, success: null });
});

app.post("/checkout/coupon", requireAuth, async (req, res, next) => {
  try {
    const code = String(req.body.coupon || "").trim().toUpperCase();
    const cart = getSessionCart(req);
    if (!code) {
      delete cart.couponCode;
      req.session.cart = cart;
      res.locals.cart = await buildCart(req);
      return res.render("checkout", { error: null, success: "優惠代碼已移除。" });
    }

    const coupon = await findCoupon(code);
    if (!coupon) {
      res.locals.cart = await buildCart(req);
      return res.status(400).render("checkout", { error: "優惠代碼無效或已停用。", success: null });
    }
    cart.couponCode = coupon.code;
    req.session.cart = cart;
    res.locals.cart = await buildCart(req);
    res.render("checkout", { error: null, success: `已套用優惠代碼 ${coupon.code}。` });
  } catch (error) {
    next(error);
  }
});

app.post("/checkout/payment", requireAuth, async (req, res, next) => {
  try {
    setPaymentMethod(req, req.body.paymentMethod);
    const cart = await buildCart(req);
    if (wantsJson(req)) return res.json(cartPayload(cart));
    res.locals.cart = cart;
    res.render("checkout", { error: null, success: null });
  } catch (error) {
    next(error);
  }
});

app.post("/checkout", requireAuth, async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const cart = await buildCart(req);
    if (cart.items.length === 0) return res.redirect("/cart");
    const customer = res.locals.user;
    if (!customer) return res.redirect("/login");

    await connection.beginTransaction();
    const orderNo = `MH${Date.now().toString().slice(-12)}${Math.floor(Math.random() * 90 + 10)}`;
    const firstItem = cart.items[0];
    const [orderResult] = await connection.execute(`
      INSERT INTO orders (order_no, customer_id, product_id, amount, subtotal, discount_amount, coupon_code)
      VALUES (:orderNo, :customerId, :productId, :amount, :subtotal, :discountAmount, :couponCode)
    `, {
      orderNo,
      customerId: customer.id,
      productId: firstItem.product.id,
      amount: cart.total,
      subtotal: cart.subtotal,
      discountAmount: cart.discount,
      couponCode: cart.coupon?.code || null
    });

    for (const item of cart.items) {
      await connection.execute(`
        INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity)
        VALUES (:orderId, :productId, :productName, :unitPrice, :quantity)
      `, {
        orderId: orderResult.insertId,
        productId: item.product.id,
        productName: item.product.name,
        unitPrice: item.product.price,
        quantity: item.quantity
      });
    }
    await connection.commit();

    req.session.cart = { items: [] };
    const baseUrl = config.site.baseUrl.replace(/\/$/, "");
    const itemName = cart.items.map((item) => `${item.product.name} x${item.quantity}`).join("#");
    const paymentMethod = paymentMethods[cart.paymentMethod] ?? paymentMethods.cvs_711;
    const params = {
      MerchantID: config.ecpay.merchantId,
      MerchantTradeNo: orderNo,
      MerchantTradeDate: formatEcpayDate(new Date()),
      PaymentType: "aio",
      TotalAmount: String(cart.total),
      TradeDesc: "MistHost hosting order",
      ItemName: itemName.slice(0, 400),
      ReturnURL: `${baseUrl}/payments/ecpay/return`,
      ChoosePayment: paymentMethod.choosePayment,
      EncryptType: "1",
      StoreExpireDate: "10080",
      ClientBackURL: `${baseUrl}/orders/${orderResult.insertId}`,
      ChooseSubPayment: paymentMethod.chooseSubPayment,
      CustomField1: String(orderResult.insertId),
      CustomField2: cart.paymentMethod
    };
    res.render("ecpay-form", paymentForm(params));
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

app.get("/register", (req, res) => {
  res.render("auth", { mode: "register", error: null });
});

app.post("/register", async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!name || !email || password.length < 8) {
      return res.status(400).render("auth", { mode: "register", error: "請輸入姓名、Email，密碼至少 8 碼。" });
    }

    const existing = await findCustomerByEmail(email);
    if (existing?.password_hash) {
      return res.status(409).render("auth", { mode: "register", error: "這個 Email 已經註冊，請直接登入。" });
    }

    const panelResult = await syncPterodactylUser({ email, name, password });
    const accountPassword = panelResult.status === "exists" ? generateRandomPassword(16) : password;
    const passwordHash = await hashPassword(accountPassword);
    await query(`
      INSERT INTO customers (email, name, password_hash, auth_provider, pterodactyl_user_id, pterodactyl_sync_status, panel_password_last)
      VALUES (:email, :name, :passwordHash, 'local', :panelUserId, :panelStatus, :panelPassword)
      ON CONFLICT(email) DO UPDATE SET
        name = excluded.name,
        password_hash = excluded.password_hash,
        auth_provider = 'local',
        pterodactyl_user_id = excluded.pterodactyl_user_id,
        pterodactyl_sync_status = excluded.pterodactyl_sync_status,
        panel_password_last = excluded.panel_password_last
    `, {
      email,
      name,
      passwordHash,
      panelUserId: panelResult.id,
      panelStatus: panelResult.message,
      panelPassword: accountPassword
    });

    const user = await findCustomerByEmail(email);
    req.session.userId = user.id;
    res.redirect(resolveReturnTo(req) || consumeNextUrl(req));
  } catch (error) {
    next(error);
  }
});

app.get("/login", (req, res) => {
  res.render("auth", { mode: "login", error: null });
});

app.post("/login", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    let user = await findCustomerByEmail(email);
    const localPasswordValid = user ? await verifyPassword(password, user.password_hash) : false;
    if (!localPasswordValid) {
      const panelPasswordValid = await verifyPanelPasswordLogin(email, password);
      if (!panelPasswordValid) {
        return res.status(401).render("auth", { mode: "login", error: "Email 或密碼錯誤。" });
      }
      user = await upsertCustomerFromPanelLogin(email, password, user);
    }
    if (!user) {
      return res.status(401).render("auth", { mode: "login", error: "Email 或密碼錯誤。" });
    }

    req.session.userId = user.id;
    res.redirect(resolveReturnTo(req) || consumeNextUrl(req));
  } catch (error) {
    next(error);
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

app.get("/auth/:provider", (req, res) => {
  const provider = getOAuthProvider(req.params.provider);
  if (!provider) return res.status(404).render("error", { message: "不支援的登入方式。" });
  if (!provider.config.enabled) return res.status(400).render("error", { message: `${provider.label} 登入尚未啟用，請先在 config.json 填入 OAuth 設定。` });

  const state = crypto.randomBytes(24).toString("hex");
  req.session.oauthState = { provider: provider.name, state };
  if (isSafeReturnTo(req.query.returnTo)) req.session.nextUrl = String(req.query.returnTo);
  res.redirect(provider.authorizeUrl(state));
});

app.get("/auth/:provider/callback", async (req, res, next) => {
  try {
    const provider = getOAuthProvider(req.params.provider);
    if (!provider) return res.status(404).render("error", { message: "不支援的登入方式。" });
    if (req.session.oauthState?.provider !== provider.name || req.session.oauthState?.state !== req.query.state) {
      return res.status(400).render("error", { message: "OAuth 驗證狀態不一致，請重新登入。" });
    }
    delete req.session.oauthState;

    const profile = await provider.fetchProfile(String(req.query.code || ""));
    if (!profile.email) return res.status(400).render("error", { message: `${provider.label} 沒有回傳 Email，無法建立帳戶。` });

    const existingCustomer = await findCustomerByEmail(profile.email);
    const generatedAccountPassword = existingCustomer?.password_hash ? null : generateRandomPassword(16);
    const panelSyncPassword = generatedAccountPassword || existingCustomer?.panel_password_last || generateRandomPassword(16);
    const panelResult = await syncPterodactylUser({ email: profile.email, name: profile.name, password: panelSyncPassword });
    const passwordHash = generatedAccountPassword ? await hashPassword(generatedAccountPassword) : null;

    await query(`
      INSERT INTO customers (email, name, password_hash, auth_provider, provider_id, pterodactyl_user_id, pterodactyl_sync_status, panel_password_last)
      VALUES (:email, :name, :passwordHash, :provider, :providerId, :panelUserId, :panelStatus, :accountPassword)
      ON CONFLICT(email) DO UPDATE SET
        name = excluded.name,
        password_hash = COALESCE(customers.password_hash, excluded.password_hash),
        provider_id = excluded.provider_id,
        auth_provider = CASE
          WHEN customers.password_hash IS NOT NULL THEN customers.auth_provider
          ELSE excluded.auth_provider
        END,
        pterodactyl_user_id = excluded.pterodactyl_user_id,
        pterodactyl_sync_status = excluded.pterodactyl_sync_status,
        panel_password_last = COALESCE(customers.panel_password_last, excluded.panel_password_last)
    `, {
      email: profile.email,
      name: profile.name,
      passwordHash,
      provider: provider.name,
      providerId: profile.id,
      panelUserId: panelResult.id,
      panelStatus: panelResult.message,
      accountPassword: generatedAccountPassword
    });

    const user = await findCustomerByEmail(profile.email);
    req.session.userId = user.id;
    res.redirect(consumeNextUrl(req));
  } catch (error) {
    next(error);
  }
});

app.get("/account", requireAuth, async (req, res, next) => {
  try {
    const activeTab = req.query.tab === "profile" ? "profile" : "orders";
    const orders = await query(`
      SELECT o.*, p.name AS product_name
      FROM orders o
      JOIN products p ON p.id = o.product_id
      WHERE o.customer_id = :customerId
      ORDER BY o.created_at DESC
    `, { customerId: req.session.userId });
    res.render("account", {
      activeTab,
      orders,
      passwordLabel: res.locals.user.panel_password_last || "尚未儲存",
      resetPassword: null,
      statusLabels
    });
  } catch (error) {
    next(error);
  }
});

app.post("/account/reset-panel-password", requireAuth, async (req, res, next) => {
  try {
    const password = generateRandomPassword(16);
    const result = await resetPanelUserPassword({ email: res.locals.user.email, password });
    const passwordHash = await hashPassword(password);
    await query(`
      UPDATE customers
      SET panel_password_last = :password,
          password_hash = :passwordHash,
          pterodactyl_user_id = COALESCE(:panelUserId, pterodactyl_user_id),
          pterodactyl_sync_status = :status
      WHERE id = :id
    `, {
      id: res.locals.user.id,
      password,
      passwordHash,
      panelUserId: result.id,
      status: result.message
    });
    const orders = await query(`
      SELECT o.*, p.name AS product_name
      FROM orders o
      JOIN products p ON p.id = o.product_id
      WHERE o.customer_id = :customerId
      ORDER BY o.created_at DESC
    `, { customerId: req.session.userId });
    res.locals.user.panel_password_last = password;
    res.render("account", {
      activeTab: "profile",
      orders,
      passwordLabel: password,
      resetPassword: password,
      statusLabels
    });
  } catch (error) {
    next(error);
  }
});

app.get("/admin", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    res.render("admin", await adminData(req.query.tab || "orders"));
  } catch (error) {
    next(error);
  }
});

app.post("/admin/coupons", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await query(`
      INSERT INTO coupons (code, type, value, active)
      VALUES (:code, :type, :value, 1)
      ON CONFLICT(code) DO UPDATE SET type = excluded.type, value = excluded.value, active = 1
    `, {
      code: String(req.body.code || "").trim().toUpperCase(),
      type: req.body.type === "fixed" ? "fixed" : "percent",
      value: Math.max(0, Number.parseInt(req.body.value || "0", 10) || 0)
    });
    res.redirect("/admin?tab=coupons");
  } catch (error) {
    next(error);
  }
});

app.post("/admin/coupons/:id/delete", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await query("DELETE FROM coupons WHERE id = :id", { id: req.params.id });
    res.redirect("/admin?tab=coupons");
  } catch (error) {
    next(error);
  }
});

app.post("/admin/fees", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    config.ecpay.fees = config.ecpay.fees || {};
    config.ecpay.fees.cvs = Math.max(0, Number.parseInt(req.body.cvsFee || "0", 10) || 0);
    fs.writeFileSync(paths.configPath, `${JSON.stringify(config, null, 2)}\n`);
    res.redirect("/admin?tab=fees");
  } catch (error) {
    next(error);
  }
});

app.post("/admin/nodes", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    for (const category of productCategories) {
      const nodeId = Math.max(0, Number.parseInt(req.body[`node_${category}`] || "0", 10) || 0);
      const nodeName = String(req.body[`node_name_${category}`] || "").trim();
      await query(`
        INSERT INTO category_node_settings (category, node_id, node_name)
        VALUES (:category, :nodeId, :nodeName)
        ON CONFLICT(category) DO UPDATE SET
          node_id = excluded.node_id,
          node_name = excluded.node_name
      `, {
        category,
        nodeId: nodeId || null,
        nodeName: nodeId ? nodeName : null
      });
    }
    res.redirect("/admin?tab=nodes");
  } catch (error) {
    next(error);
  }
});

app.post("/admin/orders/:id/status", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const allowed = orderStatuses.map((status) => status.value);
    const status = allowed.includes(req.body.status) ? req.body.status : "pending";
    await query("UPDATE orders SET status = :status WHERE id = :id", { id: req.params.id, status });
    res.redirect("/admin?tab=orders");
  } catch (error) {
    next(error);
  }
});

app.post("/admin/products", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    const slug = String(req.body.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, "-")).replace(/^-|-$/g, "");
    const cpu = Math.max(1, Number.parseInt(req.body.cpu || "1", 10) || 1);
    const ram = Math.max(1, Number.parseInt(req.body.ram || "1", 10) || 1);
    const storage = Math.max(1, Number.parseInt(req.body.storage || "10", 10) || 10);
    const specs = {
      CPU: `${cpu} 核心`,
      Memory: `${ram} GB`,
      Disk: `${storage} GB NVMe`
    };
    await query(`
      INSERT INTO products (name, slug, category, description, price, period, specs, provision_config, sort_order)
      VALUES (:name, :slug, :category, :description, :price, 'monthly', :specs, :provisionConfig, 99)
    `, {
      name,
      slug,
      category: String(req.body.category || "Minecraft伺服器"),
      description: String(req.body.description || `${name} hosting plan`),
      price: Math.max(0, Number.parseInt(req.body.price || "0", 10) || 0),
      specs: JSON.stringify(specs),
      provisionConfig: JSON.stringify({})
    });
    res.redirect("/admin?tab=products");
  } catch (error) {
    next(error);
  }
});

app.post("/admin/products/:id/price", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const cpu = Math.max(1, Number.parseInt(req.body.cpu || "1", 10) || 1);
    const ram = Math.max(1, Number.parseInt(req.body.ram || "1", 10) || 1);
    const storage = Math.max(1, Number.parseInt(req.body.storage || "10", 10) || 10);
    const specs = {
      CPU: `${cpu} 核心`,
      Memory: `${ram} GB`,
      Disk: `${storage} GB NVMe`
    };
    await query(`
      UPDATE products
      SET price = :price,
          category = :category,
          specs = :specs
      WHERE id = :id
    `, {
      id: req.params.id,
      price: Math.max(0, Number.parseInt(req.body.price || "0", 10) || 0),
      category: String(req.body.category || "Minecraft伺服器"),
      specs: JSON.stringify(specs)
    });
    res.redirect("/admin?tab=products");
  } catch (error) {
    next(error);
  }
});

app.post("/admin/products/:id/delete", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await query("UPDATE products SET active = 0 WHERE id = :id", { id: req.params.id });
    res.redirect("/admin?tab=products");
  } catch (error) {
    next(error);
  }
});

app.post("/admin/products/:id/active", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const active = req.body.active === "1" ? 1 : 0;
    await query("UPDATE products SET active = :active WHERE id = :id", { id: req.params.id, active });
    res.redirect("/admin?tab=products");
  } catch (error) {
    next(error);
  }
});

app.post("/payments/ecpay/return", async (req, res, next) => {
  try {
    if (!verifyCheckMacValue(req.body)) return res.status(400).send("0|CheckMacValue invalid");

    const orderNo = req.body.MerchantTradeNo;
    const rtnCode = String(req.body.RtnCode);
    if (rtnCode !== "1") {
      await query("UPDATE orders SET status = 'failed', provision_message = :message WHERE order_no = :orderNo", {
        orderNo,
        message: req.body.RtnMsg || "ECPay payment failed."
      });
      return res.send("1|OK");
    }

    const orderRows = await query(`
      SELECT o.*, c.email, c.name AS customer_name
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      WHERE o.order_no = :orderNo
      LIMIT 1
    `, { orderNo });
    const order = orderRows[0];
    if (!order) return res.send("1|OK");
    if (["paid", "provisioned", "manual", "failed"].includes(order.status)) return res.send("1|OK");

    await query(`
      UPDATE orders
      SET status = 'paid', ecpay_trade_no = :tradeNo, ecpay_payment_type = :paymentType, paid_at = CURRENT_TIMESTAMP
      WHERE id = :id
    `, {
      id: order.id,
      tradeNo: req.body.TradeNo || null,
      paymentType: req.body.PaymentType || null
    });

    return res.send("1|OK");
  } catch (error) {
    next(error);
  }
});

app.get("/orders/:id", requireAuth, async (req, res, next) => {
  try {
    const rows = await query(`
      SELECT o.*, COALESCE(p.name, (
        SELECT oi.product_name
        FROM order_items oi
        WHERE oi.order_id = o.id
        LIMIT 1
      ), '已刪除商品') AS product_name, c.email, c.name AS customer_name
      FROM orders o
      LEFT JOIN products p ON p.id = o.product_id
      JOIN customers c ON c.id = o.customer_id
      WHERE o.id = :id AND (o.customer_id = :customerId OR :isAdmin = 1)
    `, { id: req.params.id, customerId: req.session.userId, isAdmin: res.locals.user?.isAdmin ? 1 : 0 });
    if (!rows[0]) return res.status(404).render("error", { message: "找不到訂單。" });
    const items = await query("SELECT * FROM order_items WHERE order_id = :orderId", { orderId: rows[0].id });
    res.render("order", { order: rows[0], items, statusLabels });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).render("error", { message: "系統發生錯誤，請稍後再試。" });
});

function getSessionCart(req) {
  if (!req.session.cart || !Array.isArray(req.session.cart.items)) req.session.cart = { items: [] };
  if (!paymentMethods[req.session.cart.paymentMethod]) req.session.cart.paymentMethod = "cvs_711";
  return req.session.cart;
}

async function buildCart(req) {
  const sessionCart = getSessionCart(req);
  const items = [];
  for (const item of sessionCart.items) {
    const productId = Number(item.productId);
    const product = await findProduct(productId);
    if (!product) continue;
    const quantity = Math.max(1, Number(item.quantity) || 1);
    items.push({ product, quantity, lineTotal: product.price * quantity });
  }
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const coupon = sessionCart.couponCode ? await findCoupon(sessionCart.couponCode) : null;
  const discount = calculateDiscount(subtotal, coupon);
  const paymentMethod = paymentMethods[sessionCart.paymentMethod] ?? paymentMethods.cvs_711;
  const paymentFee = calculatePaymentFee(paymentMethod, subtotal, discount);
  return {
    items,
    subtotal,
    coupon,
    discount,
    paymentFee,
    total: Math.max(0, subtotal - discount + paymentFee),
    count: items.reduce((sum, item) => sum + item.quantity, 0),
    paymentMethod: sessionCart.paymentMethod,
    paymentLabel: paymentMethod.label
  };
}

function setPaymentMethod(req, method) {
  const cart = getSessionCart(req);
  cart.paymentMethod = paymentMethods[method] ? method : "cvs_711";
  req.session.cart = cart;
}

async function requireAdmin(req, res, next) {
  if (res.locals.user?.isAdmin) return next();
  return res.status(403).render("error", { message: "此頁面僅限 Pterodactyl 管理員使用。" });
}

async function isPanelAdmin(email, req) {
  if (!email || !config.pterodactyl.enabled) return false;
  try {
    const panelUser = await getPanelUserByEmail(email);
    return Boolean(panelUser?.root_admin);
  } catch {
    return false;
  }
}

async function adminData(activeTab) {
  const [orders, products, coupons, users, openOrders, nodeSettings, panelNodes] = await Promise.all([
    query(`
      SELECT o.*,
             c.email,
             c.name AS customer_name,
             COALESCE((
               SELECT GROUP_CONCAT(oi.product_name || ' x' || oi.quantity, ' / ')
               FROM order_items oi
               WHERE oi.order_id = o.id
             ), p.name, o.order_no) AS order_name
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN products p ON p.id = o.product_id
      ORDER BY o.created_at DESC
    `),
    query("SELECT * FROM products ORDER BY active DESC, sort_order ASC, id ASC"),
    query("SELECT * FROM coupons ORDER BY created_at DESC"),
    query(`
      SELECT c.id,
             c.email,
             c.name,
             c.created_at,
             COUNT(CASE WHEN o.status IN ('pending', 'paid', 'manual') THEN 1 END) AS open_orders
      FROM customers c
      LEFT JOIN orders o ON o.customer_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `),
    query(`
      SELECT o.id,
             o.order_no,
             o.customer_id,
             o.amount,
             o.status,
             COALESCE((
               SELECT GROUP_CONCAT(oi.product_name || ' x' || oi.quantity, ' / ')
               FROM order_items oi
               WHERE oi.order_id = o.id
             ), p.name, o.order_no) AS order_name
      FROM orders o
      LEFT JOIN products p ON p.id = o.product_id
      WHERE o.status IN ('pending', 'paid', 'manual')
      ORDER BY o.created_at DESC
    `),
    query("SELECT * FROM category_node_settings"),
    activeTab === "nodes" ? getPanelNodesForAdmin() : Promise.resolve([])
  ]);
  const openOrdersByUser = openOrders.reduce((map, order) => {
    if (!map[order.customer_id]) map[order.customer_id] = [];
    map[order.customer_id].push(order);
    return map;
  }, {});
  const nodeSettingsByCategory = Object.fromEntries(nodeSettings.map((setting) => [setting.category, setting]));
  return {
    activeTab,
    orders,
    products: products.map((product) => ({ ...product, parsedSpecs: parseProductSpecs(product.specs) })),
    coupons,
    users: users.map((user) => ({ ...user, openOrderItems: openOrdersByUser[user.id] || [] })),
    cvsFee: Number(config.ecpay?.fees?.cvs || 0),
    productCategories,
    panelNodes,
    nodeSettings: nodeSettingsByCategory,
    orderStatuses,
    statusLabels
  };
}

async function getPanelNodesForAdmin() {
  try {
    return await listPanelNodes();
  } catch {
    return [];
  }
}

function parseProductSpecs(specs) {
  try {
    const parsed = JSON.parse(specs || "{}");
    return {
      ...parsed,
      cpuValue: Math.max(1, Number.parseInt(parsed.CPU || "1", 10) || 1),
      ramValue: Math.max(1, Number.parseInt(parsed.Memory || "1", 10) || 1),
      storageValue: Math.max(1, Number.parseInt(parsed.Disk || "10", 10) || 10)
    };
  } catch {
    return { cpuValue: 1, ramValue: 1, storageValue: 10 };
  }
}

function cartPayload(cart) {
  return {
    subtotal: cart.subtotal,
    discount: cart.discount,
    paymentFee: cart.paymentFee,
    total: cart.total,
    count: cart.count,
    paymentMethod: cart.paymentMethod,
    paymentLabel: cart.paymentLabel,
    items: cart.items.map((item) => ({
      productId: item.product.id,
      quantity: item.quantity,
      lineTotal: item.lineTotal
    }))
  };
}

function wantsJson(req) {
  return req.get("X-Requested-With") === "fetch" || req.accepts(["json", "html"]) === "json";
}

async function findCoupon(code) {
  const rows = await query("SELECT * FROM coupons WHERE code = :code AND active = 1", { code: String(code || "").toUpperCase() });
  return rows[0] ?? null;
}

function calculateDiscount(subtotal, coupon) {
  if (!coupon || subtotal <= 0) return 0;
  if (coupon.type === "percent") return Math.floor(subtotal * coupon.value / 100);
  return Math.min(subtotal, coupon.value);
}

function calculatePaymentFee(paymentMethod, subtotal, discount) {
  if (subtotal <= 0 || subtotal - discount <= 0) return 0;
  const feeKey = paymentMethod.feeKey || "cvs";
  return Number(config.ecpay?.fees?.[feeKey] || 0);
}

function getOAuthProvider(name) {
  const baseUrl = config.site.baseUrl.replace(/\/$/, "");
  if (name === "google") {
    const oauthConfig = config.oauth?.google ?? {};
    return {
      name: "google",
      label: "Google",
      config: oauthConfig,
      authorizeUrl(state) {
        const params = new URLSearchParams({
          client_id: oauthConfig.clientId,
          redirect_uri: `${baseUrl}/auth/google/callback`,
          response_type: "code",
          scope: "openid email profile",
          state,
          prompt: "select_account"
        });
        return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
      },
      async fetchProfile(code) {
        const token = await axios.post("https://oauth2.googleapis.com/token", new URLSearchParams({
          code,
          client_id: oauthConfig.clientId,
          client_secret: oauthConfig.clientSecret,
          redirect_uri: `${baseUrl}/auth/google/callback`,
          grant_type: "authorization_code"
        }));
        const { data } = await axios.get("https://www.googleapis.com/oauth2/v3/userinfo", {
          headers: { Authorization: `Bearer ${token.data.access_token}` }
        });
        return { id: data.sub, email: String(data.email || "").toLowerCase(), name: data.name || data.email };
      }
    };
  }

  if (name === "discord") {
    const oauthConfig = config.oauth?.discord ?? {};
    return {
      name: "discord",
      label: "Discord",
      config: oauthConfig,
      authorizeUrl(state) {
        const params = new URLSearchParams({
          client_id: oauthConfig.clientId,
          redirect_uri: `${baseUrl}/auth/discord/callback`,
          response_type: "code",
          scope: "identify email",
          state
        });
        return `https://discord.com/api/oauth2/authorize?${params}`;
      },
      async fetchProfile(code) {
        const token = await axios.post("https://discord.com/api/oauth2/token", new URLSearchParams({
          code,
          client_id: oauthConfig.clientId,
          client_secret: oauthConfig.clientSecret,
          redirect_uri: `${baseUrl}/auth/discord/callback`,
          grant_type: "authorization_code"
        }), {
          headers: { "Content-Type": "application/x-www-form-urlencoded" }
        });
        const { data } = await axios.get("https://discord.com/api/users/@me", {
          headers: { Authorization: `Bearer ${token.data.access_token}` }
        });
        return {
          id: data.id,
          email: String(data.email || "").toLowerCase(),
          name: data.global_name || data.username || data.email
        };
      }
    };
  }

  return null;
}

async function syncPterodactylUser({ email, name, password }) {
  try {
    return await ensurePanelUser({ email, name, password });
  } catch (error) {
    return {
      status: "error",
      id: null,
      message: `Pterodactyl sync failed: ${error.response?.data?.errors?.[0]?.detail || error.message}`
    };
  }
}

async function verifyPanelPasswordLogin(email, password) {
  try {
    return await verifyPanelCredentials({ email, password });
  } catch {
    return false;
  }
}

async function upsertCustomerFromPanelLogin(email, password, existingUser) {
  const panelUser = await getPanelUserByEmail(email);
  const passwordHash = await hashPassword(password);
  const name = existingUser?.name || [panelUser?.first_name, panelUser?.last_name].filter(Boolean).join(" ") || email;
  await query(`
    INSERT INTO customers (email, name, password_hash, auth_provider, pterodactyl_user_id, pterodactyl_sync_status, panel_password_last)
    VALUES (:email, :name, :passwordHash, 'panel', :panelUserId, :panelStatus, :panelPassword)
    ON CONFLICT(email) DO UPDATE SET
      name = COALESCE(customers.name, excluded.name),
      password_hash = excluded.password_hash,
      pterodactyl_user_id = COALESCE(excluded.pterodactyl_user_id, customers.pterodactyl_user_id),
      pterodactyl_sync_status = excluded.pterodactyl_sync_status,
      panel_password_last = excluded.panel_password_last
  `, {
    email,
    name,
    passwordHash,
    panelUserId: panelUser?.id || null,
    panelStatus: "Panel password verified.",
    panelPassword: password
  });
  return findCustomerByEmail(email);
}

async function findCustomerByEmail(email) {
  const rows = await query("SELECT * FROM customers WHERE email = :email", { email });
  return rows[0] ?? null;
}

function resolveReturnTo(req) {
  const returnTo = String(req.body.returnTo || "");
  return isSafeReturnTo(returnTo) ? returnTo : null;
}

function isSafeReturnTo(returnTo) {
  return typeof returnTo === "string" && returnTo.startsWith("/") && !returnTo.startsWith("//");
}

function formatEcpayDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

app.listen(config.port, () => {
  console.log(`${config.site.name} listening on http://localhost:${config.port}`);
});
