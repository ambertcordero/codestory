# Simple POS

A tiny, beginner-friendly point-of-sale (POS) demo used as the **built-in demo
project** for [CodeStory](../../README.md). It is written with plain HTML, CSS
and vanilla JavaScript - no frameworks, bundlers, databases or payment
gateways.

All prices are in **Philippine pesos (PHP, `₱`)**. This is a simulation only:
no real payments are processed and no personal information is collected.

## Features

1. **Product list** - six sample products with names and prices.
2. **Add to cart** - add any product to the cart.
3. **Quantity controls** - increase, decrease or remove cart items.
4. **Totals** - subtotal, 12% VAT and total are calculated automatically.
5. **Checkout** - a simulated cash transaction that shows a receipt.
6. **Reset** - clear the cart and start a new transaction.

## Project structure

```text
simple-pos-demo/
├── index.html
├── README.md
├── css/
│   └── style.css
└── js/
    ├── products.js
    ├── cart.js
    └── app.js
```

- `js/products.js` - the sample catalogue and price formatting.
- `js/cart.js` - the `Cart` class: add, change quantity, remove and totals.
- `js/app.js` - DOM wiring for the product list, cart, totals and checkout.

## Running it

The demo uses JavaScript modules, so open it through a web server rather than
directly from the file system. For example, when CodeStory is served with XAMPP
open `http://localhost/codestory/simple-pos-demo/index.html`.

## Notes

- There are no external fonts, CDNs or network calls; the demo runs fully
  offline.
- Product data lives in a small local array, so it resets on every reload.
