/* Simple POS - js/cart.js
   Shopping cart logic: add items, change quantities, remove items and
   calculate the subtotal, VAT and total. */

import { findProduct } from './products.js';

export const VAT_RATE = 0.12;
export const VAT_PERCENT = Math.round(VAT_RATE * 100);

export class Cart {
  constructor() {
    this.lines = new Map();
  }

  add(sku) {
    const current = this.lines.get(sku);
    if (current) {
      current.quantity += 1;
    } else {
      this.lines.set(sku, { sku: sku, quantity: 1 });
    }
    return this.lines.get(sku);
  }

  changeQuantity(sku, delta) {
    const line = this.lines.get(sku);
    if (!line) {
      return null;
    }
    line.quantity += delta;
    if (line.quantity <= 0) {
      this.lines.delete(sku);
      return null;
    }
    return line;
  }

  remove(sku) {
    this.lines.delete(sku);
  }

  clear() {
    this.lines.clear();
  }

  isEmpty() {
    return this.lines.size === 0;
  }

  itemCount() {
    let quantity = 0;
    this.lines.forEach(function (line) {
      quantity += line.quantity;
    });
    return quantity;
  }

  items() {
    return Array.from(this.lines.values()).map(function (line) {
      const product = findProduct(line.sku);
      const price = product ? product.price : 0;
      return {
        sku: line.sku,
        name: product ? product.name : line.sku,
        price: price,
        quantity: line.quantity,
        subtotal: price * line.quantity,
      };
    });
  }

  subtotal() {
    return this.items().reduce(function (sum, item) {
      return sum + item.subtotal;
    }, 0);
  }

  vat() {
    return this.subtotal() * VAT_RATE;
  }

  total() {
    return this.subtotal() + this.vat();
  }
}
