const state = {
  catalog: [],
  customer: null,
};

const adminModal = document.getElementById("admin-modal");
const customerModal = document.getElementById("customer-modal");

async function request(url, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const adminToken = localStorage.getItem("jerseydb_admin_token");
  if (adminToken) headers["x-admin-token"] = adminToken;

  // Use FRONTEND_API_URL from docs/.env (exposed as window.FRONTEND_API_URL)
  // If not present, fall back to relative URLs.
  const API_BASE = (window.FRONTEND_API_URL || "").replace(/\/$/, "");
  const finalUrl = /^https?:\/\//i.test(url) ? url : (API_BASE ? `${API_BASE}${url}` : url);

  const response = await fetch(finalUrl, {
    headers,
    credentials: "same-origin",
    ...options,
  });
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
          <div class="catalog-media">
            <img src="${cover}" alt="${jersey.equipo}" />
          </div>
          <div class="catalog-body">
            <div class="catalog-topline">
              <span class="catalog-code">${jersey.id_jersey}</span>
              <span class="tag ${jersey.disponible ? "available" : "unavailable"}">${jersey.disponible ? "Disponible" : "No disponible"}</span>
            </div>
            <header class="catalog-header">
              <div>
                <h3>${jersey.equipo}</h3>
                <p class="catalog-meta">${jersey.tipo} • ${jersey.catalogo.nombre || "Sin catalogo"} • ${jersey.catalogo.temporada || "N/D"} ${jersey.catalogo.anio || ""}</p>
              </div>
            </header>
          </div>
          <div class="variation-list">
            ${jersey.variaciones
              .map(
                (variation) => `
                  <section class="variation-block">
                    <div class="variation-head">
                      <div>
                        <strong>${variation.color}</strong>
                        <p class="variation-copy">${variation.descripcion}</p>
                      </div>
                      <span class="pill">$${variation.precio.toFixed(2)}</span>
                    </div>
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
                    <form class="product-buy-form" data-jersey="${jersey.id_jersey}">
                      <div class="buy-row">
                        <select name="id_inventario" required>
                          ${variation.inventario
                            .map(
                              (item) => `
                                <option value="${item.id_inventario}">
                                  Talla ${item.talla} • ${item.stock} piezas
                                </option>
                              `
                            )
                            .join("")}
                        </select>
                        <input name="cantidad" type="number" min="1" value="1" required />
                      </div>
                      <button type="submit">Agregar al carrito</button>
                    </form>
                  </section>
                `
              )
              .join("")}
          </div>
        </article>
      `;
    })
    .join("");

  bindCatalogActions();
}

function renderSession(customer) {
  const sessionView = document.getElementById("customer-session-view");
  const sessionCard = document.getElementById("customer-session-card");

  if (!customer) {
    sessionView.classList.add("hidden");
    sessionCard.innerHTML = "";
    return;
  }

  sessionView.classList.remove("hidden");
  sessionCard.innerHTML = `
    <p class="eyebrow">${customer.id_cliente}</p>
    <h3>${customer.nombre}</h3>
    <p>${customer.correo}</p>
    <div class="variation-head">
      <span class="pill">Carrito ${customer.id_carrito}</span>
      <strong>Total actual $${customer.total.toFixed(2)}</strong>
    </div>
  `;
}

function renderCart(cart) {
  const container = document.getElementById("user-cart");
  if (!cart) {
    container.innerHTML = '<p class="muted">Inicia sesion para ver tu carrito.</p>';
    return;
  }

  container.innerHTML = `
    <article class="card cart-card">
      <div>
        <p class="eyebrow">Cliente</p>
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
                    <div class="editor-actions">
                      <button data-detail="${detail.id_detalle}" data-qty="${detail.cantidad + 1}">+1</button>
                      <button data-detail="${detail.id_detalle}" data-qty="${Math.max(1, detail.cantidad - 1)}">-1</button>
                      <button data-remove="${detail.id_detalle}" class="danger">Quitar</button>
                    </div>
                  </div>
                `
              )
              .join("")
          : '<p class="muted">Aun no hay articulos en el carrito.</p>'
      }
    </article>
  `;

  container.querySelectorAll("[data-detail]").forEach((button) => {
    button.addEventListener("click", async () => {
      await request(`/api/public/cart-items/${button.dataset.detail}`, {
        method: "PATCH",
        body: JSON.stringify({ cantidad: button.dataset.qty }),
      });
      await loadBootstrap();
      await loadActiveCart();
      showToast("Cantidad actualizada.");
    });
  });

  container.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", async () => {
      await request(`/api/public/cart-items/${button.dataset.remove}`, { method: "DELETE" });
      await loadBootstrap();
      await loadActiveCart();
      showToast("Articulo eliminado del carrito.");
    });
  });
}

function bindCatalogActions() {
  document.querySelectorAll(".product-buy-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      if (!state.customer) {
        showToast("Inicia sesion como cliente para agregar productos.");
        openCustomerModal();
        return;
      }

      const currentForm = event.currentTarget;
      const payload = formToObject(currentForm);
      payload.id_jersey = currentForm.dataset.jersey;

      await request("/api/public/cart-items", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      currentForm.querySelector('[name="cantidad"]').value = 1;
      await loadBootstrap();
      await loadActiveCart();
      showToast("Producto agregado al carrito.");
    });
  });
}

async function loadBootstrap() {
  const data = await request("/api/public/bootstrap");
  state.catalog = data.catalog;
  state.customer = data.customer;
  renderCatalog(state.catalog);
  renderSession(state.customer);
}

async function loadActiveCart() {
  if (!state.customer) {
    renderCart(null);
    return;
  }

  const cart = await request("/api/public/me/cart");
  renderCart(cart);
}

function openAdminModal() {
  adminModal.classList.remove("hidden");
}

function closeAdminModal() {
  adminModal.classList.add("hidden");
}

function openCustomerModal() {
  customerModal.classList.remove("hidden");
}

function closeCustomerModal() {
  customerModal.classList.add("hidden");
}

function handleAdminQueryFlag() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("admin") === "1") {
    openAdminModal();
    window.history.replaceState({}, "", "/");
  }
}

function bindForms() {
  document.getElementById("filter-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const { team } = formToObject(form);
    const catalog = await request(`/api/catalog?team=${encodeURIComponent(team || "")}`);
    renderCatalog(catalog);
  });

  document.getElementById("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = formToObject(form);
    const result = await request("/api/public/login", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setClientCookie("customer_token", result.token);
    form.reset();
    closeCustomerModal();
    await loadBootstrap();
    await loadActiveCart();
    showToast("Sesion iniciada.");
  });

  document.getElementById("customer-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = formToObject(form);
    const result = await request("/api/public/customers", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setClientCookie("customer_token", result.token);
    form.reset();
    closeCustomerModal();
    await loadBootstrap();
    await loadActiveCart();
    showToast("Cliente creado.");
  });

  document.getElementById("customer-logout-button").addEventListener("click", async () => {
    await request("/api/public/logout", { method: "POST" });
    state.customer = null;
    renderSession(null);
    renderCart(null);
    await loadBootstrap();
    showToast("Sesion cerrada.");
  });

  document.getElementById("admin-login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const form = event.currentTarget;
      const payload = formToObject(form);
      const result = await request("/api/admin/login", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setClientCookie("admin_token", result.token);
      localStorage.setItem("jerseydb_admin_token", result.token);
      const session = await request("/api/admin/session");
      if (!session.authenticated) {
        throw new Error("La sesion de admin no se pudo establecer.");
      }
      form.reset();
      closeAdminModal();
      window.location.href = "/admin";
    } catch (error) {
      showToast(error.message);
    }
  });

  document.getElementById("open-customer-modal").addEventListener("click", openCustomerModal);
  document.getElementById("open-admin-modal").addEventListener("click", openAdminModal);
  document.querySelectorAll("[data-close-admin-modal]").forEach((node) => {
    node.addEventListener("click", closeAdminModal);
  });
  document.querySelectorAll("[data-close-customer-modal]").forEach((node) => {
    node.addEventListener("click", closeCustomerModal);
  });
}

bindForms();
loadBootstrap()
  .then(() => loadActiveCart())
  .then(() => handleAdminQueryFlag())
  .catch((error) => showToast(error.message));
