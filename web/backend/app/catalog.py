"""The starter aisles, in supermarket order, and guessing a product's aisle from its name."""

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


# The food pyramid (safefood's, for Ireland), bottom shelf first: (id, name, how much).
FOOD_GROUPS: list[tuple[str, str, str]] = [
    ("veg", "Vegetables, salad and fruit", "5 to 7 servings a day"),
    ("starch", "Wholemeal cereals, breads, potatoes, pasta and rice", "3 to 5 servings a day"),
    ("dairy", "Milk, yogurt and cheese", "3 servings a day"),
    ("protein", "Meat, poultry, fish, eggs, beans and nuts", "2 servings a day"),
    ("fats", "Fats, spreads and oils", "in very small amounts"),
    ("treats", "Foods high in fat, sugar and salt", "not every day"),
]
FOOD_GROUP_IDS = {g[0] for g in FOOD_GROUPS}

# Words in a product name that place it on a shelf of the pyramid, checked in order ("chocolate milk" is a treat
# before it's milk, "peanut butter" is protein before butter is a fat).
FOOD_WORDS: list[tuple[str, list[str]]] = [
    ("treats", ["crisps", "biscuits", "chocolate", "sweets", "popcorn", "cookies", "cake", "doughnut", "donut",
                "ice cream", "cola", "lemonade", "minerals", "energy drink", "jam", "marmalade", "sugar", "ketchup",
                "mayonnaise", "pizza", "chips", "wine", "beer", "lager", "cider", "gin", "vodka", "whiskey",
                "brownie", "muffins", "croissants", "pastry", "dessert", "custard", "jelly", "syrup", "honey",
                "squash", "cordial"]),
    ("protein", ["peanut butter", "chicken", "beef", "pork", "lamb", "mince", "steak", "rashers", "bacon",
                 "sausages", "ham", "turkey", "salmon", "cod", "haddock", "fish", "prawns", "chops", "burgers",
                 "tuna", "eggs", "egg", "lentils", "chickpeas", "beans", "tofu", "nuts", "hummus", "quorn"]),
    ("fats", ["butter", "spread", "oil", "lard", "margarine", "dripping", "ghee"]),
    ("dairy", ["milk", "cheese", "cheddar", "yoghurt", "yogurt", "mozzarella", "kefir", "fromage frais",
               "cream cheese", "cream"]),
    ("starch", ["bread", "sliced pan", "wraps", "bagels", "scones", "rolls", "baguette", "pitta", "naan", "loaf",
                "pan", "cereal", "cornflakes", "porridge", "oats", "granola", "muesli", "weetabix", "pasta",
                "spaghetti", "penne", "rice", "noodles", "couscous", "potato", "potatoes", "flour", "crackers"]),
    ("veg", ["banana", "apple", "orange", "grape", "lemon", "lime", "avocado", "tomato", "onion", "carrot",
             "garlic", "pepper", "broccoli", "mushroom", "salad", "lettuce", "cucumber", "spinach", "berries",
             "strawberr", "blueberr", "raspberr", "pear", "melon", "courgette", "cabbage", "parsnip", "leek",
             "celery", "kiwi", "mango", "pineapple", "peas", "sweetcorn", "kale", "cauliflower", "beetroot",
             "plum", "peach", "nectarine", "clementine", "satsuma", "juice", "smoothie", "fruit", "veg"]),
]
_FOOD_PATTERNS = [
    (group, re.compile("|".join(r"\b" + re.escape(w) + (r"\b" if len(w) <= 4 else "") for w in words)))
    for group, words in FOOD_WORDS
]
# Aisles that aren't food at all, and the shelf for the rest when no word says.
NOT_FOOD_AISLES = re.compile(r"household|toiletr|baby|pet|cleaning|health|beauty|home", re.I)
AISLE_FOOD = [
    (re.compile(r"fruit|veg|produce|salad", re.I), "veg"),
    (re.compile(r"bakery|bread|breakfast|cereal", re.I), "starch"),
    (re.compile(r"dairy|milk", re.I), "dairy"),
    (re.compile(r"meat|fish|poultry|butcher", re.I), "protein"),
    (re.compile(r"snack|treat|sweet|confection|drink", re.I), "treats"),
]


def guess_food_group(name: str, aisle: str = "") -> str:
    """The pyramid shelf an item most likely sits on, or "" when it isn't food (or can't be told)."""
    if aisle and NOT_FOOD_AISLES.search(aisle):
        return ""
    text = name.lower().replace("'", "")
    for group, pattern in _FOOD_PATTERNS:
        if pattern.search(text):
            return group
    for pattern, group in AISLE_FOOD:
        if pattern.search(aisle or ""):
            return group
    return ""
