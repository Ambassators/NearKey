const currency = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'});
export const money = cents => currency.format(cents / 100);

export function amountCents(value) {
  const match = /^([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error('Enter a positive USD amount with at most two decimal places.');
  const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('Enter a positive amount that can be represented exactly in cents.');
  return cents;
}
