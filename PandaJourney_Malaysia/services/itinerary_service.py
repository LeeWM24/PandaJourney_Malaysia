from __future__ import annotations

import json
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
        "minimum_rating": "4.0",
        "transport_mode": "driving",
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
        # Driving uses OSRM driving duration directly.
        "speed_mps": None,
    },
    "walking": {
        "label": "Walking",
        "icon": "🚶",
        # Approx. normal walking speed: 5 km/h.
        "speed_mps": 1.4,
    },
    "cycling": {
        "label": "Cycling",
        "icon": "🚲",
        # Approx. city cycling speed: 15 km/h.
        "speed_mps": 4.2,
    },
}


def get_transport_option(transport_mode: str | None) -> dict[str, Any]:
    transport_mode = str(transport_mode or "driving").lower()

    if transport_mode not in TRANSPORT_OPTIONS:
        transport_mode = "driving"

    return TRANSPORT_OPTIONS[transport_mode]


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
            "source": "SerpApi Google Maps fallback",
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

    keyword = interests[0] if interests else "tourist attractions"

    try:
        data = _request_json(
            SERPAPI_URL,
            params={
                "engine": "google_maps",
                "type": "search",
                "q": f"{keyword} tourist attractions",
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

    for item in data.get("local_results", [])[:10]:
        coordinates = item.get("gps_coordinates") or {}

        if "latitude" not in coordinates or "longitude" not in coordinates:
            continue

        title = item.get("title", "Unnamed attraction")
        item_type = str(item.get("type", "")).lower()
        description = str(item.get("description", "")).lower()
        text = f"{title} {item_type} {description}".lower()

        tags = [interest for interest in interests if interest.lower() in text]

        candidates.append(
            {
                "name": title,
                "latitude": float(coordinates["latitude"]),
                "longitude": float(coordinates["longitude"]),
                "tags": tags or [keyword],
                "estimated_minutes": 90,
                "rating": float(item.get("rating") or 0),
                "source": "SerpApi Google Maps",
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

        # OSRM public demo route is kept for route line geometry.
        # Driving uses OSRM duration. Walking/Cycling use the same distance
        # but estimate duration using average travel speed.
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

    return score, reasons


def choose_attractions(
    candidates: list[dict[str, Any]],
    interests: list[str],
    weather: dict[str, Any] | None,
    available_minutes: int,
    minimum_rating: float
) -> list[dict[str, Any]]:
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

    visit_budget = max(60, available_minutes - 90)

    chosen: list[dict[str, Any]] = []
    spent = 0

    for attraction in ranked:
        visit_minutes = int(attraction.get("estimated_minutes", 90))

        if spent + visit_minutes <= visit_budget and len(chosen) < 3:
            chosen.append(attraction)
            spent += visit_minutes

    return chosen


def human_duration(seconds: float | int | None) -> str:
    if seconds is None:
        return "Not available"

    minutes = max(1, round(float(seconds) / 60))
    hours, remainder = divmod(minutes, 60)

    return f"{hours} hr {remainder} min" if hours else f"{remainder} min"


def build_waze_url(place: dict[str, Any]) -> str:
    latitude = place.get("latitude")
    longitude = place.get("longitude")
    name = quote_plus(str(place.get("name") or place.get("display_name") or "Destination"))

    if latitude is None or longitude is None:
        return ""

    return f"https://waze.com/ul?q={name}&ll={latitude},{longitude}&navigate=yes"


def prepare_selected_attractions(selected: list[dict[str, Any]]) -> list[dict[str, Any]]:
    prepared = []

    for index, attraction in enumerate(selected, start=1):
        item = dict(attraction)

        item["id"] = item.get("id", index)
        item["category"] = item.get("category") or ", ".join(item.get("tags", [])[:2]).title() or "Attraction"
        item["location"] = item.get("location") or "Malaysia"
        item["weather_suitability"] = "Indoor" if "indoor" in [tag.lower() for tag in item.get("tags", [])] else "Sunny"
        item["waze_url"] = build_waze_url(item)

        prepared.append(item)

    return prepared


def build_timetable(
    start_datetime: datetime,
    start_name: str,
    selected: list[dict[str, Any]],
    end_name: str,
    route: dict[str, Any] | None,
    transport_option: dict[str, Any]
) -> list[dict[str, str]]:
    timetable: list[dict[str, str]] = []
    current_time = start_datetime
    legs = route.get("legs", []) if route else []

    transport_label = transport_option["label"]
    transport_icon = transport_option["icon"]

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
            "waze_url": "",
        }
    )

    for index, attraction in enumerate(selected):
        leg_seconds = legs[index].get("duration") if index < len(legs) else 0
        current_time += timedelta(seconds=float(leg_seconds or 0))

        arrival_time = current_time
        visit_minutes = int(attraction.get("estimated_minutes", 90))

        current_time += timedelta(minutes=visit_minutes)
        departure_time = current_time

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
                "waze_url": attraction.get("waze_url", ""),
            }
        )

    final_leg_index = len(selected)

    if final_leg_index < len(legs):
        final_leg_seconds = legs[final_leg_index].get("duration")
    else:
        final_leg_seconds = 0

    current_time += timedelta(seconds=float(final_leg_seconds or 0))

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
            "waze_url": "",
        }
    )

    return timetable


def make_plan(form: dict[str, Any]) -> dict[str, Any]:
    start_text = str(form.get("start", "")).strip()
    end_text = str(form.get("end", "")).strip()
    trip_date = str(form.get("trip_date", "")).strip()
    start_time = str(form.get("start_time", "09:00")).strip()

    if not start_text:
        raise ValueError("Start location is required.")

    if not end_text:
        raise ValueError("End location is required.")

    if not trip_date:
        raise ValueError("Travel date is required.")

    raw_interests = form.getlist("interests") if hasattr(form, "getlist") else form.get("interests", [])

    if isinstance(raw_interests, str):
        interests = [raw_interests] if raw_interests else []
    else:
        interests = [interest for interest in raw_interests if interest]

    available_hours = int(form.get("available_hours", 6))
    minimum_rating = float(form.get("minimum_rating", 4.0))

    transport_mode = str(form.get("transport_mode", "driving")).lower()
    transport_option = get_transport_option(transport_mode)

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

    candidates = live_candidates or load_demo_attractions()

    source_note = (
        "Live SerpApi Google Maps search"
        if live_candidates
        else "Local Kuala Lumpur demonstration dataset. Add SERPAPI_KEY for live attraction search."
    )

    selected = choose_attractions(
        candidates,
        interests,
        weather,
        available_hours * 60,
        minimum_rating
    )

    if not selected:
        selected = choose_attractions(
            candidates,
            interests,
            weather,
            available_hours * 60,
            0
        )

    selected = prepare_selected_attractions(selected)

    route_points = [start] + selected + [end]

    route = get_route_with_stops(route_points, transport_mode)

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
        transport_option
    )

    travel_duration = (
        human_duration(route.get("duration_s"))
        if route
        else "Not available"
    )

    total_duration = travel_duration

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
        "available_hours": available_hours,
        "interests": interests,

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

        "total_duration": total_duration,
        "travel_duration": travel_duration,
        "transport_icon": transport_option["icon"],
        "transport_mode": transport_mode,
        "transport_key": transport_mode,
        "transport_label": transport_option["label"],
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
        "endText": plan.get("end_text", "End")
    }


def format_date_for_display(date_text: str) -> str:
    try:
        dt = datetime.strptime(date_text, "%Y-%m-%d")
        return dt.strftime("%b %d, %Y")
    except ValueError:
        return date_text


