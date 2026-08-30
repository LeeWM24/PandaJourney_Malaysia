import os
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
    get_location_suggestions
)

from services.smart_attraction import (
    build_attraction_results,
)


app = Flask(
    __name__,
    template_folder="presentation/ui",
    static_folder="presentation/static",
    static_url_path="/static"
)

app.secret_key = os.getenv("SECRET_KEY", "panda-demo-secret")


def get_current_user():
    return session.get("user", {})


@app.route("/", methods=["GET", "POST"])
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


@app.route("/smart-attraction", methods=["GET", "POST"])
def smart_attraction():
    filters = {
        "destination": "",
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

                attractions, weather_status, source_note = (
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

                results_label = (
                    f"Showing {len(attractions)} attractions"
                )

            except ValueError:
                flash(
                    "Invalid rating or filter input. "
                    "Please revise your selection.",
                    "error"
                )

            except Exception as error:
                print(
                    f"[SMART ATTRACTION ERROR] {error}",
                    flush=True
                )

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
            attractions, weather_status, source_note = (
                build_attraction_results(
                    destination_text=filters["destination"],
                    interest_list=filters["interests"],
                    minimum_rating=float(filters["min_rating"]),
                    use_weather=filters["weather_aware"],
                    sort_mode=filters["sort"],
                )
            )

            results_label = (
                f"Showing {len(attractions)} attractions near "
                f"{filters['destination']}"
            )

        except Exception as error:
            print(
                f"[SMART ATTRACTION INITIAL LOAD ERROR] {error}",
                flush=True
            )

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
