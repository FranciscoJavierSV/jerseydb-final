const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const mysql = require("mysql2/promise");
require("dotenv").config();
const cors = require("cors");
const app = express();


app.use(cors({
  origin: "https://franciscojaviersv.github.io",
  credentials: true
}));

const port = Number(process.env.PORT || 3000);
const dbConfig = {
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "jerseydb",
  multipleStatements: true,
};
const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
const authSecret = process.env.AUTH_SECRET || "jerseydb-admin-secret";

let pool;

function normalizeError(error) {
  if (error && error.code === "ER_SIGNAL_EXCEPTION") {
    return { status: 400, message: error.sqlMessage };
  }

  if (error && error.code === "ER_DUP_ENTRY") {
    return { status: 400, message: "Ya existe un registro con ese valor unico." };
  }

  return { status: 500, message: error.message || "Error interno del servidor." };
}

function createCode(prefix, numericId) {
  return `${prefix}${String(numericId).padStart(2, "0")}`;
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password)).digest("hex");
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  return Object.fromEntries(
    raw
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function createAdminToken() {
  return createSignedToken(`admin:${Date.now()}`);
}

function createCustomerToken(idCliente) {
  return createSignedToken(`customer:${idCliente}:${Date.now()}`);
}

function createSignedToken(payload) {
  const signature = crypto.createHmac("sha256", authSecret).update(payload).digest("hex");
  return Buffer.from(`${payload}.${signature}`).toString("base64url");
}

function decodeSignedToken(token) {
  if (!token) {
    return null;
  }

  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const lastDot = decoded.lastIndexOf(".");
    if (lastDot === -1) {
      return null;
    }

    const payload = decoded.slice(0, lastDot);
    const signature = decoded.slice(lastDot + 1);
    const expected = crypto.createHmac("sha256", authSecret).update(payload).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function isValidAdminToken(token) {
  const payload = decodeSignedToken(token);
  return Boolean(payload && payload.startsWith("admin:"));
}

function getCustomerIdFromToken(token) {
  const payload = decodeSignedToken(token);
  if (!payload || !payload.startsWith("customer:")) {
    return null;
  }

  const parts = payload.split(":");
  return parts[1] || null;
}

function requireAdmin(req, res, next) {
  const cookies = parseCookies(req);
  const headerToken = req.headers["x-admin-token"];
  const token = cookies.admin_token || headerToken;
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: "Sesion de administrador requerida." });
  }
  next();
}

function requireCustomer(req, res, next) {
  const cookies = parseCookies(req);
  const headerToken = req.headers["x-customer-token"];
  const token = cookies.customer_token || headerToken;

  const idCliente = getCustomerIdFromToken(token);
  if (!idCliente) {
    return res.status(401).json({ error: "Sesion de cliente requerida." });
  }

  req.customerId = idCliente;
  next();
}

async function initDatabase() {
  const adminConnection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    multipleStatements: true,
  });

  await adminConnection.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
  );
  await adminConnection.end();

  pool = mysql.createPool(dbConfig);

  if (String(process.env.DB_AUTO_INIT || "true").toLowerCase() === "true") {
    const schemaPath = path.join(__dirname, "db", "schema.sql");
    await executeSqlScript(schemaPath);
  }

  await ensureSchemaCompatibility();

  if (String(process.env.DB_AUTO_SEED || "false").toLowerCase() === "true") {
    const seedPath = path.join(__dirname, "db", "seed.sql");
    await executeSqlScript(seedPath);
  }
}

async function ensureSchemaCompatibility() {
  const [passwordColumn] = await pool.query(`
    SELECT COUNT(*) AS total
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'Cliente' AND COLUMN_NAME = 'password_hash'
  `, [dbConfig.database]);

  if (!passwordColumn[0].total) {
    await pool.query("ALTER TABLE Cliente ADD COLUMN password_hash VARCHAR(255) NOT NULL DEFAULT ''");
  }

  await pool.query(
    "UPDATE Cliente SET password_hash = ? WHERE password_hash IS NULL OR password_hash = ''",
    [hashPassword("123456")]
  );
}

async function executeSqlScript(filePath) {
  const rawSql = await fs.readFile(filePath, "utf8");
  const statements = splitSqlStatements(rawSql);

  for (const statement of statements) {
    await pool.query(statement);
  }
}

function splitSqlStatements(sql) {
  const lines = sql.split(/\r?\n/);
  const statements = [];
  let delimiter = ";";
  let buffer = "";

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      buffer += "\n";
      continue;
    }

    if (trimmed.startsWith("DELIMITER ")) {
      delimiter = trimmed.slice("DELIMITER ".length);
      continue;
    }

    buffer += `${line}\n`;

    if (buffer.trimEnd().endsWith(delimiter)) {
      const statement = buffer.trimEnd().slice(0, -delimiter.length).trim();
      if (statement) {
        statements.push(statement);
      }
      buffer = "";
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    statements.push(trailing);
  }

  return statements;
}

async function fetchSummary() {
  const [counts] = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM Store_Catalog) AS catalogos,
      (SELECT COUNT(*) FROM Jersey) AS jerseys,
      (SELECT COUNT(*) FROM Variacion) AS variaciones,
      (SELECT COUNT(*) FROM Inventario) AS inventario,
      (SELECT COUNT(*) FROM Cliente) AS clientes,
      (SELECT COUNT(*) FROM Carrito) AS carritos,
      (SELECT COUNT(*) FROM Detalle_Carrito) AS detalles
  `);
  return counts[0];
}

async function fetchCatalog(team = "") {
  const params = [];
  let filter = "";
  if (team) {
    filter = "WHERE j.equipo LIKE ?";
    params.push(`%${team}%`);
  }

  const [rows] = await pool.query(
    `
      SELECT
        sc.id_catalogo,
        sc.nombre AS catalogo_nombre,
        sc.temporada,
        sc.anio,
        j.id_jersey,
        j.equipo,
        j.tipo,
        j.disponible,
        v.id_variacion,
        v.color,
        v.descripcion,
        v.imagen,
        v.precio,
        i.id_inventario,
        i.talla,
        i.stock
      FROM Jersey j
      LEFT JOIN Store_Catalog sc ON sc.id_catalogo = j.id_catalogo
      LEFT JOIN Variacion v ON v.id_jersey = j.id_jersey
      LEFT JOIN Inventario i ON i.id_variacion = v.id_variacion
      ${filter}
      ORDER BY sc.anio DESC, sc.temporada, j.equipo, v.id_variacion, i.talla
    `,
    params
  );

  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.id_jersey)) {
      map.set(row.id_jersey, {
        id_jersey: row.id_jersey,
        equipo: row.equipo,
        tipo: row.tipo,
        disponible: Boolean(row.disponible),
        catalogo: {
          id_catalogo: row.id_catalogo,
          nombre: row.catalogo_nombre,
          temporada: row.temporada,
          anio: row.anio,
        },
        variaciones: [],
      });
    }

    const jersey = map.get(row.id_jersey);
    if (row.id_variacion) {
      let variation = jersey.variaciones.find((item) => item.id_variacion === row.id_variacion);
      if (!variation) {
        variation = {
          id_variacion: row.id_variacion,
          color: row.color,
          descripcion: row.descripcion,
          imagen: row.imagen,
          precio: Number(row.precio),
          inventario: [],
        };
        jersey.variaciones.push(variation);
      }

      if (row.id_inventario) {
        variation.inventario.push({
          id_inventario: row.id_inventario,
          talla: row.talla,
          stock: row.stock,
        });
      }
    }
  }

  return [...map.values()];
}

async function fetchCustomers() {
  const [rows] = await pool.query(`
    SELECT c.id_cliente, c.nombre, c.correo, c.password_hash, ca.id_carrito, ca.descuento, ca.total
    FROM Cliente c
    LEFT JOIN Carrito ca ON ca.id_cliente = c.id_cliente
    ORDER BY c.id_cliente
  `);
  return rows.map((row) => ({
    ...row,
    descuento: row.descuento === null ? null : Number(row.descuento),
    total: row.total === null ? null : Number(row.total),
  }));
}

async function fetchCarts() {
  const [rows] = await pool.query(`
    SELECT
      ca.id_carrito,
      ca.descuento,
      ca.total,
      c.id_cliente,
      c.nombre AS cliente_nombre,
      c.correo,
      dc.id_detalle,
      dc.cantidad,
      dc.fecha_agregado,
      dc.subtotal,
      j.id_jersey,
      j.equipo,
      j.tipo,
      v.color,
      v.precio,
      i.id_inventario,
      i.talla
    FROM Carrito ca
    INNER JOIN Cliente c ON c.id_cliente = ca.id_cliente
    LEFT JOIN Detalle_Carrito dc ON dc.id_carrito = ca.id_carrito
    LEFT JOIN Inventario i ON i.id_inventario = dc.id_inventario
    LEFT JOIN Variacion v ON v.id_variacion = i.id_variacion
    LEFT JOIN Jersey j ON j.id_jersey = dc.id_jersey
    ORDER BY ca.id_carrito, dc.id_detalle
  `);

  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.id_carrito)) {
      map.set(row.id_carrito, {
        id_carrito: row.id_carrito,
        descuento: Number(row.descuento),
        total: Number(row.total),
        cliente: {
          id_cliente: row.id_cliente,
          nombre: row.cliente_nombre,
          correo: row.correo,
        },
        detalles: [],
      });
    }

    if (row.id_detalle) {
      map.get(row.id_carrito).detalles.push({
        id_detalle: row.id_detalle,
        cantidad: row.cantidad,
        fecha_agregado: row.fecha_agregado,
        subtotal: Number(row.subtotal),
        jersey: {
          id_jersey: row.id_jersey,
          equipo: row.equipo,
          tipo: row.tipo,
        },
        variacion: {
          color: row.color,
          precio: row.precio === null ? null : Number(row.precio),
        },
        inventario: {
          id_inventario: row.id_inventario,
          talla: row.talla,
        },
      });
    }
  }
  return [...map.values()];
}

async function fetchReferenceQueries() {
  const [simple] = await pool.query("SELECT nombre, correo FROM Cliente ORDER BY nombre");
  const [groupBy] = await pool.query(`
    SELECT equipo, COUNT(*) AS total_jerseys
    FROM Jersey
    GROUP BY equipo
    ORDER BY total_jerseys DESC, equipo
  `);
  const [having] = await pool.query(`
    SELECT equipo, COUNT(*) AS cantidad
    FROM Jersey
    GROUP BY equipo
    HAVING COUNT(*) > 2
    ORDER BY cantidad DESC, equipo
  `);
  const [multitable] = await pool.query(`
    SELECT J.id_jersey, J.equipo, V.precio, V.descripcion
    FROM Jersey J
    INNER JOIN Variacion V ON J.id_jersey = V.id_jersey
    ORDER BY J.id_jersey, V.id_variacion
  `);

  return { simple, groupBy, having, multitable };
}

async function fetchCustomerCart(idCliente) {
  const [rows] = await pool.query(
    `
      SELECT
        ca.id_carrito,
        ca.descuento,
        ca.total,
        c.id_cliente,
        c.nombre AS cliente_nombre,
        c.correo,
        dc.id_detalle,
        dc.cantidad,
        dc.fecha_agregado,
        dc.subtotal,
        j.id_jersey,
        j.equipo,
        j.tipo,
        v.color,
        v.precio,
        i.id_inventario,
        i.talla
      FROM Cliente c
      INNER JOIN Carrito ca ON ca.id_cliente = c.id_cliente
      LEFT JOIN Detalle_Carrito dc ON dc.id_carrito = ca.id_carrito
      LEFT JOIN Inventario i ON i.id_inventario = dc.id_inventario
      LEFT JOIN Variacion v ON v.id_variacion = i.id_variacion
      LEFT JOIN Jersey j ON j.id_jersey = dc.id_jersey
      WHERE c.id_cliente = ?
      ORDER BY dc.id_detalle
    `,
    [idCliente]
  );

  if (!rows.length) {
    return null;
  }

  const first = rows[0];
  return {
    id_carrito: first.id_carrito,
    descuento: Number(first.descuento),
    total: Number(first.total),
    cliente: {
      id_cliente: first.id_cliente,
      nombre: first.cliente_nombre,
      correo: first.correo,
    },
    detalles: rows
      .filter((row) => row.id_detalle)
      .map((row) => ({
        id_detalle: row.id_detalle,
        cantidad: row.cantidad,
        fecha_agregado: row.fecha_agregado,
        subtotal: Number(row.subtotal),
        jersey: {
          id_jersey: row.id_jersey,
          equipo: row.equipo,
          tipo: row.tipo,
        },
        variacion: {
          color: row.color,
          precio: row.precio === null ? null : Number(row.precio),
        },
        inventario: {
          id_inventario: row.id_inventario,
          talla: row.talla,
        },
      })),
  };
}

async function fetchCustomerAccount(idCliente) {
  const [rows] = await pool.query(
    `
      SELECT c.id_cliente, c.nombre, c.correo, ca.id_carrito, ca.descuento, ca.total
      FROM Cliente c
      INNER JOIN Carrito ca ON ca.id_cliente = c.id_cliente
      WHERE c.id_cliente = ?
    `,
    [idCliente]
  );
  return rows[0] || null;
}

async function customerOwnsCartItem(idDetalle, idCliente) {
  const [rows] = await pool.query(
    `
      SELECT dc.id_detalle
      FROM Detalle_Carrito dc
      INNER JOIN Carrito ca ON ca.id_carrito = dc.id_carrito
      WHERE dc.id_detalle = ? AND ca.id_cliente = ?
    `,
    [idDetalle, idCliente]
  );
  return rows.length > 0;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/api/public/bootstrap", async (_req, res) => {
  try {
    const cookies = parseCookies(_req);
    const customerId = getCustomerIdFromToken(cookies.customer_token);
    const [catalog, customer] = await Promise.all([
      fetchCatalog(),
      customerId ? fetchCustomerAccount(customerId) : Promise.resolve(null),
    ]);
    res.json({
      catalog,
      customer: customer
        ? {
            id_cliente: customer.id_cliente,
            nombre: customer.nombre,
            correo: customer.correo,
            id_carrito: customer.id_carrito,
            descuento: Number(customer.descuento),
            total: Number(customer.total),
          }
        : null,
    });
  } catch (error) {
    const normalized = normalizeError(error);
    res.status(normalized.status).json({ error: normalized.message });
  }
});

app.get("/api/public/session", (req, res) => {
  const cookies = parseCookies(req);
  const customerId = getCustomerIdFromToken(cookies.customer_token);
  res.json({ authenticated: Boolean(customerId), customerId });
});

app.post("/api/public/login", async (req, res) => {
  try {
    const { correo, password } = req.body;
    const [rows] = await pool.query(
      "SELECT id_cliente, password_hash FROM Cliente WHERE correo = ?",
      [correo]
    );

    if (!rows.length || rows[0].password_hash !== hashPassword(password || "")) {
      return res.status(401).json({ error: "Credenciales incorrectas." });
    }

    const token = createCustomerToken(rows[0].id_cliente);
    res.setHeader("Set-Cookie", `customer_token=${token}; HttpOnly; Path=/; SameSite=Strict`);
    res.json({ ok: true, id_cliente: rows[0].id_cliente, token });
  } catch (error) {
    const normalized = normalizeError(error);
    res.status(normalized.status).json({ error: normalized.message });
  }
});

app.post("/api/public/logout", (_req, res) => {
  res.setHeader(
    "Set-Cookie",
    "customer_token=; HttpOnly; Path=/; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  );
  res.json({ ok: true });
});

app.get("/api/public/me/cart", requireCustomer, async (req, res) => {
  try {
    const cart = await fetchCustomerCart(req.customerId);
    if (!cart) {
      return res.status(404).json({ error: "Cliente no encontrado." });
    }
    res.json(cart);
  } catch (error) {
    const normalized = normalizeError(error);
    res.status(normalized.status).json({ error: normalized.message });
  }
});

app.post("/api/public/customers", async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    let { id_cliente, nombre, correo, password } = req.body;

    if (!id_cliente) {
      const [rows] = await connection.query("SELECT COUNT(*) AS total FROM Cliente");
      id_cliente = createCode("C", rows[0].total + 1);
    }

    await connection.query(
      "INSERT INTO Cliente (id_cliente, nombre, correo, password_hash) VALUES (?, ?, ?, ?)",
      [id_cliente, nombre, correo, hashPassword(password || "")]
    );
    await connection.query("INSERT INTO Carrito (descuento, id_cliente) VALUES (0, ?)", [id_cliente]);
    await connection.commit();
    const token = createCustomerToken(id_cliente);
    res.setHeader("Set-Cookie", `customer_token=${token}; HttpOnly; Path=/; SameSite=Strict`);
    res.status(201).json({ ok: true, id_cliente, token });
  } catch (error) {
    await connection.rollback();
    const normalized = normalizeError(error);
    res.status(normalized.status).json({ error: normalized.message });
  } finally {
    connection.release();
  }
});

app.post("/api/public/cart-items", requireCustomer, async (req, res) => {
  try {
    const { id_jersey, id_inventario, cantidad } = req.body;
    const [carts] = await pool.query("SELECT id_carrito FROM Carrito WHERE id_cliente = ?", [req.customerId]);
    if (!carts.length) {
      return res.status(404).json({ error: "Carrito no encontrado." });
    }
    await pool.query(
      "INSERT INTO Detalle_Carrito (cantidad, id_jersey, id_carrito, id_inventario) VALUES (?, ?, ?, ?)",
      [Number(cantidad), id_jersey, Number(carts[0].id_carrito), Number(id_inventario)]
    );
    res.status(201).json({ ok: true });
  } catch (error) {
    const normalized = normalizeError(error);
    res.status(normalized.status).json({ error: normalized.message });
  }
});

app.patch("/api/public/cart-items/:id", requireCustomer, async (req, res) => {
  try {
    const { cantidad } = req.body;
    if (!(await customerOwnsCartItem(Number(req.params.id), req.customerId))) {
      return res.status(403).json({ error: "No puedes modificar ese articulo." });
    }
    await pool.query("UPDATE Detalle_Carrito SET cantidad = ? WHERE id_detalle = ?", [
      Number(cantidad),
      Number(req.params.id),
    ]);
    res.json({ ok: true });
  } catch (error) {
    const normalized = normalizeError(error);
    res.status(normalized.status).json({ error: normalized.message });
  }
});

app.delete("/api/public/cart-items/:id", requireCustomer, async (req, res) => {
  try {
    if (!(await customerOwnsCartItem(Number(req.params.id), req.customerId))) {
      return res.status(403).json({ error: "No puedes eliminar ese articulo." });
    }
    await pool.query("DELETE FROM Detalle_Carrito WHERE id_detalle = ?", [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (error) {
    const normalized = normalizeError(error);
    res.status(normalized.status).json({ error: normalized.message });
  }
});

app.get("/api/admin/session", (req, res) => {
  const cookies = parseCookies(req);
  const headerToken = req.headers["x-admin-token"];
  const token = cookies.admin_token || headerToken;
  res.json({ authenticated: isValidAdminToken(token) });
});

app.post("/api/admin/login", (req, res) => {
  if ((req.body.password || "").trim() !== adminPassword.trim()) {
    return res.status(401).json({ error: "Contrasena incorrecta." });
  }

  const token = createAdminToken();
  res.setHeader("Set-Cookie", `admin_token=${token}; HttpOnly; Path=/; SameSite=Strict`);
  res.json({ ok: true, token });
});

app.post("/api/admin/logout", (_req, res) => {
  res.setHeader(
    "Set-Cookie",
    "admin_token=; HttpOnly; Path=/; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  );
  res.json({ ok: true });
});

app.get("/api/admin/bootstrap", requireAdmin, async (_req, res) => {
  try {
    const [summary, catalog, customers, carts, queries] = await Promise.all([
      fetchSummary(),
      fetchCatalog(),
      fetchCustomers(),
      fetchCarts(),
      fetchReferenceQueries(),
    ]);
    res.json({ summary, catalog, customers, carts, queries });
  } catch (error) {
    const normalized = normalizeError(error);
    res.status(normalized.status).json({ error: normalized.message });
  }
});

app.get("/api/catalog", async (req, res) => {
  try {
    const data = await fetchCatalog(req.query.team || "");
    res.json(data);
  } catch (error) {
    const normalized = normalizeError(error);
    res.status(normalized.status).json({ error: normalized.message });
  }
});

app.post("/api/catalogs", requireAdmin, async (req, res) => {
  try {
    const { nombre, temporada, anio } = req.body;
    await pool.query(
      "INSERT INTO Store_Catalog (nombre, temporada, anio) VALUES (?, ?, ?)",
      [nombre, temporada, Number(anio)]
    );
    res.status(201).json({ ok: true });
  } catch (error) {
    const normalized = normalizeError(error);
    res.status(normalized.status).json({ error: normalized.message });
  }
});

app.post("/api/jerseys", requireAdmin, async (req, res) => {
  try {
    const { id_jersey, equipo, tipo, disponible, id_catalogo } = req.body;
    await pool.query(
      "INSERT INTO Jersey (id_jersey, equipo, tipo, disponible, id_catalogo) VALUES (?, ?, ?, ?, ?)",
      [id_jersey, equipo, tipo, Boolean(disponible), Number(id_catalogo)]
    );
    res.status(201).json({ ok: true });
  } catch (error) {
    const normalized = normalizeError(error);
    res.status(normalized.status).json({ error: normalized.message });
  }
});

app.post("/api/variations", requireAdmin, async (req, res) => {
  try {
    const { color, descripcion, imagen, precio, id_jersey } = req.body;
    await pool.query(
      "INSERT INTO Variacion (color, descripcion, imagen, precio, id_jersey) VALUES (?, ?, ?, ?, ?)",
      [color, descripcion, imagen || null, Number(precio), id_jersey]
    );
    res.status(201).json({ ok: true });
  } catch (error) {
    const normalized = normalizeError(error);
    res.status(normalized.status).json({ error: normalized.message });
  }
});

app.post("/api/inventory", requireAdmin, async (req, res) => {
  try {
    const { talla, stock, id_jersey, id_variacion } = req.body;
    await pool.query(
      "INSERT INTO Inventario (talla, stock, id_jersey, id_variacion) VALUES (?, ?, ?, ?)",
      [talla, Number(stock), id_jersey, Number(id_variacion)]
    );
    res.status(201).json({ ok: true });
  } catch (error) {
    const normalized = normalizeError(error);
    res.status(normalized.status).json({ error: normalized.message });
  }
});

app.post("/api/customers", requireAdmin, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    let { id_cliente, nombre, correo, descuento, password } = req.body;

    if (!id_cliente) {
      const [rows] = await connection.query("SELECT COUNT(*) AS total FROM Cliente");
      id_cliente = createCode("C", rows[0].total + 1);
    }

    await connection.query(
      "INSERT INTO Cliente (id_cliente, nombre, correo, password_hash) VALUES (?, ?, ?, ?)",
      [id_cliente, nombre, correo, hashPassword(password || "123456")]
    );
    await connection.query(
      "INSERT INTO Carrito (descuento, id_cliente) VALUES (?, ?)",
      [Number(descuento || 0), id_cliente]
    );
    await connection.commit();
    res.status(201).json({ ok: true, id_cliente });
  } catch (error) {
    await connection.rollback();
    const normalized = normalizeError(error);
    res.status(normalized.status).json({ error: normalized.message });
  } finally {
    connection.release();
  }
});

app.patch("/api/customers/:id", requireAdmin, async (req, res) => {
  try {
    const { nombre, correo, descuento, password } = req.body;
    if (password) {
      await pool.query(
        "UPDATE Cliente SET nombre = ?, correo = ?, password_hash = ? WHERE id_cliente = ?",
        [nombre, correo, hashPassword(password), req.params.id]
      );
    } else {
      await pool.query("UPDATE Cliente SET nombre = ?, correo = ? WHERE id_cliente = ?", [
        nombre,
        correo,
        req.params.id,
      ]);
    }
    await pool.query("UPDATE Carrito SET descuento = ? WHERE id_cliente = ?", [
      Number(descuento || 0),
      req.params.id,
    ]);
    res.json({ ok: true });
  } catch (error) {
    const normalized = normalizeError(error);
    res.status(normalized.status).json({ error: normalized.message });
  }
});

app.delete("/api/customers/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM Cliente WHERE id_cliente = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    const normalized = normalizeError(error);
    res.status(normalized.status).json({ error: normalized.message });
  }
});

app.post("/api/cart-items", requireAdmin, async (req, res) => {
  try {
    const { id_jersey, id_carrito, id_inventario, cantidad } = req.body;
    await pool.query(
      "INSERT INTO Detalle_Carrito (cantidad, id_jersey, id_carrito, id_inventario) VALUES (?, ?, ?, ?)",
      [Number(cantidad), id_jersey, Number(id_carrito), Number(id_inventario)]
    );
    res.status(201).json({ ok: true });
  } catch (error) {
    const normalized = normalizeError(error);
    res.status(normalized.status).json({ error: normalized.message });
  }
});

app.patch("/api/cart-items/:id", requireAdmin, async (req, res) => {
  try {
    const { cantidad } = req.body;
    await pool.query("UPDATE Detalle_Carrito SET cantidad = ? WHERE id_detalle = ?", [
      Number(cantidad),
      Number(req.params.id),
    ]);
    res.json({ ok: true });
  } catch (error) {
    const normalized = normalizeError(error);
    res.status(normalized.status).json({ error: normalized.message });
  }
});

app.delete("/api/cart-items/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM Detalle_Carrito WHERE id_detalle = ?", [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (error) {
    const normalized = normalizeError(error);
    res.status(normalized.status).json({ error: normalized.message });
  }
});

app.use((error, _req, res, _next) => {
  const normalized = normalizeError(error);
  res.status(normalized.status).json({ error: normalized.message });
});

initDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`JerseyDB running on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error(
      "Database initialization failed:",
      error.code || error.message || error.sqlMessage || JSON.stringify(error)
    );
    process.exit(1);
  });
