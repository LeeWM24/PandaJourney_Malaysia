import os
import time
from flask import Flask, render_template, request, redirect, url_for, session, flash, jsonify

try:
    import truststore

    truststore.inject_into_ssl()
except ImportError:
    pass

# from services.public_itinerary_service import (
#     get_public_itineraries,
#     increment_view,
#     toggle_like,
#     toggle_save
# )

from services.itinerary_service import (
    make_plan,
    build_map_data,
    get_default_itinerary_form,
    get_location_suggestions,
    search_attractions_serpapi
)

from services.smart_attraction import (
    build_attraction_results,
    suggest_destinations,
    get_public_place_photo,
    logger as smart_attraction_logger,
)


app = Flask(
    __name__,
    template_folder="presentation/ui",
    static_folder="presentation/static",
    static_url_path="/static"
)

app.secret_key = os.getenv("SECRET_KEY", "panda-demo-secret")


def asset_version(relative_path: str) -> int:
    """Returns a static asset's last-modified time as a cache-busting
    query string value. Browsers cache .js/.css files aggressively and
    Flask's dev-server auto-reload doesn't touch them, so without this,
    editing a static file and refreshing the page can silently keep
    serving the old cached copy. Falls back to 0 if the file is missing
    so a template render never breaks because of this."""
    try:
        full_path = os.path.join(app.static_folder, relative_path)
        return int(os.path.getmtime(full_path))
    except OSError:
        return 0


app.jinja_env.globals["asset_version"] = asset_version


# ---------------------------------------------------------------------------
# Lightweight rate limiting for the smart-attraction routes specifically —
# these are the only routes that spend real SerpAPI credits (search) or hit
# Nominatim's rate-limited free API (suggest) per request, and neither route
# requires login, so without this a single user (or a bot) could rack up
# real cost or get our Nominatim User-Agent temporarily blocked.
#
# This is an in-memory sliding window keyed by IP — good enough for a single
# dev-server process. It intentionally does NOT scale to multiple worker
# processes (e.g. gunicorn -w 4): each worker would track its own separate
# counts, so the effective limit becomes limit * worker_count. Fine for this
# project's current deployment; swap for Flask-Limiter with a shared Redis
# backend before running with more than one worker.
# ---------------------------------------------------------------------------

from collections import defaultdict
from functools import wraps

_rate_limit_hits: dict[str, list[float]] = defaultdict(list)


def rate_limit(max_calls: int, window_seconds: int):
    def decorator(view_func):
        @wraps(view_func)
        def wrapped(*args, **kwargs):
            client_id = request.remote_addr or "unknown"
            key = f"{view_func.__name__}:{client_id}"
            now = time.time()

            hits = _rate_limit_hits[key]
            hits[:] = [t for t in hits if now - t < window_seconds]

            if len(hits) >= max_calls:
                smart_attraction_logger.warning(
                    f"[RATE LIMIT] {client_id} exceeded {max_calls}/{window_seconds}s on {view_func.__name__}"
                )
                return jsonify({
                    "error": "Too many requests — please slow down and try again shortly."
                }), 429

            hits.append(now)
            return view_func(*args, **kwargs)

        return wrapped

    return decorator


def get_current_user():
    return session.get("user", {})


@app.route("/login", methods=["GET", "POST"])
def login():
    return render_template("login.html")


@app.route("/create-account")
def create_account():
    return render_template("create_account.html")


@app.route("/dashboard")
def dashboard():
    return render_template(
        "dashboard.html",
        active_page="dashboard",
        current_user=get_current_user()
    )


@app.route("/profile", methods=["GET"])
def profile():
    return render_template(
        "profile.html",
        active_page="profile",
        current_user=get_current_user(),
        user_preferences={}
    )


@app.route("/user-management")
def user_management():
    return redirect(url_for("profile"))


@app.route("/logout", methods=["GET", "POST"])
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/smart-attraction/suggest", methods=["GET"])
@rate_limit(max_calls=30, window_seconds=60)
def smart_attraction_suggest():
    """Type-ahead destination suggestions for the smart-attraction filter
    panel's search bar (used when no Google Maps key is configured
    client-side). Separate from /api/location-suggestions, which powers
    the itinerary planner's destination field."""
    query = request.args.get("q", "").strip()
    suggestions = suggest_destinations(query)
    return jsonify(suggestions)


@app.route("/api/public-place-photo", methods=["GET"])
def public_place_photo():
    place_name = request.args.get("name", "").strip()

    if not place_name:
        return jsonify({
            "image_url": "",
            "place_name": ""
        })

    result = get_public_place_photo(place_name)

    return jsonify(result)


@app.route("/", methods=["GET", "POST"])
@app.route("/smart-attraction", methods=["GET", "POST"])
@rate_limit(max_calls=20, window_seconds=60)
def smart_attraction():
    filters = {
        "destination": "",
        "destination_lat": "",
        "destination_lng": "",
        "interests": [],
        "min_rating": "4.0",
        "weather_aware": True,
        "sort": "score",
    }

    attractions: list[dict] = []
    weather_status = ""
    source_note = ""
    searched = False
    results_label = "Recommended attractions"

    if request.method == "POST":
        searched = True

        filters["destination"] = (
            request.form.get("destination", "").strip()
        )

        # Populated by Google Places Autocomplete on the frontend when the
        # user picks a suggestion — lets us skip our own geocoding step.
        destination_lat = request.form.get("destination_lat", "").strip()
        destination_lon = request.form.get("destination_lng", "").strip()

        filters["interests"] = request.form.getlist(
            "interests"
        )

        filters["min_rating"] = request.form.get(
            "min_rating",
            "4.0"
        )

        filters["weather_aware"] = bool(
            request.form.get("weather_aware")
        )

        filters["sort"] = request.form.get(
            "sort",
            "score"
        )

        if not filters["destination"]:
            flash(
                "Please enter a destination to receive recommendations.",
                "error"
            )

        else:
            try:
                minimum_rating = float(
                    filters["min_rating"] or 4.0
                )
            except ValueError:
                flash(
                    "Invalid rating or filter input. "
                    "Please revise your selection.",
                    "error"
                )
            else:
                try:
                    attractions, weather_status, source_note, resolved_place = (
                        build_attraction_results(
                            destination_text=filters["destination"],
                            interest_list=filters["interests"],
                            minimum_rating=minimum_rating,
                            use_weather=filters["weather_aware"],
                            sort_mode=filters["sort"],
                            destination_lat=(
                                float(destination_lat) if destination_lat else None
                            ),
                            destination_lon=(
                                float(destination_lon) if destination_lon else None
                            ),
                        )
                    )

                    # Feed the resolved coordinates back into the hidden
                    # destination_lat/destination_lng inputs so that a *second*
                    # search (e.g. just changing minimum rating, without
                    # re-picking from the autocomplete dropdown) reuses these
                    # coordinates instead of re-geocoding the destination text —
                    # which can be an overly-specific address Nominatim can't
                    # parse as free text (e.g. a full autocomplete-picked address).
                    filters["destination_lat"] = resolved_place["latitude"]
                    filters["destination_lng"] = resolved_place["longitude"]

                    results_label = (
                        f"Showing {len(attractions)} attractions"
                    )

                except ValueError as error:
                    flash(
                        str(error) or (
                            "Could not find that destination. "
                            "Please try a different search term."
                        ),
                        "error"
                    )

                except Exception as error:
                    smart_attraction_logger.error(f"[SMART ATTRACTION ERROR] {error}")

                    flash(
                        "Unable to load attraction recommendations "
                        "at this time. Please try again.",
                        "error"
                    )

                    attractions = []

    else:
        filters["destination"] = "Kuala Lumpur"
        filters["interests"] = ["culture"]

        try:
            attractions, weather_status, source_note, resolved_place = (
                build_attraction_results(
                    destination_text=filters["destination"],
                    interest_list=filters["interests"],
                    minimum_rating=float(filters["min_rating"]),
                    use_weather=filters["weather_aware"],
                    sort_mode=filters["sort"],
                )
            )

            filters["destination_lat"] = resolved_place["latitude"]
            filters["destination_lng"] = resolved_place["longitude"]

            results_label = (
                f"Showing {len(attractions)} attractions near "
                f"{filters['destination']}"
            )

        except Exception as error:
            smart_attraction_logger.error(f"[SMART ATTRACTION INITIAL LOAD ERROR] {error}")

            attractions = []
            source_note = (
                "Could not load live attractions right now. "
                "Please try searching directly."
            )
            results_label = "Set filters and click Search"

    return render_template(
        "smart_attraction.html",
        active_page="attractions",
        current_user=get_current_user(),
        filters=filters,
        weather_status=weather_status,
        attractions=attractions,
        source_note=source_note,
        searched=searched,
        results_label=results_label,
        nominatim_email=os.environ.get("NOMINATIM_EMAIL", ""),
        nominatim_user_agent=os.environ.get("NOMINATIM_USER_AGENT", ""),
        google_maps_api_key=os.environ.get("GOOGLE_MAPS_API_KEY", ""),
    )


# =========================
# Location Autocomplete API
# =========================

@app.route("/api/location-suggestions")
def location_suggestions():
    query = request.args.get("q", "").strip()

    if len(query) < 3:
        return jsonify({
            "suggestions": []
        })

    try:
        suggestions = get_location_suggestions(query, limit=3)

    except Exception as error:
        print(
            f"[LOCATION SUGGESTION ERROR] {error}",
            flush=True
        )

        suggestions = []

    return jsonify({
        "suggestions": suggestions
    })


@app.route("/api/edit-stop-suggestions")
def edit_stop_suggestions():
    query_text = request.args.get("q", "").strip()
    raw_interests = request.args.get("interests", "")
    interests = [
        interest.strip().lower()
        for interest in raw_interests.split(",")
        if interest.strip()
    ]

    if len(query_text) < 3:
        return jsonify({
            "custom_location": None,
            "suggestions": []
        })

    try:
        location_matches = get_location_suggestions(query_text, limit=1)
    except Exception as error:
        print(f"[EDIT STOP LOCATION SUGGESTION ERROR] {error}", flush=True)
        location_matches = []

    custom_location = location_matches[0] if location_matches else None
    attraction_suggestions = []

    if custom_location:
        try:
            candidates = search_attractions_serpapi(
                latitude=float(custom_location["latitude"]),
                longitude=float(custom_location["longitude"]),
                interests=interests or ["culture"],
                minimum_rating=4.0
            )

            for candidate in candidates[:3]:
                attraction_suggestions.append({
                    "display_name": candidate.get("name") or "Unnamed attraction",
                    "name": candidate.get("name") or "Unnamed attraction",
                    "address": candidate.get("address", ""),
                    "latitude": candidate.get("latitude"),
                    "longitude": candidate.get("longitude"),
                    "rating": candidate.get("rating") or "Not available",
                    "category": candidate.get("category") or "Attraction",
                    "source": "SerpAPI attraction suggestion",
                    "suggestion_type": "attraction"
                })
        except Exception as error:
            print(f"[EDIT STOP ATTRACTION SUGGESTION ERROR] {error}", flush=True)

    if custom_location:
        custom_location = {
            "display_name": custom_location.get("display_name", query_text),
            "name": custom_location.get("display_name", query_text),
            "address": custom_location.get("display_name", ""),
            "latitude": custom_location.get("latitude"),
            "longitude": custom_location.get("longitude"),
            "rating": "Not available",
            "category": "Custom Stop",
            "source": custom_location.get("source", "OpenStreetMap Nominatim"),
            "suggestion_type": "custom"
        }

    return jsonify({
        "custom_location": custom_location,
        "suggestions": attraction_suggestions
    })


# =========================
# Lee Part 1: Smart Itinerary Planning
# =========================

@app.route("/smart-itinerary", methods=["GET", "POST"])
def smart_itinerary():
    plan = None
    error = None
    map_data = None

    print("[SMART ITINERARY ROUTE]", request.method, flush=True)

    if request.method == "POST":
        print("[SMART FORM DATA]", request.form, flush=True)

        try:
            plan = make_plan(request.form)
            map_data = build_map_data(plan)

        except Exception as error_message:
            print("[SMART ERROR]", error_message, flush=True)
            error = str(error_message)

    return render_template(
        "smart_itinerary.html",
        active_page="itinerary",
        current_user=get_current_user(),
        plan=plan,
        error=error,
        map_data=map_data,
        form=request.form if request.method == "POST" else get_default_itinerary_form()
    )


# =========================
# Lee Part 2: Saved Itineraries
# Firestore frontend version only
# No local JSON / data folder
# =========================

@app.route("/saved-itineraries", methods=["GET"])
def saved_itineraries():
    return render_template(
        "saved_itineraries.html",
        active_page="saved",
        current_user=get_current_user()
    )


@app.route("/saved-itinerary/<itinerary_id>")
@app.route("/saved-itineraries/<itinerary_id>")
def saved_itinerary_detail(itinerary_id):
    return render_template(
        "saved_itinerary_detail.html",
        active_page="saved",
        current_user=get_current_user(),
        itinerary_id=itinerary_id
    )


@app.route("/saved-itinerary/<itinerary_id>/edit")
@app.route("/saved-itineraries/<itinerary_id>/edit")
def saved_itinerary_edit(itinerary_id):
    return render_template(
        "saved_itinerary_edit.html",
        active_page="saved",
        current_user=get_current_user(),
        itinerary_id=itinerary_id
    )


@app.route("/collaboration", methods=["GET", "POST"])
def collaboration():
    return render_template(
        "collaboration.html",
        active_page="collaboration",
        current_user=get_current_user(),
        itinerary={
            "id": 1,
            "title": "Collaboration Module",
            "date": "",
            "stop_count": 0,
            "duration": "",
            "stops": []
        },
        comments=[],
        collaborators=[],
        notifications=[]
    )


@app.route("/public-itineraries", methods=["GET", "POST"])
def public_itinerary():
    if request.method == "POST":
        action = request.form.get("_action")

        if action == "copy":
            flash("Itinerary copied to your saved list.", "success")

        return redirect(url_for("public_itinerary"))

    return render_template(
        "public_itineraries.html",
        active_page="public",
        current_user=get_current_user(),
        itineraries=[]
    )


if __name__ == "__main__":
    app.run(debug=True)