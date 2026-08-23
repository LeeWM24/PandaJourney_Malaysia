from __future__ import annotations

import json
import math
import os
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus

import requests
from dotenv import load_dotenv


NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OSRM_URL = "https://router.project-osrm.org/route/v1/driving/"
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


def get_default_itinerary_form():
    return {
        "start": "",
        "end": "",
        "trip_date": "",
        "start_time": "09:00",
        "available_hours": 6,
        "max_stops": 3,
        "minimum_rating": "4.0",
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


TRANSPORT_OPTIONS = {
    "driving": {
        "label": "Driving",
        "icon": "🚗",
        "speed_mps": None,
    },
    "walking": {
        "label": "Walking",
        "icon": "🚶",
        "speed_mps": 1.4,
    },
    "cycling": {
        "label": "Cycling",
        "icon": "🚲",
        "speed_mps": 4.2,
    },
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


def get_transport_option(transport_mode: str | None) -> dict[str, Any]:
    transport_mode = str(transport_mode or "driving").lower()

    if transport_mode not in TRANSPORT_OPTIONS:
        transport_mode = "driving"

    return TRANSPORT_OPTIONS[transport_mode]


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


def get_serpapi_search_keyword(interests: list[str]) -> str:
    """Return more suitable Google Maps search keyword based on interest."""
    interest = interests[0].lower() if interests else "attraction"

    keyword_map = {
        "food": "restaurants cafe food court",
        "shopping": "shopping mall",
        "culture": "cultural attractions",
        "museum": "museum",
        "nature": "parks nature attractions",
    }

    return keyword_map.get(interest, f"{interest} attractions")


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

        title = item.get("title", query)
        address = item.get("address", "")

        result = {
            "display_name": f"{title}, {address}".strip(", "),
            "latitude": float(coordinates["latitude"]),
            "longitude": float(coordinates["longitude"]),
            "source": "SerpApi fallback",
        }

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

            result = {
                "display_name": raw.get("display_name", query),
                "latitude": float(raw["lat"]),
                "longitude": float(raw["lon"]),
                "source": "OpenStreetMap Nominatim API",
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
            "source": "Local demo fallback",
        }

        GEOCODE_CACHE[key] = result

        print(f"[GEOCODE DEMO] {query}", flush=True)
        return result

    GEOCODE_CACHE[key] = None
    return None


def get_weather(latitude: float, longitude: float, trip_date: str) -> dict[str, Any] | None:
    try:
        data = _request_json(
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
        )

        daily = data.get("daily", {})

        if not daily.get("time"):
            return None

        weather_code = daily["weather_code"][0]

        return {
            "date": daily["time"][0],
            "weather_code": weather_code,
            "condition": WEATHER_LABELS.get(weather_code, f"WMO code {weather_code}"),
            "max_temp": daily.get("temperature_2m_max", [None])[0],
            "min_temp": daily.get("temperature_2m_min", [None])[0],
            "precipitation_mm": daily.get("precipitation_sum", [None])[0],
            "rain_probability": daily.get("precipitation_probability_max", [None])[0],
        }

    except (requests.RequestException, KeyError, IndexError, TypeError):
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
        return []

    keyword = get_serpapi_search_keyword(interests)

    try:
        data = _request_json(
            SERPAPI_URL,
            params={
                "engine": "google_maps",
                "type": "search",
                "q": keyword,
                "ll": f"@{latitude},{longitude},13z",
                "min_rating": str(minimum_rating),
                "hl": "en",
                "gl": "my",
                "api_key": api_key,
            },
        )

    except requests.RequestException:
        return []

    candidates = []

    for item in data.get("local_results", [])[:12]:
        coordinates = item.get("gps_coordinates") or {}

        if "latitude" not in coordinates or "longitude" not in coordinates:
            continue

        title = item.get("title", "Unnamed attraction")
        item_type = str(item.get("type", "")).lower()
        description = str(item.get("description", "")).lower()

        if is_bad_candidate_name(title):
            continue

        text = f"{title} {item_type} {description}".lower()

        tags = [
            interest
            for interest in interests
            if interest.lower() in text
        ]

        if interests and not tags:
            tags = [interests[0]]

        candidates.append(
            {
                "name": title,
                "latitude": float(coordinates["latitude"]),
                "longitude": float(coordinates["longitude"]),
                "tags": tags or [keyword],
                "estimated_minutes": 90,
                "rating": float(item.get("rating") or 0),
                "source": "SerpApi",
            }
        )

    return candidates


def get_route_with_stops(
    points: list[dict[str, Any]],
    transport_mode: str = "driving"
) -> dict[str, Any] | None:
    if len(points) < 2:
        return None

    transport_option = get_transport_option(transport_mode)

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
                "steps": "false"
            },
        )

        routes = data.get("routes", [])

        if not routes:
            return None

        route = routes[0]
        distance_m = float(route.get("distance", 0))
        duration_s = float(route.get("duration", 0))
        legs = route.get("legs", [])

        if transport_mode != "driving":
            speed_mps = transport_option.get("speed_mps")

            if speed_mps:
                duration_s = distance_m / float(speed_mps)
                adjusted_legs = []

                for leg in legs:
                    new_leg = dict(leg)
                    leg_distance = float(new_leg.get("distance", 0))
                    new_leg["duration"] = leg_distance / float(speed_mps)
                    adjusted_legs.append(new_leg)

                legs = adjusted_legs

        return {
            "distance_m": distance_m,
            "duration_s": duration_s,
            "geometry": route.get("geometry", {}),
            "legs": legs,
        }

    except requests.RequestException:
        return None


def get_serpapi_direction(
    start: str,
    end: str,
    travel_mode: str,
    depart_at: datetime
) -> dict[str, Any] | None:
    api_key = os.getenv("SERPAPI_KEY", "").strip()

    if not api_key:
        return None

    mode_value = "0" if travel_mode == "driving" else "3"

    params: dict[str, Any] = {
        "engine": "google_maps_directions",
        "start_addr": start,
        "end_addr": end,
        "travel_mode": mode_value,
        "distance_unit": "0",
        "hl": "en",
        "gl": "my",
        "api_key": api_key,
        "time": f"depart_at:{int(depart_at.timestamp())}",
    }

    if travel_mode == "transit":
        params["prefer"] = "bus"

    try:
        data = _request_json(SERPAPI_URL, params=params)
        direction = next(iter(data.get("directions", [])), None)

        if not direction:
            return None

        return {
            "mode": direction.get("travel_mode", travel_mode.title()),
            "duration_seconds": direction.get("duration"),
            "duration": direction.get("formatted_duration", "Not available"),
            "distance": direction.get("formatted_distance", "Not available"),
            "extensions": direction.get("extensions", []),
        }

    except requests.RequestException:
        return None


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
    available_minutes: int,
    minimum_rating: float,
    max_stops: int
) -> list[dict[str, Any]]:
    max_stops = max(1, min(int(max_stops), 6))
    ranked: list[dict[str, Any]] = []

    for attraction in candidates:
        rating = float(attraction.get("rating") or 0)

        if rating and rating < minimum_rating:
            continue

        score, reasons = score_attraction(attraction, interests, weather)

        item = dict(attraction)
        item["score"] = score
        item["reasons"] = reasons

        ranked.append(item)

    ranked.sort(key=lambda item: item["score"], reverse=True)

    return ranked[:max_stops]


def recommend_attractions(
    candidates: list[dict[str, Any]],
    interests: list[str],
    weather: dict[str, Any] | None,
    minimum_rating: float,
    max_results: int = 8,
    filter_partly_cloudy: bool = False,
) -> list[dict[str, Any]]:
    ranked: list[dict[str, Any]] = []

    for attraction in candidates:
        tags = {tag.lower() for tag in attraction.get("tags", [])}
        rating = float(attraction.get("rating") or 0)

        if rating and rating < minimum_rating:
            continue

        if (
            filter_partly_cloudy
            and weather
            and weather.get("condition", "").lower() == "partly cloudy"
            and "outdoor" in tags
        ):
            continue

        score, reasons = score_attraction(attraction, interests, weather)

        item = dict(attraction)
        item["score"] = score
        item["reasons"] = reasons
        item["rating"] = rating
        item["tags"] = list(tags)

        ranked.append(item)

    ranked.sort(key=lambda item: item["score"], reverse=True)
    return ranked[:max_results]


def human_duration(seconds: float | int | None) -> str:
    if seconds is None:
        return "Not available"

    minutes = max(1, round(float(seconds) / 60))
    hours, remainder = divmod(minutes, 60)

    return f"{hours} hr {remainder} min" if hours else f"{remainder} min"


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


def build_google_maps_route_url(
    origin: dict[str, Any] | None,
    destination: dict[str, Any] | None,
    waypoints: list[dict[str, Any]] | None = None,
) -> str:
    """Build a Google Maps directions URL with a fixed origin and destination.

    This is used because Google Maps URLs support origin, destination and
    waypoints, while Waze deep links mainly navigate to one destination from
    the driver's current location.
    """
    origin_text = build_coordinate_text(origin)
    destination_text = build_coordinate_text(destination)

    if not origin_text or not destination_text:
        return ""

    params = [
        ("api", "1"),
        ("origin", origin_text),
        ("destination", destination_text),
    ]

    waypoint_texts = [
        build_coordinate_text(point)
        for point in (waypoints or [])
    ]
    waypoint_texts = [text for text in waypoint_texts if text]

    if waypoint_texts:
        params.append(("waypoints", "|".join(waypoint_texts)))

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
    return build_google_maps_route_url(
        start,
        end,
        waypoints=selected,
    )


def compute_distance_km(
    lat1: float,
    lon1: float,
    lat2: float,
    lon2: float,
) -> float:
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(delta_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1 - a)))
    return 6371.0 * c


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
        item["category"] = (
            item.get("category")
            or ", ".join(item.get("tags", [])[:2]).title()
            or "Attraction"
        )
        item["location"] = item.get("location") or "Malaysia"
        item["weather_suitability"] = (
            "Indoor"
            if "indoor" in [tag.lower() for tag in item.get("tags", [])]
            else "Sunny"
        )
        
        item["photo_urls"] = item.get("photo_urls") or get_attraction_images([tag.lower() for tag in item.get("tags", [])])
        item["image_url"] = item.get("image_url") or item["photo_urls"][0]
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
            item["distance_km"] = compute_distance_km(
                float(reference_lat),
                float(reference_lon),
                float(item["latitude"]),
                float(item["longitude"]),
            )
            item["distance_label"] = f"{item['distance_km']:.1f} km"

        prepared.append(item)

    return prepared


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

    timetable.append(
        {
            "time": current_time.strftime("%H:%M"),
            "arrival_time": current_time.strftime("%I:%M %p"),
            "departure_time": "",
            "name": f"Start at {start_name}",
            "activity": f"Start at {start_name}",
            "duration": "Start point",
            "transport": transport_label,
            "transport_icon": transport_icon,
            "google_maps_url": "",
            "google_maps_label": "",
            "route_leg_from": "",
            "route_leg_to": "",
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

    timetable.append(
        {
            "time": current_time.strftime("%H:%M"),
            "arrival_time": current_time.strftime("%I:%M %p"),
            "departure_time": "",
            "name": f"Arrive at {end_name}",
            "activity": f"Arrive at {end_name}",
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

    transport_mode = "driving"
    transport_option = get_transport_option(transport_mode)

    if use_current_location:
        start_text = "Current Location"
        start = {
            "display_name": "Current Location",
            "latitude": float(start_latitude),
            "longitude": float(start_longitude),
            "source": "Browser GPS",
        }
    else:
        start = geocode_place(start_text)
        time.sleep(1.05)

    end = geocode_place(end_text)

    if not start or not end:
        raise ValueError(
            "Could not find the start or end location. "
            "Try a more specific Malaysian place name."
        )

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
        source_note = "Live SerpApi Google Maps search with local demo backup"
    else:
        candidates = demo_candidates
        source_note = "Local Kuala Lumpur demonstration dataset. Add SERPAPI_KEY for live attraction search."

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
            available_hours * 60,
            minimum_rating,
            remaining_stop_slots
        )

    if not recommended_selected and remaining_stop_slots > 0:
        recommended_selected = choose_attractions(
            candidates,
            interests,
            weather,
            available_hours * 60,
            0,
            remaining_stop_slots
        )

    selected = selected_favourites + recommended_selected
    selected = prepare_selected_attractions(selected)

    route_points = [start] + selected + [end]

    route = get_route_with_stops(route_points, transport_mode)

    selected = assign_visit_duration_by_available_hours(
        selected,
        route,
        available_hours
    )

    car_comparison = get_serpapi_direction(
        start_text,
        end_text,
        "driving",
        start_datetime
    )

    transit_comparison = get_serpapi_direction(
        start_text,
        end_text,
        "transit",
        start_datetime
    )

    if not car_comparison and route:
        car_comparison = {
            "mode": "Driving (OSRM estimate)",
            "duration_seconds": route.get("duration_s"),
            "duration": human_duration(route.get("duration_s")),
            "distance": f"{route.get('distance_m', 0) / 1000:.1f} km",
            "extensions": ["OpenStreetMap road-route estimate"],
        }

    timetable = build_timetable(
        start_datetime,
        start_text,
        selected,
        end_text,
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
        "title": f"{start_text} to {end_text} Trip",
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

        "car_comparison": car_comparison,
        "transit_comparison": transit_comparison,
        "attraction_source_note": source_note,

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
        "startText": plan.get("start_text", "Start"),
        "endText": plan.get("end_text", "End"),
        "googleMapsFullRouteUrl": plan.get("google_maps_full_route_url", "")
    }


def format_date_for_display(date_text: str) -> str:
    try:
        dt = datetime.strptime(date_text, "%Y-%m-%d")
        return dt.strftime("%b %d, %Y")
    except ValueError:
        return date_text