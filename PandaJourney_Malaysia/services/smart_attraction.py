from __future__ import annotations

import json
import logging
import math
import os
import time
import hashlib
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus

import requests
from dotenv import load_dotenv

try:
    import firebase_admin
    from firebase_admin import credentials, firestore
    from google.cloud import firestore as google_firestore
    from google.oauth2 import service_account
except ImportError:
    firebase_admin = None
    credentials = None
    firestore = None
    google_firestore = None
    service_account = None


NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
SERPAPI_URL = "https://serpapi.com/search.json"

BASE_DIR = Path(__file__).resolve().parents[1]

load_dotenv(BASE_DIR / ".env")

# ---------------------------------------------------------------------------
# Logging — was previously a scattering of logger.info(...) calls.
# Same visibility, but now controllable by level instead of by deleting
# lines: set SMART_ATTRACTION_LOG_LEVEL=DEBUG in .env to see every cache
# hit and geocode HTTP call again (useful when debugging search issues,
# same detail as before), or leave it at the INFO default for a quieter
# console that still shows every search + geocode fallback decision.
# ---------------------------------------------------------------------------

logger = logging.getLogger("smart_attraction")

if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%H:%M:%S"))
    logger.addHandler(_handler)
    logger.propagate = False

logger.setLevel(os.getenv("SMART_ATTRACTION_LOG_LEVEL", "INFO").upper())

# ---------------------------------------------------------------------------
# Firestore cache cuts down repeat SerpAPI / geocoding usage on temporary-disk
# hosting. Geocode results barely change; attraction results refresh sooner.
# ---------------------------------------------------------------------------

FIRESTORE_CACHE_COLLECTION = os.getenv(
    "SMART_ATTRACTION_FIRESTORE_CACHE_COLLECTION",
    "api_cache",
)
FIRESTORE_DATABASE_ID = os.getenv("FIRESTORE_DATABASE_ID", "(default)").strip() or "(default)"
GEOCODE_CACHE_TTL_SECONDS = 30 * 24 * 3600  # 30 days
ATTRACTION_CACHE_TTL_SECONDS = int(
    os.getenv("SMART_ATTRACTION_CACHE_TTL_SECONDS", str(24 * 3600))
)  # fresh attraction cache, default 24 hours
ATTRACTION_STALE_CACHE_TTL_SECONDS = int(
    os.getenv("SMART_ATTRACTION_STALE_CACHE_TTL_SECONDS", str(30 * 24 * 3600))
)  # fallback attraction cache, default 30 days
PUBLIC_PHOTO_CACHE_TTL_SECONDS = 7 * 24 * 3600 # 7 days

_firestore_db = None
_firestore_checked = False


def _get_firestore_db():
    global _firestore_db, _firestore_checked

    if _firestore_checked:
        return _firestore_db

    _firestore_checked = True

    if firebase_admin is None:
        logger.warning("[FIRESTORE CACHE] firebase-admin is not installed.")
        return None

    try:
        credential_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
        credential_path = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH", "").strip()
        google_credential = None
        project_id = os.getenv("GOOGLE_CLOUD_PROJECT", "").strip() or None

        if credential_json:
            service_account_info = json.loads(credential_json)
            google_credential = service_account.Credentials.from_service_account_info(
                service_account_info
            )
            project_id = project_id or service_account_info.get("project_id")
        elif credential_path:
            google_credential = service_account.Credentials.from_service_account_file(
                credential_path
            )

        if not firebase_admin._apps:
            if credential_json:
                cred = credentials.Certificate(json.loads(credential_json))
                firebase_admin.initialize_app(cred)
            elif credential_path:
                cred = credentials.Certificate(credential_path)
                firebase_admin.initialize_app(cred)
            else:
                firebase_admin.initialize_app()

        if google_credential is not None:
            _firestore_db = google_firestore.Client(
                project=project_id,
                credentials=google_credential,
                database=FIRESTORE_DATABASE_ID,
            )
        else:
            _firestore_db = google_firestore.Client(
                project=project_id,
                database=FIRESTORE_DATABASE_ID,
            )

        if FIRESTORE_DATABASE_ID == "(default)":
            _firestore_db._database_string_internal = (
                f"projects/{_firestore_db.project}/databases/(default)"
            )

        logger.info(f"[FIRESTORE CACHE] Connected to database {FIRESTORE_DATABASE_ID!r}.")
    except Exception as error:
        logger.warning(f"[FIRESTORE CACHE] Disabled: {error}")
        _firestore_db = None

    return _firestore_db


def _firestore_cache_doc_id(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def firestore_cache_get_with_age(key: str, max_age_seconds: float) -> dict[str, Any] | None:
    db = _get_firestore_db()
    if db is None:
        return None

    try:
        doc_ref = db.collection(FIRESTORE_CACHE_COLLECTION).document(
            _firestore_cache_doc_id(key)
        )
        snapshot = doc_ref.get()
    except Exception as error:
        logger.warning(f"[FIRESTORE CACHE READ ERROR] {error}")
        return None

    if not snapshot.exists:
        return None

    data = snapshot.to_dict() or {}
    created_at = float(data.get("created_at") or 0)

    if not created_at or time.time() - created_at > max_age_seconds:
        return None

    payload = data.get("payload")
    if payload is None:
        return None

    logger.debug(f"[FIRESTORE CACHE HIT] {key}")
    return {
        "payload": payload,
        "age_seconds": time.time() - created_at,
        "created_at": created_at,
    }


def firestore_cache_set(key: str, value: Any) -> bool:
    db = _get_firestore_db()
    if db is None:
        return False

    try:
        db.collection(FIRESTORE_CACHE_COLLECTION).document(
            _firestore_cache_doc_id(key)
        ).set({
            "cache_key": key,
            "payload": value,
            "created_at": time.time(),
            "updated_at": firestore.SERVER_TIMESTAMP,
        })
        return True
    except Exception as error:
        logger.warning(f"[FIRESTORE CACHE WRITE ERROR] {error}")
        return False


def cache_get(key: str, max_age_seconds: float) -> Any | None:
    cached = cache_get_with_age(key, max_age_seconds)
    if cached is None:
        return None
    return cached["payload"]


def cache_get_with_age(key: str, max_age_seconds: float) -> dict[str, Any] | None:
    return firestore_cache_get_with_age(key, max_age_seconds)


def cache_set(key: str, value: Any) -> None:
    firestore_cache_set(key, value)

USER_AGENT = os.getenv(
    "NOMINATIM_USER_AGENT",
    "VisitMYPlannerPrototype/1.0 (student-project@example.com)",
).strip()

NOMINATIM_EMAIL = os.getenv("NOMINATIM_EMAIL", "").strip()

logger.info(
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
    if not interests:
        return "tourist attractions"

    interest = interests[0].lower()

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

def get_public_place_photo(place_name: str) -> dict[str, Any]:
    place_name = str(place_name or "").strip()

    if not place_name:
        return {
            "image_url": "",
            "place_name": ""
        }

    cache_key = f"public_photo_v3:{place_name.lower()}"

    cached = cache_get(
        cache_key,
        PUBLIC_PHOTO_CACHE_TTL_SECONDS
    )

    if cached is not None and cached.get("image_url"):
        return cached

    api_key = os.getenv("SERPAPI_KEY", "").strip()

    if not api_key:
        return {
            "image_url": "",
            "place_name": place_name
        }

    try:
        data = _request_json(
            SERPAPI_URL,
            params={
                "engine": "google_maps",
                "type": "search",
                "q": f"{place_name}, Malaysia",
                "hl": "en",
                "gl": "my",
                "api_key": api_key,
            },
        )

    except requests.RequestException as error:
        return {
            "image_url": "",
            "place_name": place_name
        }

    image_url = ""
    photo_data_id = ""

    place_result = data.get("place_results") or {}

    if place_result:
        image_url = place_result.get("thumbnail") or ""
        photo_data_id = place_result.get("data_id") or ""

    search_results = data.get("local_results", [])

    for item in data.get("local_results", []):
        thumbnail = item.get("thumbnail") or ""
        data_id = item.get("data_id") or ""

        if thumbnail:
            image_url = thumbnail
            break

        if data_id and not photo_data_id:
            photo_data_id = data_id

        if not image_url and photo_data_id:
            try:
                photo_data = _request_json(
                    SERPAPI_URL,
                    params={
                        "engine": "google_maps_photos",
                        "data_id": photo_data_id,
                        "hl": "en",
                        "api_key": api_key,
                    },
                )

                photos = photo_data.get("photos", [])

                if photos:
                    image_url = (
                        photos[0].get("image")
                        or photos[0].get("thumbnail")
                        or ""
                    )

            except requests.RequestException as error:
                print(
                    f"[PUBLIC PHOTO FALLBACK ERROR] {place_name}: {error}",
                    flush=True
                )

    result = {
        "image_url": image_url,
        "place_name": place_name
    }

    cache_set(cache_key, result)

    return result


def is_malaysia_location(location: dict[str, Any] | None) -> bool:
    """Return whether a geocoded point is inside Malaysia's bounding box."""
    if not location:
        return False

    try:
        latitude = float(location["latitude"])
        longitude = float(location["longitude"])
    except (KeyError, TypeError, ValueError):
        return False

    # Includes Peninsular Malaysia plus Sabah and Sarawak. This is a safety
    # check for broad place names such as "Pavilion", which also exist abroad.
    return 0.7 <= latitude <= 7.6 and 99.5 <= longitude <= 120.5


def geocode_with_serpapi(query: str) -> dict[str, Any] | None:
    api_key = os.getenv("SERPAPI_KEY", "").strip()

    if not api_key:
        logger.warning("[SERPAPI GEOCODE] No SERPAPI_KEY configured.")
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
        logger.error(f"[SERPAPI GEOCODE ERROR] {error}")
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

        if not is_malaysia_location(result):
            logger.warning(
                f"[GEOCODE SERPAPI OUTSIDE MALAYSIA] Ignoring: {result['display_name']}"
            )
            continue

        logger.info(
            f"[GEOCODE SERPAPI SUCCESS] {result['display_name']} "
            f"({result['latitude']}, {result['longitude']})"
        )

        return result

    logger.warning(f"[GEOCODE SERPAPI NO RESULT] {query}")
    return None


def geocode_place(query: str) -> dict[str, Any] | None:
    key = query.strip().lower()
    cache_key = f"geocode:my:v2:{key}"

    if not key:
        logger.error("[GEOCODE ERROR] Empty input.")
        return None

    # Only ever cache *successful* geocodes. Caching a failure would mean
    # one Nominatim hiccup (or one query that's simply too specific)
    # permanently blocks that exact string for the rest of the process's
    # life — even after we improve the fallback logic below.
    if key in GEOCODE_CACHE:
        cached = GEOCODE_CACHE[key]
        if is_malaysia_location(cached):
            logger.debug(f"[GEOCODE MEMORY CACHE] {query}")
            return cached
        GEOCODE_CACHE.pop(key, None)

    # v2 prevents old, unrestricted geocode cache entries from being reused.
    db_cached = cache_get(cache_key, GEOCODE_CACHE_TTL_SECONDS)
    if is_malaysia_location(db_cached):
        GEOCODE_CACHE[key] = db_cached
        return db_cached

    search_queries = [query] if "malaysia" in key else [f"{query}, Malaysia", query]

    # A destination string can be over-specified — e.g. a full address
    # copied from an autocomplete suggestion ("Bukit Jalil National
    # Stadium, Persiaran KL Sports City, Bukit Jalil, Kuala Lumpur, 57000,
    # Malaysia") — which Nominatim's free-text search can fail to match
    # even though the venue name and the area are each individually
    # findable. If the exact string fails, progressively drop the
    # left-most comma-separated segment (usually the venue name) and
    # retry, falling back toward the general area rather than giving up.
    segments = [part.strip() for part in query.split(",") if part.strip()]
    for drop_count in range(1, len(segments) - 1):
        reduced = ", ".join(segments[drop_count:])
        if reduced and reduced not in search_queries:
            search_queries.append(reduced)

    for index, search_text in enumerate(search_queries):
        params = {
            "q": search_text,
            "format": "jsonv2",
            "limit": 5,
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
                timeout=20,
            )

            logger.debug(
                f"[GEOCODE HTTP] Status {response.status_code} | Query: {search_text}"
            )

            response.raise_for_status()
            results = response.json()

        except requests.RequestException as error:
            logger.error(f"[GEOCODE ERROR] {error}")
            results = []

        for raw in results:
            try:
                result = {
                    "display_name": raw.get("display_name", query),
                    "latitude": float(raw["lat"]),
                    "longitude": float(raw["lon"]),
                    "source": "OpenStreetMap Nominatim API",
                }
            except (KeyError, TypeError, ValueError):
                continue

            if not is_malaysia_location(result):
                logger.warning(
                    f"[GEOCODE OUTSIDE MALAYSIA] Ignoring: {result['display_name']}"
                )
                continue

            if search_text != query:
                logger.info(
                    f"[GEOCODE FALLBACK] '{query}' matched via reduced query '{search_text}'"
                )

            GEOCODE_CACHE[key] = result
            cache_set(cache_key, result)

            logger.info(
                f"[GEOCODE SUCCESS] {result['display_name']} "
                f"({result['latitude']}, {result['longitude']})"
            )

            return result

        if index < len(search_queries) - 1:
            time.sleep(1.1)

    logger.warning(f"[GEOCODE NO RESULT] Nominatim could not find: {query}")

    serpapi_result = geocode_with_serpapi(query)

    if serpapi_result:
        GEOCODE_CACHE[key] = serpapi_result
        cache_set(cache_key, serpapi_result)
        return serpapi_result

    # Deliberately NOT caching this failure — see comment above.
    return None


CURATED_DESTINATION_SUGGESTIONS = [
    {
        "name": "Kuala Lumpur",
        "display_name": "Kuala Lumpur, Malaysia",
        "latitude": 3.1478,
        "longitude": 101.6953,
    },
]


def suggest_destinations(query: str, limit: int = 5) -> list[dict[str, Any]]:
    """Lightweight autocomplete for the destination field — powers the
    'type-ahead' dropdown when no Google Maps key is configured. Uses the
    same free Nominatim endpoint as geocode_place, cached briefly since
    the same partial query gets hit repeatedly as the user types."""

    key = query.strip().lower()

    if len(key) < 3:
        return []

    curated = [
        dict(suggestion)
        for suggestion in CURATED_DESTINATION_SUGGESTIONS
        if key in suggestion["name"].lower()
    ]

    # Version the key so earlier venue-only suggestions are not reused.
    cache_key = f"suggest:venues:v4:{key}:{limit}"
    cached = cache_get(cache_key, max_age_seconds=24 * 3600)
    if cached is not None:
        cached_names = {item.get("name", "").lower() for item in curated}
        return (curated + [
            item for item in cached
            if item.get("name", "").lower() not in cached_names
        ])[:limit]

    params = {
        "q": key,
        "format": "jsonv2",
        # Fetch extra candidates because Nominatim may rank a residential
        # area or transport stop above the actual venue.
        "limit": min(max(limit * 5, 15), 50),
        "addressdetails": 1,
        "countrycodes": "my",
    }

    if NOMINATIM_EMAIL:
        params["email"] = NOMINATIM_EMAIL

    try:
        response = requests.get(
            NOMINATIM_URL,
            params=params,
            headers={"User-Agent": USER_AGENT, "Accept-Language": "en"},
            timeout=10,
        )
        response.raise_for_status()
        results = response.json()
    except requests.RequestException as error:
        logger.error(f"[SUGGEST ERROR] {error}")
        return []

    suggestions = list(curated)
    ignored_types = {
        "administrative", "bus_stop", "city", "neighbourhood", "platform",
        "residential", "road", "station", "stop", "suburb",
    }
    seen_locations: set[tuple[str, int, int]] = {
        (item["name"].lower(), round(item["latitude"], 3), round(item["longitude"], 3))
        for item in curated
    }

    for item in results:
        if "lat" not in item or "lon" not in item:
            continue

        if str(item.get("type", "")).lower() in ignored_types:
            continue

        display_name = item.get("display_name", "")
        # Nominatim's jsonv2 "name" field is just the place/venue name
        # (e.g. "Bukit Jalil National Stadium"); display_name is the full
        # comma-separated address. Fall back to the first address segment
        # if "name" is missing so we still get something short.
        short_name = item.get("name") or display_name.split(",")[0].strip()

        if not short_name:
            continue

        latitude = float(item["lat"])
        longitude = float(item["lon"])
        location_key = (short_name.lower(), round(latitude, 3), round(longitude, 3))
        if location_key in seen_locations:
            continue
        seen_locations.add(location_key)

        # Secondary line for context — whatever's left of the address
        # after the name, trimmed down to the first couple of segments.
        remainder = display_name
        if short_name and remainder.startswith(short_name):
            remainder = remainder[len(short_name):].lstrip(", ")
        sub_parts = [part.strip() for part in remainder.split(",") if part.strip()]
        subtitle = ", ".join(sub_parts[:2])

        suggestions.append({
            "name": short_name,
            "display_name": display_name,
            "latitude": latitude,
            "longitude": longitude,
        })

    # Prefer official, descriptive venue names over generic OSM labels. For
    # example, show "Pavilion Kuala Lumpur" instead of a bare "Pavilion"
    # when both are available for the same search.
    descriptive_names_exist = any(
        suggestion["name"].lower().startswith(f"{key} ")
        for suggestion in suggestions
    )
    if descriptive_names_exist:
        suggestions = [
            suggestion
            for suggestion in suggestions
            if suggestion["name"].lower() != key
        ]

    suggestions = suggestions[:limit]
    cache_set(cache_key, suggestions)
    return suggestions


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
        logger.error(f"[WEATHER BATCH ERROR] {error}")
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
    zoom: int = 13,
    apply_min_rating: bool = True,
) -> list[dict[str, Any]]:
    """Fetch one page (~20 results) of Google Maps local results."""

    params = {
        "engine": "google_maps",
        "type": "search",
        "q": keyword,
        "ll": f"@{latitude},{longitude},{zoom}z",
        "hl": "en",
        "gl": "my",
        "api_key": api_key,
    }

    if apply_min_rating:
        params["min_rating"] = str(minimum_rating)

    if start:
        params["start"] = start

    try:
        data = _request_json(SERPAPI_URL, params=params)
    except requests.RequestException as error:
        logger.error(f"[SERPAPI SEARCH ERROR] {error}")
        return []

    if data.get("error"):
        logger.error(f"[SERPAPI SEARCH ERROR] API responded: {data['error']}")
        return []

    return data.get("local_results", [])


def _serpapi_destination_page(
    destination_name: str,
    latitude: float,
    longitude: float,
    minimum_rating: float,
    api_key: str,
) -> list[dict[str, Any]]:
    """Fetch a selected venue, including SerpAPI's direct place_results form."""
    params = {
        "engine": "google_maps",
        "type": "search",
        "q": destination_name,
        "ll": f"@{latitude},{longitude},13z",
        "hl": "en",
        "gl": "my",
        "min_rating": str(minimum_rating),
        "api_key": api_key,
    }

    try:
        data = _request_json(SERPAPI_URL, params=params)
    except requests.RequestException as error:
        logger.error(f"[SERPAPI DESTINATION SEARCH ERROR] {error}")
        return []

    if data.get("error"):
        logger.error(f"[SERPAPI DESTINATION SEARCH ERROR] API responded: {data['error']}")
        return []

    results: list[dict[str, Any]] = []
    place_result = data.get("place_results")
    if isinstance(place_result, dict):
        direct_result = dict(place_result)
        direct_result["title"] = direct_result.get("title") or destination_name
        direct_result["gps_coordinates"] = (
            direct_result.get("gps_coordinates")
            or {"latitude": latitude, "longitude": longitude}
        )
        results.append(direct_result)

    results.extend(data.get("local_results", []))
    return results


def classify_indoor_outdoor(item_type: str, description: str, title: str) -> str | None:
    """Heuristic indoor/outdoor classification from SerpAPI's place type,
    description and name — this is what actually powers weather-aware
    scoring, so without it the feature silently does nothing."""

    text = f"{item_type} {description} {title}".lower()

    indoor_keywords = (
        "museum", "gallery", "mall", "shopping centre", "shopping center",
        "aquarium", "cinema", "theatre", "theater", "planetarium",
        "indoor", "arcade", "market hall", "temple interior", "mosque",
        "church", "spa", "casino", "bowling", "convention centre",
    )
    outdoor_keywords = (
        "park", "garden", "beach", "waterfall", "hiking", "trail",
        "square", "viewpoint", "hill", "lake", "island", "zoo",
        "outdoor", "playground", "botanical", "trek", "mountain",
        "river", "cave", "wildlife", "farm", "street",
    )

    if any(keyword in text for keyword in indoor_keywords):
        return "indoor"
    if any(keyword in text for keyword in outdoor_keywords):
        return "outdoor"
    return None


def search_attractions_serpapi(
    latitude: float,
    longitude: float,
    interests: list[str],
    minimum_rating: float,
    max_pages: int = 3,
    destination_name: str = "",
) -> list[dict[str, Any]]:
    """Search Google Maps via SerpAPI, paginating up to `max_pages` pages
    (~20 results each) so results aren't hard-capped at 20. Results are
    cached in Firestore per (location, interests, min rating) so repeat
    searches for the same destination don't re-spend SerpAPI credits.

    NOTE on cost: every extra page is a separate billed SerpAPI request —
    3 pages = 3 credits per *uncached* search. The cache above is what
    keeps this affordable; pagination alone does not. If a search comes
    back completely empty (e.g. a precise POI like a single stadium
    building), we retry at up to 2 wider zoom levels — this only spends
    extra credits on the rare 0-result case, not on every search.
    """

    keyword = get_serpapi_search_keyword(interests)

    normalized_destination = " ".join(destination_name.lower().split())
    cache_key = (
        f"attractions:v4:{round(latitude, 3)}:{round(longitude, 3)}:"
        f"{keyword}:{minimum_rating}:{max_pages}:{normalized_destination}"
    )
    cached = cache_get_with_age(cache_key, ATTRACTION_CACHE_TTL_SECONDS)
    if cached is not None:
        logger.info(
            f"[ATTRACTION CACHE FRESH] key={cache_key} "
            f"age={int(cached['age_seconds'])}s"
        )
        return cached["payload"]

    stale_cached = cache_get_with_age(
        cache_key,
        ATTRACTION_STALE_CACHE_TTL_SECONDS,
    )

    api_key = os.getenv("SERPAPI_KEY", "").strip()

    if not api_key:
        if stale_cached is not None:
            logger.warning(
                f"[ATTRACTION CACHE STALE] SERPAPI_KEY missing; using "
                f"{int(stale_cached['age_seconds'])}s old cached results."
            )
            return stale_cached["payload"]

        logger.warning("[SERPAPI SEARCH] No SERPAPI_KEY configured.")
        return []

    logger.info(
        f"[SERPAPI SEARCH] query={keyword!r} near ({latitude}, {longitude}) "
        f"min_rating={minimum_rating} max_pages={max_pages}"
    )

    raw_results: list[dict[str, Any]] = []
    priority_place_ids: set[str] = set()
    priority_signatures: set[tuple[str, float, float]] = set()

    # Look up the selected venue before the wider category search. This lets
    # a search for a real attraction (for example, Pavilion Kuala Lumpur)
    # include that attraction as the first recommendation when available.
    area_destinations = {
        suggestion["name"].lower()
        for suggestion in CURATED_DESTINATION_SUGGESTIONS
    }
    if normalized_destination and normalized_destination not in area_destinations | {"malaysia"}:
        priority_cache_key = (
            f"destination-attraction:v2:{round(latitude, 3)}:{round(longitude, 3)}:"
            f"{normalized_destination}:{minimum_rating}"
        )
        priority_results = cache_get(
            priority_cache_key,
            ATTRACTION_CACHE_TTL_SECONDS,
        )

        if priority_results is None:
            priority_results = _serpapi_destination_page(
                destination_name,
                latitude,
                longitude,
                minimum_rating,
                api_key,
            )
            cache_set(priority_cache_key, priority_results)

        for item in priority_results:
            place_id = item.get("place_id") or item.get("data_id") or ""
            if place_id:
                priority_place_ids.add(place_id)
            coordinates = item.get("gps_coordinates") or {}
            if "latitude" in coordinates and "longitude" in coordinates:
                priority_signatures.add((
                    str(item.get("title", "")).strip().lower(),
                    round(float(coordinates["latitude"]), 5),
                    round(float(coordinates["longitude"]), 5),
                ))
        raw_results.extend(priority_results)

    # A destination picked from the autocomplete dropdown can be a precise
    # single building (e.g. a stadium) rather than a whole city/area — the
    # default zoom that works great for a city-centre point can come back
    # empty for those. If we get nothing, automatically zoom out and retry
    # before giving up, so precise POIs don't silently return 0 results.
    for zoom in (13, 11, 9):
        for page in range(max_pages):
            page_results = _serpapi_page(
                keyword, latitude, longitude, minimum_rating, api_key,
                start=page * 20, zoom=zoom,
            )

            if not page_results:
                break  # no more pages / error — stop paginating this zoom level

            raw_results.extend(page_results)

            if len(page_results) < 20:
                break  # short page = last page

        if raw_results:
            break  # found something — no need to zoom out further

        logger.info(f"[SERPAPI SEARCH] 0 results at zoom={zoom}, widening search area...")

    # Still nothing even at the widest zoom? Google's own min_rating filter
    # can zero out an otherwise-nonempty result set in a sparse/rural area
    # (e.g. a small border town) where nearby places just aren't well-rated
    # or well-reviewed yet. Try once more without it — recommend_attractions()
    # still applies minimum_rating locally afterwards, but only against
    # places that actually have a rating, so unrated-but-real places can
    # still surface instead of a flat "0 results".
    if not raw_results:
        logger.warning("[SERPAPI SEARCH] Still empty — retrying widest zoom without min_rating filter...")
        for page in range(max_pages):
            page_results = _serpapi_page(
                keyword, latitude, longitude, minimum_rating, api_key,
                start=page * 20, zoom=9, apply_min_rating=False,
            )

            if not page_results:
                break

            raw_results.extend(page_results)

            if len(page_results) < 20:
                break

    if not raw_results and stale_cached is not None:
        logger.warning(
            f"[ATTRACTION CACHE STALE] SerpAPI returned no raw results; "
            f"using {int(stale_cached['age_seconds'])}s old cached results."
        )
        return stale_cached["payload"]

    logger.info(f"[SERPAPI SEARCH] {len(raw_results)} raw result(s) from Google Maps")

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
        candidate_signature = (
            str(title).strip().lower(),
            round(float(coordinates["latitude"]), 5),
            round(float(coordinates["longitude"]), 5),
        )

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

        weather_class = classify_indoor_outdoor(item_type, description, title)
        if weather_class:
            tags.append(weather_class)

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
                # A tag-free search is intentionally broad; do not invent a
                # "tourist attractions" interest tag for the result card.
                "tags": tags or ([keyword] if interests else []),
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
                "is_destination_match": (
                    place_id in priority_place_ids
                    or candidate_signature in priority_signatures
                ),
            }
        )

    logger.info(f"[SERPAPI SEARCH] {len(candidates)} candidate(s) kept after filtering")

    if not candidates and stale_cached is not None:
        logger.warning(
            f"[ATTRACTION CACHE STALE] SerpAPI produced no usable candidates; "
            f"using {int(stale_cached['age_seconds'])}s old cached results."
        )
        return stale_cached["payload"]

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
    elif not requested:
        reasons.append("matches broad attraction search")

    if attraction.get("is_destination_match"):
        score += 1000
        reasons.append("matches searched destination")

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

        if rating < minimum_rating:
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


def get_default_initial_attractions() -> list[dict[str, Any]]:
    """Local initial recommendations shown without spending SerpAPI credits."""
    defaults = [
        {
            "name": "Petronas Twin Towers",
            "latitude": 3.1579,
            "longitude": 101.7123,
            "tags": ["culture", "indoor", "heritage"],
            "estimated_minutes": 90,
            "rating": 4.7,
            "source": "Local launch cache",
            "category": "Landmark",
            "location": "Kuala Lumpur City Centre",
            "area": "KLCC, Kuala Lumpur",
            "description": "An iconic Kuala Lumpur landmark with skyline views, shopping, dining, and easy public transport access.",
        },
        {
            "name": "Islamic Arts Museum Malaysia",
            "latitude": 3.1417,
            "longitude": 101.6893,
            "tags": ["culture", "museum", "indoor"],
            "estimated_minutes": 120,
            "rating": 4.7,
            "source": "Local launch cache",
            "category": "Museum",
            "location": "Jalan Lembah Perdana, Kuala Lumpur",
            "area": "Perdana Botanical Gardens, Kuala Lumpur",
            "description": "A highly rated museum with Islamic art collections, architecture, and calm indoor galleries.",
        },
        {
            "name": "Central Market Kuala Lumpur",
            "latitude": 3.1457,
            "longitude": 101.6950,
            "tags": ["culture", "shopping", "indoor"],
            "estimated_minutes": 90,
            "rating": 4.4,
            "source": "Local launch cache",
            "category": "Market",
            "location": "Jalan Hang Kasturi, Kuala Lumpur",
            "area": "Pasar Seni, Kuala Lumpur",
            "description": "A heritage market for Malaysian crafts, souvenirs, batik, snacks, and cultural shopping.",
        },
        {
            "name": "KLCC Park",
            "latitude": 3.1556,
            "longitude": 101.7145,
            "tags": ["nature", "outdoor"],
            "estimated_minutes": 60,
            "rating": 4.6,
            "source": "Local launch cache",
            "category": "Park",
            "location": "City Centre, Kuala Lumpur",
            "area": "KLCC, Kuala Lumpur",
            "description": "A city park beside the Petronas Twin Towers with walking paths, lake views, and skyline photo spots.",
        },
        {
            "name": "Batu Caves",
            "latitude": 3.2379,
            "longitude": 101.6840,
            "tags": ["culture", "heritage", "outdoor"],
            "estimated_minutes": 120,
            "rating": 4.4,
            "source": "Local launch cache",
            "category": "Temple",
            "location": "Gombak, Selangor",
            "area": "Batu Caves, Selangor",
            "description": "A famous limestone cave temple complex with colorful steps and strong cultural significance.",
        },
    ]

    return prepare_selected_attractions(
        defaults,
        reference_lat=3.1478,
        reference_lon=101.6953,
    )


def get_cached_initial_attractions() -> tuple[list[dict[str, Any]], str]:
    """Use an existing Kuala Lumpur culture cache for initial page results.

    This gives the page the richer "already searched" result set without
    spending SerpAPI credits during page load.
    """
    default_lat = 3.1478
    default_lon = 101.6953
    cache_keys = [
        (
            f"attractions:{round(default_lat, 3)}:{round(default_lon, 3)}:"
            "cultural attractions:4.0:3"
        ),
        "attractions:3.152:101.694:cultural attractions:4.0:3",
        "attractions:3.148:101.695:cultural attractions:4.0:3",
    ]
    cached_options = [
        cached
        for cache_key in cache_keys
        if (
            cached := cache_get_with_age(
                cache_key,
                ATTRACTION_STALE_CACHE_TTL_SECONDS,
            )
        ) and cached["payload"]
    ]
    cached = max(
        cached_options,
        key=lambda option: len(option["payload"]),
        default=None,
    )

    if cached and cached["payload"]:
        logger.info(
            f"[ATTRACTION INITIAL CACHE] using {len(cached['payload'])} "
            f"cached Kuala Lumpur culture attractions, "
            f"age={int(cached['age_seconds'])}s"
        )
        return (
            prepare_selected_attractions(
                cached["payload"],
                reference_lat=default_lat,
                reference_lon=default_lon,
            ),
            (
                "Initial recommendations are loaded from your cached "
                "Kuala Lumpur culture search."
            ),
        )

    return (
        get_default_initial_attractions(),
        "Starter attractions are served locally to avoid SerpAPI usage on page load.",
    )


def prepare_selected_attractions(
    selected: list[dict[str, Any]],
    reference_lat: float | None = None,
    reference_lon: float | None = None,
    include_weather: bool = True,
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

        # Most Relevant should still be geographically relevant. A strong
        # distance penalty prevents places in another state outranking good
        # attractions close to the selected city, while preserving the exact
        # venue boost added by score_attraction().
        distance_penalty = min(float(item["distance_km"] or 0) * 2, 600)
        item["relevance_score"] = float(item.get("score", 0)) - distance_penalty

        prepared.append(item)

    # Real-time weather per attraction — one batched Open-Meteo call for
    # every card instead of a static "Sunny"/"Indoor" guess.
    if not include_weather:
        return prepared

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
        destination_name=destination_text,
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
        include_weather=use_weather,
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
                item.get("relevance_score", item.get("score", 0))
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
        {
            "latitude": destination_place["latitude"],
            "longitude": destination_place["longitude"],
            "display_name": destination_place.get("display_name", destination_text),
        },
    )
