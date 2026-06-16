const state = {
  data: null,
};

const API_BASE = "https://jerseydb-final-production.up.railway.app";

async function request(url, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const adminToken = localStorage.getItem("jerseydb_admin_token");
  if (adminToken) headers["x-admin-token"] = adminToken;

  const finalUrl = /^https?:\/\//i.test(url) ? url : (API_BASE ? `${API_BASE}${url}` : url);
  const response = await fetch(finalUrl, { headers, credentials: "same-origin", ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "No se pudo completar la solicitud.");
  return payload;
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2400);
}

function formToObject(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  for (const [key, value] of Object.entries(data)) {
    if (value === "") {
      data[key] = null;
    }
  }
  return data;
}

function setClientCookie(name, value) {
  document.cookie = `${name}=${value}; Path=/; SameSite=Strict`;
}

function renderStats(summary) {
  const labels = {
    catalogos: "Catalogos",
    jerseys: "Jerseys",
    variaciones: "Variaciones",
    inventario: "Registros stock",
    clientes: "Clientes",
    carritos: "Carritos",
    detalles: "Detalles",
  };

  document.getElementById("stats").innerHTML = Object.entries(labels)
    .map(
      ([key, label]) => `
        <article class="stat">
          <span>${label}</span>
          <strong>${summary[key]}</strong>
        </article>
      `
    )
    .join("");
}

function renderCatalog(catalog) {
  const grid = document.getElementById("catalog-grid");
  if (!catalog.length) {
    grid.innerHTML = '<p class="muted">No hay jerseys con ese filtro.</p>';
    return;
  }

  grid.innerHTML = catalog
    .map((jersey) => {
      const cover =
        jersey.variaciones[0]?.imagen ||
        "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=900&q=80";
      return `
        <article class="card catalog-card">
          <img src="${cover}" alt="${jersey.equipo}" />
          <header>
            <div>
              <p class="eyebrow">${jersey.id_jersey}</p>
              <h3>${jersey.equipo}</h3>
            </div>
            <span class="tag ${jersey.disponible ? "available" : "unavailable"}">${jersey.disponible ? "Disponible" : "No disponible"}</span>
          </header>
          <p>${jersey.tipo} | ${jersey.catalogo.nombre || "Sin catalogo"} | ${jersey.catalogo.temporada || "N/D"} ${jersey.catalogo.anio || ""}</p>
          <div class="variation-list">
            ${jersey.variaciones
              .map(
                (variation) => `
                  <section class="variation-block">
                    <div class="variation-head">
                      <strong>${variation.color}</strong>
                      <span class="pill">$${variation.precio.toFixed(2)}</span>
                    </div>
                    <p>${variation.descripcion}</p>
                    <div class="inventory-list">
                      ${variation.inventario
                        .map(
                          (item) => `
                            <div class="inventory-chip">
                              <span>${item.talla}</span>
                              <strong>${item.stock} piezas</strong>
                            </div>
                          `
                        )
                        .join("")}
                    </div>
                  </section>
                `
              )
              .join("")}
          </div>
        </article>
      `;
    })
    .join("");
}

function renderCustomers(customers) {
  const container = document.getElementById("customers");
  const template = document.getElementById("customer-template");
  container.innerHTML = "";

  customers.forEach((customer) => {
    const node = template.content.firstElementChild.cloneNode(true);
    node.querySelector('[name="id_cliente"]').value = customer.id_cliente;
    node.querySelector('[name="nombre"]').value = customer.nombre;
    node.querySelector('[name="correo"]').value = customer.correo;
    node.querySelector('[name="password"]').value = "";
    node.querySelector('[name="descuento"]').value = customer.descuento ?? 0;

    node.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = formToObject(node);
      await request(`/api/customers/${payload.id_cliente}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      await load();
      showToast("Cliente actualizado.");
    });

    node.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      await request(`/api/customers/${customer.id_cliente}`, { method: "DELETE" });
      await load();
      showToast("Cliente eliminado.");
    });

    container.appendChild(node);
  });
}

function renderCarts(carts) {
  const container = document.getElementById("carts");
  container.innerHTML = carts
    .map(
      (cart) => `
        <article class="card cart-card">
          <div>
            <p class="eyebrow">Carrito ${cart.id_carrito}</p>
            <h3>${cart.cliente.nombre}</h3>
            <p>${cart.cliente.correo}</p>
          </div>
          <div class="variation-head">
            <span class="pill">Descuento ${cart.descuento}%</span>
            <strong>Total $${cart.total.toFixed(2)}</strong>
          </div>
          ${
            cart.detalles.length
              ? cart.detalles
                  .map(
                    (detail) => `
                      <div class="cart-row">
                        <div>
                          <strong>${detail.jersey.equipo}</strong>
                          <p>${detail.jersey.id_jersey} | ${detail.variacion.color} | talla ${detail.inventario.talla}</p>
                          <small>Cantidad ${detail.cantidad} | subtotal $${detail.subtotal.toFixed(2)}</small>
                        </div>
                      </div>
                    `
                  )
                  .join("")
              : '<p class="muted">Carrito sin articulos.</p>'
          }
        </article>
      `
    )
    .join("");
}

function renderQueryTable(title, rows) {
  if (!rows.length) {
    return `
      <article class="card query-card">
        <h3>${title}</h3>
        <p class="muted">Sin resultados.</p>
      </article>
    `;
  }

  const columns = Object.keys(rows[0]);
  return `
    <article class="card query-card">
      <h3>${title}</h3>
      <table>
        <thead>
          <tr>${columns.map((column) => `<th>${column}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (row) => `
                <tr>${columns.map((column) => `<td>${row[column]}</td>`).join("")}</tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </article>
  `;
}

function renderQueries(queries) {
  document.getElementById("queries").innerHTML = [
    renderQueryTable("Consulta sencilla", queries.simple),
    renderQueryTable("GROUP BY", queries.groupBy),
    renderQueryTable("HAVING", queries.having),
    renderQueryTable("Multitabla", queries.multitable),
  ].join("");
}

function setSelectOptions() {
  const { catalog } = state.data;
  const catalogOptions = Array.from(
    new Map(catalog.map((item) => [item.catalogo.id_catalogo, item.catalogo])).values()
  ).filter((item) => item.id_catalogo);
  const jerseys = catalog.map((item) => ({ id: item.id_jersey, label: `${item.id_jersey} | ${item.equipo}` }));
  const variations = catalog.flatMap((item) =>
    item.variaciones.map((variation) => ({
      id: variation.id_variacion,
      label: `${item.id_jersey} | ${variation.color}`,
      jerseyId: item.id_jersey,
    }))
  );

  document.getElementById("jersey-catalog-select").innerHTML = catalogOptions
    .map((item) => `<option value="${item.id_catalogo}">${item.nombre} | ${item.temporada} ${item.anio}</option>`)
    .join("");

  const jerseyOptions = jerseys.map((item) => `<option value="${item.id}">${item.label}</option>`).join("");
  document.getElementById("variation-jersey-select").innerHTML = jerseyOptions;
  document.getElementById("inventory-jersey-select").innerHTML = jerseyOptions;

  const inventoryVariationSelect = document.getElementById("inventory-variation-select");
  function syncVariationOptions() {
    const jerseyId = document.getElementById("inventory-jersey-select").value;
    inventoryVariationSelect.innerHTML = variations
      .filter((variation) => variation.jerseyId === jerseyId)
      .map((variation) => `<option value="${variation.id}">${variation.label}</option>`)
      .join("");
  }

  document.getElementById("inventory-jersey-select").onchange = syncVariationOptions;
  syncVariationOptions();
}

async function load() {
  const data = await request("/api/admin/bootstrap");
  state.data = data;
  renderStats(data.summary);
  renderCatalog(data.catalog);
  renderCustomers(data.customers);
  renderCarts(data.carts);
  renderQueries(data.queries);
  setSelectOptions();
}

function bindForms() {
  document.getElementById("filter-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const { team } = formToObject(form);
    const catalog = await request(`/api/catalog?team=${encodeURIComponent(team || "")}`);
    renderCatalog(catalog);
  });

  const definitions = [
    ["catalog-form", "/api/catalogs"],
    ["jersey-form", "/api/jerseys"],
    ["variation-form", "/api/variations"],
    ["inventory-form", "/api/inventory"],
    ["customer-form", "/api/customers"],
  ];

  definitions.forEach(([formId, url]) => {
    document.getElementById(formId).addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const payload = formToObject(form);
      if (form.id === "jersey-form") {
        payload.disponible = form.querySelector('[name="disponible"]').checked;
      }
      await request(url, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      form.reset();
      await load();
      showToast("Operacion completada.");
    });
  });
}

async function bootAdmin() {
  const session = await request("/api/admin/session");
  if (session.authenticated) {
    await load();
  } else {
    window.location.href = "index.html";
  }
}

document.getElementById("logout-button").addEventListener("click", async () => {
  await request("/api/admin/logout", { method: "POST" });
  localStorage.removeItem("jerseydb_admin_token");
  window.location.href = "index.html";
  showToast("Sesion cerrada.");
});

bindForms();
bootAdmin().catch((error) => showToast(error.message));
