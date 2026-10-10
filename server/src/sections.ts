export interface Section {
  id: string;
  name: string;
  color: string;
}

// Default order follows a typical Irish/UK supermarket walk: fresh at the door, frozen near the tills.
export const DEFAULT_SECTIONS: Section[] = [
  { id: "produce", name: "Fruit & veg", color: "#3E8E41" },
  { id: "bakery", name: "Bakery", color: "#B7791F" },
  { id: "deli", name: "Deli", color: "#D07A5B" },
  { id: "meat", name: "Meat & fish", color: "#C2413B" },
  { id: "dairy", name: "Dairy & eggs", color: "#3B82C4" },
  { id: "cupboard", name: "Cupboard", color: "#A0703A" },
  { id: "drinks", name: "Drinks", color: "#2E9C8F" },
  { id: "frozen", name: "Frozen", color: "#4F97A8" },
  { id: "household", name: "Household", color: "#7A6BB0" },
  { id: "health", name: "Health & beauty", color: "#B05A8E" },
  { id: "other", name: "Other", color: "#8A918C" },
];

const KEYWORDS: Record<string, string[]> = {
  frozen: ["frozen", "ice cream", "fish fingers", "chips", "ice pop"],
  produce: [
    "apple", "watermelon", "banana", "orange", "lemon", "lime", "grape", "berry", "berries", "pear", "melon", "mango",
    "avocado", "tomato", "potato", "onion", "garlic", "carrot", "lettuce", "spinach", "salad", "cucumber",
    "pepper", "broccoli", "cauliflower", "mushroom", "courgette", "leek", "celery", "herbs", "ginger", "kale",
  ],
  bakery: ["bread", "loaf", "sourdough", "bagel", "croissant", "roll", "wrap", "pitta", "scone", "brioche", "muffin"],
  deli: ["ham", "salami", "hummus", "olives", "coleslaw", "pesto", "quiche"],
  meat: ["chicken", "beef", "pork", "lamb", "mince", "sausage", "rasher", "bacon", "steak", "salmon", "cod", "fish", "prawn", "turkey"],
  dairy: ["milk", "cheese", "cheddar", "butter", "yoghurt", "yogurt", "cream", "egg", "mozzarella", "feta", "oat drink"],
  drinks: ["juice", "water", "cola", "coke", "beer", "wine", "coffee", "tea", "squash", "soda", "lemonade"],
  household: [
    "washing", "detergent", "bleach", "toilet roll", "kitchen roll", "bin bag", "foil", "cling", "sponge",
    "dishwasher", "fabric", "cleaner", "batteries", "bulb",
  ],
  health: ["shampoo", "conditioner", "toothpaste", "toothbrush", "deodorant", "soap", "razor", "paracetamol", "plasters", "shower gel", "nappies"],
  cupboard: [
    "pasta", "rice", "flour", "sugar", "oil", "vinegar", "tin", "beans", "soup", "cereal", "porridge", "oats",
    "jam", "honey", "sauce", "ketchup", "mayo", "spice", "salt", "stock", "noodles", "crisps", "biscuits", "chocolate", "nuts",
  ],
};

// Order matters: "frozen peas" must win over produce, "oat drink" over drinks.
const KEYWORD_ORDER = ["frozen", "health", "household", "dairy", "deli", "meat", "bakery", "produce", "drinks", "cupboard"];

export function categorize(name: string): string {
  const text = name.toLowerCase();
  for (const sectionId of KEYWORD_ORDER) {
    if (KEYWORDS[sectionId].some((k) => new RegExp(`\\b${k}`).test(text))) return sectionId;
  }
  return "other";
}

// Open Food Facts category tags → our sections. First match wins, so specific tags come first.
const OFF_TAGS: Array<[string, string]> = [
  ["en:frozen-foods", "frozen"],
  ["en:plant-based-milk-substitutes", "dairy"],
  ["en:dairies", "dairy"],
  ["en:eggs", "dairy"],
  ["en:meats", "meat"],
  ["en:seafood", "meat"],
  ["en:fishes", "meat"],
  ["en:breads", "bakery"],
  ["en:pastries", "bakery"],
  ["en:fresh-vegetables", "produce"],
  ["en:fresh-fruits", "produce"],
  ["en:beverages", "drinks"],
  ["en:fruits-and-vegetables-based-foods", "produce"],
];

export function sectionFromOffTags(tags: string[] | undefined): string | null {
  if (!tags?.length) return null;
  for (const [tag, sectionId] of OFF_TAGS) {
    if (tags.includes(tag)) return sectionId;
  }
  return "cupboard";
}
