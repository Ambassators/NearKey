const currency = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'});
export function money(cents) {
  if (!Number.isSafeInteger(cents)) throw new Error('Expected an exact integer amount in cents.');
  const value = BigInt(cents);
  const dollars = value / 100n;
  const fraction = String((value < 0n ? -value : value) % 100n).padStart(2, '0');
  // Format the whole dollars exactly; dividing large cent amounts as a Number loses cents.
  return currency.formatToParts(cents < 0 && dollars === 0n ? -0 : dollars)
    .map(part => part.type === 'fraction' ? fraction : part.value).join('');
}

export function amountCents(value) {
  const match = typeof value === 'string'
    ? /^([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(value.trim()) : null;
  if (!match) throw new Error('Enter a positive USD amount with at most two decimal places.');
  const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('Enter a positive amount that can be represented exactly in cents.');
  return cents;
}
