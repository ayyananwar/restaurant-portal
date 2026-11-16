const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

export function formatPaise(paise: number) {
  return inr.format(paise / 100);
}

export function parseRupees(value: string) {
  const amount = /^([0-9]{1,9})(?:\.([0-9]{1,2}))?$/.exec(value.trim());
  return amount ? Number(amount[1]) * 100 + Number((amount[2] ?? '').padEnd(2, '0')) : undefined;
}
