const DEMO_FX_RATES: Readonly<Record<string, number>> = { USD: 1, EUR: 1.029, GBP: 1.24 };

export const getDemoAmountReport = (amount: number, currency: string): number | null => {
  const rate = DEMO_FX_RATES[currency];
  if (rate === undefined) {
    return null;
  }
  return Math.round(amount * rate * 100) / 100;
};
