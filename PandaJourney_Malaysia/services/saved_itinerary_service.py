import json
from pathlib import Path
from datetime import datetime

from google.cloud.firestore_v1 import FieldFilter


BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / "data"
SAVED_FILE = DATA_DIR / "saved_itineraries.json"
ITINERARY_COLLECTION = "Itinerary"
ITINERARY_STOP_COLLECTION = "itinerary_stops"
PUBLIC_ITINERARY_COLLECTION = "public_itineraries"
TIMEOUT_SECONDS = 10
_firestore_db = None


def configure_saved_itinerary_backend(db=None):
    global _firestore_db
    _firestore_db = db


def using_firestore():
    return _firestore_db is not None


def get_default_itineraries():
    return []


def ensure_saved_file():
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if not SAVED_FILE.exists():
        write_saved_itineraries(get_default_itineraries())


def read_saved_itineraries():
    ensure_saved_file()

    with open(SAVED_FILE, "r", encoding="utf-8") as file:
        itineraries = json.load(file)

    return itineraries


def write_saved_itineraries(itineraries):
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    with open(SAVED_FILE, "w", encoding="utf-8") as file:
        json.dump(itineraries, file, indent=4, ensure_ascii=False)


def _now_string():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _doc_to_saved_item(doc):
    data = doc.to_dict() or {}
    data.setdefault("id", doc.id)
    data.setdefault("date", data.get("travel_date", ""))
    data.setdefault("user_uid", data.get("user_id"))
    return data


def _itinerary_collection():
    return _firestore_db.collection(ITINERARY_COLLECTION)


def _stop_collection():
    return _firestore_db.collection(ITINERARY_STOP_COLLECTION)


def _public_collection():
    return _firestore_db.collection(PUBLIC_ITINERARY_COLLECTION)


def _normalize_stop_for_erd(stop, itinerary_id, index):
    return {
        "stop_id": str(stop.get("stop_id") or stop.get("id") or f"{itinerary_id}_stop_{index}"),
        "itinerary_id": str(itinerary_id),
        "place_id": str(stop.get("place_id") or stop.get("id") or ""),
        "name": stop.get("name") or stop.get("activity") or stop.get("title") or f"Stop {index}",
        "stop_order": int(stop.get("stop_order") or stop.get("stopNumber") or index),
        "arrival_time": stop.get("arrival_time") or stop.get("time") or "",
        "departure_time": stop.get("departure_time") or "",
        "visit_duration": stop.get("visit_duration") or stop.get("duration") or "",
        "duration": stop.get("duration") or "",
        "time": stop.get("time") or stop.get("arrival_time") or "",
        "transport": stop.get("transport") or "",
        "icon": stop.get("icon") or "pin",
    }


def _plan_to_erd_itinerary(plan_data, itinerary_id, user_uid, now):
    start = plan_data.get("start") or {}
    end = plan_data.get("end") or {}
    return {
        "itinerary_id": str(itinerary_id),
        "id": str(itinerary_id),
        "user_id": user_uid,
        "user_uid": user_uid,
        "title": plan_data.get("title", "Untitled Itinerary"),
        "start_location_name": plan_data.get("start_text", ""),
        "start_latitude": start.get("latitude"),
        "start_longitude": start.get("longitude"),
        "end_location_name": plan_data.get("end_text") or plan_data.get("destination", "Malaysia"),
        "end_latitude": end.get("latitude"),
        "end_longitude": end.get("longitude"),
        "travel_date": plan_data.get("trip_date") or plan_data.get("date", ""),
        "date": plan_data.get("date", ""),
        "start_time": plan_data.get("start_time", ""),
        "available_hours": plan_data.get("available_hours"),
        "total_distance": (plan_data.get("route") or {}).get("distance_m"),
        "total_duration": plan_data.get("duration", "Estimated"),
        "duration": plan_data.get("duration", "Estimated"),
        "destination": plan_data.get("destination", "Malaysia"),
        "stop_count": plan_data.get("stop_count", 0),
        "status": plan_data.get("status", "Draft"),
        "is_public": bool(plan_data.get("is_public", False)),
        "created_at": plan_data.get("created_at", now),
        "updated_at": now,
        "selected": plan_data.get("selected", []),
        "timetable": plan_data.get("timetable", []),
    }


def _write_erd_itinerary(plan_data, itinerary_id, user_uid, now):
    itinerary = _plan_to_erd_itinerary(plan_data, itinerary_id, user_uid, now)
    _itinerary_collection().document(str(itinerary_id)).set(itinerary, merge=True)

    stops = plan_data.get("timetable") or plan_data.get("selected") or []
    for index, stop in enumerate(stops, start=1):
        stop_data = _normalize_stop_for_erd(stop, itinerary_id, index)
        _stop_collection().document(stop_data["stop_id"]).set(stop_data, merge=True)

    return itinerary


def _get_firestore_saved_itineraries(user_uid=None):
    items_by_id = {}

    queries = [_itinerary_collection()]
    if user_uid:
        queries = [
            _itinerary_collection().where(filter=FieldFilter("user_id", "==", user_uid)),
            _itinerary_collection().where(filter=FieldFilter("user_uid", "==", user_uid)),
        ]

    for query in queries:
        for doc in query.stream(retry=None, timeout=TIMEOUT_SECONDS):
            item = _doc_to_saved_item(doc)
            item.setdefault("id", item.get("itinerary_id") or doc.id)
            item.setdefault("user_uid", item.get("user_id"))
            items_by_id[str(item.get("id"))] = item

    items = list(items_by_id.values())
    return sorted(
        items,
        key=lambda item: item.get("created_at") or item.get("updated_at") or "",
        reverse=True
    )


def _find_firestore_item(itinerary_id, user_uid=None):
    if not itinerary_id:
        return None, None

    doc_ref = _itinerary_collection().document(str(itinerary_id))
    doc = doc_ref.get(retry=None, timeout=TIMEOUT_SECONDS)
    if doc.exists:
        item = _doc_to_saved_item(doc)
        item.setdefault("user_uid", item.get("user_id"))
        owner_ids = {item.get("user_uid"), item.get("user_id")}
        if user_uid and user_uid not in owner_ids:
            return None, doc_ref
        return item, doc_ref

    return None, _itinerary_collection().document(str(itinerary_id))


def _get_local_saved_itineraries(user_uid=None):
    items = read_saved_itineraries()
    if not user_uid:
        return items

    scoped_items = [
        item for item in items
        if item.get("user_uid") in (None, "", user_uid)
    ]
    return scoped_items


def get_saved_itineraries(user_uid=None):
    if using_firestore():
        return _get_firestore_saved_itineraries(user_uid)
    return _get_local_saved_itineraries(user_uid)


def save_itinerary(plan_data, user_uid=None):
    if using_firestore():
        now = _now_string()
        doc_ref = _itinerary_collection().document()
        new_itinerary = {
            "id": doc_ref.id,
            "itinerary_id": doc_ref.id,
            "user_id": user_uid,
            "user_uid": user_uid,
            "title": plan_data.get("title", "Untitled Itinerary"),
            "status": "Draft",
            "destination": plan_data.get("destination", "Malaysia"),
            "date": plan_data.get("date", ""),
            "duration": plan_data.get("duration", "Estimated"),
            "stop_count": plan_data.get("stop_count", 0),
            "is_public": False,
            "created_at": now,
            "updated_at": now,
            "selected": plan_data.get("selected", []),
            "timetable": plan_data.get("timetable", [])
        }
        new_itinerary.update(_write_erd_itinerary({**plan_data, **new_itinerary}, doc_ref.id, user_uid, now))
        return new_itinerary

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
        "user_uid": user_uid,
        "created_at": _now_string(),
        "selected": plan_data.get("selected", []),
        "timetable": plan_data.get("timetable", [])
    }

    itineraries.insert(0, new_itinerary)

    write_saved_itineraries(itineraries)

    return new_itinerary


def delete_itinerary(itinerary_id, user_uid=None):
    if not itinerary_id:
        return False

    if using_firestore():
        item, doc_ref = _find_firestore_item(itinerary_id, user_uid)
        if not item:
            return False
        doc_ref.delete(timeout=TIMEOUT_SECONDS)
        return True

    try:
        itinerary_id = int(itinerary_id)
    except (TypeError, ValueError):
        return False

    itineraries = read_saved_itineraries()

    updated_list = [
        item for item in itineraries
        if int(item.get("id")) != itinerary_id
    ]

    write_saved_itineraries(updated_list)

    return True


def toggle_publish_status(itinerary_id, user_uid=None):
    if not itinerary_id:
        return False

    if using_firestore():
        item, doc_ref = _find_firestore_item(itinerary_id, user_uid)
        if not item:
            return False

        is_public = item.get("is_public", False)
        now = _now_string()
        doc_ref.set({
            "is_public": not is_public,
            "status": "Published" if not is_public else "Draft",
            "published_at": now if not is_public else None,
            "updated_at": now
        }, merge=True)
        if not is_public:
            _public_collection().document(str(itinerary_id)).set({
                "public_id": str(itinerary_id),
                "itinerary_id": str(itinerary_id),
                "view_count": item.get("view_count", 0),
                "copy_count": item.get("copy_count", 0),
                "like_count": item.get("like_count", 0),
                "published_date": now,
            }, merge=True)
        return True

    try:
        itinerary_id = int(itinerary_id)
    except (TypeError, ValueError):
        return False

    itineraries = read_saved_itineraries()

    for item in itineraries:
        if int(item.get("id")) == itinerary_id:
            is_public = item.get("is_public", False)
            item["is_public"] = not is_public

            if item["is_public"]:
                item["status"] = "Published"
                item["published_at"] = _now_string()
            else:
                item["status"] = "Draft"
                item["published_at"] = None

            break

    write_saved_itineraries(itineraries)

    return True


def update_saved_itinerary_details(itinerary_id, *, user_uid=None, title=None, date=None, stop_count=None, stops=None):
    if not itinerary_id:
        return False

    if using_firestore():
        item, doc_ref = _find_firestore_item(itinerary_id, user_uid)
        if not item:
            return False

        updates = {"updated_at": _now_string()}
        if title is not None:
            updates["title"] = title
        if date is not None:
            updates["date"] = date
        if stop_count is not None:
            updates["stop_count"] = stop_count
        if stops is not None:
            numbered_stops = []
            for index, stop in enumerate(stops, start=1):
                numbered_stops.append({
                    **stop,
                    "stopNumber": int(stop.get("stopNumber") or index)
                })
            updates["timetable"] = numbered_stops
            updates["selected"] = numbered_stops
            for index, stop in enumerate(numbered_stops, start=1):
                stop_data = _normalize_stop_for_erd(stop, itinerary_id, index)
                _stop_collection().document(stop_data["stop_id"]).set(stop_data, merge=True)
        doc_ref.set(updates, merge=True)
        return True

    try:
        itinerary_id = int(itinerary_id)
    except (TypeError, ValueError):
        return False

    itineraries = read_saved_itineraries()
    updated = False

    for item in itineraries:
        if int(item.get("id", 0)) != itinerary_id:
            continue

        if title is not None:
            item["title"] = title
        if date is not None:
            item["date"] = date
        if stop_count is not None:
            item["stop_count"] = stop_count
        if stops is not None:
            numbered_stops = []
            for index, stop in enumerate(stops, start=1):
                numbered_stops.append({
                    **stop,
                    "stopNumber": int(stop.get("stopNumber") or index)
                })
            item["timetable"] = numbered_stops
            item["selected"] = numbered_stops
        updated = True
        break

    if updated:
        write_saved_itineraries(itineraries)

    return updated


def get_next_id(itineraries):
    if not itineraries:
        return 1

    return max(int(item.get("id", 0)) for item in itineraries) + 1
