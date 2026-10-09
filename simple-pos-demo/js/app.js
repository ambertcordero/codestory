/* Simple POS - js/app.js
   Wires the product list, the cart and the checkout together, and keeps the
   page in sync with the cart state. */

import { PRODUCTS, formatPeso } from './products.js';
import { Cart, VAT_PERCENT } from './cart.js';

const cart = new Cart();

const productGrid = document.getElementById('productGrid');
const cartLines = document.getElementById('cartLines');
const cartEmpty = document.getElementById('cartEmpty');
const itemCount = document.getElementById('itemCount');
const subtotalValue = document.getElementById('subtotalValue');
const vatValue = document.getElementById('vatValue');
const totalValue = document.getElementById('totalValue');
const vatLabel = document.getElementById('vatLabel');
const checkoutButton = document.getElementById('checkoutButton');
const resetButton = document.getElementById('resetButton');
const receipt = document.getElementById('receipt');

function productCard(product) {
  return (
    '<article class="product-card">' +
      '<div class="product-info">' +
        '<h3>' + product.name + '</h3>' +
        '<p class="product-price">' + formatPeso(product.price) + '</p>' +
      '</div>' +
      '<button class="pos-button primary" type="button" data-add="' + product.sku + '">' +
        'Add' +
      '</button>' +
    '</article>'
  );
}

function cartLine(item) {
  return (
    '<li class="cart-line">' +
      '<div class="cart-line-info">' +
        '<span class="cart-line-name">' + item.name + '</span>' +
        '<span class="cart-line-price">' + formatPeso(item.price) + ' each</span>' +
      '</div>' +
      '<div class="cart-line-controls">' +
        '<button class="qty-button" type="button" data-decrease="' + item.sku + '">-</button>' +
        '<span class="qty-value">' + item.quantity + '</span>' +
        '<button class="qty-button" type="button" data-increase="' + item.sku + '">+</button>' +
      '</div>' +
      '<span class="cart-line-subtotal">' + formatPeso(item.subtotal) + '</span>' +
      '<button class="remove-button" type="button" data-remove="' + item.sku + '">Remove</button>' +
    '</li>'
  );
}

function renderProducts() {
  productGrid.innerHTML = PRODUCTS.map(productCard).join('');
}

function renderCart() {
  const items = cart.items();
  itemCount.textContent = String(cart.itemCount());

  if (items.length === 0) {
    cartLines.innerHTML = '';
    cartEmpty.hidden = false;
  } else {
    cartEmpty.hidden = true;
    cartLines.innerHTML = items.map(cartLine).join('');
  }

  subtotalValue.textContent = formatPeso(cart.subtotal());
  vatValue.textContent = formatPeso(cart.vat());
  totalValue.textContent = formatPeso(cart.total());

  const empty = cart.isEmpty();
  checkoutButton.disabled = empty;
  resetButton.disabled = empty && receipt.hidden;
}

function receiptLine(item) {
  return (
    '<li>' +
      '<span>' + item.quantity + ' x ' + item.name + '</span>' +
      '<span>' + formatPeso(item.subtotal) + '</span>' +
    '</li>'
  );
}

function buildReceipt(reference, issuedAt) {
  const totals =
    '<p><span>Subtotal</span><span>' + formatPeso(cart.subtotal()) + '</span></p>' +
    '<p><span>VAT (' + VAT_PERCENT + '%)</span><span>' + formatPeso(cart.vat()) + '</span></p>' +
    '<p class="receipt-total"><span>Total</span><span>' + formatPeso(cart.total()) + '</span></p>';

  return (
    '<div class="receipt-card">' +
      '<h3>Sales Receipt</h3>' +
      '<p class="receipt-meta">Reference ' + reference + ' &middot; ' + issuedAt + '</p>' +
      '<ul class="receipt-lines">' + cart.items().map(receiptLine).join('') + '</ul>' +
      '<div class="receipt-totals">' + totals + '</div>' +
      '<p class="receipt-note">Thank you! This is a simulated transaction - ' +
        'no real payment was processed.</p>' +
    '</div>'
  );
}

function checkout() {
  if (cart.isEmpty()) {
    return;
  }
  const reference = 'POS-' + Date.now().toString().slice(-6);
  receipt.innerHTML = buildReceipt(reference, new Date().toLocaleString());
  receipt.hidden = false;
  cart.clear();
  renderCart();
}

function resetTransaction() {
  cart.clear();
  receipt.hidden = true;
  receipt.innerHTML = '';
  renderCart();
}

productGrid.addEventListener('click', function (event) {
  const button = event.target.closest('[data-add]');
  if (!button) {
    return;
  }
  cart.add(button.getAttribute('data-add'));
  receipt.hidden = true;
  renderCart();
});

cartLines.addEventListener('click', function (event) {
  const increase = event.target.closest('[data-increase]');
  const decrease = event.target.closest('[data-decrease]');
  const remove = event.target.closest('[data-remove]');
  if (increase) {
    cart.changeQuantity(increase.getAttribute('data-increase'), 1);
  } else if (decrease) {
    cart.changeQuantity(decrease.getAttribute('data-decrease'), -1);
  } else if (remove) {
    cart.remove(remove.getAttribute('data-remove'));
  } else {
    return;
  }
  renderCart();
});

checkoutButton.addEventListener('click', checkout);
resetButton.addEventListener('click', resetTransaction);

vatLabel.textContent = 'VAT (' + VAT_PERCENT + '%)';

renderProducts();
renderCart();
