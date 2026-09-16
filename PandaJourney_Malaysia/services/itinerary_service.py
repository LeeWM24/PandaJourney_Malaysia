from __future__ import annotations

import json
import math
import os
import re
import time
from itertools import permutations
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus

import requests
from dotenv import load_dotenv


NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse"
OSRM_URL = "https://router.project-osrm.org/route/v1/driving/"
OSRM_TABLE_URL = "https://router.project-osrm.org/table/v1/driving/"
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
SERPAPI_URL = "https://serpapi.com/search.json"

BASE_DIR = Path(__file__).resolve().parents[1]

load_dotenv(BASE_DIR / ".env")

DEMO_ATTRACTIONS_FILE = BASE_DIR / "data" / "demo_attractions.json"

USER_AGENT = os.getenv(
    "NOMINATIM_USER_AGENT",
    "VisitMYPlannerPrototype/1.0 (student-project@example.com)",
).strip()

NOMINATIM_EMAIL = os.getenv("NOMINATIM_EMAIL", "").strip()

print(
    "[NOMINATIM CONFIG] "
    f"contact email configured: {'yes' if NOMINATIM_EMAIL else 'no'} | "
    f"custom User-Agent configured: {'yes' if 'student-project@example.com' not in USER_AGENT else 'no'}"
)

GEOCODE_CACHE: dict[str, dict[str, Any] | None] = {}
LOCATION_SUGGESTION_CACHE: dict[str, list[dict[str, Any]]] = {}
REVERSE_GEOCODE_CACHE: dict[str, dict[str, Any] | None] = {}
CURRENT_LOCATION_NEARBY_CACHE: dict[str, dict[str, Any] | None] = {}
MALAYSIA_ONLY_MESSAGE = (
    "PandaJourney currently supports itinerary planning within Malaysia only. "
    "Please select locations in Malaysia."
)
ROAD_ROUTE_UNAVAILABLE_MESSAGE = (
    "The selected destination cannot be reached using the current road-based itinerary mode. "
    "Please choose a destination connected by road."
)


def get_default_itinerary_form():
    return {
        "start": "",
        "end": "",
        "trip_date": "",
        "start_time": "09:00",
        "available_hours": 6,
        "max_stops": 3,
        "minimum_rating": "4.0",
        "interests": ["culture"],
        "selected_attractions": []
    }


DEMO_LOCATIONS = {
    "kl sentral": {
        "display_name": "KL Sentral, Kuala Lumpur",
        "latitude": 3.1349,
        "longitude": 101.6860,
    },
    "petronas twin towers": {
        "display_name": "Petronas Twin Towers, Kuala Lumpur",
        "latitude": 3.1579,
        "longitude": 101.7123,
    },
    "bukit bintang": {
        "display_name": "Bukit Bintang, Kuala Lumpur",
        "latitude": 3.1467,
        "longitude": 101.7100,
    },
    "merdeka square": {
        "display_name": "Merdeka Square, Kuala Lumpur",
        "latitude": 3.1479,
        "longitude": 101.6953,
    },
}

WEATHER_LABELS = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    80: "Rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    95: "Thunderstorm",
}


DRIVING_OPTION = {
    "label": "Driving",
    "icon": "🚗",
}


BAD_CANDIDATE_KEYWORDS = [
    "tour",
    "tours",
    "private tour",
    "sightseeing",
    "sightseeing tour",
    "day trip",
    "package",
    "experience",
    "walking tour",
    "guided tour",
]


INTEREST_KEYWORDS = {
    "museum": [
        "museum", "gallery", "exhibition", "art", "artefact",
        "history", "historical", "heritage"
    ],
    "nature": [
        "park", "garden", "forest", "lake", "river", "nature",
        "botanical", "eco", "waterfall", "trail", "wildlife", "farm"
    ],
    "culture": [
        "culture", "cultural", "heritage", "temple", "mosque",
        "church", "palace", "monument", "memorial", "market",
        "caves", "lighthouse", "hill", "historical", "art"
    ],
    "shopping": [
        "mall", "shopping", "market", "bazaar", "plaza",
        "retail", "store", "outlet", "central market", "suria", "pavilion"
    ],
    "food": [
        "food", "restaurant", "cafe", "hawker", "street food",
        "dining", "kopitiam", "eatery", "food court", "market"
    ],
}

ONE_SEARCH_KEYWORD_PARTS = {
    "culture": "cultural heritage places",
    "museum": "museums galleries art heritage",
    "nature": "parks gardens nature attractions",
    "shopping": "shopping malls markets",
    "food": "restaurants cafes food courts",
}


def build_one_search_keyword(selected_interests: list[str]) -> str:
    """Build one SerpAPI keyword from multiple interests.

    The system still sends only one request to SerpAPI, but the keyword becomes
    more relevant when the user selects interests such as food or shopping.
    """
    selected = []

    for interest in selected_interests:
        interest_key = str(interest).lower().strip()

        if interest_key and interest_key not in selected:
            selected.append(interest_key)

    keyword_parts = ["tourist attractions"]

    for interest_key in selected:
        keyword_part = ONE_SEARCH_KEYWORD_PARTS.get(interest_key)

        if keyword_part and keyword_part not in keyword_parts:
            keyword_parts.append(keyword_part)

    return " ".join(keyword_parts)


def build_candidate_search_text(item: dict[str, Any]) -> str:
    """Combine SerpAPI fields into searchable text for local matching."""
    return " ".join(
        [
            str(item.get("title", "")),
            str(item.get("type", "")),
            str(item.get("category", "")),
            str(item.get("description", "")),
            str(item.get("address", "")),
        ]
    ).lower()


def detect_interest_tags_from_text(text: str, selected_interests: list[str]) -> list[str]:
    """Detect selected interests from local candidate text."""
    candidate_text = str(text or "").lower()
    matched_tags: list[str] = []

    for interest in selected_interests:
        interest_key = str(interest).lower().strip()
        keywords = INTEREST_KEYWORDS.get(interest_key, [])

        if any(keyword in candidate_text for keyword in keywords):
            matched_tags.append(interest_key)

    return matched_tags


GENERIC_PLACE_FEATURES = {
    "attraction",
    "establishment",
    "point of interest",
    "tourist attraction",
    "tourist attractions",
}

BROAD_PLACE_CATEGORIES = {
    "cafe",
    "food",
    "food court",
    "garden",
    "mall",
    "museum",
    "park",
    "restaurant",
    "shopping mall",
}

ABOUT_GROUP_KEYWORDS = {
    "food": [
        "cafe",
        "coffee",
        "cuisine",
        "delivery",
        "dessert",
        "dine",
        "dining",
        "food",
        "halal",
        "meal",
        "restaurant",
        "takeaway",
        "vegetarian",
    ],
    "culture": [
        "art",
        "artwork",
        "batik",
        "craft",
        "cultural",
        "exhibit",
        "gallery",
        "handicraft",
        "heritage",
        "historical",
        "history",
        "museum",
    ],
    "shopping": [
        "boutique",
        "brand",
        "cinema",
        "dining",
        "electronics",
        "entertainment",
        "fashion",
        "market",
        "mall",
        "retail",
        "shopping",
        "store",
    ],
    "nature": [
        "beach",
        "forest",
        "garden",
        "hiking",
        "lake",
        "nature",
        "outdoor",
        "park",
        "recreation",
        "trail",
        "viewpoint",
        "waterfall",
    ],
}


def clean_source_text(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def format_source_feature(value: Any) -> str:
    text = clean_source_text(value).replace("_", " ")

    if not text:
        return ""

    if text.islower():
        text = text.title()

    return text


def append_source_feature(features: list[str], value: Any) -> None:
    text = format_source_feature(value)

    if not text:
        return

    if text.lower() in GENERIC_PLACE_FEATURES:
        return

    if text.lower() not in {feature.lower() for feature in features}:
        features.append(text)


def flatten_serpapi_fact_values(value: Any) -> list[str]:
    if isinstance(value, dict):
        flattened: list[str] = []

        for key, nested_value in value.items():
            if isinstance(nested_value, bool):
                if nested_value:
                    flattened.append(str(key))
                continue

            flattened.extend(flatten_serpapi_fact_values(nested_value))

        return flattened

    if isinstance(value, list):
        flattened = []

        for item in value:
            flattened.extend(flatten_serpapi_fact_values(item))

        return flattened

    text = clean_source_text(value)
    return [text] if text else []


def collect_serpapi_place_features(item: dict[str, Any]) -> list[str]:
    features: list[str] = []

    for value in flatten_serpapi_fact_values(item.get("types")):
        append_source_feature(features, value)

    for value in flatten_serpapi_fact_values(item.get("extensions")):
        append_source_feature(features, value)

    for value in flatten_serpapi_fact_values(item.get("service_options")):
        append_source_feature(features, value)

    for key in ("type", "category"):
        append_source_feature(features, item.get(key))

    return features[:8]


def get_about_group(place: dict[str, Any]) -> str:
    text = " ".join(
        [
            str(place.get("category", "")),
            " ".join(str(tag) for tag in place.get("tags", [])),
            " ".join(str(feature) for feature in place.get("place_features", [])),
        ]
    ).lower()

    for group, keywords in ABOUT_GROUP_KEYWORDS.items():
        if any(keyword in text for keyword in keywords):
            return group

    return "generic"


def get_group_highlights(place: dict[str, Any], group: str) -> list[str]:
    keywords = ABOUT_GROUP_KEYWORDS.get(group, [])
    category_text = clean_source_text(place.get("category")).lower()
    highlights: list[str] = []

    for feature in place.get("place_features", []):
        feature_text = clean_source_text(feature)
        feature_key = feature_text.lower()

        if not feature_text:
            continue

        if (
            feature_key == category_text
            and category_text in BROAD_PLACE_CATEGORIES
        ):
            continue

        if keywords and not any(keyword in feature_key for keyword in keywords):
            continue

        append_source_feature(highlights, feature_text)

    return highlights[:6]


def build_place_about_fields(place: dict[str, Any]) -> dict[str, Any]:
    source_description = clean_source_text(
        place.get("source_description")
        or place.get("description")
    )
    source_snippet = clean_source_text(
        place.get("source_snippet")
        or place.get("snippet")
    )

    if source_description:
        return {
            "about_text": source_description,
            "about_heading": "",
            "place_highlights": get_group_highlights(place, get_about_group(place)),
        }

    if source_snippet:
        return {
            "about_text": source_snippet,
            "about_heading": "",
            "place_highlights": get_group_highlights(place, get_about_group(place)),
        }

    group = get_about_group(place)
    highlights = get_group_highlights(place, group)

    if not highlights:
        return {
            "about_text": "",
            "about_heading": "",
            "place_highlights": [],
        }

    return {
        "about_text": "",
        "about_heading": "",
        "place_highlights": highlights,
    }


def get_stop_limit_by_available_hours(available_hours: int | str) -> int:
    """Limit available Maximum Stops options based on available travelling hours.

    Rule used in this prototype:
    4 hours -> max 1 stop
    5 hours -> max 2 stops
    6 hours -> max 3 stops
    7 hours -> max 4 stops
    8 hours -> max 5 stops
    9 or 10 hours -> max 6 stops
    """
    try:
        hours = int(available_hours)
    except (TypeError, ValueError):
        hours = 6

    return max(1, min(hours - 3, 6))


def calculate_distance_km(
    lat1: float,
    lon1: float,
    lat2: float,
    lon2: float
) -> float:
    """Calculate distance between two coordinates using Haversine formula."""
    radius = 6371

    lat1_rad = math.radians(float(lat1))
    lon1_rad = math.radians(float(lon1))
    lat2_rad = math.radians(float(lat2))
    lon2_rad = math.radians(float(lon2))

    diff_lat = lat2_rad - lat1_rad
    diff_lon = lon2_rad - lon1_rad

    a = (
        math.sin(diff_lat / 2) ** 2
        + math.cos(lat1_rad)
        * math.cos(lat2_rad)
        * math.sin(diff_lon / 2) ** 2
    )

    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    return radius * c


def is_bad_candidate_name(name: str) -> bool:
    """Remove tour/package type result that is not suitable as stop point."""
    text = str(name or "").lower()

    return any(keyword in text for keyword in BAD_CANDIDATE_KEYWORDS)


def filter_route_relevant_candidates(
    candidates: list[dict[str, Any]],
    start: dict[str, Any],
    end: dict[str, Any]
) -> list[dict[str, Any]]:
    """Keep candidates that are near the start-end route.

    This prevents the system from choosing far locations just because the
    interest keyword matches.
    """
    if not candidates:
        return []

    start_lat = start["latitude"]
    start_lon = start["longitude"]
    end_lat = end["latitude"]
    end_lon = end["longitude"]

    direct_distance = calculate_distance_km(
        start_lat,
        start_lon,
        end_lat,
        end_lon
    )

    if direct_distance <= 6:
        max_extra_distance = 4
        max_nearest_point_distance = 3
    elif direct_distance <= 15:
        max_extra_distance = 7
        max_nearest_point_distance = 5
    else:
        max_extra_distance = 10
        max_nearest_point_distance = 6

    filtered: list[dict[str, Any]] = []

    for candidate in candidates:
        name = candidate.get("name", "")

        if is_bad_candidate_name(name):
            continue

        latitude = candidate.get("latitude")
        longitude = candidate.get("longitude")

        if latitude is None or longitude is None:
            continue

        distance_from_start = calculate_distance_km(
            start_lat,
            start_lon,
            latitude,
            longitude
        )

        distance_from_end = calculate_distance_km(
            end_lat,
            end_lon,
            latitude,
            longitude
        )

        extra_distance = (
            distance_from_start
            + distance_from_end
            - direct_distance
        )

        nearest_point_distance = min(
            distance_from_start,
            distance_from_end
        )

        if (
            extra_distance <= max_extra_distance
            or nearest_point_distance <= max_nearest_point_distance
        ):
            item = dict(candidate)
            item["route_extra_km"] = round(extra_distance, 2)
            item["nearest_point_km"] = round(nearest_point_distance, 2)
            filtered.append(item)

    return filtered


def normalise_name_key(name: str) -> str:
    return str(name or "").strip().lower()


def parse_json_list(value: Any) -> list[Any]:
    if not value:
        return []

    if isinstance(value, list):
        return value

    try:
        parsed = json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return []

    return parsed if isinstance(parsed, list) else []


def parse_bool(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def parse_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None

    return number if math.isfinite(number) else None


def reverse_geocode_coordinates(
    latitude: Any,
    longitude: Any,
    *,
    zoom: int = 18,
) -> dict[str, Any] | None:
    lat = parse_float(latitude)
    lon = parse_float(longitude)

    if lat is None or lon is None:
        return None

    safe_zoom = max(3, min(int(zoom or 18), 18))
    cache_key = f"{lat:.6f},{lon:.6f}:{safe_zoom}"

    if cache_key in REVERSE_GEOCODE_CACHE:
        return REVERSE_GEOCODE_CACHE[cache_key]

    params: dict[str, Any] = {
        "lat": lat,
        "lon": lon,
        "format": "jsonv2",
        "addressdetails": 1,
        "namedetails": 1,
        "zoom": safe_zoom,
    }

    if NOMINATIM_EMAIL:
        params["email"] = NOMINATIM_EMAIL

    try:
        data = _request_json(
            NOMINATIM_REVERSE_URL,
            params=params,
            headers={
                "User-Agent": USER_AGENT,
                "Accept-Language": "en",
            },
        )
    except requests.RequestException as error:
        print(f"[REVERSE GEOCODE ERROR] {error}", flush=True)
        data = None

    REVERSE_GEOCODE_CACHE[cache_key] = data if isinstance(data, dict) else None
    return REVERSE_GEOCODE_CACHE[cache_key]


def get_reverse_country_code(data: dict[str, Any] | None) -> str:
    address = (data or {}).get("address") or {}
    return str(address.get("country_code", "")).strip().lower()


def clean_reverse_location_label(value: Any) -> str:
    text = " ".join(str(value or "").split()).strip(" ,")

    if not text:
        return ""

    if text.lower() in {"malaysia"}:
        return ""

    if text.replace(" ", "").isdigit():
        return ""

    return truncate_display_text(text, DISPLAY_LOCATION_MAX_LENGTH)


def get_readable_reverse_location_name(data: dict[str, Any] | None) -> str:
    if not data:
        return ""

    address = data.get("address") or {}
    namedetails = data.get("namedetails") or {}
    candidates: list[Any] = [
        data.get("name"),
        namedetails.get("name:en"),
        namedetails.get("name"),
    ]

    for key in (
        "amenity",
        "railway",
        "station",
        "tourism",
        "building",
        "historic",
        "leisure",
        "shop",
        "office",
        "road",
        "neighbourhood",
        "suburb",
        "quarter",
        "village",
        "town",
        "city",
        "municipality",
    ):
        candidates.append(address.get(key))

    display_name = data.get("display_name")

    if display_name:
        candidates.extend(str(display_name).split(",")[:3])

    for candidate in candidates:
        label = clean_reverse_location_label(candidate)

        if label:
            return label

    return ""


def add_current_location_display_metadata(place: dict[str, Any]) -> dict[str, Any]:
    original_latitude = parse_float(place.get("latitude"))
    original_longitude = parse_float(place.get("longitude"))

    if original_latitude is not None:
        place["original_gps_latitude"] = original_latitude

    if original_longitude is not None:
        place["original_gps_longitude"] = original_longitude

    place["is_approximate"] = False
    place["location_source"] = "browser_gps"
    place["route_start_snapped"] = False

    data = reverse_geocode_coordinates(
        place.get("latitude"),
        place.get("longitude"),
        zoom=18,
    )

    country_code = get_reverse_country_code(data)

    if country_code:
        place["country_code"] = country_code

    # Reverse-geocode fallback name
    reverse_name = get_readable_reverse_location_name(data)
    reverse_area = get_readable_reverse_area_name(data)

    nearby_poi = get_current_location_nearby_poi(
        place.get("latitude"),
        place.get("longitude"),
    )

    if nearby_poi:
        place["resolved_name"] = nearby_poi["name"]
        place["nearby_name"] = nearby_poi["name"]
        place["nearby_category"] = nearby_poi["category"]
        place["nearby_distance_m"] = nearby_poi["distance_m"]
        place["nearby_source"] = "serpapi"

        place["latitude"] = nearby_poi["latitude"]
        place["longitude"] = nearby_poi["longitude"]

        place["route_start_snapped"] = True

        return place

    # No suitable SerpAPI POI:
    # keep original GPS coordinate but preserve a readable nearby name.
    fallback_name = reverse_name or reverse_area

    if fallback_name:
        place["resolved_name"] = fallback_name
        place["nearby_name"] = fallback_name
        place["nearby_source"] = "nominatim_reverse"

    return place


SERPAPI_GEOCODE_STOPWORDS = {
    "malaysia",
    "near",
    "the",
    "and",
    "for",
    "jalan",
}

SERPAPI_GENERIC_LOCATION_TOKENS = {
    "airport",
    "beach",
    "bus",
    "cafe",
    "hotel",
    "mall",
    "museum",
    "park",
    "restaurant",
    "station",
    "terminal",
    "train",
}

CURRENT_LOCATION_NEARBY_RADIUS_M = 500
CURRENT_LOCATION_NEARBY_SEARCH_KEYWORD = (
    "MRT LRT KTM railway train station landmark shopping mall university "
    "hospital park museum tourist attraction government office cafe restaurant shop"
)

CURRENT_LOCATION_POI_PRIORITY_RULES = (
    (
        1,
        "Transit station",
        (
            "mrt",
            "lrt",
            "ktm",
            "railway",
            "train station",
            "transit station",
            "metro station",
            "subway station",
            "monorail",
        ),
    ),
    (
        2,
        "Major landmark",
        (
            "landmark",
            "monument",
            "tower",
            "square",
            "palace",
            "caves",
            "historical landmark",
        ),
    ),
    (
        3,
        "Shopping mall",
        (
            "shopping mall",
            "shopping centre",
            "shopping center",
            "mall",
            "plaza",
        ),
    ),
    (
        4,
        "Education",
        (
            "university",
            "college",
            "school",
            "campus",
            "institute",
        ),
    ),
    (5, "Hospital", ("hospital", "medical centre", "medical center")),
    (6, "Park", ("park", "garden", "recreation")),
    (
        7,
        "Tourist or cultural place",
        (
            "tourist attraction",
            "museum",
            "gallery",
            "cultural",
            "heritage",
            "temple",
            "mosque",
            "church",
        ),
    ),
    (
        8,
        "Government or civic building",
        (
            "government",
            "municipal",
            "majlis",
            "city hall",
            "library",
            "court",
            "police",
        ),
    ),
    (
        10,
        "Cafe or small retail",
        (
            "cafe",
            "coffee",
            "restaurant",
            "convenience",
            "shop",
            "store",
            "retail",
            "mart",
            "pharmacy",
        ),
    ),
)


def get_location_query_tokens(value: Any) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9]+", str(value or "").lower())
        if len(token) >= 2 and token not in SERPAPI_GEOCODE_STOPWORDS
    }


def is_relevant_serpapi_geocode_result(query: str, item: dict[str, Any]) -> bool:
    query_tokens = get_location_query_tokens(query)

    if not query_tokens:
        return False

    title = str(item.get("title") or "").strip()
    address = str(item.get("address") or "").strip()
    result_text = f"{title} {address}"
    title_tokens = get_location_query_tokens(title)
    result_tokens = get_location_query_tokens(result_text)
    matched_title_tokens = query_tokens.intersection(title_tokens)
    matched_result_tokens = query_tokens.intersection(result_tokens)

    if not matched_result_tokens:
        return False

    if query_tokens.issubset(SERPAPI_GENERIC_LOCATION_TOKENS):
        return False

    return bool(matched_title_tokens) or len(matched_result_tokens) >= 2


def get_readable_reverse_area_name(data: dict[str, Any] | None) -> str:
    if not data:
        return ""

    address = data.get("address") or {}

    for key in (
        "road",
        "neighbourhood",
        "suburb",
        "quarter",
        "village",
        "town",
        "city",
        "municipality",
        "county",
        "state",
    ):
        label = clean_reverse_location_label(address.get(key))

        if label:
            return label

    return ""


def get_serpapi_text_field(item: dict[str, Any], key: str) -> str:
    value = item.get(key)

    if isinstance(value, list):
        return " ".join(str(part) for part in value)

    return str(value or "")


def location_text_has_keyword(text: str, keyword: str) -> bool:
    keyword_text = str(keyword or "").strip().lower()

    if not keyword_text:
        return False

    if " " in keyword_text:
        return keyword_text in text

    return bool(re.search(rf"\b{re.escape(keyword_text)}\b", text))


def classify_current_location_poi(item: dict[str, Any]) -> tuple[int, str]:
    text = " ".join(
        [
            get_serpapi_text_field(item, "title"),
            get_serpapi_text_field(item, "type"),
            get_serpapi_text_field(item, "category"),
            get_serpapi_text_field(item, "address"),
        ]
    ).lower()

    if (
        "petrol station" in text
        or "gas station" in text
        or "car park" in text
        or "parking" in text
    ):
        return 9, "Useful POI"

    for priority, category, keywords in CURRENT_LOCATION_POI_PRIORITY_RULES:
        if any(location_text_has_keyword(text, keyword) for keyword in keywords):
            return priority, category

    return 9, "Useful POI"


def get_current_location_nearby_poi(latitude: Any, longitude: Any) -> dict[str, Any] | None:
    lat = parse_float(latitude)
    lon = parse_float(longitude)

    if lat is None or lon is None:
        return None

    cache_key = f"{lat:.5f},{lon:.5f}"

    if cache_key in CURRENT_LOCATION_NEARBY_CACHE:
        return CURRENT_LOCATION_NEARBY_CACHE[cache_key]

    api_key = os.getenv("SERPAPI_KEY", "").strip()

    if not api_key:
        CURRENT_LOCATION_NEARBY_CACHE[cache_key] = None
        return None

    try:
        data = _request_json(
            SERPAPI_URL,
            params={
                "engine": "google_maps",
                "type": "search",
                "q": CURRENT_LOCATION_NEARBY_SEARCH_KEYWORD,
                "ll": f"@{lat},{lon},16z",
                "hl": "en",
                "gl": "my",
                "api_key": api_key,
            },
        )
    except requests.RequestException as error:
        print(f"[CURRENT LOCATION NEARBY ERROR] {error}", flush=True)
        CURRENT_LOCATION_NEARBY_CACHE[cache_key] = None
        return None

    candidates: list[dict[str, Any]] = []

    for item in data.get("local_results", [])[:20]:
        coordinates = item.get("gps_coordinates") or {}
        candidate_lat = parse_float(coordinates.get("latitude"))
        candidate_lon = parse_float(coordinates.get("longitude"))
        title = str(item.get("title") or "").strip()

        if not title or candidate_lat is None or candidate_lon is None:
            continue

        if is_bad_candidate_name(title):
            continue

        distance_m = round(
            calculate_distance_km(lat, lon, candidate_lat, candidate_lon) * 1000
        )

        if distance_m > CURRENT_LOCATION_NEARBY_RADIUS_M:
            continue

        priority, category = classify_current_location_poi(item)

        candidates.append(
            {
                "name": title,
                "category": category,
                "priority": priority,
                "distance_m": int(distance_m),
                "latitude": candidate_lat,
                "longitude": candidate_lon,
                "google_place_id": item.get("place_id") or "",
            }
        )

    candidates.sort(
        key=lambda candidate: (
            candidate["priority"],
            candidate["distance_m"],
        )
    )

    if candidates:
        print(
            "[CURRENT LOCATION NEARBY CANDIDATES] "
            + " | ".join(
                f"{candidate['name']} ({candidate['category']}, {candidate['distance_m']}m)"
                for candidate in candidates[:5]
            ),
            flush=True,
        )

    selected = candidates[0] if candidates else None
    CURRENT_LOCATION_NEARBY_CACHE[cache_key] = selected
    return selected


def is_point_in_malaysia_bounds(latitude: Any, longitude: Any) -> bool:
    """Fallback Malaysia check for GPS/SerpAPI results without country_code."""
    lat = parse_float(latitude)
    lon = parse_float(longitude)

    if lat is None or lon is None:
        return False

    return 0.8 <= lat <= 7.6 and 99.0 <= lon <= 120.5


def get_place_country_code(place: dict[str, Any] | None) -> str:
    if not place:
        return ""

    country_code = str(place.get("country_code", "")).strip().lower()

    if country_code:
        return country_code

    latitude = parse_float(place.get("latitude"))
    longitude = parse_float(place.get("longitude"))

    if latitude is None or longitude is None:
        return ""

    data = reverse_geocode_coordinates(latitude, longitude, zoom=10)
    country_code = get_reverse_country_code(data)

    if country_code:
        place["country_code"] = country_code

    return country_code


def ensure_malaysian_place(place: dict[str, Any] | None) -> None:
    country_code = get_place_country_code(place)

    if country_code:
        if country_code != "my":
            raise ValueError(MALAYSIA_ONLY_MESSAGE)
        return

    if not place or not is_point_in_malaysia_bounds(place.get("latitude"), place.get("longitude")):
        raise ValueError(MALAYSIA_ONLY_MESSAGE)


def parse_excluded_stop_names(form: dict[str, Any]) -> set[str]:
    raw_names = form.get("excluded_stop_names", "[]")
    names = parse_json_list(raw_names)

    return {
        normalise_name_key(name)
        for name in names
        if str(name or "").strip()
    }


def parse_selected_favourites(form: dict[str, Any]) -> list[dict[str, Any]]:
    raw_favourites = form.get("selected_favourites_json", "[]")
    favourites = parse_json_list(raw_favourites)
    selected: list[dict[str, Any]] = []

    for index, favourite in enumerate(favourites, start=1):
        if not isinstance(favourite, dict):
            continue

        name = str(favourite.get("name", "")).strip()
        latitude = favourite.get("latitude")
        longitude = favourite.get("longitude")

        if not name or latitude is None or longitude is None:
            continue

        category = str(favourite.get("category") or "Favourite").strip()
        category_tag = category.lower() if category else "favourite"

        try:
            rating = float(favourite.get("rating") or 0)
        except (TypeError, ValueError):
            rating = 0

        selected.append(
            {
                "id": favourite.get("id") or favourite.get("place_id") or f"fav_{index}",
                "place_id": favourite.get("place_id") or favourite.get("id") or f"fav_{index}",
                "name": name,
                "latitude": float(latitude),
                "longitude": float(longitude),
                "tags": ["favourite", category_tag],
                "category": category,
                "estimated_minutes": 90,
                "rating": rating,
                "source": "User Favourite",
                "is_favourite": True,
            }
        )

    return selected


def remove_excluded_candidates(
    candidates: list[dict[str, Any]],
    excluded_names: set[str]
) -> list[dict[str, Any]]:
    if not excluded_names:
        return candidates

    return [
        candidate
        for candidate in candidates
        if normalise_name_key(candidate.get("name", "")) not in excluded_names
    ]


def rotate_candidates_for_regenerate(
    candidates: list[dict[str, Any]],
    regenerate_token: str
) -> list[dict[str, Any]]:
    if not regenerate_token or len(candidates) <= 1:
        return candidates

    offset = sum(ord(char) for char in str(regenerate_token)) % len(candidates)

    if offset == 0:
        offset = 1

    return candidates[offset:] + candidates[:offset]


def _request_json(
    url: str,
    *,
    params: dict[str, Any],
    headers: dict[str, str] | None = None
) -> Any:
    response = requests.get(url, params=params, headers=headers, timeout=20)
    response.raise_for_status()
    return response.json()


def get_location_suggestions(query: str, limit: int = 3) -> list[dict[str, Any]]:
    """Return Malaysian location suggestions for start/end autocomplete.

    This uses OpenStreetMap Nominatim, not SerpAPI, to avoid consuming
    SerpAPI quota. It is intentionally limited and cached for safer usage.
    """
    search_text = str(query or "").strip()

    if len(search_text) < 3:
        return []

    safe_limit = max(1, min(int(limit or 3), 3))
    cache_key = f"{search_text.lower()}:{safe_limit}"

    if cache_key in LOCATION_SUGGESTION_CACHE:
        print(f"[LOCATION SUGGESTION CACHE] {search_text}", flush=True)
        return LOCATION_SUGGESTION_CACHE[cache_key]

    params: dict[str, Any] = {
        "q": search_text,
        "format": "jsonv2",
        "limit": safe_limit,
        "addressdetails": 1,
        "countrycodes": "my",
    }

    if NOMINATIM_EMAIL:
        params["email"] = NOMINATIM_EMAIL

    try:
        response = requests.get(
            NOMINATIM_URL,
            params=params,
            headers={
                "User-Agent": USER_AGENT,
                "Accept-Language": "en",
            },
            timeout=15,
        )

        print(
            f"[LOCATION SUGGESTION HTTP] Status {response.status_code} | Query: {search_text}",
            flush=True,
        )

        response.raise_for_status()
        results = response.json()

    except requests.RequestException as error:
        print(f"[LOCATION SUGGESTION ERROR] {error}", flush=True)
        results = []

    suggestions: list[dict[str, Any]] = []

    for item in results:
        display_name = item.get("display_name", "")
        latitude = item.get("lat")
        longitude = item.get("lon")
        address = item.get("address") or {}

        if not display_name or latitude is None or longitude is None:
            continue

        suggestions.append(
            {
                "display_name": display_name,
                "latitude": float(latitude),
                "longitude": float(longitude),
                "source": "OpenStreetMap Nominatim",
                "country_code": str(address.get("country_code", "")).lower(),
            }
        )

    if not suggestions:
        demo_matches: list[dict[str, Any]] = []
        key = search_text.lower()

        for demo_key, value in DEMO_LOCATIONS.items():
            if key in demo_key or demo_key in key:
                demo_matches.append(
                    {
                        "display_name": value["display_name"],
                        "latitude": value["latitude"],
                        "longitude": value["longitude"],
                        "source": "Local demo fallback",
                        "country_code": "my",
                    }
                )

        suggestions = demo_matches

    LOCATION_SUGGESTION_CACHE[cache_key] = suggestions[:safe_limit]
    return LOCATION_SUGGESTION_CACHE[cache_key]


def geocode_with_serpapi(query: str) -> dict[str, Any] | None:
    api_key = os.getenv("SERPAPI_KEY", "").strip()

    if not api_key:
        print("[SERPAPI GEOCODE] No SERPAPI_KEY configured.", flush=True)
        return None

    try:
        data = _request_json(
            SERPAPI_URL,
            params={
                "engine": "google_maps",
                "type": "search",
                "q": f"{query}, Malaysia",
                "hl": "en",
                "gl": "my",
                "api_key": api_key,
            },
        )
    except requests.RequestException as error:
        print(f"[SERPAPI GEOCODE ERROR] {error}", flush=True)
        return None

    for item in data.get("local_results", []):
        coordinates = item.get("gps_coordinates") or {}

        if "latitude" not in coordinates or "longitude" not in coordinates:
            continue

        latitude = parse_float(coordinates.get("latitude"))
        longitude = parse_float(coordinates.get("longitude"))

        if latitude is None or longitude is None:
            continue

        if not is_point_in_malaysia_bounds(latitude, longitude):
            continue

        if not is_relevant_serpapi_geocode_result(query, item):
            print(
                f"[GEOCODE SERPAPI SKIP] Irrelevant result for '{query}': "
                f"{item.get('title', '')}",
                flush=True,
            )
            continue

        title = str(item.get("title") or query).strip()
        address = str(item.get("address") or "").strip()
        display_name = f"{title}, {address}".strip(", ")

        result = {
            "display_name": display_name,
            "resolved_name": get_short_location_name(title) or get_short_location_name(display_name),
            "latitude": latitude,
            "longitude": longitude,
            "google_place_id": item.get("place_id") or "",
            "source": "SerpApi fallback",
            "country_code": "my" if "malaysia" in address.lower() else "",
            "is_approximate": True,
            "location_source": "serpapi",
        }

        if not result["country_code"] and get_place_country_code(result) != "my":
            print(
                f"[GEOCODE SERPAPI SKIP] Non-Malaysia result for '{query}': "
                f"{display_name}",
                flush=True,
            )
            continue

        print(
            f"[GEOCODE SERPAPI SUCCESS] {result['display_name']} "
            f"({result['latitude']}, {result['longitude']})",
            flush=True,
        )

        return result

    print(f"[GEOCODE SERPAPI NO RESULT] {query}", flush=True)
    return None


def geocode_place(query: str) -> dict[str, Any] | None:
    key = query.strip().lower()

    if not key:
        print("[GEOCODE ERROR] Empty input.", flush=True)
        return None

    if key in GEOCODE_CACHE:
        print(f"[GEOCODE CACHE] {query}", flush=True)
        return GEOCODE_CACHE[key]

    search_queries = [query]

    if "malaysia" not in key:
        search_queries.append(f"{query}, Malaysia")

    for index, search_text in enumerate(search_queries):
        params = {
            "q": search_text,
            "format": "jsonv2",
            "limit": 1,
            "addressdetails": 1,
        }

        if NOMINATIM_EMAIL:
            params["email"] = NOMINATIM_EMAIL

        try:
            response = requests.get(
                NOMINATIM_URL,
                params=params,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept-Language": "en",
                },
                timeout=20,
            )

            print(
                f"[GEOCODE HTTP] Status {response.status_code} | Query: {search_text}",
                flush=True,
            )

            response.raise_for_status()
            results = response.json()

        except requests.RequestException as error:
            print(f"[GEOCODE ERROR] {error}", flush=True)
            results = []

        if results:
            raw = results[0]
            address = raw.get("address") or {}

            result = {
                "display_name": raw.get("display_name", query),
                "resolved_name": get_short_location_name(raw.get("display_name", query)),
                "latitude": float(raw["lat"]),
                "longitude": float(raw["lon"]),
                "source": "OpenStreetMap Nominatim API",
                "country_code": str(address.get("country_code", "")).lower(),
                "is_approximate": False,
                "location_source": "nominatim",
            }

            GEOCODE_CACHE[key] = result

            print(
                f"[GEOCODE SUCCESS] {result['display_name']} "
                f"({result['latitude']}, {result['longitude']})",
                flush=True,
            )

            return result

        if index < len(search_queries) - 1:
            time.sleep(1.1)

    print(f"[GEOCODE NO RESULT] Nominatim could not find: {query}", flush=True)

    serpapi_result = geocode_with_serpapi(query)

    if serpapi_result:
        GEOCODE_CACHE[key] = serpapi_result
        return serpapi_result

    if key in DEMO_LOCATIONS:
        result = {
            **DEMO_LOCATIONS[key],
            "resolved_name": get_short_location_name(DEMO_LOCATIONS[key].get("display_name", query)),
            "source": "Local demo fallback",
            "country_code": "my",
            "is_approximate": False,
            "location_source": "local_demo",
        }

        GEOCODE_CACHE[key] = result

        print(f"[GEOCODE DEMO] {query}", flush=True)
        return result

    GEOCODE_CACHE[key] = None
    return None


def get_weather(latitude: float, longitude: float, trip_date: str) -> dict[str, Any] | None:
    print(
        f"[WEATHER REQUEST] latitude={latitude}, longitude={longitude}, date={trip_date}",
        flush=True
    )

    try:
        response = requests.get(
            OPEN_METEO_URL,
            params={
                "latitude": latitude,
                "longitude": longitude,
                "daily": (
                    "weather_code,"
                    "temperature_2m_max,"
                    "temperature_2m_min,"
                    "precipitation_sum,"
                    "precipitation_probability_max"
                ),
                "timezone": "Asia/Kuala_Lumpur",
                "start_date": trip_date,
                "end_date": trip_date,
            },
            timeout=20,
        )

        print(f"[WEATHER HTTP] status={response.status_code}", flush=True)

        if response.status_code != 200:
            print(f"[WEATHER RESPONSE] {response.text[:500]}", flush=True)

        response.raise_for_status()
        data = response.json()

        daily = data.get("daily", {})

        if not daily.get("time"):
            print(f"[WEATHER NO DAILY DATA] {data}", flush=True)
            return None

        weather_code = daily["weather_code"][0]

        weather = {
            "date": daily["time"][0],
            "weather_code": weather_code,
            "condition": WEATHER_LABELS.get(weather_code, f"WMO code {weather_code}"),
            "max_temp": daily.get("temperature_2m_max", [None])[0],
            "min_temp": daily.get("temperature_2m_min", [None])[0],
            "precipitation_mm": daily.get("precipitation_sum", [None])[0],
            "rain_probability": daily.get("precipitation_probability_max", [None])[0],
        }

        print(f"[WEATHER SUCCESS] {weather}", flush=True)
        return weather

    except (requests.RequestException, KeyError, IndexError, TypeError, ValueError) as error:
        print(f"[WEATHER ERROR] {type(error).__name__}: {error}", flush=True)
        return None


def load_demo_attractions() -> list[dict[str, Any]]:
    if DEMO_ATTRACTIONS_FILE.exists():
        with DEMO_ATTRACTIONS_FILE.open("r", encoding="utf-8") as file:
            return json.load(file)

    return [
        {
            "name": "Batu Caves",
            "latitude": 3.2379,
            "longitude": 101.6840,
            "tags": ["culture", "heritage", "outdoor"],
            "estimated_minutes": 90,
            "rating": 4.7,
            "source": "Local fallback data",
        },
        {
            "name": "Petronas Twin Towers",
            "latitude": 3.1579,
            "longitude": 101.7123,
            "tags": ["landmark", "culture", "indoor"],
            "estimated_minutes": 90,
            "rating": 4.8,
            "source": "Local fallback data",
        },
        {
            "name": "Central Market Kuala Lumpur",
            "latitude": 3.1459,
            "longitude": 101.6955,
            "tags": ["shopping", "culture", "indoor"],
            "estimated_minutes": 75,
            "rating": 4.4,
            "source": "Local fallback data",
        },
        {
            "name": "Perdana Botanical Garden",
            "latitude": 3.1436,
            "longitude": 101.6841,
            "tags": ["nature", "outdoor"],
            "estimated_minutes": 90,
            "rating": 4.6,
            "source": "Local fallback data",
        },
    ]


def search_attractions_serpapi(
    latitude: float,
    longitude: float,
    interests: list[str],
    minimum_rating: float
) -> list[dict[str, Any]]:
    api_key = os.getenv("SERPAPI_KEY", "").strip()

    if not api_key:
        print("[SERPAPI ATTRACTION] Missing SERPAPI_KEY", flush=True)
        return []

    selected_interests = [
        str(interest).lower().strip()
        for interest in interests
        if str(interest).strip()
    ]

    if not selected_interests:
        selected_interests = ["culture"]

    # Method 2:
    # Send only one SerpAPI request, then perform local multi-interest matching.
    search_keyword = build_one_search_keyword(selected_interests)

    print(
        f"[SERPAPI ONE SEARCH] keyword={search_keyword} | selected_interests={selected_interests}",
        flush=True,
    )

    try:
        data = _request_json(
            SERPAPI_URL,
            params={
                "engine": "google_maps",
                "type": "search",
                "q": search_keyword,
                "ll": f"@{latitude},{longitude},13z",
                "min_rating": str(minimum_rating),
                "hl": "en",
                "gl": "my",
                "api_key": api_key,
            },
        )

    except requests.HTTPError as error:
        status_code = error.response.status_code if error.response is not None else "unknown"
        print(
            f"[SERPAPI ATTRACTION ERROR] one search failed | status={status_code}",
            flush=True,
        )
        return []

    except requests.RequestException as error:
        print(
            f"[SERPAPI ATTRACTION ERROR] one search failed | {type(error).__name__}",
            flush=True,
        )
        return []

    candidates: list[dict[str, Any]] = []
    seen_places: set[str] = set()

    for item in data.get("local_results", [])[:20]:
        coordinates = item.get("gps_coordinates") or {}

        if "latitude" not in coordinates or "longitude" not in coordinates:
            continue

        title = item.get("title", "Unnamed attraction")

        if is_bad_candidate_name(title):
            continue

        address = item.get("address", "")
        place_key = f"{title}|{address}".lower()

        if place_key in seen_places:
            continue

        seen_places.add(place_key)

        rating = float(item.get("rating") or 0)

        if rating < minimum_rating:
            continue

        search_text = build_candidate_search_text(item)
        matched_tags = detect_interest_tags_from_text(search_text, selected_interests)

        if matched_tags:
            tags = matched_tags
            match_reason = "matched selected interest: " + ", ".join(matched_tags)
        else:
            tags = ["attraction"]
            match_reason = "general attraction candidate"

        source_description = clean_source_text(item.get("description"))
        source_snippet = clean_source_text(item.get("snippet"))
        place_features = collect_serpapi_place_features(item)

        candidate = {
            "name": title,
            "latitude": float(coordinates["latitude"]),
            "longitude": float(coordinates["longitude"]),
            "google_place_id": item.get("place_id") or "",
            "tags": tags,
            "matched_interests": matched_tags,
            "interest_match_count": len(matched_tags),
            "interest_match_reason": match_reason,
            "estimated_minutes": 90,
            "rating": rating,
            "source": f"SerpApi - one search: {search_keyword}",
            "category": item.get("type") or item.get("category") or "Attraction",
            "address": address,
            "source_description": source_description,
            "source_snippet": source_snippet,
            "source_types": flatten_serpapi_fact_values(item.get("types")),
            "source_extensions": item.get("extensions") or [],
            "service_options": item.get("service_options") or {},
            "place_features": place_features,
        }

        if source_description:
            candidate["description"] = source_description

        candidate.update(build_place_about_fields(candidate))

        candidates.append(candidate)

        print(
            f"[LOCAL INTEREST MATCH] name={title} | matched={matched_tags} | rating={rating}",
            flush=True,
        )

    # Put matched attractions first before the normal scoring step.
    candidates.sort(
        key=lambda place: (
            place.get("interest_match_count", 0),
            place.get("rating", 0),
        ),
        reverse=True,
    )

    return candidates


def get_osrm_duration_matrix(points: list[dict[str, Any]]) -> list[list[float | None]] | None:
    """Return an all-to-all driving-duration matrix from OSRM Table API."""
    if len(points) < 2:
        return None

    coordinates = ";".join(
        f"{point['longitude']},{point['latitude']}"
        for point in points
    )

    try:
        data = _request_json(
            f"{OSRM_TABLE_URL}{coordinates}",
            params={"annotations": "duration"},
        )

        durations = data.get("durations")

        if not durations or len(durations) != len(points):
            return None

        return durations

    except requests.RequestException as error:
        print(f"[OSRM TABLE ERROR] {type(error).__name__}: {error}", flush=True)
        return None


def _route_order_cost(
    order: tuple[int, ...],
    matrix: list[list[float | None]],
    end_index: int,
) -> float:
    """Calculate total driving duration for Start -> ordered stops -> End."""
    total = 0.0
    previous = 0

    for current in order:
        duration = matrix[previous][current]

        if duration is None:
            return float("inf")

        total += float(duration)
        previous = current

    final_duration = matrix[previous][end_index]

    if final_duration is None:
        return float("inf")

    return total + float(final_duration)


def optimise_stop_order_by_road(
    start: dict[str, Any],
    selected: list[dict[str, Any]],
    end: dict[str, Any],
) -> list[dict[str, Any]]:
    """Optimise visit order while keeping Start and End fixed.

    The recommendation engine decides WHICH attractions are selected.
    This function separately decides IN WHICH ORDER those selected stops
    should be visited. Since the prototype allows at most 6 stops, all
    possible stop orders can be checked exactly after one OSRM Table call.
    """
    if len(selected) <= 1:
        return list(selected)

    points = [start, *selected, end]
    matrix = get_osrm_duration_matrix(points)

    if matrix:
        stop_indexes = tuple(range(1, len(points) - 1))
        end_index = len(points) - 1

        best_order: tuple[int, ...] | None = None
        best_cost = float("inf")

        for order in permutations(stop_indexes):
            cost = _route_order_cost(order, matrix, end_index)

            if cost < best_cost:
                best_cost = cost
                best_order = order

        if best_order is not None and math.isfinite(best_cost):
            optimised = [selected[index - 1] for index in best_order]

            print(
                "[ROUTE ORDER - OSRM] "
                + " -> ".join(
                    [start.get("display_name", "Start")]
                    + [place.get("name", "Stop") for place in optimised]
                    + [end.get("display_name", "End")]
                )
                + f" | estimated driving time={human_duration(best_cost)}",
                flush=True,
            )

            return optimised

    # Fallback: exact ordering using straight-line distance if OSRM Table fails.
    best_order_places = list(selected)
    best_distance = float("inf")

    for order in permutations(selected):
        points_in_order = [start, *order, end]
        total_distance = 0.0

        for index in range(len(points_in_order) - 1):
            current = points_in_order[index]
            next_point = points_in_order[index + 1]

            total_distance += calculate_distance_km(
                current["latitude"],
                current["longitude"],
                next_point["latitude"],
                next_point["longitude"],
            )

        if total_distance < best_distance:
            best_distance = total_distance
            best_order_places = list(order)

    print(
        "[ROUTE ORDER - HAVERSINE FALLBACK] "
        + " -> ".join(
            [start.get("display_name", "Start")]
            + [place.get("name", "Stop") for place in best_order_places]
            + [end.get("display_name", "End")]
        )
        + f" | estimated distance={best_distance:.1f} km",
        flush=True,
    )

    return best_order_places


def get_route_with_stops(
    points: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """Calculate the final driving route in the supplied waypoint order."""
    if len(points) < 2:
        return None

    coordinates = ";".join(
        f"{point['longitude']},{point['latitude']}"
        for point in points
    )

    try:
        data = _request_json(
            f"{OSRM_URL}{coordinates}",
            params={
                "overview": "full",
                "geometries": "geojson",
                "steps": "false",
            },
        )

        routes = data.get("routes", [])

        if not routes:
            return None

        route = routes[0]

        return {
            "distance_m": float(route.get("distance", 0)),
            "duration_s": float(route.get("duration", 0)),
            "geometry": route.get("geometry", {}),
            "legs": route.get("legs", []),
        }

    except requests.RequestException:
        return None


def route_has_non_road_step(route: dict[str, Any]) -> bool:
    for leg in route.get("legs", []):
        for step in leg.get("steps", []):
            mode = str(step.get("mode", "driving")).lower()
            maneuver = step.get("maneuver") or {}
            step_text = " ".join(
                [
                    mode,
                    str(step.get("name", "")),
                    str(step.get("ref", "")),
                    str(maneuver.get("type", "")),
                    str(maneuver.get("modifier", "")),
                ]
            ).lower()

            if mode and mode != "driving":
                return True

            if "ferry" in step_text:
                return True

    return False


def get_valid_driving_route(
    points: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """Return an OSRM driving route only when every leg is road-driveable."""
    if len(points) < 2:
        return None

    coordinates = ";".join(
        f"{point['longitude']},{point['latitude']}"
        for point in points
    )

    try:
        data = _request_json(
            f"{OSRM_URL}{coordinates}",
            params={
                "overview": "full",
                "geometries": "geojson",
                "steps": "true",
            },
        )
    except requests.RequestException as error:
        print(f"[OSRM ROUTE ERROR] {type(error).__name__}: {error}", flush=True)
        return None

    if data.get("code") and data.get("code") != "Ok":
        print(f"[OSRM ROUTE REJECTED] code={data.get('code')}", flush=True)
        return None

    routes = data.get("routes", [])

    if not routes:
        return None

    route = routes[0]

    if route_has_non_road_step(route):
        print("[OSRM ROUTE REJECTED] non-road or ferry segment detected", flush=True)
        return None

    return {
        "distance_m": float(route.get("distance", 0)),
        "duration_s": float(route.get("duration", 0)),
        "geometry": route.get("geometry", {}),
        "legs": route.get("legs", []),
    }


def select_road_reachable_attractions(
    start: dict[str, Any],
    selected: list[dict[str, Any]],
    candidates: list[dict[str, Any]],
    end: dict[str, Any],
    max_stops: int,
) -> list[dict[str, Any]]:
    """Keep stops only when OSRM can route Start -> stops -> End by road."""
    chosen: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    pool = [*selected, *candidates[:12]]

    for candidate in pool:
        if len(chosen) >= max_stops:
            break

        name_key = normalise_name_key(candidate.get("name", ""))

        if not name_key or name_key in seen_names:
            continue

        if candidate.get("latitude") is None or candidate.get("longitude") is None:
            continue

        trial_route = get_valid_driving_route([start, *chosen, candidate, end])

        if trial_route:
            chosen.append(candidate)
            seen_names.add(name_key)
        else:
            print(
                f"[ROUTE CANDIDATE SKIPPED] {candidate.get('name', 'Unnamed stop')} is not road reachable in this itinerary.",
                flush=True,
            )

    return chosen


def is_rainy(weather: dict[str, Any] | None) -> bool:
    if not weather:
        return False

    return (
        (weather.get("rain_probability") or 0) >= 50
        or (weather.get("weather_code") or 0) >= 51
    )


def score_attraction(
    attraction: dict[str, Any],
    interests: list[str],
    weather: dict[str, Any] | None
) -> tuple[int, list[str]]:
    tags = {tag.lower() for tag in attraction.get("tags", [])}
    requested = {item.lower() for item in interests}
    reasons: list[str] = []
    score = 0

    matched = tags.intersection(requested)

    if matched:
        score += 40 + 10 * len(matched)
        reasons.append(f"matches interest: {', '.join(sorted(matched))}")

    rating = float(attraction.get("rating") or 0)
    score += int(rating * 5)

    if rating:
        reasons.append(f"rating {rating:.1f}")

    if is_rainy(weather):
        if "indoor" in tags:
            score += 25
            reasons.append("indoor option for rainy weather")

        if "outdoor" in tags:
            score -= 20
            reasons.append("outdoor option penalised because rain is likely")

    route_extra_km = attraction.get("route_extra_km")

    if route_extra_km is not None:
        if route_extra_km <= 2:
            score += 20
            reasons.append("near selected route")
        elif route_extra_km <= 5:
            score += 10
            reasons.append("reasonably close to route")
        else:
            score -= 10
            reasons.append("less close to route")

    return score, reasons


def choose_attractions(
    candidates: list[dict[str, Any]],
    interests: list[str],
    weather: dict[str, Any] | None,
    minimum_rating: float,
    max_stops: int
) -> list[dict[str, Any]]:
    max_stops = max(1, min(int(max_stops), 6))
    ranked: list[dict[str, Any]] = []

    requested_interests = {
        str(interest).lower().strip()
        for interest in interests
        if str(interest).strip()
    }

    for attraction in candidates:
        rating = float(attraction.get("rating") or 0)

        if rating < minimum_rating:
            continue

        score, reasons = score_attraction(attraction, interests, weather)

        tags = {
            str(tag).lower().strip()
            for tag in attraction.get("tags", [])
            if str(tag).strip()
        }

        matched_interests = attraction.get("matched_interests")

        if not matched_interests:
            matched_interests = sorted(tags.intersection(requested_interests))

        item = dict(attraction)
        item["score"] = score
        item["reasons"] = reasons
        item["matched_interests"] = matched_interests
        item["interest_match_count"] = len(matched_interests)

        ranked.append(item)

    ranked.sort(
        key=lambda item: (
            item.get("interest_match_count", 0),
            item.get("score", 0),
            item.get("rating", 0),
        ),
        reverse=True
    )

    return ranked[:max_stops]


def human_duration(seconds: float | int | None) -> str:
    if seconds is None:
        return "Not available"

    minutes = max(1, round(float(seconds) / 60))
    hours, remainder = divmod(minutes, 60)

    return f"{hours} hr {remainder} min" if hours else f"{remainder} min"


DISPLAY_LOCATION_MAX_LENGTH = 40


def truncate_display_text(value: Any, max_length: int) -> str:
    text = " ".join(str(value or "").split()).strip()

    if len(text) <= max_length:
        return text

    return text[: max(1, max_length - 3)].rstrip() + "..."


def get_short_location_name(value: Any, max_length: int = DISPLAY_LOCATION_MAX_LENGTH) -> str:
    """Return a concise UI label without changing the stored full address.

    Examples:
    - 'Kajang Municipal Council, Hulu Langat, Selangor, Malaysia'
      -> 'Kajang Municipal Council'
    - 'Cheras, Jalan Jelawat 1, ...' -> 'Cheras'

    The original full start/end text is still kept in start_text/end_text for
    Firestore and routing.
    """
    text = " ".join(str(value or "").split()).strip()

    if not text:
        return ""

    if text.lower() == "current location":
        return "Current Location"

    parts = [part.strip() for part in text.split(",") if part.strip()]
    short_name = parts[0] if parts else text

    # If the first address segment is only a house/building number, keep the
    # following segment too so the label remains meaningful.
    if short_name.replace(" ", "").isdigit() and len(parts) > 1:
        short_name = f"{short_name}, {parts[1]}"

    return truncate_display_text(short_name, max_length)


def assign_visit_duration_by_available_hours(
    selected: list[dict[str, Any]],
    route: dict[str, Any] | None,
    available_hours: int
) -> list[dict[str, Any]]:
    if not selected:
        return selected

    available_minutes = int(available_hours) * 60
    travel_minutes = round(float((route or {}).get("duration_s", 0)) / 60)

    remaining_visit_minutes = available_minutes - travel_minutes
    minimum_total_visit_minutes = 30 * len(selected)

    if remaining_visit_minutes < minimum_total_visit_minutes:
        remaining_visit_minutes = minimum_total_visit_minutes

    visit_minutes_each = max(30, round(remaining_visit_minutes / len(selected)))

    updated_selected = []

    for attraction in selected:
        item = dict(attraction)
        item["estimated_minutes"] = visit_minutes_each
        updated_selected.append(item)

    return updated_selected


def get_itinerary_duration_seconds(
    route: dict[str, Any] | None,
    selected: list[dict[str, Any]]
) -> float:
    travel_seconds = float((route or {}).get("duration_s", 0))
    visit_seconds = sum(
        int(attraction.get("estimated_minutes", 90)) * 60
        for attraction in selected
    )

    return travel_seconds + visit_seconds

def is_browser_current_location(place: dict[str, Any] | None) -> bool:
    if not place:
        return False

    source = str(place.get("source", "")).lower()
    display_name = str(place.get("display_name", "")).lower()
    name = str(place.get("name", "")).lower()

    if place.get("route_start_snapped"):
        return False

    return (
        source == "browser gps"
        or display_name == "current location"
        or name == "current location"
    )


def is_current_location_point(place: dict[str, Any] | None) -> bool:
    if not place:
        return False

    source = str(place.get("source", "")).lower()
    display_name = str(place.get("display_name", "")).lower()
    name = str(place.get("name", "")).lower()

    return (
        source == "browser gps"
        or display_name == "current location"
        or name == "current location"
    )


def build_coordinate_text(place: dict[str, Any] | None) -> str:
    if not place:
        return ""

    latitude = place.get("latitude")
    longitude = place.get("longitude")

    if latitude is None or longitude is None:
        return ""

    try:
        return f"{float(latitude):.7f},{float(longitude):.7f}"
    except (TypeError, ValueError):
        return ""


def get_google_maps_place_id(place: dict[str, Any] | None) -> str:
    if not place:
        return ""

    return str(place.get("google_place_id") or "").strip()


def build_google_maps_place_text(place: dict[str, Any] | None) -> str:
    if not place:
        return ""

    for key in ("name", "resolved_name", "display_name"):
        text = " ".join(str(place.get(key) or "").split()).strip()

        if text:
            return text

    return ""


def build_google_maps_point_text(place: dict[str, Any] | None) -> str:
    if not place:
        return ""

    if is_current_location_point(place):
        return build_coordinate_text(place)

    place_id = get_google_maps_place_id(place)
    place_text = build_google_maps_place_text(place)

    if place_id and place_text:
        return place_text

    return build_coordinate_text(place)


def build_google_maps_route_url(
    origin: dict[str, Any] | None,
    destination: dict[str, Any] | None,
    waypoints: list[dict[str, Any]] | None = None,
    *,
    force_origin_coordinates: bool = False,
) -> str:
    destination_text = build_google_maps_point_text(destination)

    if not destination_text:
        return ""

    params = [
        ("api", "1"),
    ]

    force_origin_to_coordinates = (
        force_origin_coordinates
        and is_current_location_point(origin)
    )

    origin_text = (
        build_coordinate_text(origin)
        if force_origin_to_coordinates
        else build_google_maps_point_text(origin)
    )

    if origin_text:
        params.append(("origin", origin_text))

        origin_place_id = (
            ""
            if force_origin_to_coordinates or is_current_location_point(origin)
            else get_google_maps_place_id(origin)
        )

        if origin_place_id:
            params.append(("origin_place_id", origin_place_id))

    params.append(("destination", destination_text))

    destination_place_id = get_google_maps_place_id(destination)

    if destination_place_id and not is_current_location_point(destination):
        params.append(("destination_place_id", destination_place_id))

    waypoint_points = [
        point
        for point in (waypoints or [])
        if build_google_maps_point_text(point)
    ]

    waypoint_texts = [
        build_google_maps_point_text(point)
        for point in waypoint_points
    ]
    waypoint_texts = [text for text in waypoint_texts if text]

    if waypoint_texts:
        params.append(("waypoints", "|".join(waypoint_texts)))

        waypoint_place_ids = [
            get_google_maps_place_id(point)
            for point in waypoint_points
            if get_google_maps_place_id(point) and not is_current_location_point(point)
        ]

        if len(waypoint_place_ids) == len(waypoint_texts):
            params.append(("waypoint_place_ids", "|".join(waypoint_place_ids)))

    params.append(("travelmode", "driving"))

    return "https://www.google.com/maps/dir/?" + "&".join(
        f"{key}={quote_plus(value)}"
        for key, value in params
    )


def build_google_maps_full_route_url(
    start: dict[str, Any],
    selected: list[dict[str, Any]],
    end: dict[str, Any],
) -> str:
    # The full-route link must mirror the final OSRM/Leaflet route points.
    return build_google_maps_route_url(
        start,
        end,
        waypoints=selected,
        force_origin_coordinates=True,
    )


DEFAULT_ATTRACTION_IMAGES: dict[str, list[str]] = {
    "culture": [
        "https://images.unsplash.com/photo-1512453979798-5ea266f8880c?auto=format&fit=crop&w=900&q=80",
        "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=900&q=80",
        "https://images.unsplash.com/photo-1494526585095-c41746248156?auto=format&fit=crop&w=900&q=80",
    ],
    "museum": [
        "https://images.unsplash.com/photo-1534452203293-494d7ddbf7e0?auto=format&fit=crop&w=900&q=80",
        "https://images.unsplash.com/photo-1519677100203-a0e668c92439?auto=format&fit=crop&w=900&q=80",
        "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=900&q=80",
    ],
    "nature": [
        "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=900&q=80",
        "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=900&q=80",
        "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=900&q=80",
    ],
    "shopping": [
        "https://images.unsplash.com/photo-1495121605193-b116b5b9c5d8?auto=format&fit=crop&w=900&q=80",
        "https://images.unsplash.com/photo-1470337458703-46ad1756a187?auto=format&fit=crop&w=900&q=80",
        "https://images.unsplash.com/photo-1533196350647-8cef3c2d9f85?auto=format&fit=crop&w=900&q=80",
    ],
    "food": [
        "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=900&q=80",
        "https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?auto=format&fit=crop&w=900&q=80",
        "https://images.unsplash.com/photo-1528716321682-0a570e4cc34e?auto=format&fit=crop&w=900&q=80",
    ],
    "adventure": [
        "https://images.unsplash.com/photo-1493558103817-58b2924bce98?auto=format&fit=crop&w=900&q=80",
        "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=900&q=80",
        "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=900&q=80",
    ],
    "beach": [
        "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=900&q=80",
        "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=900&q=80",
        "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=900&q=80",
    ],
    "heritage": [
        "https://images.unsplash.com/photo-1526481280694-3df0480fd2f7?auto=format&fit=crop&w=900&q=80",
        "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=900&q=80",
        "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=900&q=80",
    ],
}


def get_attraction_images(tags: list[str]) -> list[str]:
    images: list[str] = []
    for tag in tags:
        key = tag.lower()
        if key in DEFAULT_ATTRACTION_IMAGES:
            images.extend(DEFAULT_ATTRACTION_IMAGES[key])
    if not images:
        images = [item for sublist in DEFAULT_ATTRACTION_IMAGES.values() for item in sublist][:3]
    return images[:3]


def prepare_selected_attractions(
    selected: list[dict[str, Any]],
    reference_lat: float | None = None,
    reference_lon: float | None = None,
) -> list[dict[str, Any]]:
    prepared = []

    for index, attraction in enumerate(selected, start=1):
        item = dict(attraction)

        item["id"] = item.get("id", index)
        item["category"] = infer_attraction_category(item)
        item["location"] = item.get("location") or "Malaysia"
        item["weather_suitability"] = (
            "Indoor"
            if "indoor" in [tag.lower() for tag in item.get("tags", [])]
            else "Sunny"
        )
        
        item["photo_urls"] = item.get("photo_urls") or get_attraction_images([tag.lower() for tag in item.get("tags", [])])
        item["image_url"] = item.get("image_url") or item["photo_urls"][0]

        about_fields = build_place_about_fields(item)
        item["about_text"] = item.get("about_text") or about_fields["about_text"]
        item["about_heading"] = item.get("about_heading") or about_fields["about_heading"]
        item["place_highlights"] = item.get("place_highlights") or about_fields["place_highlights"]

        item["description"] = item.get(
            "description",
            f"{item['name']} is a popular {item['category'].lower()} destination in Malaysia with excellent visitor facilities.",
        )
        item["hours"] = item.get("hours") or "09:00 - 18:00"
        item["entry_fee"] = item.get("entry_fee") or "Free"
        item["visitor_tips"] = item.get(
            "visitor_tips",
            [
                "Arrive early to avoid the busiest periods.",
                "Wear comfortable shoes and bring water.",
                "Check opening hours before you travel.",
            ],
        )
        item["interest_tags"] = [tag.title() for tag in item.get("tags", [])]
        item["reason_tags"] = [tag for tag in item.get("reasons", [])]
        item["rating"] = float(item.get("rating") or 0)
        item["estimated_minutes"] = int(item.get("estimated_minutes", 90))
        item["distance_km"] = None
        item["distance_label"] = ""

        if (
            reference_lat is not None
            and reference_lon is not None
            and item.get("latitude") is not None
            and item.get("longitude") is not None
        ):
            item["distance_km"] = calculate_distance_km(
                float(reference_lat),
                float(reference_lon),
                float(item["latitude"]),
                float(item["longitude"]),
            )
            item["distance_label"] = f"{item['distance_km']:.1f} km"

        prepared.append(item)

    return prepared


def infer_attraction_category(attraction: dict[str, Any]) -> str:
    direct_category = str(
        attraction.get("category")
        or attraction.get("type")
        or attraction.get("place_type")
        or ""
    ).strip()

    if direct_category:
        return direct_category

    tags = [
        str(tag).strip()
        for tag in attraction.get("tags", [])
        if str(tag).strip()
    ]

    if tags:
        return ", ".join(tags[:2]).title()

    text = " ".join(
        [
            str(attraction.get("name", "")),
            str(attraction.get("description", "")),
            str(attraction.get("address", "")),
        ]
    ).lower()

    category_keywords = {
        "Museum": ["museum", "gallery", "exhibition"],
        "Nature": ["park", "garden", "forest", "waterfall", "lake", "trail"],
        "Shopping": ["mall", "market", "shopping", "bazaar", "plaza"],
        "Food": ["restaurant", "cafe", "food", "hawker"],
        "Religious Site": ["temple", "mosque", "church", "shrine"],
        "Landmark": ["tower", "square", "monument", "palace", "caves"],
    }

    for category, keywords in category_keywords.items():
        if any(keyword in text for keyword in keywords):
            return category

    return "Attraction"


def build_timetable(
    start_datetime: datetime,
    start_name: str,
    selected: list[dict[str, Any]],
    end_name: str,
    route: dict[str, Any] | None,
    transport_option: dict[str, Any],
    start_place: dict[str, Any] | None = None,
    end_place: dict[str, Any] | None = None,
) -> list[dict[str, str]]:
    timetable: list[dict[str, str]] = []
    current_time = start_datetime
    legs = route.get("legs", []) if route else []

    transport_label = transport_option["label"]
    transport_icon = transport_option["icon"]
    previous_stop_name = start_name
    previous_stop_place = start_place
    start_location_note = ""
    start_action_label = "Start at"

    if start_place and start_place.get("route_start_snapped"):
        start_action_label = "Start near"
        start_location_note = "Selected from Current Location"

    elif start_place and is_browser_current_location(start_place):
        start_resolved_name = str(start_place.get("resolved_name") or "").strip()

        if start_resolved_name:
            start_location_note = f"Near {start_resolved_name}"

    timetable.append(
        {
            "time": current_time.strftime("%H:%M"),
            "arrival_time": current_time.strftime("%I:%M %p"),
            "departure_time": "",
            "name": f"{start_action_label} {start_name}",
            "activity": f"{start_action_label} {start_name}",
            "duration": "Start point",
            "transport": transport_label,
            "transport_icon": transport_icon,
            "google_maps_url": "",
            "google_maps_label": "",
            "route_leg_from": "",
            "route_leg_to": "",
            "location_note": start_location_note,
        }
    )

    for index, attraction in enumerate(selected):
        leg_seconds = legs[index].get("duration") if index < len(legs) else 0
        current_time += timedelta(seconds=float(leg_seconds or 0))

        arrival_time = current_time
        visit_minutes = int(attraction.get("estimated_minutes", 90))

        current_time += timedelta(minutes=visit_minutes)
        departure_time = current_time

        google_maps_url = build_google_maps_route_url(
            previous_stop_place,
            attraction,
        )

        timetable.append(
            {
                "time": arrival_time.strftime("%H:%M"),
                "arrival_time": arrival_time.strftime("%I:%M %p"),
                "departure_time": departure_time.strftime("%I:%M %p"),
                "name": attraction["name"],
                "activity": attraction["name"],
                "duration": f"{visit_minutes} mins",
                "transport": f"{transport_label} · {human_duration(leg_seconds)}",
                "transport_icon": transport_icon,
                "google_maps_url": google_maps_url,
                "google_maps_label": f"Google Maps: {previous_stop_name} → {attraction['name']}",
                "route_leg_from": previous_stop_name,
                "route_leg_to": attraction["name"],
            }
        )

        previous_stop_name = attraction["name"]
        previous_stop_place = attraction

    final_leg_index = len(selected)

    if final_leg_index < len(legs):
        final_leg_seconds = legs[final_leg_index].get("duration")
    else:
        final_leg_seconds = 0

    current_time += timedelta(seconds=float(final_leg_seconds or 0))

    final_google_maps_url = ""

    if end_place:
        final_google_maps_url = build_google_maps_route_url(
            previous_stop_place,
            end_place,
        )

    end_arrival_label = "Arrive at"

    if (
        end_place
        and end_place.get("is_approximate")
        and end_place.get("location_source") == "serpapi"
    ):
        end_arrival_label = "Arrive near"

    timetable.append(
        {
            "time": current_time.strftime("%H:%M"),
            "arrival_time": current_time.strftime("%I:%M %p"),
            "departure_time": "",
            "name": f"{end_arrival_label} {end_name}",
            "activity": f"{end_arrival_label} {end_name}",
            "duration": "End point",
            "transport": f"{transport_label} · {human_duration(final_leg_seconds)}",
            "transport_icon": transport_icon,
            "google_maps_url": final_google_maps_url,
            "google_maps_label": f"Google Maps: {previous_stop_name} → {end_name}",
            "route_leg_from": previous_stop_name,
            "route_leg_to": end_name,
        }
    )

    return timetable


def make_plan(form: dict[str, Any]) -> dict[str, Any]:
    start_text = str(form.get("start", "")).strip()
    end_text = str(form.get("end", "")).strip()
    trip_date = str(form.get("trip_date", "")).strip()
    start_time = str(form.get("start_time", "09:00")).strip()

    use_current_location = parse_bool(form.get("use_current_location", "0"))
    start_latitude = parse_float(form.get("start_latitude"))
    start_longitude = parse_float(form.get("start_longitude"))

    if not start_text and not use_current_location:
        raise ValueError("Start location is required.")

    if use_current_location and (start_latitude is None or start_longitude is None):
        raise ValueError("Could not use current location. Please allow GPS permission or type a start location manually.")

    if not end_text:
        raise ValueError("End location is required.")

    if not trip_date:
        raise ValueError("Travel date is required.")

    raw_interests = form.getlist("interests") if hasattr(form, "getlist") else form.get("interests", [])  # type: ignore

    if isinstance(raw_interests, str):
        interests = [raw_interests] if raw_interests else []
    else:
        interests = [interest for interest in raw_interests if interest]

    print(f"[SELECTED INTERESTS] {interests}", flush=True)

    available_hours = int(form.get("available_hours", 6))
    minimum_rating = float(form.get("minimum_rating", 4.0))

    stop_limit = get_stop_limit_by_available_hours(available_hours)
    requested_max_stops = int(form.get("max_stops", stop_limit))
    max_stops = max(1, min(requested_max_stops, stop_limit))

    excluded_stop_names = parse_excluded_stop_names(form)
    selected_favourites = parse_selected_favourites(form)
    selected_favourites = remove_excluded_candidates(
        selected_favourites,
        excluded_stop_names
    )
    selected_favourites = selected_favourites[:max_stops]
    remaining_stop_slots = max(0, max_stops - len(selected_favourites))
    regenerate_token = str(form.get("regenerate_token", "")).strip()

    transport_option = DRIVING_OPTION

    if use_current_location:
        start_text = "Current Location"
        start = add_current_location_display_metadata(
            {
                "display_name": "Current Location",
                "latitude": float(start_latitude),
                "longitude": float(start_longitude),
                "source": "Browser GPS",
            }
        )
    else:
        start = geocode_place(start_text)
        time.sleep(1.05)

    end = geocode_place(end_text)

    if not start or not end:
        raise ValueError(
            "Could not find the start or end location. "
            "Try a more specific Malaysian place name."
        )

    ensure_malaysian_place(start)
    ensure_malaysian_place(end)

    if not get_valid_driving_route([start, end]):
        raise ValueError(ROAD_ROUTE_UNAVAILABLE_MESSAGE)

    start_datetime = datetime.fromisoformat(f"{trip_date}T{start_time}")

    weather = get_weather(
        end["latitude"],
        end["longitude"],
        trip_date
    )

    live_candidates = search_attractions_serpapi(
        end["latitude"],
        end["longitude"],
        interests,
        minimum_rating
    )

    demo_candidates = load_demo_attractions()

    if live_candidates:
        candidates = live_candidates + demo_candidates
    else:
        candidates = demo_candidates

    route_relevant_candidates = filter_route_relevant_candidates(
        candidates,
        start,
        end
    )

    if route_relevant_candidates:
        candidates = route_relevant_candidates
    else:
        candidates = [
            candidate
            for candidate in candidates
            if not is_bad_candidate_name(candidate.get("name", ""))
        ]

    favourite_names = {
        normalise_name_key(favourite.get("name", ""))
        for favourite in selected_favourites
    }

    candidates = remove_excluded_candidates(
        candidates,
        excluded_stop_names.union(favourite_names)
    )

    candidates = rotate_candidates_for_regenerate(
        candidates,
        regenerate_token
    )

    recommended_selected: list[dict[str, Any]] = []

    if remaining_stop_slots > 0:
        recommended_selected = choose_attractions(
            candidates,
            interests,
            weather,
            minimum_rating,
            remaining_stop_slots
        )

    selected = selected_favourites + recommended_selected
    selected = prepare_selected_attractions(selected)
    backfill_candidates = prepare_selected_attractions(candidates)
    selected = select_road_reachable_attractions(
        start,
        selected,
        backfill_candidates,
        end,
        max_stops,
    )

    print(
        "[ROUTE ORDER BEFORE] "
        + " -> ".join(place.get("name", "Stop") for place in selected),
        flush=True,
    )

    selected = optimise_stop_order_by_road(
        start,
        selected,
        end,
    )

    print(
        "[ROUTE ORDER AFTER] "
        + " -> ".join(place.get("name", "Stop") for place in selected),
        flush=True,
    )

    route_points = [start] + selected + [end]
    route = get_valid_driving_route(route_points)

    if not route:
        raise ValueError(ROAD_ROUTE_UNAVAILABLE_MESSAGE)

    selected = assign_visit_duration_by_available_hours(
        selected,
        route,
        available_hours
    )


    # Keep full start_text/end_text for routing + saving, but use concise
    # labels in the generated timetable and UI.
    start_display_source = start_text

    if start.get("route_start_snapped"):
        start_display_source = (
            start.get("resolved_name")
            or start.get("nearby_name")
            or start_text
        )

    start_display_text = get_short_location_name(start_display_source) or "Start Location"
    end_display_source = end_text

    if end.get("is_approximate") and end.get("location_source") == "serpapi":
        end_display_source = (
            end.get("resolved_name")
            or end.get("display_name")
            or end_text
        )

    end_display_text = get_short_location_name(end_display_source) or "End Location"

    timetable = build_timetable(
        start_datetime,
        start_display_text,
        selected,
        end_display_text,
        route,
        transport_option,
        start_place=start,
        end_place=end,
    )

    travel_duration = (
        human_duration(route.get("duration_s"))
        if route
        else "Not available"
    )

    total_distance_km = round(float(route.get("distance_m", 0)) / 1000, 1) if route else 0
    google_maps_full_route_url = build_google_maps_full_route_url(start, selected, end)

    itinerary_duration_seconds = get_itinerary_duration_seconds(route, selected)
    itinerary_duration = human_duration(itinerary_duration_seconds)

    total_duration = itinerary_duration

    return {
        "id": int(datetime.now().timestamp()),
        "title": f"{end_display_text} Trip",
        "destination": end_text,
        "date": format_date_for_display(trip_date),
        "duration": f"{available_hours} hrs",
        "stop_count": len(selected),
        "status": "Draft",
        "is_public": False,

        "start": start,
        "end": end,
        "start_text": start_text,
        "end_text": end_text,
        "start_display_text": start_display_text,
        "end_display_text": end_display_text,
        "trip_date": trip_date,
        "start_time": start_time,
        "use_current_location": use_current_location,
        "start_latitude": start.get("latitude"),
        "start_longitude": start.get("longitude"),
        "available_hours": available_hours,
        "max_stops": max_stops,
        "requested_max_stops": requested_max_stops,
        "stop_limit": stop_limit,
        "actual_stop_count": len(selected),
        "stop_limit_message": "",
        "interests": interests,
        "selected_favourites_count": len(selected_favourites),
        "excluded_stop_names": list(excluded_stop_names),

        "weather": weather,
        "weather_icon": "🌧️" if is_rainy(weather) else "☀️",
        "weather_temp": (
            f"{weather.get('min_temp')}°C - {weather.get('max_temp')}°C"
            if weather
            else "Not available"
        ),

        "selected": selected,
        "route": route,
        "timetable": timetable,


        "total_distance_km": total_distance_km,
        "google_maps_full_route_url": google_maps_full_route_url,
        "total_duration": total_duration,
        "travel_duration": travel_duration,
        "itinerary_duration": itinerary_duration,
        "exceeds_hours": False,
        "image_url": "https://images.unsplash.com/photo-1596422846543-75c6fc197f07?w=400&h=200&fit=crop&auto=format",
    }


def build_map_data(plan: dict[str, Any] | None) -> dict[str, Any] | None:
    if not plan:
        return None

    route = plan.get("route") or {}

    return {
        "start": plan.get("start"),
        "end": plan.get("end"),
        "attractions": plan.get("selected", []),
        "routeGeometry": route.get("geometry"),
        # Full values are preserved for saving/routing. Display values are
        # concise labels used only by the UI.
        "startText": plan.get("start_text", "Start"),
        "endText": plan.get("end_text", "End"),
        "startDisplayText": plan.get("start_display_text") or get_short_location_name(plan.get("start_text", "Start")),
        "endDisplayText": plan.get("end_display_text") or get_short_location_name(plan.get("end_text", "End")),
        "googleMapsFullRouteUrl": plan.get("google_maps_full_route_url", "")
    }


def format_date_for_display(date_text: str) -> str:
    try:
        dt = datetime.strptime(date_text, "%Y-%m-%d")
        return dt.strftime("%b %d, %Y")
    except ValueError:
        return date_text
