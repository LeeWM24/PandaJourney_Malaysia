import os
from flask import Flask, render_template, request, redirect, url_for, session, flash, jsonify

from services.itinerary_service import (
    make_plan,
    build_map_data,
    get_default_itinerary_form
)

from services.smart_attraction import (
    load_demo_attractions,
    build_attraction_results,
    prepare_selected_attractions
)

from services.saved_itinerary_service import (
    get_saved_itineraries,
    save_itinerary,
    delete_itinerary,
    toggle_publish_status
)

from services.favorite_service import (
    get_favourites,
    get_favourite_names,
    toggle_favourite,
    remove_favourite as remove_favourite_entry
)


app = Flask(
    __name__,
    template_folder="presentation/ui",
    static_folder="presentation/static",
    static_url_path="/static"
)

app.secret_key = "panda-demo-secret"


def get_current_user():
    return session.get("user", {
        "display_name": "Ahmad Faris",
        "email": "ahmad@email.com"
    })


def mark_favourites(attractions):
    """Flag each attraction with is_favourite so the UI can render the
    correct star state on page load (instead of only after a toggle)."""
    favourite_names = get_favourite_names()

    for item in attractions:
        item["is_favourite"] = item.get("name") in favourite_names

    return attractions


@app.route("/", methods=["GET", "POST"])  # Jiading
def login():
    if request.method == "POST":
        session["user"] = {
            "display_name": "User",
            "email": request.form.get("email") 
        }
        return redirect(url_for("dashboard"))

    return render_template("login.html")


@app.route('/create-account')
def create_account():
    return render_template('create_account.html')

@app.route("/dashboard")#jiading
def dashboard():
    saved_list = get_saved_itineraries()

    return render_template(
        "dashboard.html",
        active_page="dashboard",
        current_user=get_current_user(),
        saved_count=len(saved_list),
        favourite_count=0,
        shared_count=0,
        upcoming_date=saved_list[0].get("date", "No Trip") if saved_list else "No Trip",
        recent_itineraries=saved_list[:3],
        upcoming_trip=saved_list[0] if saved_list else None
    )


@app.route("/smart-attraction", methods=["GET", "POST"]) # Kaixi
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

        # Validate destination
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
                    )
                )

                attractions = mark_favourites(attractions)

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
                    f"[SMART ATTRACTION ERROR] {error}"
                )

                flash(
                    "Unable to load attraction recommendations "
                    "at this time. Please try again.",
                    "error"
                )

                attractions = []

    else:
        # GET request:
        # Show initial demonstration attractions.
        try:
            attractions = prepare_selected_attractions(
                load_demo_attractions()
            )
            attractions = mark_favourites(attractions)
        except Exception as error:
            print(
                f"[SMART ATTRACTION INITIAL LOAD ERROR] {error}"
            )
            attractions = []

        results_label = (
            "Set filters and click Search"
        )

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
    )


@app.route("/api/favourites/toggle", methods=["POST"])  # Kaixi
def api_toggle_favourite():
    """Adds/removes an attraction from the persisted favourites store.

    smart_attraction.js already POSTs here on every star click, but the
    route never existed, so every request 404'd and nothing was ever
    saved. This wires it up to the existing favorite_service module.
    """
    payload = request.get_json(silent=True) or {}

    if not payload.get("name"):
        return jsonify({"error": "Attraction name is required."}), 400

    is_favourite_now, _ = toggle_favourite(payload)

    return jsonify({"is_favourite": is_favourite_now})


# =========================
# Lee Part 1: Smart Itinerary Planning
# =========================
@app.route("/smart-itinerary", methods=["GET", "POST"])  # Lee
def smart_itinerary():
    plan = None
    error = None
    map_data = None

    print("[SMART ITINERARY ROUTE]", request.method)

    if request.method == "POST":
        print("[SMART FORM DATA]", request.form)

        try:
            plan = make_plan(request.form)
            map_data = build_map_data(plan)

        except Exception as e:
            print("[SMART ERROR]", e)
            error = str(e)

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
# =========================
@app.route("/saved-itineraries", methods=["GET", "POST"])  # Lee
def saved_itineraries():
    if request.method == "POST":
        action = request.form.get("_action")
        itinerary_id = request.form.get("itinerary_id")

        if action == "save":
            latest_plan = session.get("latest_plan")

            if latest_plan:
                save_itinerary(latest_plan)
                flash("Itinerary saved successfully.", "success")
            else:
                flash("No generated itinerary found. Please generate a plan first.", "warning")

        elif action == "delete":
            delete_itinerary(itinerary_id)
            flash("Itinerary deleted.", "info")

        elif action == "toggle_publish":
            toggle_publish_status(itinerary_id)
            flash("Publish status updated.", "success")

        return redirect(url_for("saved_itineraries"))

    return render_template(
        "saved_itineraries.html",
        active_page="saved",
        current_user=get_current_user(),
        itineraries=get_saved_itineraries()
    )


@app.route("/collaboration", methods=["GET", "POST"])  # Manas
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


@app.route("/public-itinerary", methods=["GET", "POST"])  # Zham Feng
def public_itinerary():
    if request.method == "POST":
        action = request.form.get("_action")

        if action == "copy":
            flash("Itinerary copied to your saved list.", "success")

        return redirect(url_for("public_itinerary"))

    return render_template(
        "public_itinerary.html",
        active_page="public",
        current_user=get_current_user(),
        filters={
            "q": "",
            "destination": ""
        },
        popular_itineraries=[],
        itineraries=[],
        destinations=[],
        pagination=None
    )


@app.route("/profile", methods=["GET", "POST"])  # Jiading
def profile():
    if request.method == "POST":
        action = request.form.get("_action")

        if action == "update_profile":
            session["user"] = {
                "display_name": request.form.get("display_name") or "Ahmad Faris",
                "email": get_current_user().get("email", "ahmad@email.com")
            }
            flash("Profile updated.", "success")

        elif action == "update_preferences":
            flash("Preferences saved.", "success")

        elif action == "remove_favourite":
            name = request.form.get("name")

            if name:
                remove_favourite_entry(name)

            flash("Favourite attraction removed.", "info")

        return redirect(url_for("profile"))

    saved_list = get_saved_itineraries()
    favourites_list = get_favourites()

    return render_template(
        "profile.html",
        active_page="profile",
        current_user=get_current_user(),
        user_preferences={
            "interests": [],
            "min_rating": "",
            "preferred_area": ""
        },
        favourite_attractions=favourites_list,
        saved_itineraries_preview=saved_list[:3],
        shared_itineraries_preview=[],
        saved_count=len(saved_list),
        favourite_count=len(favourites_list),
        shared_count=0
    )


@app.route("/user-management")  # Jiading
def user_management():
    return redirect(url_for("profile"))


@app.route("/logout", methods=["GET", "POST"])  # Jiading
def logout():
    session.clear()
    return redirect(url_for("login"))


if __name__ == "__main__":
    app.run(debug=True)