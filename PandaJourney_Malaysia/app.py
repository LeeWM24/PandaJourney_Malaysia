import os
import time
import hashlib
import threading
import secrets
import base64
import json
import requests
from functools import wraps
from datetime import datetime, timezone, timedelta
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
    get_cached_initial_attractions,
    _get_firestore_db,
    logger as smart_attraction_logger,
)

try:
    import firebase_admin
    from firebase_admin import auth as firebase_admin_auth
    from google.cloud import firestore as google_cloud_firestore
except ImportError:
    firebase_admin = None
    firebase_admin_auth = None
    google_cloud_firestore = None


app = Flask(
    __name__,
    template_folder="presentation/ui",
    static_folder="presentation/static",
    static_url_path="/static"
)

configured_secret_key = os.getenv("SECRET_KEY", "").strip()
app.secret_key = configured_secret_key or secrets.token_hex(32)

if not configured_secret_key:
    app.logger.warning(
        "SECRET_KEY is not configured; sessions will reset when the server restarts."
    )

app.config.update(
    PERMANENT_SESSION_LIFETIME=timedelta(minutes=30),
    SESSION_REFRESH_EACH_REQUEST=True,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=(
        os.getenv("SESSION_COOKIE_SECURE", "").lower()
        in {"1", "true", "yes"}
    ),
)


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

ACCOUNT_DAILY_SEARCH_LIMIT = 50
IP_DAILY_SEARCH_LIMIT = 80
API_USAGE_COLLECTION = "api_usage_limits"

_daily_usage_fallback: dict[str, int] = defaultdict(int)
_daily_usage_lock = threading.Lock()


class DailySearchLimitExceeded(Exception):
    pass


class FirebaseTokenRejected(Exception):
    pass


class FirebaseAuthUnavailable(Exception):
    pass


def _verified_firebase_uid() -> str | None:
    token = request.form.get("_firebase_id_token", "").strip()

    if not token:
        return None

    try:
        decoded_token = _verify_firebase_id_token(token)
        uid = str(decoded_token.get("uid") or "").strip()
        return uid or None
    except (FirebaseTokenRejected, FirebaseAuthUnavailable) as error:
        smart_attraction_logger.warning(
            f"[AUTH TOKEN INVALID] {error}"
        )
        return None


def _daily_usage_keys(uid: str | None, client_ip: str) -> list[tuple[str, int]]:
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    ip_hash = hashlib.sha256(client_ip.encode("utf-8")).hexdigest()

    keys = [
        (f"ip:{day}:{ip_hash}", IP_DAILY_SEARCH_LIMIT),
    ]

    if uid:
        uid_hash = hashlib.sha256(uid.encode("utf-8")).hexdigest()
        keys.append(
            (f"account:{day}:{uid_hash}", ACCOUNT_DAILY_SEARCH_LIMIT)
        )

    return keys


def _consume_daily_search_quota(uid: str | None, client_ip: str) -> dict[str, int]:
    usage_keys = _daily_usage_keys(uid, client_ip)
    db = _get_firestore_db()

    if (
        db is not None and
        google_cloud_firestore is not None
    ):
        try:
            refs = [
                (
                    db.collection(API_USAGE_COLLECTION).document(
                        hashlib.sha256(key.encode("utf-8")).hexdigest()
                    ),
                    key,
                    limit
                )
                for key, limit in usage_keys
            ]

            transaction = db.transaction()

            @google_cloud_firestore.transactional
            def update_usage(current_transaction):
                snapshots = [
                    ref.get(transaction=current_transaction)
                    for ref, _, _ in refs
                ]

                for snapshot, (_, _, limit) in zip(snapshots, refs):
                    count = int((snapshot.to_dict() or {}).get("count", 0))
                    if count >= limit:
                        raise DailySearchLimitExceeded()

                for snapshot, (ref, key, limit) in zip(snapshots, refs):
                    count = int((snapshot.to_dict() or {}).get("count", 0))
                    current_transaction.set(
                        ref,
                        {
                            "scope": key.split(":", 1)[0],
                            "day_utc": key.split(":")[1],
                            "count": count + 1,
                            "limit": limit,
                            "updated_at": google_cloud_firestore.SERVER_TIMESTAMP,
                        },
                        merge=True,
                    )

                return {
                    key.split(":", 1)[0]: limit - (
                        int((snapshot.to_dict() or {}).get("count", 0)) + 1
                    )
                    for snapshot, (_, key, limit) in zip(snapshots, refs)
                }

            return update_usage(transaction)
        except DailySearchLimitExceeded:
            raise
        except Exception as error:
            smart_attraction_logger.warning(
                f"[DAILY QUOTA FIRESTORE FALLBACK] {error}"
            )

    # Keeps protection active during local development if Admin/Firestore
    # is temporarily unavailable. Counts reset only when the process restarts.
    with _daily_usage_lock:
        for key, limit in usage_keys:
            if _daily_usage_fallback[key] >= limit:
                raise DailySearchLimitExceeded()

        for key, _ in usage_keys:
            _daily_usage_fallback[key] += 1

        return {
            key.split(":", 1)[0]: limit - _daily_usage_fallback[key]
            for key, limit in usage_keys
        }


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


def login_required(view_function):
    @wraps(view_function)
    def wrapped(*args, **kwargs):
        if not get_current_user().get("uid"):
            if request.path.startswith("/api/"):
                return jsonify({
                    "error": "Authentication required."
                }), 401

            next_url = request.full_path.rstrip("?")
            return redirect(
                url_for("login", next=next_url)
            )

        return view_function(*args, **kwargs)

    return wrapped


def _ensure_firebase_auth_ready() -> bool:
    """Initialise token verification without requiring Firestore access."""
    if firebase_admin is None or firebase_admin_auth is None:
        return False

    try:
        if not firebase_admin._apps:
            firebase_admin.initialize_app(options={
                "projectId": os.getenv(
                    "GOOGLE_CLOUD_PROJECT",
                    "pandajourney-ef50a",
                )
            })
        return True
    except Exception as error:
        app.logger.error("Firebase Auth initialisation failed: %s", error)
        return False


def _get_firebase_sign_in_provider(id_token: str) -> str:
    """Read the provider from a Firebase ID token after the token is verified."""
    try:
        payload_segment = id_token.split(".")[1]
        padding = "=" * (-len(payload_segment) % 4)
        payload_json = base64.urlsafe_b64decode(
            f"{payload_segment}{padding}".encode("utf-8")
        )
        payload = json.loads(payload_json.decode("utf-8"))
    except (IndexError, ValueError, TypeError, json.JSONDecodeError):
        return ""

    firebase_claim = payload.get("firebase") or {}
    return str(firebase_claim.get("sign_in_provider") or "")


def _verify_firebase_id_token(id_token: str) -> dict:
    """Verify with Admin SDK, or Firebase Auth REST when Admin is unavailable."""
    if _ensure_firebase_auth_ready():
        try:
            return firebase_admin_auth.verify_id_token(
                id_token,
                check_revoked=False,
            )
        except Exception as error:
            app.logger.warning(
                "Firebase Admin token verification failed; trying REST: %s",
                error,
            )

    api_key = os.getenv(
        "FIREBASE_WEB_API_KEY",
        "AIzaSyAX3NQdMKHFGwoySHcNAYW8dHFSnZBo_MI",
    ).strip()

    try:
        response = requests.post(
            "https://identitytoolkit.googleapis.com/v1/accounts:lookup",
            params={"key": api_key},
            json={"idToken": id_token},
            timeout=10,
        )
    except requests.RequestException as error:
        raise FirebaseAuthUnavailable() from error

    if response.status_code in {400, 401, 403}:
        raise FirebaseTokenRejected()
    if not response.ok:
        raise FirebaseAuthUnavailable()

    users = response.json().get("users") or []
    if not users:
        raise FirebaseTokenRejected()

    user = users[0]
    return {
        "uid": user.get("localId", ""),
        "email": user.get("email", ""),
        "name": user.get("displayName", ""),
        "email_verified": bool(user.get("emailVerified", False)),
        "firebase": {
            "sign_in_provider": _get_firebase_sign_in_provider(id_token),
        },
    }

@app.route("/session-login", methods=["POST"])
def session_login():
    payload = request.get_json(silent=True) or {}
    id_token = str(payload.get("idToken") or "").strip()

    if not id_token:
        return jsonify({
            "error": "Firebase ID token is required."
        }), 400

    try:
        decoded_token = _verify_firebase_id_token(id_token)
    except FirebaseTokenRejected as error:
        app.logger.warning(
            "Rejected Firebase session token: %s",
            error,
        )
        return jsonify({
            "error": "Invalid or expired authentication token."
        }), 401
    except FirebaseAuthUnavailable as error:
        app.logger.error("Firebase Auth verification unavailable: %s", error)
        return jsonify({
            "error": "Authentication service is temporarily unavailable."
        }), 503

    firebase_claim = decoded_token.get("firebase") or {}
    sign_in_provider = str(
        firebase_claim.get("sign_in_provider") or ""
    )

    if (
        sign_in_provider != "google.com" and
        not decoded_token.get("email_verified", False)
    ):
        return jsonify({
            "error": "Please verify your email before logging in."
        }), 403

    session.clear()
    session.permanent = True
    session["user"] = {
        "uid": decoded_token["uid"],
        "email": decoded_token.get("email", ""),
        "displayName": decoded_token.get("name", ""),
    }

    return jsonify({"ok": True})


@app.route("/login", methods=["GET", "POST"])
def login():
    return render_template("login.html")


@app.route("/create-account")
def create_account():
    return render_template("create_account.html")


@app.route("/resend-verification")
def resend_verification():
    return render_template("resend_verification.html")


@app.route("/dashboard")
@login_required
def dashboard():
    return render_template(
        "dashboard.html",
        active_page="dashboard",
        current_user=get_current_user()
    )


@app.route("/profile", methods=["GET"])
@login_required
def profile():
    return render_template(
        "profile.html",
        active_page="profile",
        current_user=get_current_user(),
        user_preferences={}
    )


@app.route("/user-management")
@login_required
def user_management():
    return redirect(url_for("profile"))


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/smart-attraction/suggest", methods=["GET"])
@rate_limit(max_calls=12, window_seconds=60)
def smart_attraction_suggest():
    """Type-ahead destination suggestions for the smart-attraction filter
    panel's search bar (used when no Google Maps key is configured
    client-side). Separate from /api/location-suggestions, which powers
    the itinerary planner's destination field."""
    query = request.args.get("q", "").strip()
    suggestions = suggest_destinations(query)
    return jsonify(suggestions)


@app.route("/api/public-place-photo", methods=["GET"])
@rate_limit(max_calls=10, window_seconds=60)
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
@app.route("/attractions", methods=["GET", "POST"])
@app.route("/smart-attraction", methods=["GET", "POST"])
@rate_limit(max_calls=6, window_seconds=60)
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
    quota_remaining: dict[str, int] = {}
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

        # Blank destination means "search across Malaysia" so users can filter
        # purely by interest/rating without being forced to pick one area.
        search_destination = filters["destination"] or "Malaysia"

        verified_uid = _verified_firebase_uid()
        client_ip = request.remote_addr or "unknown"
        quota_available = True

        try:
            quota_remaining = _consume_daily_search_quota(
                verified_uid,
                client_ip,
            )
        except DailySearchLimitExceeded:
            quota_available = False
            flash(
                "The daily attraction search limit has been reached. "
                "It resets at 8:00 AM Malaysia time.",
                "warning"
            )

        # Only a server-verified Firebase user receives the larger result set.
        search_max_pages = 3 if verified_uid else 1

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
                if not quota_available:
                    raise DailySearchLimitExceeded()

                attractions, weather_status, source_note, resolved_place = (
                    build_attraction_results(
                        destination_text=search_destination,
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
                        max_pages=search_max_pages,
                    )
                )
                # Feed the resolved coordinates back into the hidden
                # destination_lat/destination_lng inputs so that a second search
                # can reuse the coordinates instead of re-geocoding the text.
                filters["destination_lat"] = resolved_place["latitude"]
                filters["destination_lng"] = resolved_place["longitude"]

                if filters["destination"]:
                    results_label = f"Showing {len(attractions)} attractions"
                else:
                    results_label = (
                        f"Showing {len(attractions)} attractions across Malaysia"
                    )

            except DailySearchLimitExceeded:
                attractions = []
                searched = False

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
        attractions, source_note = get_cached_initial_attractions()
        weather_status = "Showing local starter recommendations. Search to refresh live results."
        searched = True

        filters["destination_lat"] = 3.1478
        filters["destination_lng"] = 101.6953
        results_label = (
            f"Showing {len(attractions)} starter attractions near "
            f"{filters['destination']}"
        )

    return render_template(
        "smart_attraction.html",
        active_page="attractions",
        current_user=get_current_user(),
        filters=filters,
        attractions=attractions,
        searched=searched,
        search_submitted=request.method == "POST",
        results_label=results_label,
        google_maps_api_key=os.environ.get("GOOGLE_MAPS_API_KEY", ""),
        google_maps_enabled=bool(os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()),
    )


# =========================
# Location Autocomplete API
# =========================

@app.route("/api/location-suggestions")
@login_required
@rate_limit(max_calls=15, window_seconds=60)
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
@login_required
@rate_limit(max_calls=8, window_seconds=60)
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
                minimum_rating=4.0,
                max_pages=3 if get_current_user() else 1,
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
@login_required
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

    itinerary_form = request.form if request.method == "POST" else get_default_itinerary_form()

    if request.method == "GET" and request.args.get("start", "").strip():
        itinerary_form["start"] = request.args.get("start", "").strip()
        itinerary_form["start_latitude"] = request.args.get("start_latitude", "").strip()
        itinerary_form["start_longitude"] = request.args.get("start_longitude", "").strip()
        itinerary_form["use_current_location"] = "0"

    return render_template(
        "smart_itinerary.html",
        active_page="itinerary",
        current_user=get_current_user(),
        plan=plan,
        error=error,
        map_data=map_data,
        form=itinerary_form
    )


# =========================
# Lee Part 2: Saved Itineraries
# Firestore frontend version only
# No local JSON / data folder
# =========================

@app.route("/saved-itineraries", methods=["GET"])
@login_required
def saved_itineraries():
    return render_template(
        "saved_itineraries.html",
        active_page="saved",
        current_user=get_current_user()
    )


@app.route("/saved-itinerary/<itinerary_id>")
@app.route("/saved-itineraries/<itinerary_id>")
@login_required
def saved_itinerary_detail(itinerary_id):
    return render_template(
        "saved_itinerary_detail.html",
        active_page="saved",
        current_user=get_current_user(),
        itinerary_id=itinerary_id
    )


@app.route("/saved-itinerary/<itinerary_id>/edit")
@app.route("/saved-itineraries/<itinerary_id>/edit")
@login_required
def saved_itinerary_edit(itinerary_id):
    return render_template(
        "saved_itinerary_edit.html",
        active_page="saved",
        current_user=get_current_user(),
        itinerary_id=itinerary_id
    )


@app.route("/collaboration", methods=["GET", "POST"])
@login_required
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
        if not get_current_user().get("uid"):
            return redirect(url_for("login", next=request.path))

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
