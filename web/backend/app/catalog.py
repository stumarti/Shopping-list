"""Common items the app starts with, grouped roughly in supermarket order."""

import re

CATEGORIES = [
    "Fruit & veg",
    "Bakery",
    "Meat & fish",
    "Dairy & eggs",
    "Fridge",
    "Frozen",
    "Cupboard",
    "Breakfast",
    "Snacks & treats",
    "Drinks",
    "Household",
    "Toiletries",
    "Other",
]

COMMON_ITEMS: dict[str, list[str]] = {
    "Fruit & veg": [
        "Bananas", "Apples", "Oranges", "Grapes", "Lemons", "Avocados", "Tomatoes",
        "Potatoes", "Onions", "Carrots", "Garlic", "Peppers", "Broccoli", "Mushrooms",
        "Salad leaves", "Cucumber", "Spinach", "Berries",
    ],
    "Bakery": ["Sliced pan", "Brown bread", "Wraps", "Bagels", "Croissants", "Scones"],
    "Meat & fish": [
        "Chicken fillets", "Mince", "Rashers", "Sausages", "Ham", "Salmon", "Steak",
    ],
    "Dairy & eggs": ["Milk", "Butter", "Eggs", "Cheddar", "Yoghurt", "Cream", "Mozzarella"],
    "Fridge": ["Hummus", "Coleslaw", "Fresh pasta", "Pesto", "Orange juice"],
    "Frozen": ["Frozen peas", "Chips", "Fish fingers", "Ice cream", "Frozen pizza"],
    "Cupboard": [
        "Pasta", "Rice", "Tinned tomatoes", "Beans", "Stock cubes", "Olive oil",
        "Flour", "Sugar", "Tuna", "Peanut butter", "Jam", "Soup", "Salt", "Pepper",
    ],
    "Breakfast": ["Cereal", "Porridge oats", "Tea", "Coffee", "Honey"],
    "Snacks & treats": ["Crisps", "Biscuits", "Chocolate", "Nuts", "Crackers"],
    "Drinks": ["Sparkling water", "Minerals", "Beer", "Wine"],
    "Household": [
        "Toilet roll", "Kitchen roll", "Washing-up liquid", "Dishwasher tablets",
        "Laundry detergent", "Bin bags", "Tin foil", "Cling film",
    ],
    "Toiletries": ["Toothpaste", "Shampoo", "Shower gel", "Deodorant", "Hand soap"],
}

# Words in a store's product name that place it in an aisle, for products imported from past orders.
# Checked in order, so "frozen peas" lands in Frozen before "peas" could put it in Fruit & veg.
AISLE_WORDS: list[tuple[str, list[str]]] = [
    ("Frozen", ["frozen", "ice cream", "fish fingers", "oven chips"]),
    ("Toiletries", ["toothpaste", "toothbrush", "shampoo", "conditioner", "shower gel", "deodorant", "razor",
                    "hand soap", "body wash", "sanitary", "tampons", "nappies", "wipes", "mouthwash", "plasters"]),
    ("Household", ["toilet roll", "toilet tissue", "kitchen roll", "washing up", "washing-up", "dishwasher",
                   "detergent", "laundry", "fabric conditioner", "bin bag", "bin liner", "foil", "cling film",
                   "bleach", "cleaner", "sponges", "batteries", "light bulb"]),
    ("Drinks", ["water", "juice", "cola", "lemonade", "minerals", "beer", "lager", "cider", "wine", "gin",
                "whiskey", "vodka", "squash", "cordial", "smoothie", "energy drink"]),
    ("Breakfast", ["cereal", "cornflakes", "porridge", "oats", "granola", "muesli", "weetabix", "tea bags", "teabags",
                   "coffee", "honey", "marmalade"]),
    ("Snacks & treats", ["crisps", "biscuits", "chocolate", "sweets", "popcorn", "nuts", "crackers", "cookies", "bar"]),
    ("Meat & fish", ["chicken", "beef", "pork", "lamb", "mince", "steak", "rashers", "bacon", "sausages", "ham",
                     "turkey", "salmon", "cod", "haddock", "fish", "prawns", "chops", "burgers"]),
    ("Dairy & eggs", ["milk", "butter", "eggs", "cheese", "cheddar", "yoghurt", "yogurt", "cream", "mozzarella",
                      "spread", "kefir"]),
    ("Bakery", ["bread", "sliced pan", "wraps", "bagels", "croissants", "scones", "rolls", "baguette",
                "brioche", "muffins", "pitta", "naan", "loaf", "pan"]),
    ("Fruit & veg", ["banana", "apple", "orange", "grape", "lemon", "lime", "avocado", "tomato", "potato", "onion",
                     "carrot", "garlic", "pepper", "broccoli", "mushroom", "salad", "lettuce", "cucumber", "spinach",
                     "berries", "strawberr", "blueberr", "raspberr", "pear", "melon", "courgette", "cabbage",
                     "parsnip", "leek", "celery", "kiwi", "mango", "pineapple", "peas", "beans"]),
    ("Fridge", ["hummus", "coleslaw", "fresh pasta", "pesto", "dip", "ready meal", "quiche", "pizza"]),
    ("Cupboard", ["pasta", "spaghetti", "rice", "noodles", "tinned", "baked beans", "stock", "oil", "flour",
                  "sugar", "tuna", "peanut butter", "jam", "soup", "salt", "sauce", "ketchup", "mayonnaise",
                  "vinegar", "spice", "herbs", "lentils", "chickpeas"]),
]


# Each word must start a word in the name; short ones must be the whole word ("gin" isn't "original").
_AISLE_PATTERNS = [
    (aisle, re.compile("|".join(r"\b" + re.escape(w) + (r"\b" if len(w) <= 4 else "") for w in words)))
    for aisle, words in AISLE_WORDS
]


def guess_aisle(product_name: str) -> str:
    name = product_name.lower().replace("'", "")
    for aisle, pattern in _AISLE_PATTERNS:
        if pattern.search(name):
            return aisle
    return "Other"
