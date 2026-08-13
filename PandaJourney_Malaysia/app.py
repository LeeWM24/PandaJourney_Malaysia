from datetime import datetime
import os
from flask import Flask, render_template, request, redirect, url_for, session, flash

from services.itinerary_service import (
    build_map_data,
    choose_attractions,
    geocode_place,
    get_weather,
    load_demo_attractions,
    make_plan,
    prepare_selected_attractions,
    recommend_attractions,
    search_attractions_serpapi,
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


@app.route("/", methods=["GET", "POST"])#jiading
def login():
    if request.method == "POST":
        session["user"] = {
            "display_name": "Ahmad Faris",
            "email": request.form.get("email") or "ahmad@email.com"
        }
        return redirect(url_for("dashboard"))

    return render_template("login.html")


@app.route("/dashboard")#jiading
def dashboard():
    return render_template(
        "dashboard.html",
        active_page="dashboard",
        current_user=get_current_user(),
        saved_count=7,
        favourite_count=24,
        shared_count=3,
        upcoming_date="Aug 10",
        recent_itineraries=[],
        upcoming_trip=None
    )


@app.route("/smart-attraction", methods=["GET", "POST"])#Kaixi
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
        filters=filters,
        weather_status=weather_status,
        attractions=attractions,
        source_note=source_note,
        searched=searched,
        results_label=results_label,
        serpapi_key=os.environ.get('SERPAPI_KEY', ''),
        SERPAPI_KEY=os.environ.get('SERPAPI_KEY', ''),
        nominatim_email=os.environ.get('NOMINATIM_EMAIL', ''),
        nominatim_user_agent=os.environ.get('NOMINATIM_USER_AGENT', ''),
    )

@app.route("/smart-itinerary", methods=["GET", "POST"])#Lee
def smart_itinerary():
    error = None
    plan = None
    map_data = None
    form = {
        "start": "",
        "end": "",
        "trip_date": "",
        "start_time": "09:00",
        "available_hours": 6,
        "minimum_rating": "4.0",
        "interests": "culture",
    }

    if request.method == "POST":
        form = {
            "start": request.form.get("start", ""),
            "end": request.form.get("end", ""),
            "trip_date": request.form.get("trip_date", ""),
            "start_time": request.form.get("start_time", "09:00"),
            "available_hours": request.form.get("available_hours", 6),
            "minimum_rating": request.form.get("minimum_rating", "4.0"),
            "interests": request.form.get("interests", "culture"),
        }

        try:
            plan = make_plan(request.form)
            map_data = build_map_data(plan)
        except ValueError as exc:
            error = str(exc)
        except Exception:
            error = (
                "Unable to generate itinerary at this time. "
                "Please check your inputs and try again."
            )

    return render_template(
        "smart_itinerary.html",
        active_page="itinerary",
        current_user=get_current_user(),
        plan=plan,
        error=error,
        map_data=map_data,
        form=form,
    )


@app.route("/saved-itineraries", methods=["GET", "POST"])#Lee
def saved_itineraries():
    if request.method == "POST":
        action = request.form.get("_action")

        if action == "toggle_publish":
            flash("Publish status updated.", "success")
        elif action == "delete":
            flash("Itinerary deleted.", "info")
        elif action == "save":
            flash("Itinerary saved.", "success")

        return redirect(url_for("saved_itineraries"))

    return render_template(
        "saved_itineraries.html",
        active_page="saved",
        current_user=get_current_user(),
        itineraries=[]
    )


@app.route("/collaboration", methods=["GET", "POST"])#Manas
def collaboration():
    return render_template(
        "collaboration.html",
        active_page="collaboration",
        current_user=get_current_user(),
        
    )


@app.route("/public-itinerary", methods=["GET", "POST"])#Zham feng
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
        
    )


@app.route("/profile", methods=["GET", "POST"])#Jiading
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
        saved_itineraries_preview=[],
        shared_itineraries_preview=[],
        saved_count=7,
        favourite_count=24,
        shared_count=3
    )


@app.route("/user-management")#Jiading
def user_management():
    return redirect(url_for("profile"))


@app.route("/logout", methods=["GET", "POST"])#Jiading
def logout():
    session.clear()
    return redirect(url_for("login"))


if __name__ == "__main__":
    app.run(debug=True)


