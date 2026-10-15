"""Common items the app starts with, grouped roughly in supermarket order."""

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
