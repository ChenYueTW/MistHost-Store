import express from "express";
import session from "express-session";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, publicConfig } from "./config.js";
import { findProduct, getActiveProducts, pool, query } from "./db.js";
import { paymentForm, verifyCheckMacValue } from "./ecpay.js";
import { provisionServer } from "./pterodactyl.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: config.session.secret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax" }
}));

app.use((req, res, next) => {
  res.locals.config = publicConfig();
  res.locals.cart = req.session.cart ?? null;
  next();
});

app.get("/", async (req, res, next) => {
  try {
    const products = await getActiveProducts();
    res.render("home", { products });
  } catch (error) {
    next(error);
  }
});

app.get("/checkout/:productId", async (req, res, next) => {
  try {
    const product = await findProduct(req.params.productId);
    if (!product) return res.status(404).render("error", { message: "找不到方案。" });
    res.render("checkout", { product });
  } catch (error) {
    next(error);
  }
});

app.post("/checkout/:productId", async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const product = await findProduct(req.params.productId);
    if (!product) return res.status(404).render("error", { message: "找不到方案。" });

    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!name || !email) {
      return res.status(400).render("checkout", { product, error: "請輸入姓名與 Email。" });
    }

    await connection.beginTransaction();
    await connection.execute(
      "INSERT INTO customers (email, name) VALUES (:email, :name) ON CONFLICT(email) DO UPDATE SET name = excluded.name",
      { email, name }
    );
    const [customerRows] = await connection.execute("SELECT * FROM customers WHERE email = :email", { email });
    const customer = customerRows[0];
    const orderNo = `MH${Date.now().toString().slice(-12)}${Math.floor(Math.random() * 90 + 10)}`;
    const [orderResult] = await connection.execute(
      "INSERT INTO orders (order_no, customer_id, product_id, amount) VALUES (:orderNo, :customerId, :productId, :amount)",
      { orderNo, customerId: customer.id, productId: product.id, amount: product.price }
    );
    await connection.commit();

    const baseUrl = config.site.baseUrl.replace(/\/$/, "");
    const params = {
      MerchantID: config.ecpay.merchantId,
      MerchantTradeNo: orderNo,
      MerchantTradeDate: formatEcpayDate(new Date()),
      PaymentType: "aio",
      TotalAmount: String(product.price),
      TradeDesc: `${config.site.name} hosting order`,
      ItemName: product.name,
      ReturnURL: `${baseUrl}/payments/ecpay/return`,
      OrderResultURL: `${baseUrl}/orders/${orderResult.insertId}`,
      ChoosePayment: "ALL",
      EncryptType: "1",
      CustomField1: String(orderResult.insertId)
    };
    res.render("ecpay-form", paymentForm(params));
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
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
      SELECT o.*, c.email, c.name AS customer_name, p.name AS product_name, p.provision_config
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      JOIN products p ON p.id = o.product_id
      WHERE o.order_no = :orderNo
      LIMIT 1
    `, { orderNo });
    const order = orderRows[0];
    if (!order) return res.send("1|OK");
    if (["paid", "provisioned", "manual"].includes(order.status)) return res.send("1|OK");

    await query(`
      UPDATE orders
      SET status = 'paid', ecpay_trade_no = :tradeNo, ecpay_payment_type = :paymentType, paid_at = CURRENT_TIMESTAMP
      WHERE id = :id
    `, {
      id: order.id,
      tradeNo: req.body.TradeNo || null,
      paymentType: req.body.PaymentType || null
    });

    const provisionResult = await provisionServer({
      customer: { id: order.customer_id, email: order.email, name: order.customer_name },
      product: { id: order.product_id, name: order.product_name, provision_config: order.provision_config },
      order
    });
    await query(`
      UPDATE orders
      SET status = :status, provision_message = :message, pterodactyl_server_id = :serverId
      WHERE id = :id
    `, {
      id: order.id,
      status: provisionResult.status === "provisioned" ? "provisioned" : "manual",
      message: provisionResult.message || "Provisioning completed.",
      serverId: provisionResult.pterodactylServerId || null
    });

    res.send("1|OK");
  } catch (error) {
    next(error);
  }
});

app.get("/orders/:id", async (req, res, next) => {
  try {
    const rows = await query(`
      SELECT o.*, p.name AS product_name, c.email, c.name AS customer_name
      FROM orders o
      JOIN products p ON p.id = o.product_id
      JOIN customers c ON c.id = o.customer_id
      WHERE o.id = :id
    `, { id: req.params.id });
    if (!rows[0]) return res.status(404).render("error", { message: "找不到訂單。" });
    res.render("order", { order: rows[0] });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).render("error", { message: "系統發生錯誤，請稍後再試。" });
});

function formatEcpayDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

app.listen(config.port, () => {
  console.log(`${config.site.name} listening on http://localhost:${config.port}`);
});
