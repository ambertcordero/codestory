/* Simple POS - js/products.js
   The sample product catalogue. Prices are in Philippine pesos (PHP). */

export const PRODUCTS = [
  { sku: 'P001', name: 'Rice (1 kg)', price: 55.0 },
  { sku: 'P002', name: 'Cooking Oil (1 L)', price: 92.5 },
  { sku: 'P003', name: 'Instant Noodles', price: 15.0 },
  { sku: 'P004', name: 'Bottled Water (500 ml)', price: 20.0 },
  { sku: 'P005', name: 'Canned Sardines', price: 28.75 },
  { sku: 'P006', name: 'Coffee (3-in-1, 10 pcs)', price: 85.0 },
];

export function findProduct(sku) {
  return PRODUCTS.find(function (product) {
    return product.sku === sku;
  }) || null;
}

export function formatPeso(amount) {
  return '\u20B1' + Number(amount).toFixed(2);
}
