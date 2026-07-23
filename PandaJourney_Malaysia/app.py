from flask import Flask, render_template, request

from services.itinerary_service import make_plan

app = Flask(__name__,
    template_folder="presentation/ui",
    static_folder="presentation/static"
    )


@app.route("/")
def dashboard():
    return render_template("dashboard.html")


@app.route("/smart-attraction")
def smart_attraction():
    return render_template("smart_attraction.html")


@app.route("/smart-itinerary", methods=["GET", "POST"])
def smart_itinerary():
    plan = None
    error = None
    map_data = None

    if request.method == "POST":
        try:
            plan = make_plan(request.form)
            map_data = build_map_data(plan)
        except Exception as e:
            error = str(e)

    return render_template(
        "smart_itinerary.html",
        plan=plan,
        error=error,
        map_data=map_data
    )

def build_map_data(plan):
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


@app.route("/collaboration")
def collaboration():
    return render_template("collaboration.html")


@app.route("/user-management")
def user_management():
    return render_template("user_management.html")


if __name__ == "__main__":
    app.run(debug=True)