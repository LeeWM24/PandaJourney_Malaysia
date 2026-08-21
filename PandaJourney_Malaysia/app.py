from flask import Flask, render_template, request, redirect, url_for, session, flash, jsonify
# Using local service instead of Firebase for now
# import firebase_admin
# from firebase_admin import credentials, firestore
from services.collaboration_service_local import LocalCollaborationService
from services.saved_itinerary_service import (
    delete_itinerary,
    get_saved_itineraries,
    toggle_publish_status,
    update_saved_itinerary_details,
)

# ==========================================
# 1. Flask App Configuration
# ==========================================
app = Flask(
    __name__,
    template_folder="presentation/ui",
    static_folder="presentation/static",
    static_url_path="/static"
)
app.secret_key = "panda-demo-secret"

# ==========================================
# 2. Service Initialization (Local JSON Storage)
# ==========================================
# Using local JSON storage instead of Firebase for development
collab_service = LocalCollaborationService()

# ==========================================
# Helper Functions
# ==========================================
def get_current_user():
    return session.get("user", {
        "display_name": "Ahmad Faris",
        "email": "ahmad@email.com",
        "uid": "user_123"
    })

# ==========================================
# User & Authentication Routes
# ==========================================
@app.route("/", methods=["GET", "POST"]) # Jiading
def login():
    if request.method == "POST":
        session["user"] = {
            "display_name": "Ahmad Faris",
            "email": request.form.get("email") or "ahmad@email.com",
            "uid": "user_123"
        }
        return redirect(url_for("dashboard"))

    return render_template("login.html")

@app.route("/dashboard") # Jiading
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

@app.route("/profile", methods=["GET", "POST"]) # Jiading
def profile():
    if request.method == "POST":
        action = request.form.get("_action")

        if action == "update_profile":
            session["user"] = {
                "display_name": request.form.get("display_name") or "Ahmad Faris",
                "email": get_current_user().get("email", "ahmad@email.com"),
                "uid": get_current_user().get("uid", "user_123")
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

@app.route("/user-management") # Jiading
def user_management():
    return redirect(url_for("profile"))

@app.route("/logout", methods=["GET", "POST"]) # Jiading
def logout():
    session.clear()
    return redirect(url_for("login"))

# ==========================================
# Core Feature Routes
# ==========================================
@app.route("/smart-attraction") # Kaixi
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

@app.route("/smart-itinerary", methods=["GET", "POST"]) # Lee
def smart_itinerary():
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

@app.route("/saved-itineraries", methods=["GET", "POST"]) # Lee & Manas
def saved_itineraries():
    if request.method == "POST":
        action = request.form.get("_action")
        itinerary_id = request.form.get("itinerary_id")

        if action == "toggle_publish":
            if toggle_publish_status(itinerary_id):
                flash("Publish status updated.", "success")
            else:
                flash("Could not update publish status.", "danger")
        elif action == "delete":
            if delete_itinerary(itinerary_id):
                flash("Itinerary deleted.", "info")
            else:
                flash("Could not delete itinerary.", "danger")
        elif action == "save":
            flash("Itinerary saved.", "success")

        return redirect(url_for("saved_itineraries"))

    current_user = get_current_user()
    current_uid = current_user.get("uid")

    saved_items = get_saved_itineraries()

    my_itineraries = [{
        "id": item.get("id"),
        "title": item.get("title", "Untitled"),
        "date": item.get("date", ""),
        "stop_count": item.get("stop_count", len(item.get("selected", []))),
        "status": "Published" if item.get("is_public") else item.get("status", "Draft"),
    } for item in saved_items]

    # Fetch collaboration data from local JSON storage
    all_data = collab_service._read_data()
    itineraries = all_data.get("itineraries", {})
    invitations = all_data.get("invitations", [])

    shared_itineraries = []

    for itin_id, itin_data in itineraries.items():
        collaborators = itin_data.get("collaborators", {})
        my_membership = collaborators.get(current_uid)

        item = {
            "id": itin_id,
            "title": itin_data.get("title", "Untitled"),
            "date": itin_data.get("date", ""),
            "stop_count": len(itin_data.get("stops", [])),
            "status": itin_data.get("status", "Draft"),
        }

        if my_membership and my_membership.get("role") == "Owner":
            if not any(str(existing.get("id")) == str(itin_id) for existing in my_itineraries):
                my_itineraries.append(item)
        elif my_membership and my_membership.get("status") == "active":
            owner_uid = next(
                (uid for uid, c in collaborators.items() if c.get("role") == "Owner"),
                None
            )
            owner_name = collaborators.get(owner_uid, {}).get("name", "Someone") if owner_uid else "Someone"
            shared_item = dict(item)
            shared_item["shared_by"] = owner_name
            shared_item["role"] = my_membership.get("role", "Viewer")
            shared_itineraries.append(shared_item)

    # Pending invitations addressed to the current user
    pending_invitations = []
    for inv in invitations:
        if inv.get("invitedUid") == current_uid and inv.get("status") == "pending":
            itin = itineraries.get(inv.get("itineraryId"), {})
            owner_uid = inv.get("ownerId")
            owner_name = itin.get("collaborators", {}).get(owner_uid, {}).get("name", "Someone")
            pending_invitations.append({
                "invitation_id": inv.get("id"),
                "itinerary_id": inv.get("itineraryId"),
                "title": itin.get("title", "Untitled trip"),
                "date": itin.get("date", ""),
                "stop_count": len(itin.get("stops", [])),
                "role": inv.get("role", "Viewer"),
                "invited_by": owner_name
            })

    return render_template(
        "saved_itineraries.html",
        active_page="saved",
        current_user=current_user,
        itineraries=my_itineraries,
        shared_itineraries=shared_itineraries,
        pending_invitations=pending_invitations
    )

@app.route("/public-itinerary", methods=["GET", "POST"]) # Zham feng
def public_itinerary():
    if request.method == "POST":
        action = request.form.get("_action")

        if action == "copy":
            flash("Itinerary copied to your saved list.", "success")

        return redirect(url_for("public_itinerary"))

    return render_template(
        "public_itinerary.html",
        active_page="public",
        current_user=get_current_user()
    )

# ==========================================
# Collaborative Planning Module Routes (Manas)
# ==========================================
@app.route("/collaboration", methods=["GET", "POST"])
def collaboration():
    # Dynamic Itinerary ID passed via query parameter (?id=itin_test)
    itin_id = request.args.get('id', 'itin_test')

    # Fetch itinerary data from local JSON storage
    itin_data = collab_service.get_itinerary(itin_id)
    if not itin_data:
        saved_item = next(
            (item for item in get_saved_itineraries() if str(item.get("id")) == str(itin_id)),
            None
        )
        if saved_item:
            itin_data = collab_service.create_itinerary_from_saved(saved_item, get_current_user())

    return render_template(
        "collaboration.html",
        active_page="collaboration",
        current_user=get_current_user(),
        itinerary_id=itin_id,
        itinerary_data=itin_data,
        comments=collab_service.get_comments(itin_id).get("comments", []),
        activities=collab_service.get_activities(itin_id)
    )

# Get Comments Endpoint
@app.route('/api/collaboration/comments/<itin_id>', methods=['GET'])
def get_comments(itin_id):
    try:
        result = collab_service.get_comments(itin_id)
        return jsonify(result)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# FR 4.1: Send Invitation
@app.route('/api/collaboration/invite', methods=['POST'])
def invite():
    data = request.json or {}
    result = collab_service.invite_collaborator(
        itin_id=data.get('itineraryId'),
        invited_email=data.get('email'),
        owner_id=data.get('ownerId', get_current_user().get('uid'))
    )
    return jsonify(result)

# FR 4.2: Accept/Decline Invitation
@app.route('/api/collaboration/respond-invite', methods=['POST'])
def respond_invite():
    data = request.json or {}
    result = collab_service.respond_invitation(
        invitation_id=data.get('invitationId'),
        user_uid=data.get('userId'),
        action=data.get('action') # 'accept' or 'decline'
    )
    return jsonify(result)

# FR 4.4: Update Shared Itinerary
@app.route('/api/collaboration/update-itinerary', methods=['POST'])
def update_itinerary():
    data = request.json or {}
    result = collab_service.update_itinerary(
        itin_id=data.get('itineraryId'),
        editor_uid=data.get('editorUid'),
        stops=data.get('stops')
    )
    if result.get('success'):
        stops = collab_service.get_itinerary(data.get('itineraryId')).get('stops', [])
        update_saved_itinerary_details(
            data.get('itineraryId'),
            stop_count=len(stops),
            stops=stops
        )
    return jsonify(result)

# FR 4.5: Add Comment
@app.route('/api/collaboration/comment', methods=['POST'])
def add_comment():
    data = request.json or {}
    result = collab_service.add_comment(
        itin_id=data.get('itineraryId'),
        author_uid=data.get('authorUid'),
        author_name=data.get('authorName'),
        text=data.get('text')
    )
    return jsonify(result)

# Update Comment
@app.route('/api/collaboration/comment/update', methods=['POST'])
def update_comment():
    data = request.json or {}
    result = collab_service.update_comment(
        itin_id=data.get('itineraryId'),
        comment_id=data.get('commentId'),
        author_uid=data.get('authorUid', get_current_user().get('uid')),
        text=data.get('text')
    )
    return jsonify(result)

# Update single stop
@app.route('/api/collaboration/update-stop', methods=['POST'])
def update_stop():
    data = request.json or {}
    result = collab_service.update_stop(
        itin_id=data.get('itineraryId'),
        stop_index=data.get('stopIndex'),
        stop_data=data.get('stopData'),
        editor_uid=data.get('editorUid', get_current_user().get('uid'))
    )
    if result.get('success'):
        itinerary = collab_service.get_itinerary(data.get('itineraryId')) or {}
        stops = itinerary.get('stops', [])
        update_saved_itinerary_details(
            data.get('itineraryId'),
            stop_count=len(stops),
            stops=stops
        )
    return jsonify(result)

# Update itinerary title (plan name)
@app.route('/api/collaboration/update-title', methods=['POST'])
def update_title():
    data = request.json or {}
    result = collab_service.update_title(
        itin_id=data.get('itineraryId'),
        new_title=data.get('title'),
        editor_uid=data.get('editorUid', get_current_user().get('uid'))
    )
    if result.get('success'):
        update_saved_itinerary_details(data.get('itineraryId'), title=result.get('title'))
    return jsonify(result)

# Update itinerary date
@app.route('/api/collaboration/update-date', methods=['POST'])
def update_date():
    data = request.json or {}
    result = collab_service.update_date(
        itin_id=data.get('itineraryId'),
        new_date=data.get('date'),
        editor_uid=data.get('editorUid', get_current_user().get('uid'))
    )
    if result.get('success'):
        update_saved_itinerary_details(data.get('itineraryId'), date=result.get('date'))
    return jsonify(result)

# Get notifications for real-time updates
@app.route('/api/collaboration/notifications', methods=['GET'])
def get_notifications():
    itinerary_id = request.args.get('itineraryId', 'itin_test')
    user_uid = get_current_user().get('uid')

    try:
        notifications = collab_service.get_notifications(user_uid)
        # Filter notifications for this itinerary
        itin_notifications = [n for n in notifications if n.get('itineraryId') == itinerary_id]
        return jsonify({
            'success': True,
            'notifications': itin_notifications
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'notifications': [],
            'error': str(e)
        })

# ==========================================
# 3. Application Entry Point
# ==========================================
if __name__ == "__main__":
    app.run(debug=True)
