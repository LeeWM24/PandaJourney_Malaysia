from flask import Flask, render_template, request, redirect, url_for, session, flash
# from services.public_itinerary_service import (get_public_itineraries, increment_view, toggle_like, toggle_save)

from services.itinerary_service import (
    make_plan,
    build_map_data,
    get_default_itinerary_form
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
        attractions=[]
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

@app.route("/saved-itineraries/<itinerary_id>")
def saved_itinerary_detail(itinerary_id):
    return render_template(
        "saved_itinerary_detail.html",
        active_page="saved",
        current_user=get_current_user(),
        itinerary_id=itinerary_id
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

# @app.route("/public-itineraries/<itinerary_id>/view", methods=["POST"]) #Zham feng
# def increment_itinerary_view(itinerary_id):
#     increment_view(itinerary_id)
#     return {"success": True}

# @app.route("/public-itineraries/<itinerary_id>/like", methods=["POST"]) #Zham feng
# def like_public_itinerary(itinerary_id):
#     current_user = get_current_user()

#     is_liked = toggle_like(itinerary_id)

#     return {
#         "success": True,
#         "liked": is_liked
#     }

# @app.route("/public-itineraries/<itinerary_id>/save", methods=["POST"]) #Zham feng
# def save_public_itinerary(itinerary_id):
#     current_user = get_current_user()

#     is_saved = toggle_save(itinerary_id)

#     return {
#         "success": True,
#         "saved": is_saved
#     }

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