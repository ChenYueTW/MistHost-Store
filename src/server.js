import axios from "axios";
import compression from "compression";
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
import { sendPasswordResetEmail } from "./mailer.js";
import {
  ensurePanelUser,
  getPanelServer,
  getPanelServerPowerState,
  getPanelUserByEmail,
  listMinecraftEggs,
  listPanelNodes,
  listPanelServersByUserEmail,
  panelServerUrl,
  provisionServer,
  renamePanelServer,
  resetPanelUserPassword,
  updatePanelServerEgg,
  verifyPanelCredentials
} from "./pterodactyl.js";
import { runStartupMigrations } from "./schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const sessionMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
const authRateLimitWindowMs = 15 * 60 * 1000;
const passwordResetRateLimitWindowMs = 60 * 60 * 1000;
const rateLimitStore = new Map();
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

runStartupMigrations();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(securityHeaders);
app.use(compression());
app.use(express.static(path.join(__dirname, "..", "public"), {
  etag: true,
  immutable: true,
  lastModified: true,
  maxAge: "7d"
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: config.session.secret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  name: "misthost.sid",
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureCookieEnabled(),
    maxAge: sessionMaxAgeMs
  }
}));
app.use(csrfProtection);

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
    res.locals.csrfToken = getCsrfToken(req);
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
    const minecraftEggs = isMinecraftProduct(product) ? await getMinecraftEggOptions() : [];
    res.render("product-detail", { product, error: null, minecraftEggs });
  } catch (error) {
    next(error);
  }
});

app.post("/cart/add/:productId", async (req, res, next) => {
  try {
    const product = await findProduct(req.params.productId);
    if (!product) return res.status(404).render("error", { message: "找不到方案。" });
    const selection = await resolveProductSelection(req, product);
    if (selection.error) {
      return res.status(400).render("product-detail", {
        product,
        error: selection.error,
        minecraftEggs: selection.minecraftEggs || []
      });
    }
    const quantity = Math.max(1, Math.min(10, Number.parseInt(req.body.quantity || "1", 10) || 1));
    const cart = getSessionCart(req);
    const productId = Number(product.id);
    const existing = cart.items.find((item) => Number(item.productId) === productId);
    if (existing) {
      existing.quantity = Math.min(10, existing.quantity + quantity);
      existing.options = selection.options;
    } else {
      cart.items.push({ productId, quantity, options: selection.options });
    }
    req.session.cart = cart;
    const categoryUrl = `/products/${encodeURIComponent(product.category)}`;
    res.redirect(req.body.intent === "checkout" ? "/cart" : categoryUrl);
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
        INSERT INTO order_items (
          order_id,
          product_id,
          product_name,
          unit_price,
          quantity,
          server_type_egg_id,
          server_type_nest_id,
          server_type_name
        )
        VALUES (
          :orderId,
          :productId,
          :productName,
          :unitPrice,
          :quantity,
          :serverTypeEggId,
          :serverTypeNestId,
          :serverTypeName
        )
      `, {
        orderId: orderResult.insertId,
        productId: item.product.id,
        productName: item.product.name,
        unitPrice: item.product.price,
        quantity: item.quantity,
        serverTypeEggId: item.options?.minecraftEggId || null,
        serverTypeNestId: item.options?.minecraftNestId || null,
        serverTypeName: item.options?.minecraftEggName || null
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
      PaymentInfoURL: `${baseUrl}/payments/ecpay/info`,
      OrderResultURL: `${baseUrl}/payments/ecpay/result`,
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
    const limitKey = rateLimitKey("register", req);
    if (isRateLimited(limitKey, 8, authRateLimitWindowMs)) {
      return res.status(429).render("auth", { mode: "register", error: "嘗試次數過多，請稍後再試。" });
    }
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!name || name.length > 80 || !isValidEmail(email) || !isValidCustomPassword(password)) {
      recordRateLimitAttempt(limitKey);
      return res.status(400).render("auth", { mode: "register", error: "請輸入有效姓名與 Email，密碼需大於 8 字元且包含英文與數字。" });
    }

    const existing = await findCustomerByEmail(email);
    if (existing?.password_hash) {
      recordRateLimitAttempt(limitKey);
      return res.status(409).render("auth", { mode: "register", error: "這個 Email 已經註冊，請直接登入。" });
    }

    const panelResult = await syncPterodactylUser({ email, name, password });
    const accountPassword = password;
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
      panelPassword: null
    });

    const user = await findCustomerByEmail(email);
    const redirectTo = resolveReturnTo(req) || consumeNextUrl(req);
    await establishSession(req, user.id);
    res.redirect(redirectTo);
  } catch (error) {
    next(error);
  }
});

app.get("/login", (req, res) => {
  res.render("auth", { mode: "login", error: null });
});

app.get("/forgot-password", (req, res) => {
  res.render("forgot-password", { error: null, notice: null });
});

app.post("/forgot-password", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const limitKey = rateLimitKey("forgot-password", req, email || "unknown");
    if (isRateLimited(limitKey, 5, passwordResetRateLimitWindowMs)) {
      return res.status(429).render("forgot-password", {
        error: "重設密碼申請過於頻繁，請稍後再試。",
        notice: null
      });
    }
    recordRateLimitAttempt(limitKey, passwordResetRateLimitWindowMs);
    const user = email ? await findCustomerByEmail(email) : null;
    if (!user) {
      return res.render("forgot-password", {
        error: null,
        notice: "如果 Email 存在，系統會寄出重設密碼連結。"
      });
    }

    const token = await createPasswordResetToken(user.id);
    const baseUrl = config.site.baseUrl.replace(/\/$/, "");
    const resetUrl = `${baseUrl}/reset-password/${token}`;
    await sendPasswordResetEmail({ to: user.email, resetUrl });
    return res.render("forgot-password", {
      error: null,
      notice: "如果 Email 存在，系統會寄出重設密碼連結。"
    });
  } catch (error) {
    console.error("Password reset email failed:", error);
    return res.status(500).render("forgot-password", {
      error: "重設密碼信件寄送失敗，請確認 SMTP 設定。",
      notice: null
    });
  }
});

app.get("/reset-password/:token", async (req, res, next) => {
  try {
    const reset = await findValidPasswordReset(req.params.token);
    if (!reset) return res.status(400).render("reset-password", { token: null, error: "重設連結無效或已過期。", notice: null });
    return res.render("reset-password", { token: req.params.token, error: null, notice: null });
  } catch (error) {
    next(error);
  }
});

app.post("/reset-password/:token", async (req, res, next) => {
  try {
    const token = req.params.token;
    const limitKey = rateLimitKey("reset-password", req, String(token || "").slice(0, 16));
    if (isRateLimited(limitKey, 8, passwordResetRateLimitWindowMs)) {
      return res.status(429).render("reset-password", { token: null, error: "嘗試次數過多，請重新申請重設連結。", notice: null });
    }
    const reset = await findValidPasswordReset(token);
    if (!reset) {
      recordRateLimitAttempt(limitKey, passwordResetRateLimitWindowMs);
      return res.status(400).render("reset-password", { token: null, error: "重設連結無效或已過期。", notice: null });
    }

    const password = String(req.body.password || "");
    const confirmPassword = String(req.body.confirmPassword || "");
    if (!isValidCustomPassword(password)) {
      recordRateLimitAttempt(limitKey, passwordResetRateLimitWindowMs);
      return res.status(400).render("reset-password", { token, error: "密碼需大於 8 字元，且至少包含 1 個英文與 1 個數字。", notice: null });
    }
    if (password !== confirmPassword) {
      recordRateLimitAttempt(limitKey, passwordResetRateLimitWindowMs);
      return res.status(400).render("reset-password", { token, error: "兩次輸入的密碼不一致。", notice: null });
    }

    await resetCustomerPassword(reset, password);
    await query("UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = :id", { id: reset.reset_token_id });
    return res.render("reset-password", { token: null, error: null, notice: "密碼已更新，請使用新密碼登入。" });
  } catch (error) {
    next(error);
  }
});

app.post("/login", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const limitKey = rateLimitKey("login", req, email || "unknown");
    if (isRateLimited(limitKey, 10, authRateLimitWindowMs)) {
      return res.status(429).render("auth", { mode: "login", error: "登入嘗試次數過多，請稍後再試。" });
    }
    if (!isValidEmail(email) || !password) {
      recordRateLimitAttempt(limitKey);
      return res.status(401).render("auth", { mode: "login", error: "Email 或密碼錯誤。" });
    }
    let user = await findCustomerByEmail(email);
    const localPasswordValid = user ? await verifyPassword(password, user.password_hash) : false;
    if (!localPasswordValid) {
      const panelPasswordValid = await verifyPanelPasswordLogin(email, password);
      if (!panelPasswordValid) {
        recordRateLimitAttempt(limitKey);
        return res.status(401).render("auth", { mode: "login", error: "Email 或密碼錯誤。" });
      }
      user = await upsertCustomerFromPanelLogin(email, password, user);
    }
    if (!user) {
      recordRateLimitAttempt(limitKey);
      return res.status(401).render("auth", { mode: "login", error: "Email 或密碼錯誤。" });
    }

    clearRateLimit(limitKey);
    const redirectTo = resolveReturnTo(req) || consumeNextUrl(req);
    await establishSession(req, user.id);
    res.redirect(redirectTo);
  } catch (error) {
    next(error);
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("misthost.sid");
    res.redirect("/");
  });
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
    const panelSyncPassword = generatedAccountPassword || generateRandomPassword(16);
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
      accountPassword: null
    });

    const user = await findCustomerByEmail(profile.email);
    const redirectTo = consumeNextUrl(req);
    await establishSession(req, user.id);
    res.redirect(redirectTo);
  } catch (error) {
    next(error);
  }
});

app.get("/account", requireAuth, async (req, res, next) => {
  try {
    const requestedTab = String(req.query.tab || "orders");
    const activeTab = ["orders", "servers", "profile"].includes(requestedTab) ? requestedTab : "orders";
    await refreshCustomerProvisioning(req.session.userId);
    const [orders, servers, minecraftEggs] = await Promise.all([
      getAccountOrders(req.session.userId),
      getCustomerServers(res.locals.user),
      activeTab === "servers" ? getMinecraftEggOptions() : Promise.resolve([])
    ]);
    res.render("account", {
      activeTab,
      orders,
      servers,
      minecraftEggs,
      passwordLabel: passwordDisplayLabel(res.locals.user),
      passwordError: null,
      passwordNotice: null,
      serverError: null,
      serverNotice: null,
      resetPassword: null,
      statusLabels
    });
  } catch (error) {
    next(error);
  }
});

app.get("/account/servers/:id", requireAuth, async (req, res, next) => {
  try {
    const server = await getOwnedCustomerServer(res.locals.user, req.params.id);
    if (!server) return res.status(404).render("error", { message: "找不到伺服器。" });
    const minecraftEggs = await getMinecraftEggOptions();
    res.render("server-detail", {
      server,
      minecraftEggs,
      error: null,
      notice: null,
      statusLabels
    });
  } catch (error) {
    next(error);
  }
});

app.post("/account/servers/:id", requireAuth, async (req, res, next) => {
  try {
    const server = await getOwnedCustomerServer(res.locals.user, req.params.id);
    if (!server) return res.status(404).render("error", { message: "找不到伺服器。" });

    const name = String(req.body.name || "").trim();
    if (name && name !== server.name) {
      await renamePanelServer({ serverId: server.pterodactyl_server_id, name });
      await query("UPDATE customer_servers SET name = :name WHERE pterodactyl_server_id = :serverId", {
        serverId: server.pterodactyl_server_id,
        name
      });
    }

    const minecraftEggs = await getMinecraftEggOptions();
    const eggId = Number(req.body.minecraftEggId || 0);
    const selected = minecraftEggs.find((egg) => Number(egg.id) === eggId);
    if (selected && Number(selected.id) !== Number(server.egg_id)) {
      await updatePanelServerEgg({ serverId: server.pterodactyl_server_id, nestId: selected.nest, eggId: selected.id });
      await query(`
        UPDATE customer_servers
        SET egg_id = :eggId,
            nest_id = :nestId,
            egg_name = :eggName,
            status = 'manual',
            installed = 0
        WHERE pterodactyl_server_id = :serverId
      `, { serverId: server.pterodactyl_server_id, eggId: selected.id, nestId: selected.nest, eggName: selected.name });
      await updateOrderProvisioningStatus(server.order_id);
    }

    res.redirect(`/account/servers/${encodeURIComponent(req.params.id)}`);
  } catch (error) {
    next(error);
  }
});

app.post("/account/servers/:id/name", requireAuth, async (req, res, next) => {
  try {
    const server = await getOwnedCustomerServer(res.locals.user, req.params.id);
    if (!server) return res.status(404).render("error", { message: "找不到伺服器。" });
    const name = String(req.body.name || "").trim();
    if (!name) return res.redirect(`/account/servers/${encodeURIComponent(req.params.id)}`);
    await renamePanelServer({ serverId: server.pterodactyl_server_id, name });
    await query("UPDATE customer_servers SET name = :name WHERE pterodactyl_server_id = :serverId", { serverId: server.pterodactyl_server_id, name });
    res.redirect(`/account/servers/${encodeURIComponent(req.params.id)}`);
  } catch (error) {
    next(error);
  }
});

app.post("/account/servers/:id/egg", requireAuth, async (req, res, next) => {
  try {
    const server = await getOwnedCustomerServer(res.locals.user, req.params.id);
    if (!server) return res.status(404).render("error", { message: "找不到伺服器。" });
    const minecraftEggs = await getMinecraftEggOptions();
    const eggId = Number(req.body.minecraftEggId || 0);
    const selected = minecraftEggs.find((egg) => Number(egg.id) === eggId);
    if (!selected) return res.redirect(`/account/servers/${encodeURIComponent(req.params.id)}`);
    await updatePanelServerEgg({ serverId: server.pterodactyl_server_id, nestId: selected.nest, eggId: selected.id });
    await query(`
      UPDATE customer_servers
      SET egg_id = :eggId,
          nest_id = :nestId,
          egg_name = :eggName,
          status = 'manual',
          installed = 0
      WHERE pterodactyl_server_id = :serverId
    `, { serverId: server.pterodactyl_server_id, eggId: selected.id, nestId: selected.nest, eggName: selected.name });
    await updateOrderProvisioningStatus(server.order_id);
    res.redirect(`/account/servers/${encodeURIComponent(req.params.id)}`);
  } catch (error) {
    next(error);
  }
});

app.post("/account/reset-panel-password", requireAuth, async (req, res, next) => {
  try {
    const limitKey = rateLimitKey("account-password", req, res.locals.user.email);
    if (isRateLimited(limitKey, 5, passwordResetRateLimitWindowMs)) {
      const orders = await getAccountOrders(req.session.userId);
      return res.status(429).render("account", {
        activeTab: "profile",
        orders,
        passwordLabel: passwordDisplayLabel(res.locals.user),
        passwordError: "重設密碼過於頻繁，請稍後再試。",
        passwordNotice: null,
        resetPassword: null,
        statusLabels
      });
    }
    recordRateLimitAttempt(limitKey, passwordResetRateLimitWindowMs);
    const password = generateRandomPassword(16);
    const result = await resetPanelUserPassword({ email: res.locals.user.email, password });
    const passwordHash = await hashPassword(password);
    await query(`
      UPDATE customers
      SET panel_password_last = NULL,
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
    res.locals.user.panel_password_last = null;
    res.render("account", {
      activeTab: "profile",
      orders,
      passwordLabel: passwordDisplayLabel(res.locals.user),
      passwordError: null,
      passwordNotice: null,
      resetPassword: password,
      statusLabels
    });
  } catch (error) {
    next(error);
  }
});

app.post("/account/password", requireAuth, async (req, res, next) => {
  try {
    const mode = req.body.mode === "random" ? "random" : "custom";
    const password = String(mode === "random" ? req.body.randomPassword || "" : req.body.customPassword || "");
    const orders = await getAccountOrders(req.session.userId);
    const renderProfile = (locals) => res.status(locals.passwordError ? 400 : 200).render("account", {
      activeTab: "profile",
      orders,
      passwordLabel: passwordDisplayLabel(res.locals.user),
      passwordError: null,
      passwordNotice: null,
      resetPassword: null,
      statusLabels,
      ...locals
    });

    if (!isValidCustomPassword(password)) {
      return renderProfile({ passwordError: "密碼需大於 8 字元，且至少包含 1 個英文與 1 個數字。" });
    }

    const limitKey = rateLimitKey("account-password", req, res.locals.user.email);
    if (isRateLimited(limitKey, 5, passwordResetRateLimitWindowMs)) {
      return renderProfile({ passwordError: "重設密碼過於頻繁，請稍後再試。" });
    }
    recordRateLimitAttempt(limitKey, passwordResetRateLimitWindowMs);
    const result = await resetPanelUserPassword({ email: res.locals.user.email, password });
    const passwordHash = await hashPassword(password);
    await query(`
      UPDATE customers
      SET panel_password_last = NULL,
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
    res.locals.user.panel_password_last = null;
    return renderProfile({
      passwordLabel: passwordDisplayLabel(res.locals.user),
      resetPassword: password,
      passwordNotice: "密碼已更新，可用於本店登入與 Panel 登入。"
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
    const code = String(req.body.code || "").trim().toUpperCase();
    if (!code) return finishAdminMutation(req, res, "coupons");
    const value = parseNonNegativeNumber(req.body.value);
    await query(`
      INSERT INTO coupons (code, type, value, active)
      VALUES (:code, :type, :value, 1)
      ON CONFLICT(code) DO UPDATE SET type = excluded.type, value = excluded.value, active = 1
    `, {
      code,
      type: req.body.type === "fixed" ? "fixed" : "percent",
      value
    });
    await finishAdminMutation(req, res, "coupons");
  } catch (error) {
    next(error);
  }
});

app.post("/admin/coupons/:id/delete", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await query("DELETE FROM coupons WHERE id = :id", { id: req.params.id });
    await finishAdminMutation(req, res, "coupons");
  } catch (error) {
    next(error);
  }
});

app.post("/admin/fees", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    config.ecpay.fees = config.ecpay.fees || {};
    config.ecpay.fees.cvs = Math.max(0, Number.parseInt(req.body.cvsFee || "0", 10) || 0);
    fs.writeFileSync(paths.configPath, `${JSON.stringify(config, null, 2)}\n`);
    await finishAdminMutation(req, res, "fees");
  } catch (error) {
    next(error);
  }
});

app.post("/admin/nodes", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    for (let index = 0; index < productCategories.length; index += 1) {
      const category = String(req.body[`category_${index}`] || productCategories[index]);
      if (!productCategories.includes(category)) continue;
      const nodeId = Math.max(0, Number.parseInt(req.body[`node_${index}`] || "0", 10) || 0);
      const nodeName = String(req.body[`node_name_${index}`] || "").trim();
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
    await finishAdminMutation(req, res, "nodes");
  } catch (error) {
    next(error);
  }
});

app.post("/admin/orders/:id/status", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const allowed = orderStatuses.map((status) => status.value);
    const status = allowed.includes(req.body.status) ? req.body.status : "pending";
    await query("UPDATE orders SET status = :status WHERE id = :id", { id: req.params.id, status });
    await finishAdminMutation(req, res, "orders");
  } catch (error) {
    next(error);
  }
});

app.post("/admin/products", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    const slug = String(req.body.slug || name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) return res.status(400).render("admin", await adminData("products"));
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
    await finishAdminMutation(req, res, "products");
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
          specs = :specs
      WHERE id = :id
    `, {
      id: req.params.id,
      price: Math.max(0, Number.parseInt(req.body.price || "0", 10) || 0),
      specs: JSON.stringify(specs)
    });
    await finishAdminMutation(req, res, "products");
  } catch (error) {
    next(error);
  }
});

app.post("/admin/products/:id/delete", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await query("UPDATE products SET active = 0 WHERE id = :id", { id: req.params.id });
    await finishAdminMutation(req, res, "products");
  } catch (error) {
    next(error);
  }
});

app.post("/admin/products/:id/active", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const active = req.body.active === "1" ? 1 : 0;
    await query("UPDATE products SET active = :active WHERE id = :id", { id: req.params.id, active });
    await finishAdminMutation(req, res, "products");
  } catch (error) {
    next(error);
  }
});

app.post("/payments/ecpay/return", async (req, res, next) => {
  try {
    const result = await handleEcpayNotification(req.body);
    recordEcpayCallback("return", req.body, result);
    return res.type("text/plain").send("1|OK");
  } catch (error) {
    console.error("ECPay ReturnURL failed:", error);
    recordEcpayCallback("return", req.body, { ok: false, error: error.message });
    return res.type("text/plain").send("1|OK");
  }
});

app.post("/payments/ecpay/result", async (req, res, next) => {
  try {
    const result = await handleEcpayNotification(req.body);
    recordEcpayCallback("result", req.body, result);
    const orderId = Number(result?.orderId || req.body.CustomField1 || 0);
    if (orderId) return res.redirect(`/orders/${orderId}`);
    return res.redirect("/account");
  } catch (error) {
    next(error);
  }
});

app.post("/payments/ecpay/info", (req, res) => {
  recordEcpayCallback("payment-info", req.body, { ok: true, acknowledged: true });
  return res.type("text/plain").send("1|OK");
});

app.get("/orders/:id", requireAuth, async (req, res, next) => {
  try {
    await refreshOrderProvisioning(req.params.id);
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

function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data: https://cdn.simpleicons.org",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "form-action 'self' https://payment.ecpay.com.tw https://payment-stage.ecpay.com.tw"
  ].join("; "));
  next();
}

function csrfProtection(req, res, next) {
  getCsrfToken(req);
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.path.startsWith("/payments/ecpay/")) {
    return next();
  }

  const expected = req.session.csrfToken;
  const received = String(req.body?._csrf || req.get("X-CSRF-Token") || "");
  if (safeTokenEqual(expected, received)) return next();
  return res.status(403).type("text/plain").send("Invalid CSRF token.");
}

function getCsrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  return req.session.csrfToken;
}

function safeTokenEqual(expected, received) {
  if (!expected || !received) return false;
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(received));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isSecureCookieEnabled() {
  return Boolean(config.session?.secure) || String(config.site?.baseUrl || "").startsWith("https://");
}

async function establishSession(req, userId) {
  const cart = req.session.cart;
  const nextUrl = req.session.nextUrl;
  await new Promise((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
  req.session.userId = userId;
  if (cart) req.session.cart = cart;
  if (nextUrl) req.session.nextUrl = nextUrl;
  req.session.csrfToken = crypto.randomBytes(32).toString("hex");
}

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function rateLimitKey(scope, req, subject = "") {
  return `${scope}:${clientIp(req)}:${String(subject).slice(0, 256)}`;
}

function isRateLimited(key, maxAttempts, windowMs) {
  pruneRateLimits();
  const entry = rateLimitStore.get(key);
  return Boolean(entry && entry.resetAt > Date.now() && entry.count >= maxAttempts);
}

function recordRateLimitAttempt(key, windowMs = authRateLimitWindowMs) {
  const now = Date.now();
  const entry = rateLimitStore.get(key);
  if (!entry || entry.resetAt <= now) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  entry.count += 1;
}

function clearRateLimit(key) {
  rateLimitStore.delete(key);
}

function pruneRateLimits() {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetAt <= now) rateLimitStore.delete(key);
  }
}

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
    items.push({ product, quantity, options: item.options || {}, lineTotal: product.price * quantity });
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

async function finishAdminMutation(req, res, tab) {
  if (req.get("X-Requested-With") === "fetch") {
    return res.render("admin", await adminData(tab));
  }
  return res.redirect(`/admin?tab=${tab}`);
}

async function handleEcpayNotification(payload) {
  if (!verifyCheckMacValue(payload)) {
    console.warn("ECPay callback ignored: invalid CheckMacValue", {
      merchantTradeNo: payload.MerchantTradeNo,
      rtnCode: payload.RtnCode
    });
    return { ok: false, reason: "invalid-checkmac" };
  }

  const orderNo = payload.MerchantTradeNo;
  const orderRows = await query(`
    SELECT o.*, c.email, c.name AS customer_name
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    WHERE o.order_no = :orderNo
    LIMIT 1
  `, { orderNo });
  const order = orderRows[0];
  if (!order) return { ok: false, reason: "order-not-found" };

  const rtnCode = String(payload.RtnCode || "");
  if (rtnCode !== "1") {
    if (!["paid", "provisioned", "manual"].includes(order.status)) {
      await query("UPDATE orders SET status = 'failed', provision_message = :message WHERE id = :id", {
        id: order.id,
        message: payload.RtnMsg || "ECPay payment failed."
      });
    }
    return { ok: true, orderId: order.id, status: "failed" };
  }

  if (["provisioned", "manual"].includes(order.status)) {
    return { ok: true, orderId: order.id, status: order.status };
  }

  await query(`
    UPDATE orders
    SET status = 'paid',
        ecpay_trade_no = :tradeNo,
        ecpay_payment_type = :paymentType,
        paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP),
        provision_message = NULL
    WHERE id = :id
  `, {
    id: order.id,
    tradeNo: payload.TradeNo || order.ecpay_trade_no || null,
    paymentType: payload.PaymentType || order.ecpay_payment_type || null
  });

  const provision = await provisionPaidOrder(order.id);
  return { ok: true, orderId: order.id, status: provision.status, provision };
}

async function provisionPaidOrder(orderId) {
  const orderRows = await query(`
    SELECT o.*, c.email, c.name AS customer_name, c.panel_password_last
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    WHERE o.id = :orderId
    LIMIT 1
  `, { orderId });
  const order = orderRows[0];
  if (!order) return { status: "manual", message: "Order not found." };

  const items = await query(`
    SELECT oi.*,
           p.name,
           p.slug,
           p.category,
           p.description,
           p.price,
           p.period,
           p.specs,
           p.provision_config
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = :orderId
    ORDER BY oi.id ASC
  `, { orderId });

  const customer = {
    email: order.email,
    name: order.customer_name,
    panel_password_last: order.panel_password_last
  };
  const itemSummaries = [];
  const allServerIds = [];

  for (const item of items) {
    if (item.provision_status === "provisioned") {
      const existingIds = parseServerIds(item.pterodactyl_server_ids, item.pterodactyl_server_id);
      allServerIds.push(...existingIds);
      itemSummaries.push({ status: "provisioned", message: item.provision_message || null, serverIds: existingIds });
      continue;
    }

    const nodeSetting = await findCategoryNodeSetting(item.category);
    const quantity = Math.max(1, Number(item.quantity) || 1);
    const results = [];

    for (let index = 0; index < quantity; index += 1) {
      try {
        results.push(await provisionServer({
          customer,
          product: item,
          order,
          orderItem: { ...item, id: `${item.id}-${index + 1}` },
          nodeId: nodeSetting?.node_id
        }));
      } catch (error) {
        results.push({
          status: "manual",
          message: error.response?.data?.errors?.[0]?.detail || error.message
        });
      }
    }

    const serverIds = results.map((result) => result.pterodactylServerId).filter(Boolean);
    const itemStatus = results.every((result) => result.status === "provisioned") ? "provisioned" : "manual";
    const messages = results.map((result) => result.message).filter(Boolean);
    const message = messages.length > 0 ? messages.join(" / ") : null;
    allServerIds.push(...serverIds);
    itemSummaries.push({ status: itemStatus, message, serverIds });

    for (const result of results.filter((entry) => entry.pterodactylServerId)) {
      await query(`
        INSERT INTO customer_servers (
          customer_id,
          order_id,
          order_item_id,
          pterodactyl_server_id,
          pterodactyl_identifier,
          name,
          egg_id,
          nest_id,
          egg_name,
          status,
          installed
        )
        VALUES (
          :customerId,
          :orderId,
          :orderItemId,
          :serverId,
          :identifier,
          :name,
          :eggId,
          :nestId,
          :eggName,
          :status,
          :installed
        )
        ON CONFLICT(pterodactyl_server_id) DO UPDATE SET
          pterodactyl_identifier = excluded.pterodactyl_identifier,
          name = excluded.name,
          egg_id = excluded.egg_id,
          nest_id = excluded.nest_id,
          egg_name = excluded.egg_name,
          status = excluded.status,
          installed = excluded.installed
      `, {
        customerId: order.customer_id,
        orderId: order.id,
        orderItemId: item.id,
        serverId: result.pterodactylServerId,
        identifier: result.identifier || null,
        name: result.name || `${item.name} #${order.id}`,
        eggId: item.server_type_egg_id || null,
        nestId: item.server_type_nest_id || null,
        eggName: item.server_type_name || null,
        status: result.status,
        installed: result.status === "provisioned" ? 1 : 0
      });
    }

    await query(`
      UPDATE order_items
      SET provision_status = :status,
          provision_message = :message,
          pterodactyl_server_id = :serverId,
          pterodactyl_server_ids = :serverIds
      WHERE id = :id
    `, {
      id: item.id,
      status: itemStatus,
      message,
      serverId: serverIds[0] || null,
      serverIds: serverIds.length > 0 ? JSON.stringify(serverIds) : null
    });
  }

  const finalStatus = itemSummaries.length > 0 && itemSummaries.every((item) => item.status === "provisioned") ? "provisioned" : "manual";
  const finalMessage = itemSummaries.map((item) => item.message).filter(Boolean).join(" / ") || null;
  await query(`
    UPDATE orders
    SET status = :status,
        provision_message = :message,
        pterodactyl_server_id = :serverId
    WHERE id = :id
  `, {
    id: order.id,
    status: finalStatus,
    message: finalMessage,
    serverId: allServerIds[0] || null
  });

  return { status: finalStatus, message: finalMessage, serverIds: allServerIds };
}

function recordEcpayCallback(source, payload, result) {
  try {
    const safePayload = { ...payload };
    delete safePayload.CheckMacValue;
    const logDir = path.join(paths.rootDir, "data");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, "ecpay-callbacks.log"),
      `${JSON.stringify({ at: new Date().toISOString(), source, payload: safePayload, result })}\n`
    );
  } catch (error) {
    console.error("Failed to write ECPay callback log:", error);
  }
}

async function getPanelNodesForAdmin() {
  try {
    return await listPanelNodes();
  } catch {
    return [];
  }
}

async function refreshCustomerProvisioning(customerId) {
  await backfillCustomerServers(customerId);
  const servers = await query(`
    SELECT *
    FROM customer_servers
    WHERE customer_id = :customerId
      AND status != 'provisioned'
  `, { customerId });

  for (const server of servers) {
    await refreshStoredServer(server);
  }

  const orderIds = [...new Set(servers.map((server) => server.order_id).filter(Boolean))];
  for (const orderId of orderIds) await updateOrderProvisioningStatus(orderId);
}

async function refreshOrderProvisioning(orderId) {
  const rows = await query("SELECT customer_id FROM orders WHERE id = :orderId LIMIT 1", { orderId });
  if (rows[0]) await refreshCustomerProvisioning(rows[0].customer_id);
}

async function refreshStoredServer(server) {
  try {
    const panelServer = await getPanelServer(server.pterodactyl_server_id);
    if (!panelServer) return;
    const status = panelServer.installed ? "provisioned" : "manual";
    await query(`
      UPDATE customer_servers
      SET pterodactyl_identifier = :identifier,
          name = :name,
          egg_id = COALESCE(:eggId, egg_id),
          nest_id = COALESCE(:nestId, nest_id),
          status = :status,
          installed = :installed
      WHERE id = :id
    `, {
      id: server.id,
      identifier: panelServer.identifier || server.pterodactyl_identifier || null,
      name: panelServer.name || server.name,
      eggId: panelServer.egg || null,
      nestId: panelServer.nest || null,
      status,
      installed: panelServer.installed ? 1 : 0
    });
  } catch (error) {
    await query("UPDATE customer_servers SET status = 'manual' WHERE id = :id", { id: server.id });
  }
}

async function updateOrderProvisioningStatus(orderId) {
  if (!orderId) return;
  const itemRows = await query("SELECT id FROM order_items WHERE order_id = :orderId", { orderId });
  for (const item of itemRows) {
    const servers = await query("SELECT status FROM customer_servers WHERE order_item_id = :itemId", { itemId: item.id });
    if (servers.length === 0) continue;
    const itemStatus = servers.every((server) => server.status === "provisioned") ? "provisioned" : "manual";
    await query("UPDATE order_items SET provision_status = :status WHERE id = :id", { id: item.id, status: itemStatus });
  }

  const statuses = await query("SELECT provision_status FROM order_items WHERE order_id = :orderId", { orderId });
  if (statuses.length === 0) return;
  const finalStatus = statuses.every((item) => item.provision_status === "provisioned") ? "provisioned" : "manual";
  await query("UPDATE orders SET status = :status WHERE id = :orderId AND status IN ('paid', 'manual', 'provisioned')", { orderId, status: finalStatus });
}

async function backfillCustomerServers(customerId) {
  const rows = await query(`
    SELECT oi.*,
           o.customer_id,
           o.id AS order_id
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.customer_id = :customerId
  `, { customerId });

  for (const item of rows) {
    const serverIds = parseServerIds(item.pterodactyl_server_ids, item.pterodactyl_server_id);
    for (const serverId of serverIds) {
      await query(`
        INSERT INTO customer_servers (
          customer_id,
          order_id,
          order_item_id,
          pterodactyl_server_id,
          name,
          egg_id,
          nest_id,
          egg_name,
          status,
          installed
        )
        VALUES (
          :customerId,
          :orderId,
          :orderItemId,
          :serverId,
          :name,
          :eggId,
          :nestId,
          :eggName,
          :status,
          :installed
        )
        ON CONFLICT(pterodactyl_server_id) DO NOTHING
      `, {
        customerId,
        orderId: item.order_id,
        orderItemId: item.id,
        serverId,
        name: item.product_name,
        eggId: item.server_type_egg_id || null,
        nestId: item.server_type_nest_id || null,
        eggName: item.server_type_name || null,
        status: item.provision_status === "provisioned" ? "provisioned" : "manual",
        installed: item.provision_status === "provisioned" ? 1 : 0
      });
    }
  }
}

async function getCustomerServers(user) {
  return getPanelServersForAccount(user);
}

async function getPanelServersForAccount(user) {
  try {
    const panelServers = await listPanelServersByUserEmail(user.email);
    const cachedServers = await query(`
      SELECT cs.*,
             o.order_no,
             oi.product_name
      FROM customer_servers cs
      LEFT JOIN orders o ON o.id = cs.order_id
      LEFT JOIN order_items oi ON oi.id = cs.order_item_id
      WHERE cs.customer_id = :customerId
    `, { customerId: user.id });
    const cachedByPanelId = Object.fromEntries(cachedServers.map((server) => [Number(server.pterodactyl_server_id), server]));

    return panelServers.map((server) => {
      const cached = cachedByPanelId[Number(server.id)] || {};
      const status = server.installed ? "provisioned" : "manual";
      return {
        ...cached,
        id: server.id,
        customer_id: user.id,
        pterodactyl_server_id: server.id,
        pterodactyl_identifier: server.identifier,
        name: server.name,
        egg_id: server.egg ?? cached.egg_id ?? null,
        nest_id: server.nest ?? cached.nest_id ?? null,
        egg_name: cached.egg_name || server.egg || null,
        status,
        installed: server.installed ? 1 : 0,
        product_name: cached.product_name || "Pterodactyl Server",
        order_no: cached.order_no || "-",
        panelUrl: panelServerUrl(server.identifier),
        statusLabel: statusLabels[status] || status,
        runtimeState: null,
        runtimeLabel: server.installed ? "已開啟" : "開啟中",
        runtimeClass: server.installed ? "syncing" : "starting"
      };
    });
  } catch (error) {
    console.error("Failed to load account servers from Pterodactyl:", error.response?.data || error.message);
    return [];
  }
}

async function getOwnedCustomerServer(user, serverId) {
  const panelServers = await getPanelServersForAccount(user);
  const panelServer = panelServers.find((server) => Number(server.pterodactyl_server_id) === Number(serverId));
  if (panelServer) return withRuntimeState(panelServer);

  const rows = await query("SELECT * FROM customer_servers WHERE pterodactyl_server_id = :serverId AND customer_id = :customerId LIMIT 1", { serverId, customerId: user.id });
  return rows[0] ? withRuntimeState({
    ...rows[0],
    id: rows[0].pterodactyl_server_id,
    panelUrl: panelServerUrl(rows[0].pterodactyl_identifier),
    statusLabel: statusLabels[rows[0].status] || rows[0].status
  }) : null;
}

async function withRuntimeState(server) {
  const runtimeState = await getRuntimeState(server.pterodactyl_identifier);
  if (!runtimeState) return server;
  return {
    ...server,
    runtimeState,
    runtimeLabel: runtimeStateLabel(runtimeState),
    runtimeClass: runtimeStateClass(runtimeState)
  };
}

async function getRuntimeState(identifier) {
  try {
    return await getPanelServerPowerState(identifier);
  } catch {
    return null;
  }
}

function runtimeStateLabel(state) {
  const labels = {
    running: "已開啟",
    offline: "未開啟",
    starting: "開啟中",
    stopping: "開啟中"
  };
  return labels[state] || "開啟中";
}

function runtimeStateClass(state) {
  if (state === "running") return "running";
  if (state === "offline") return "offline";
  if (state === "starting") return "starting";
  if (state === "stopping") return "stopping";
  return "syncing";
}

async function getMinecraftEggOptions() {
  try {
    return await listMinecraftEggs();
  } catch (error) {
    console.error("Failed to load Minecraft eggs:", error.response?.data || error.message);
    return [];
  }
}

function isMinecraftProduct(product) {
  return String(product.category || "").toLowerCase().includes("minecraft");
}

async function resolveProductSelection(req, product) {
  if (!isMinecraftProduct(product)) return { options: {} };

  const minecraftEggs = await getMinecraftEggOptions();
  if (minecraftEggs.length === 0) {
    return {
      error: "目前無法從 Pterodactyl 讀取 Minecraft 伺服器類型，請稍後再試。",
      minecraftEggs
    };
  }

  const eggId = Number(req.body.minecraftEggId || 0);
  const selected = minecraftEggs.find((egg) => Number(egg.id) === eggId);
  if (!selected) {
    return {
      error: "請選擇要購買的 Minecraft 伺服器類型。",
      minecraftEggs
    };
  }

  return {
    options: {
      minecraftEggId: selected.id,
      minecraftNestId: selected.nest,
      minecraftEggName: selected.name
    },
    minecraftEggs
  };
}

async function findCategoryNodeSetting(category) {
  const rows = await query("SELECT * FROM category_node_settings WHERE category = :category LIMIT 1", { category });
  return rows[0] ?? null;
}

function parseServerIds(rawServerIds, fallbackServerId) {
  try {
    const parsed = JSON.parse(rawServerIds || "[]");
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
  } catch {}
  return fallbackServerId ? [fallbackServerId] : [];
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

function parseNonNegativeNumber(value) {
  const match = String(value || "").match(/\d+/);
  return match ? Math.max(0, Number.parseInt(match[0], 10) || 0) : 0;
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

async function getAccountOrders(customerId) {
  return query(`
    SELECT o.*, p.name AS product_name
    FROM orders o
    JOIN products p ON p.id = o.product_id
    WHERE o.customer_id = :customerId
    ORDER BY o.created_at DESC
  `, { customerId });
}

async function resetCustomerPassword(user, password) {
  const result = await resetPanelUserPassword({ email: user.email, password });
  const passwordHash = await hashPassword(password);
  await query(`
    UPDATE customers
    SET panel_password_last = NULL,
        password_hash = :passwordHash,
        pterodactyl_user_id = COALESCE(:panelUserId, pterodactyl_user_id),
        pterodactyl_sync_status = :status
    WHERE id = :id
  `, {
    id: user.id,
    password,
    passwordHash,
    panelUserId: result.id,
    status: result.message
  });
  return result;
}

async function createPasswordResetToken(customerId) {
  await query("UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE customer_id = :customerId AND used_at IS NULL", { customerId });
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashResetToken(token);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await query(`
    INSERT INTO password_reset_tokens (customer_id, token_hash, expires_at)
    VALUES (:customerId, :tokenHash, :expiresAt)
  `, { customerId, tokenHash, expiresAt });
  return token;
}

async function findValidPasswordReset(token) {
  const tokenHash = hashResetToken(token);
  const rows = await query(`
    SELECT prt.id AS reset_token_id,
           prt.customer_id,
           c.id,
           c.email,
           c.name,
           c.pterodactyl_user_id
    FROM password_reset_tokens prt
    JOIN customers c ON c.id = prt.customer_id
    WHERE prt.token_hash = :tokenHash
      AND prt.used_at IS NULL
      AND prt.expires_at > :now
    LIMIT 1
  `, { tokenHash, now: new Date().toISOString() });
  return rows[0] ?? null;
}

function hashResetToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function isValidCustomPassword(password) {
  return password.length > 8 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "")) && String(email || "").length <= 254;
}

function passwordDisplayLabel(user) {
  return user?.password_hash ? "已設定（不在頁面顯示）" : "尚未設定";
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
    panelPassword: null
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
