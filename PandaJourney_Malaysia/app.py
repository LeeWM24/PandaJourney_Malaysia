from flask import Flask, render_template, request, redirect, url_for, session, flash

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


@app.route("/smart-attraction")#Kaixi
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
        weather_status="Sunny today in KL",
        attractions=[]
    )


@app.route("/smart-itinerary", methods=["GET", "POST"])#Lee
def smart_itinerary():
    return render_template(
        "smart_itinerary.html",
        active_page="itinerary",
        current_user=get_current_user(),
        plan=None,
        error=None,
        map_data=None,
        form={}
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
@app.route("/public-itineraries", methods=["GET", "POST"])#Zham feng
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





@app.route("/smart-itinerary", methods=["GET", "POST"])
def smart_itinerary2():
    return render_template(
        "smart_itinerary.html",
        active_page="itinerary",
        current_user=get_current_user(),
        plan=None,
        error=None,
        map_data=None,
        form={
            "start": "",
            "end": "",
            "trip_date": "",
            "start_time": "09:00",
            "available_hours": 6,
            "selected_attractions": []
        }
    )