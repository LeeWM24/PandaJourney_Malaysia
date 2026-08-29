from __future__ import annotations

import json
import math
import os
import sqlite3
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus

import requests
from dotenv import load_dotenv


NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
SERPAPI_URL = "https://serpapi.com/search.json"

BASE_DIR = Path(__file__).resolve().parents[1]

load_dotenv(BASE_DIR / ".env")

# ---------------------------------------------------------------------------
# Persistent SQLite cache — cuts down repeat SerpAPI / geocoding usage.
# Geocode results barely change (long TTL); attraction search results are
# cached for a few hours since ratings/hours can drift slowly.
# ---------------------------------------------------------------------------

CACHE_DB_PATH = BASE_DIR / "data" / "cache.db"
GEOCODE_CACHE_TTL_SECONDS = 30 * 24 * 3600  # 30 days
ATTRACTION_CACHE_TTL_SECONDS = 6 * 3600      # 6 hours


def _init_cache_db() -> None:
    CACHE_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(CACHE_DB_PATH)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS api_cache (
            cache_key TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            created_at REAL NOT NULL
        )"""
    )
    conn.commit()
    conn.close()


_init_cache_db()


def cache_get(key: str, max_age_seconds: float) -> Any | None:
    try:
        conn = sqlite3.connect(CACHE_DB_PATH)
        row = conn.execute(
            "SELECT payload, created_at FROM api_cache WHERE cache_key = ?",
            (key,),
        ).fetchone()
        conn.close()
    except sqlite3.Error as error:
        print(f"[CACHE READ ERROR] {error}", flush=True)
        return None

    if not row:
        return None

    payload, created_at = row

    if time.time() - created_at > max_age_seconds:
        return None

    try:
        print(f"[CACHE HIT] {key}", flush=True)
        return json.loads(payload)
    except (json.JSONDecodeError, TypeError):
        return None


def cache_set(key: str, value: Any) -> None:
    try:
        conn = sqlite3.connect(CACHE_DB_PATH)
        conn.execute(
            "INSERT OR REPLACE INTO api_cache (cache_key, payload, created_at) VALUES (?, ?, ?)",
            (key, json.dumps(value), time.time()),
        )
        conn.commit()
        conn.close()
    except sqlite3.Error as error:
        print(f"[CACHE WRITE ERROR] {error}", flush=True)

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


def is_bad_candidate_name(name: str) -> bool:
    """Remove tour/package type result that is not suitable as a real attraction."""
    text = str(name or "").lower()

    return any(keyword in text for keyword in BAD_CANDIDATE_KEYWORDS)


def get_serpapi_search_keyword(interests: list[str]) -> str:
    """Return a more suitable Google Maps search keyword based on interest."""
    interest = interests[0].lower() if interests else "attraction"

    keyword_map = {
        "food": "restaurants cafe food court",
        "shopping": "shopping mall",
        "culture": "cultural attractions",
        "museum": "museum",
        "nature": "parks nature attractions",
    }

    return keyword_map.get(interest, f"{interest} attractions")


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
        print(f"[GEOCODE MEMORY CACHE] {query}", flush=True)
        return GEOCODE_CACHE[key]

    db_cached = cache_get(f"geocode:{key}", GEOCODE_CACHE_TTL_SECONDS)
    if db_cached is not None:
        GEOCODE_CACHE[key] = db_cached
        return db_cached

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
            cache_set(f"geocode:{key}", result)

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
        cache_set(f"geocode:{key}", serpapi_result)
        return serpapi_result

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


def get_current_weather_batch(
    coords: list[tuple[float, float]]
) -> list[dict[str, Any] | None]:
    """Fetch real-time weather for many coordinates in a single Open-Meteo
    request (it accepts comma-separated lat/lon lists), so we don't need
    one HTTP call per attraction card."""

    if not coords:
        return []

    try:
        data = _request_json(
            OPEN_METEO_URL,
            params={
                "latitude": ",".join(str(lat) for lat, _ in coords),
                "longitude": ",".join(str(lon) for _, lon in coords),
                "current": "temperature_2m,weather_code",
                "timezone": "Asia/Kuala_Lumpur",
            },
        )
    except requests.RequestException as error:
        print(f"[WEATHER BATCH ERROR] {error}", flush=True)
        return [None] * len(coords)

    # Open-Meteo returns a list of results when multiple locations are
    # requested, or a single object when only one location is requested.
    entries = data if isinstance(data, list) else [data]

    results: list[dict[str, Any] | None] = []

    for entry in entries:
        current = (entry or {}).get("current") or {}
        code = current.get("weather_code")

        if code is None:
            results.append(None)
            continue

        results.append(
            {
                "temp": current.get("temperature_2m"),
                "weather_code": code,
                "condition": WEATHER_LABELS.get(code, f"WMO code {code}"),
            }
        )

    # Defensive: pad/truncate in case the API returned an unexpected shape.
    if len(results) < len(coords):
        results.extend([None] * (len(coords) - len(results)))

    return results[: len(coords)]


def _serpapi_page(
    keyword: str,
    latitude: float,
    longitude: float,
    minimum_rating: float,
    api_key: str,
    start: int,
) -> list[dict[str, Any]]:
    """Fetch one page (~20 results) of Google Maps local results."""

    params = {
        "engine": "google_maps",
        "type": "search",
        "q": keyword,
        "ll": f"@{latitude},{longitude},13z",
        "min_rating": str(minimum_rating),
        "hl": "en",
        "gl": "my",
        "api_key": api_key,
    }

    if start:
        params["start"] = start

    try:
        data = _request_json(SERPAPI_URL, params=params)
    except requests.RequestException as error:
        print(f"[SERPAPI SEARCH ERROR] {error}", flush=True)
        return []

    if data.get("error"):
        print(f"[SERPAPI SEARCH ERROR] API responded: {data['error']}", flush=True)
        return []

    return data.get("local_results", [])


def search_attractions_serpapi(
    latitude: float,
    longitude: float,
    interests: list[str],
    minimum_rating: float,
    max_pages: int = 3,
) -> list[dict[str, Any]]:
    """Search Google Maps via SerpAPI, paginating up to `max_pages` pages
    (~20 results each) so results aren't hard-capped at 20. Results are
    cached in SQLite per (location, interests, min rating) so repeat
    searches for the same destination don't re-spend SerpAPI credits.

    NOTE on cost: every extra page is a separate billed SerpAPI request —
    3 pages = 3 credits per *uncached* search. The cache above is what
    keeps this affordable; pagination alone does not.
    """

    api_key = os.getenv("SERPAPI_KEY", "").strip()

    if not api_key:
        print("[SERPAPI SEARCH] No SERPAPI_KEY configured.", flush=True)
        return []

    keyword = get_serpapi_search_keyword(interests)

    cache_key = (
        f"attractions:{round(latitude, 3)}:{round(longitude, 3)}:"
        f"{keyword}:{minimum_rating}:{max_pages}"
    )
    cached = cache_get(cache_key, ATTRACTION_CACHE_TTL_SECONDS)
    if cached is not None:
        return cached

    print(
        f"[SERPAPI SEARCH] query={keyword!r} near ({latitude}, {longitude}) "
        f"min_rating={minimum_rating} max_pages={max_pages}",
        flush=True,
    )

    raw_results: list[dict[str, Any]] = []

    for page in range(max_pages):
        page_results = _serpapi_page(
            keyword, latitude, longitude, minimum_rating, api_key, start=page * 20
        )

        if not page_results:
            break  # no more pages / error — stop paginating

        raw_results.extend(page_results)

        if len(page_results) < 20:
            break  # short page = last page

    print(f"[SERPAPI SEARCH] {len(raw_results)} raw result(s) from Google Maps", flush=True)

    seen_place_ids: set[str] = set()
    candidates = []

    for item in raw_results:
        coordinates = item.get("gps_coordinates") or {}

        if "latitude" not in coordinates or "longitude" not in coordinates:
            continue

        title = item.get("title", "Unnamed attraction")
        item_type = str(item.get("type", "")).lower()
        raw_description = str(item.get("description", ""))
        description = raw_description.lower()

        if is_bad_candidate_name(title):
            continue

        place_id = item.get("place_id") or item.get("data_id") or ""

        if place_id and place_id in seen_place_ids:
            continue  # de-dupe across pages

        if place_id:
            seen_place_ids.add(place_id)

        text = f"{title} {item_type} {description}".lower()

        tags = [
            interest
            for interest in interests
            if interest.lower() in text
        ]

        if interests and not tags:
            tags = [interests[0]]

        # data from SerpApi
        thumbnail = item.get("thumbnail") or ""
        address = item.get("address") or ""
        hours = item.get("hours") or ""
        price = item.get("price") or ""

        candidates.append(
            {
                "name": title,
                "latitude": float(coordinates["latitude"]),
                "longitude": float(coordinates["longitude"]),
                "tags": tags or [keyword],
                "estimated_minutes": 90,
                "rating": float(item.get("rating") or 0),
                "source": "SerpApi (Google Maps)",
                "place_id": place_id,
                "category": item.get("type", "") or "",
                "location": address,
                "area": address,
                "description": raw_description,
                "hours": hours,
                "entry_fee": price,
                "photo_urls": [thumbnail] if thumbnail else [],
                "image_url": thumbnail,
                "maps_url": f"https://www.google.com/maps/place/?q=place_id:{place_id}" if place_id else "",
            }
        )

    print(f"[SERPAPI SEARCH] {len(candidates)} candidate(s) kept after filtering", flush=True)

    cache_set(cache_key, candidates)

    return candidates


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

    return score, reasons


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


def build_waze_url(place: dict[str, Any]) -> str:
    latitude = place.get("latitude")
    longitude = place.get("longitude")
    name = quote_plus(str(place.get("name") or place.get("display_name") or "Destination"))

    if latitude is None or longitude is None:
        return ""

    return f"https://waze.com/ul?q={name}&ll={latitude},{longitude}&navigate=yes"


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
        item["category"] = item.get("category") or ", ".join(item.get("tags", [])[:2]).title() or "Attraction"
        item["location"] = item.get("location") or item.get("source") or "Malaysia"
        item["area"] = item.get("area") or item["location"]
        item["waze_url"] = build_waze_url(item)
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

    # Real-time weather per attraction — one batched Open-Meteo call for
    # every card instead of a static "Sunny"/"Indoor" guess.
    coords: list[tuple[float, float]] = []
    coord_indexes: list[int] = []

    for idx, item in enumerate(prepared):
        lat = item.get("latitude")
        lon = item.get("longitude")
        if lat is not None and lon is not None:
            coords.append((float(lat), float(lon)))
            coord_indexes.append(idx)

    weather_results = get_current_weather_batch(coords)

    for idx, weather in zip(coord_indexes, weather_results):
        item = prepared[idx]
        item["current_weather"] = weather

        is_indoor = "indoor" in [tag.lower() for tag in item.get("tags", [])]

        if weather:
            item["weather_suitability"] = weather["condition"]
        elif is_indoor:
            item["weather_suitability"] = "Indoor"
        else:
            item["weather_suitability"] = "Unknown"

    for idx, item in enumerate(prepared):
        if "current_weather" not in item:
            item["current_weather"] = None
            item["weather_suitability"] = item.get("weather_suitability") or "Unknown"

    return prepared


def build_attraction_results(
    destination_text: str,
    interest_list: list[str],
    minimum_rating: float,
    use_weather: bool,
    sort_mode: str,
    keyword: str = "",
    destination_lat: float | None = None,
    destination_lon: float | None = None,
    max_results: int = 60,
    max_pages: int = 3,
) -> tuple[list[dict[str, Any]], str, str]:

    destination_text = destination_text.strip()

    if not destination_text:
        raise ValueError(
            "Destination is required."
        )

    # 1. Resolve destination coordinates.
    # If the frontend already gave us lat/lon (e.g. from Google Places
    # Autocomplete), skip geocoding entirely — one less network call and
    # one less thing that can fail.

    if destination_lat is not None and destination_lon is not None:
        destination_place = {
            "display_name": destination_text,
            "latitude": float(destination_lat),
            "longitude": float(destination_lon),
            "source": "Google Places Autocomplete",
        }
    else:
        destination_place = geocode_place(
            destination_text
        )

    if not destination_place:
        raise ValueError(
            f"Could not find the destination: {destination_text}"
        )

    # 2. Weather

    weather = None

    if use_weather:
        weather = get_weather(
            destination_place["latitude"],
            destination_place["longitude"],
            datetime.now().strftime("%Y-%m-%d"),
        )

    if use_weather and weather:

        weather_message = (
            f"{weather['condition']} today in "
            f"{destination_text.title()} - "
            f"{weather['min_temp']}°C to "
            f"{weather['max_temp']}°C"
        )

    else:

        weather_message = (
            f"Destination located: "
            f"{destination_place['display_name']}."
        )

    # 3. Search live attractions

    candidates = search_attractions_serpapi(
        destination_place["latitude"],
        destination_place["longitude"],
        interest_list,
        minimum_rating,
        max_pages=max_pages,
    )

    live_data = bool(candidates)

    # 4. Keyword search (searches attraction name and tags)

    keyword = (keyword or "").strip().lower()

    if keyword:
        candidates = [
            attraction
            for attraction in candidates
            if keyword in str(attraction.get("name", "")).lower()
            or any(
                keyword in str(tag).lower()
                for tag in attraction.get("tags", [])
            )
        ]

    # 5. Recommendation engine

    selected = recommend_attractions(
        candidates,
        interest_list,
        weather,
        minimum_rating,
        max_results=max_results,
        filter_partly_cloudy=(
            use_weather
            and weather is not None
            and weather.get(
                "condition",
                ""
            ).lower() == "partly cloudy"
        ),
    )

    # 6. Prepare final attraction data

    selected = prepare_selected_attractions(
        selected,
        reference_lat=destination_place["latitude"],
        reference_lon=destination_place["longitude"],
    )

    # 7. Sort
    
    if sort_mode == "rating":

        selected.sort(
            key=lambda item: float(
                item.get("rating", 0)
            ),
            reverse=True,
        )

    elif sort_mode == "nearest":

        selected.sort(
            key=lambda item: (
                item.get("distance_km")
                if item.get("distance_km") is not None
                else float("inf")
            )
        )

    else:

        selected.sort(
            key=lambda item: float(
                item.get("score", 0)
            ),
            reverse=True,
        )

    # 8. Data source note

    if live_data:
        source_note = (
            "Live attraction data retrieved through "
            "SerpAPI Google Maps search."
        )
    else:
        source_note = (
            "No live attractions found via SerpAPI for this "
            "destination/filter combination. Try a different "
            "destination, interest, or a lower minimum rating."
        )

    return (
        selected,
        weather_message,
        source_note,
    )