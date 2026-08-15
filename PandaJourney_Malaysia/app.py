from datetime import datetime
import os
from flask import Flask, render_template, request, redirect, url_for, session, flash

from services.itinerary_service import (
    make_plan,
    build_map_data,
    get_default_itinerary_form
)

from services.smart_attraction import(
    geocode_place,
    get_weather,
    search_attractions_serpapi,
    load_demo_attractions,
    recommend_attractions,
    prepare_selected_attractions
)

from services.saved_itinerary_service import (
    get_saved_itineraries,
    save_itinerary,
    delete_itinerary,
    toggle_publish_status
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


@app.route("/smart-attraction")  # Kaixi
def smart_attraction():
    filters = {
        "destination": "",
        "interests": [],
        "min_rating": "4.0",
        "weather_aware": True,
        "sort": "score",
    }
    weather_status = ""
    source_note = ""
    searched = False
    results_label = "Recommended attractions"
    attractions: list[dict] = []

    def build_results(
        destination_text: str,
        interest_list: list[str],
        minimum_rating: float,
        use_weather: bool,
        sort_mode: str,
    ) -> tuple[list[dict], str, str]:
        weather = None
        destination_place = geocode_place(destination_text) if destination_text else None

        if destination_place and use_weather:
            weather = get_weather(
                destination_place["latitude"],
                destination_place["longitude"],
                datetime.now().strftime("%Y-%m-%d"),
            )

        if use_weather and weather and destination_text:
            weather_message = (
                f"{weather['condition']} today in {destination_text.title()} - "
                f"{weather['min_temp']}C to {weather['max_temp']}C"
            )
        elif destination_place:
            weather_message = f"Destination located: {destination_place['display_name']}."
        else:
            weather_message = "Using the Kuala Lumpur demonstration dataset while you refine your filters."

        if destination_place:
            candidates: list[dict] = search_attractions_serpapi(
                destination_place["latitude"],
                destination_place["longitude"],
                interest_list,
                minimum_rating,
            ) or load_demo_attractions()
        else:
            candidates = load_demo_attractions()

        selected = recommend_attractions(
            candidates,
            interest_list,
            weather,
            minimum_rating,
            max_results=8,
            filter_partly_cloudy=bool(
                use_weather
                and weather
                and weather.get("condition", "").lower() == "partly cloudy"
            ),
        )

        destination_coords = (
            destination_place["latitude"],
            destination_place["longitude"],
        ) if destination_place else (None, None)

        selected = prepare_selected_attractions(
            selected,
            reference_lat=destination_coords[0],
            reference_lon=destination_coords[1],
        )

        if sort_mode == "rating":
            selected.sort(key=lambda item: float(item.get("rating", 0)), reverse=True)
        elif sort_mode == "nearest":
            selected.sort(key=lambda item: item.get("distance_km") or float("inf"))
        else:
            selected.sort(key=lambda item: float(item.get("score", 0)), reverse=True)

        source = (
            "Live SerpApi Leaf Maps search"
            if destination_place and candidates and candidates[0].get("source", "").startswith("SerpApi")
            else "Local demonstration dataset across all destinations."
        )
        return selected, weather_message, source

    try:
        if request.method == "POST":
            searched = True
            filters["destination"] = request.form.get("destination", "").strip()
            filters["interests"] = request.form.getlist("interests")
            filters["min_rating"] = request.form.get("min_rating", "4.0")
            filters["weather_aware"] = bool(request.form.get("weather_aware"))
            filters["sort"] = request.form.get("sort", "score")
            interest_list = [item for item in filters["interests"] if item]
            minimum_rating = float(filters["min_rating"] or 4.0)
            attractions, weather_status, source_note = build_results(
                filters["destination"],
                interest_list,
                minimum_rating,
                filters["weather_aware"],
                filters["sort"],
            )
            results_label = f"Showing {len(attractions)} attractions"
        else:
            attractions = prepare_selected_attractions(load_demo_attractions())
            results_label = "Set filters and click Search"
    except ValueError:
        flash("Invalid rating or filter input. Please revise your selection.", "error")
        attractions = []

    return render_template(
        "smart_attraction.html",
        active_page="attractions",
        current_user=get_current_user(),
        filters={
            "destination": "",
            "interests": [],
            "min_rating": "",
            "weather_aware": True,
            "sort": "rating"
        },
        weather_status="",
        attractions=[],
        nominatim_email="",
        nominatim_user_agent=""
        
        
    )


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
            flash("Favourite attraction removed.", "info")

        return redirect(url_for("profile"))

    saved_list = get_saved_itineraries()

    return render_template(
        "profile.html",
        active_page="profile",
        current_user=get_current_user(),
        user_preferences={
            "interests": [],
            "min_rating": "",
            "preferred_area": ""
        },
        favourite_attractions=[],
        saved_itineraries_preview=saved_list[:3],
        shared_itineraries_preview=[],
        saved_count=len(saved_list),
        favourite_count=0,
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
