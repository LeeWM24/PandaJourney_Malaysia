import json
from pathlib import Path
from datetime import datetime


BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / "data"
SAVED_FILE = DATA_DIR / "saved_itineraries.json"


def ensure_saved_file():
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if not SAVED_FILE.exists():
        default_data = [
            {
                "id": 1,
                "title": "Penang Heritage Walk",
                "status": "Completed",
                "destination": "Penang",
                "date": "Jul 20, 2026",
                "duration": "7 hrs",
                "stop_count": 6,
                "is_public": False,
                "created_at": "2026-07-20 10:00:00"
            },
            {
                "id": 2,
                "title": "Cameron Highlands Nature Escape",
                "status": "Upcoming",
                "destination": "Pahang",
                "date": "Aug 10, 2026",
                "duration": "6 hrs",
                "stop_count": 4,
                "is_public": True,
                "created_at": "2026-07-21 12:00:00"
            }
        ]

        write_saved_itineraries(default_data)


def read_saved_itineraries():
    ensure_saved_file()

    with open(SAVED_FILE, "r", encoding="utf-8") as file:
        return json.load(file)


def write_saved_itineraries(itineraries):
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    with open(SAVED_FILE, "w", encoding="utf-8") as file:
        json.dump(itineraries, file, indent=4, ensure_ascii=False)


def get_saved_itineraries():
    return read_saved_itineraries()


def save_itinerary(plan_data):
    itineraries = read_saved_itineraries()

    new_id = get_next_id(itineraries)

    new_itinerary = {
        "id": new_id,
        "title": plan_data.get("title", "Untitled Itinerary"),
        "status": "Draft",
        "destination": plan_data.get("destination", "Malaysia"),
        "date": plan_data.get("date", ""),
        "duration": plan_data.get("duration", "Estimated"),
        "stop_count": plan_data.get("stop_count", 0),
        "is_public": False,
        "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "selected": plan_data.get("selected", []),
        "timetable": plan_data.get("timetable", [])
    }

    itineraries.insert(0, new_itinerary)

    write_saved_itineraries(itineraries)

    return new_itinerary


def delete_itinerary(itinerary_id):
    if not itinerary_id:
        return False

    itinerary_id = int(itinerary_id)
    itineraries = read_saved_itineraries()

    updated_list = [
        item for item in itineraries
        if int(item.get("id")) != itinerary_id
    ]

    write_saved_itineraries(updated_list)

    return True


def toggle_publish_status(itinerary_id):
    if not itinerary_id:
        return False

    itinerary_id = int(itinerary_id)
    itineraries = read_saved_itineraries()

    for item in itineraries:
        if int(item.get("id")) == itinerary_id:
            is_public = item.get("is_public", False)
            item["is_public"] = not is_public

            if item["is_public"]:
                item["status"] = "Published"
                item["published_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            else:
                item["status"] = "Draft"
                item["published_at"] = None

            break

    write_saved_itineraries(itineraries)

    return True


def get_next_id(itineraries):
    if not itineraries:
        return 1

    return max(int(item.get("id", 0)) for item in itineraries) + 1