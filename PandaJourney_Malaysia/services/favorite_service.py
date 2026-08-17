import json
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / "data"
FAVOURITES_FILE = DATA_DIR / "favourite_attractions.json"


def ensure_favourites_file():
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if not FAVOURITES_FILE.exists():
        write_favourites([])


def read_favourites():
    ensure_favourites_file()

    with open(FAVOURITES_FILE, "r", encoding="utf-8") as file:
        return json.load(file)


def write_favourites(favourites):
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    with open(FAVOURITES_FILE, "w", encoding="utf-8") as file:
        json.dump(favourites, file, indent=4, ensure_ascii=False)


def get_favourites():
    return read_favourites()


def get_favourite_names():
    return {item.get("name") for item in read_favourites()}


def is_favourite(name):
    return name in get_favourite_names()


def add_favourite(attraction):
    favourites = read_favourites()
    name = attraction.get("name")

    if not name or any(item.get("name") == name for item in favourites):
        return favourites

    favourites.insert(
        0,
        {
            "name": name,
            "category": attraction.get("category", ""),
            "rating": attraction.get("rating", 0),
            "image_url": attraction.get("image_url", ""),
            "area": attraction.get("area") or attraction.get("location", ""),
            "waze_url": attraction.get("waze_url", ""),
        },
    )

    write_favourites(favourites)
    return favourites


def remove_favourite(name):
    favourites = read_favourites()
    updated = [item for item in favourites if item.get("name") != name]

    write_favourites(updated)
    return updated


def toggle_favourite(attraction):
    """Adds or removes an attraction from favourites.

    Returns a tuple of (is_now_favourite, updated_favourites_list).
    """
    name = attraction.get("name")

    if not name:
        return False, read_favourites()

    if is_favourite(name):
        favourites = remove_favourite(name)
        return False, favourites

    favourites = add_favourite(attraction)
    return True, favourites
