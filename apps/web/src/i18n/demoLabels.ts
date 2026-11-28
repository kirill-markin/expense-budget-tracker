type Translate = (key: string) => string;

const DEMO_CATEGORY_LABEL_KEYS: ReadonlyMap<string, string> = new Map([
  ["Salary", "demo.category.salary"],
  ["Freelance", "demo.category.freelance"],
  ["Rent", "demo.category.rent"],
  ["Groceries", "demo.category.groceries"],
  ["Dining", "demo.category.dining"],
  ["Utilities", "demo.category.utilities"],
  ["Subscriptions", "demo.category.subscriptions"],
  ["Transport", "demo.category.transport"],
  ["Entertainment", "demo.category.entertainment"],
  ["Healthcare", "demo.category.healthcare"],
  ["Clothing", "demo.category.clothing"],
  ["Future taxes", "demo.category.futureTaxes"],
  ["Big purchases", "demo.category.bigPurchases"],
  ["Gifts", "demo.category.gifts"],
  ["Other", "demo.category.other"],
  ["Adjustment", "demo.category.adjustment"],
  ["Travel reserve", "demo.category.travelReserve"],
]);

export const formatCategoryLabel = (category: string, isDemoMode: boolean, t: Translate): string => {
  if (!isDemoMode) return category;
  const messageKey = DEMO_CATEGORY_LABEL_KEYS.get(category);
  return messageKey === undefined ? category : t(messageKey);
};
