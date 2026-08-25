import os
from pathlib import Path
from hashlib import sha1
from datetime import date, datetime

from dotenv import load_dotenv
from flask import Flask, render_template, request, redirect, url_for, session, flash, jsonify
from services.collaboration_service_local import LocalCollaborationService
from services.firebase_migration import migrate_local_json_to_firestore
from services.itinerary_service import build_map_data, get_default_itinerary_form, make_plan
from services.smart_attraction import build_attraction_results
from services.saved_itinerary_service import (
    configure_saved_itinerary_backend,
    delete_itinerary,
    get_saved_itineraries,
    save_itinerary,
    toggle_publish_status,
    update_saved_itinerary_details,
)

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")


def configure_certificate_paths():
    try:
        import certifi
    except Exception:
        return

    ca_bundle = certifi.where()
    os.environ["GRPC_DEFAULT_SSL_ROOTS_FILE_PATH"] = ca_bundle
    os.environ["SSL_CERT_FILE"] = ca_bundle
    os.environ["REQUESTS_CA_BUNDLE"] = ca_bundle


configure_certificate_paths()


def allow_insecure_google_ssl_for_local_dev():
    if os.getenv("FIREBASE_ALLOW_INSECURE_SSL", "false").lower() not in ("1", "true", "yes", "on"):
        return

    import urllib3
    import requests

    original_request = requests.sessions.Session.request

    def request_without_google_ssl_verification(self, method, url, **kwargs):
        if "googleapis.com" in url or "google.com" in url:
            kwargs.setdefault("verify", False)
            if kwargs.get("timeout") in (None, 5, 5.0):
                kwargs["timeout"] = 20
        return original_request(self, method, url, **kwargs)

    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    requests.sessions.Session.request = request_without_google_ssl_verification


allow_insecure_google_ssl_for_local_dev()

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
# 2. Service Initialization
# ==========================================
firebase_init_error = None


def create_firebase_db():
    global firebase_init_error

    if os.getenv("USE_FIREBASE", "true").lower() not in ("1", "true", "yes", "on"):
        return None

    try:
        import firebase_admin
        from firebase_admin import credentials, firestore
        from google.cloud.firestore_v1 import Client as FirestoreClient
        from google.cloud.firestore_v1.services.firestore import client as firestore_client
        from google.cloud.firestore_v1.services.firestore.transports import rest as firestore_rest_transport

        class RestFirestoreClient(FirestoreClient):
            @property
            def _firestore_api(self):
                if self._firestore_api_internal is None:
                    self._transport = firestore_rest_transport.FirestoreRestTransport(
                        credentials=self._credentials,
                        host=self._target,
                        client_info=self._client_info,
                    )
                    self._firestore_api_internal = firestore_client.FirestoreClient(
                        transport=self._transport,
                        client_options=self._client_options,
                    )
                    firestore_client._client_info = self._client_info

                return self._firestore_api_internal

        if not firebase_admin._apps:
            credential_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
            project_id = os.getenv("FIREBASE_PROJECT_ID")
            options = {"projectId": project_id} if project_id else None

            if credential_path:
                cred = credentials.Certificate(credential_path)
                firebase_admin.initialize_app(cred, options=options)
            else:
                cred = credentials.ApplicationDefault()
                firebase_admin.initialize_app(cred, options=options)

        if os.getenv("FIREBASE_USE_REST", "false").lower() in ("1", "true", "yes", "on"):
            app_instance = firebase_admin.get_app()
            db = RestFirestoreClient(
                project=app_instance.project_id,
                credentials=app_instance.credential.get_credential(),
            )
        else:
            db = firestore.client()
        next(db.collection("_panda_firebase_healthcheck").limit(1).stream(retry=None, timeout=5), None)
        firebase_init_error = None
        return db
    except Exception as error:
        firebase_init_error = str(error)
        app.logger.warning("Firebase unavailable; using local storage: %s", error)
        return None


firebase_db = create_firebase_db()
configure_saved_itinerary_backend(firebase_db)


def create_collaboration_service():
    if firebase_db is None:
        return LocalCollaborationService()

    from services.collaboration_service import CollaborationService
    return CollaborationService(firebase_db)


collab_service = create_collaboration_service()

# ==========================================
# Helper Functions
# ==========================================
def get_current_user():
    return session.get("user", {
        "display_name": "Guest",
        "email": "guest@example.com",
        "uid": "guest"
    })


def is_logged_in_user(user):
    return bool(user and user.get("uid") and user.get("uid") != "guest")


def make_local_uid(email):
    normalized_email = (email or "guest@example.com").strip().lower()
    digest = sha1(normalized_email.encode("utf-8")).hexdigest()[:10]
    return f"user_{digest}"


def find_firebase_user_by_email(email):
    if firebase_db is None or not email:
        return None

    try:
        from google.cloud.firestore_v1 import FieldFilter

        users = (
            firebase_db.collection("users")
            .where(filter=FieldFilter("email", "==", email.strip().lower()))
            .limit(1)
            .stream(retry=None, timeout=10)
        )
        user_doc = next(users, None)
        if not user_doc:
            return None
        user = user_doc.to_dict() or {}
        user.setdefault("uid", user_doc.id)
        return user
    except Exception as error:
        app.logger.warning("Could not resolve Firebase user by email: %s", error)
        return None


def read_collaboration_data_safely():
    try:
        return collab_service._read_data()
    except Exception as error:
        app.logger.warning("Could not load collaboration data: %s", error)
        return {
            "itineraries": {},
            "invitations": [],
            "comments": {},
            "activities": {},
            "notifications": [],
            "users": {},
        }


def claim_queued_invitations_for_user(user):
    if not user or not user.get("uid") or not user.get("email"):
        return

    claim = getattr(collab_service, "claim_queued_invitations", None)
    if not claim:
        return

    try:
        claim(user)
    except Exception as error:
        app.logger.warning("Could not claim queued invitations: %s", error)

# ==========================================
# User & Authentication Routes
# ==========================================
@app.route("/", methods=["GET", "POST"]) # Jiading
def login():
    if request.method == "GET" and is_logged_in_user(session.get("user")):
        return redirect(url_for("dashboard"))

    if request.method == "POST":
        email = request.form.get("email") or "guest@example.com"
        firebase_user = find_firebase_user_by_email(email)
        display_name = (
            (firebase_user or {}).get("displayName")
            or (firebase_user or {}).get("name")
            or email.split("@")[0].replace(".", " ").replace("_", " ").title()
        )
        session["user"] = {
            "display_name": display_name or "Guest",
            "email": email,
            "uid": (firebase_user or {}).get("uid") or make_local_uid(email)
        }
        claim_queued_invitations_for_user(session["user"])
        return redirect(url_for("dashboard"))

    return render_template("login.html")


def get_itinerary_date_value(itinerary):
    return (
        (itinerary or {}).get("travel_date")
        or (itinerary or {}).get("date")
        or (itinerary or {}).get("trip_date")
        or ""
    )


def parse_itinerary_date(date_value):
    if not date_value:
        return None

    text = str(date_value).strip()
    for date_format in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%b %d, %Y", "%B %d, %Y"):
        try:
            return datetime.strptime(text, date_format).date()
        except ValueError:
            continue

    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def get_shared_itinerary_count(collaboration_data, current_uid):
    shared_ids = set()
    for itin_id, itinerary in collaboration_data.get("itineraries", {}).items():
        membership = (itinerary.get("collaborators") or {}).get(current_uid)
        if membership and membership.get("status") == "active" and membership.get("role") != "Owner":
            shared_ids.add(str(itin_id))

    for invitation in collaboration_data.get("invitations", []):
        if invitation.get("invitedUid") == current_uid and invitation.get("status") == "accepted":
            shared_ids.add(str(invitation.get("itineraryId")))

    return len(shared_ids)


def get_upcoming_trip(saved_items):
    today = date.today()
    dated_items = []

    for item in saved_items:
        trip_date = parse_itinerary_date(get_itinerary_date_value(item))
        if trip_date and trip_date >= today:
            dated_items.append((trip_date, item))

    if dated_items:
        return sorted(dated_items, key=lambda entry: entry[0])[0][1]

    return None


def get_user_dashboard_stats(current_uid):
    saved_list = get_saved_itineraries(current_uid)
    collaboration_data = read_collaboration_data_safely()
    upcoming_trip = get_upcoming_trip(saved_list)

    return {
        "saved_list": saved_list,
        "saved_count": len(saved_list),
        "favourite_count": 0,
        "shared_count": get_shared_itinerary_count(collaboration_data, current_uid),
        "upcoming_trip": upcoming_trip,
        "upcoming_date": get_itinerary_date_value(upcoming_trip) if upcoming_trip else "No Trip",
    }

@app.route("/dashboard") # Jiading
def dashboard():
    current_user = get_current_user()
    stats = get_user_dashboard_stats(current_user.get("uid"))

    return render_template(
        "dashboard.html",
        active_page="dashboard",
        current_user=current_user,
        saved_count=stats["saved_count"],
        favourite_count=stats["favourite_count"],
        shared_count=stats["shared_count"],
        upcoming_date=stats["upcoming_date"],
        recent_itineraries=stats["saved_list"][:3],
        upcoming_trip=stats["upcoming_trip"]
    )

@app.route("/create-account")
def create_account():
    return render_template("create_account.html")

@app.route("/profile", methods=["GET", "POST"]) # Jiading
def profile():
    current_user = get_current_user()
    current_uid = current_user.get("uid")

    if request.method == "POST":
        action = request.form.get("_action")

        if action == "update_profile":
            session["user"] = {
                "display_name": request.form.get("display_name") or current_user.get("display_name", "Guest"),
                "email": current_user.get("email", "guest@example.com"),
                "uid": current_uid or "guest"
            }
            flash("Profile updated.", "success")
        elif action == "update_preferences":
            flash("Preferences saved.", "success")
        elif action == "remove_favourite":
            flash("Favourite attraction removed.", "info")

        return redirect(url_for("profile"))

    stats = get_user_dashboard_stats(current_uid)

    return render_template(
        "profile.html",
        active_page="profile",
        current_user=current_user,
        user_preferences={
            "interests": [],
            "min_rating": "",
            "preferred_area": ""
        },
        favourite_attractions=[],
        saved_itineraries_preview=[],
        shared_itineraries_preview=[],
        saved_count=stats["saved_count"],
        favourite_count=stats["favourite_count"],
        shared_count=stats["shared_count"]
    )

@app.route("/user-management") # Jiading
def user_management():
    return redirect(url_for("profile"))

@app.route("/logout", methods=["GET", "POST"]) # Jiading
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/api/auth/session", methods=["POST"])
def sync_auth_session():
    payload = request.get_json(silent=True) or {}
    uid = (payload.get("uid") or "").strip()
    email = (payload.get("email") or "").strip().lower()

    if not uid:
        return jsonify({"success": False, "message": "Missing Firebase user id."}), 400

    display_name = (
        payload.get("displayName")
        or payload.get("display_name")
        or (email.split("@")[0].replace(".", " ").replace("_", " ").title() if email else "User")
    )

    session["user"] = {
        "display_name": display_name,
        "email": email,
        "uid": uid,
    }
    claim_queued_invitations_for_user(session["user"])

    return jsonify({"success": True, "user": session["user"]})

# ==========================================
# Core Feature Routes
# ==========================================
@app.route("/smart-attraction", methods=["GET", "POST"]) # Kaixi
def smart_attraction():
    filters = {
        "destination": "",
        "interests": [],
        "min_rating": "4.0",
        "weather_aware": True,
        "sort": "score",
    }
    attractions = []
    weather_status = ""
    source_note = ""
    searched = False
    results_label = "Recommended attractions"

    if request.method == "POST":
        searched = True
        filters["destination"] = request.form.get("destination", "").strip()
        filters["interests"] = request.form.getlist("interests")
        filters["min_rating"] = request.form.get("min_rating", "4.0")
        filters["weather_aware"] = bool(request.form.get("weather_aware"))
        filters["sort"] = request.form.get("sort", "score")

        if not filters["destination"]:
            flash("Please enter a destination to receive recommendations.", "error")
        else:
            try:
                attractions, weather_status, source_note = build_attraction_results(
                    destination_text=filters["destination"],
                    interest_list=filters["interests"],
                    minimum_rating=float(filters["min_rating"] or 4.0),
                    use_weather=filters["weather_aware"],
                    sort_mode=filters["sort"],
                )
                results_label = f"Showing {len(attractions)} attractions"
            except ValueError:
                flash("Invalid rating or filter input. Please revise your selection.", "error")
            except Exception as error:
                print(f"[SMART ATTRACTION ERROR] {error}")
                flash("Unable to load attraction recommendations at this time. Please try again.", "error")
    else:
        filters["destination"] = "Kuala Lumpur"
        filters["interests"] = ["culture"]
        try:
            attractions, weather_status, source_note = build_attraction_results(
                destination_text=filters["destination"],
                interest_list=filters["interests"],
                minimum_rating=float(filters["min_rating"]),
                use_weather=filters["weather_aware"],
                sort_mode=filters["sort"],
            )
            results_label = f"Showing {len(attractions)} attractions near {filters['destination']}"
        except Exception as error:
            print(f"[SMART ATTRACTION INITIAL LOAD ERROR] {error}")
            source_note = "Could not load live attractions right now. Please try searching directly."
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
    )

@app.route("/smart-itinerary", methods=["GET", "POST"]) # Lee
def smart_itinerary():
    form = get_default_itinerary_form()
    plan = None
    error = None

    if request.method == "POST":
        form.update({
            "start": request.form.get("start", ""),
            "end": request.form.get("end", ""),
            "trip_date": request.form.get("trip_date", ""),
            "start_time": request.form.get("start_time", "09:00"),
            "available_hours": int(request.form.get("available_hours", 6) or 6),
            "interests": request.form.get("interests", "culture"),
            "minimum_rating": request.form.get("minimum_rating", "4.0"),
        })
        try:
            plan = make_plan(request.form)
            session["last_generated_plan"] = plan
        except Exception as exc:
            error = str(exc)

    return render_template(
        "smart_itinerary.html",
        active_page="itinerary",
        current_user=get_current_user(),
        plan=plan,
        error=error,
        map_data=build_map_data(plan),
        form=form
    )

@app.route("/saved-itineraries", methods=["GET", "POST"]) # Lee & Manas
def saved_itineraries():
    current_user = get_current_user()
    current_uid = current_user.get("uid")

    if request.method == "POST":
        action = request.form.get("_action")
        itinerary_id = request.form.get("itinerary_id")

        if action == "toggle_publish":
            if toggle_publish_status(itinerary_id, current_uid):
                flash("Publish status updated.", "success")
            else:
                flash("Could not update publish status.", "danger")
        elif action == "delete":
            if delete_itinerary(itinerary_id, current_uid):
                flash("Itinerary deleted.", "info")
            else:
                flash("Could not delete itinerary.", "danger")
        elif action == "save":
            plan = session.get("last_generated_plan")
            if plan:
                saved_item = save_itinerary(plan, current_uid)
                collab_service.create_itinerary_from_saved(saved_item, current_user)
                flash("Itinerary saved to Firebase.", "success")
            else:
                flash("Generate an itinerary before saving.", "warning")

        return redirect(url_for("saved_itineraries"))

    saved_items = get_saved_itineraries(current_uid)

    my_itineraries = [{
        "id": item.get("id"),
        "title": item.get("title", "Untitled"),
        "date": item.get("date", ""),
        "stop_count": item.get("stop_count", len(item.get("selected", []))),
        "status": "Published" if item.get("is_public") else item.get("status", "Draft"),
    } for item in saved_items]

    # Fetch collaboration data from the configured collaboration service
    all_data = read_collaboration_data_safely()
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

# ==========================================
# Collaborative Planning Module Routes (Manas)
# ==========================================
@app.route("/collaboration", methods=["GET", "POST"])
def collaboration():
    # Dynamic Itinerary ID passed via query parameter (?id=<saved itinerary id>)
    itin_id = request.args.get('id')
    if not itin_id:
        flash("Choose a saved itinerary to collaborate on.", "warning")
        return redirect(url_for("saved_itineraries"))

    # Fetch itinerary data from local JSON storage
    itin_data = collab_service.get_itinerary(itin_id)
    if not itin_data:
        saved_item = next(
            (item for item in get_saved_itineraries(get_current_user().get("uid")) if str(item.get("id")) == str(itin_id)),
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


@app.route('/api/collaboration/activity/<itin_id>', methods=['GET'])
def get_collaboration_activity(itin_id):
    try:
        return jsonify({
            'success': True,
            'activities': collab_service.get_activities(itin_id)
        })
    except Exception as e:
        return jsonify({'success': False, 'activities': [], 'error': str(e)}), 500


@app.route('/api/collaboration/collaborators/<itin_id>', methods=['GET'])
def get_collaborators(itin_id):
    try:
        itinerary = collab_service.get_itinerary(itin_id) or {}
        return jsonify({
            'success': True,
            'collaborators': itinerary.get('collaborators', {})
        })
    except Exception as e:
        return jsonify({'success': False, 'collaborators': {}, 'error': str(e)}), 500

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


@app.route('/api/collaboration/update-role', methods=['POST'])
def update_collaborator_role():
    data = request.json or {}
    result = collab_service.update_collaborator_role(
        itin_id=data.get('itineraryId'),
        owner_uid=data.get('ownerUid', get_current_user().get('uid')),
        collaborator_uid=data.get('collaboratorUid'),
        role=data.get('role')
    )
    return jsonify(result)


@app.route('/api/collaboration/remove-collaborator', methods=['POST'])
def remove_collaborator():
    data = request.json or {}
    result = collab_service.remove_collaborator(
        itin_id=data.get('itineraryId'),
        owner_uid=data.get('ownerUid', get_current_user().get('uid')),
        collaborator_uid=data.get('collaboratorUid')
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
            user_uid=get_current_user().get('uid'),
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
            user_uid=get_current_user().get('uid'),
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
        update_saved_itinerary_details(
            data.get('itineraryId'),
            user_uid=get_current_user().get('uid'),
            title=result.get('title')
        )
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
        update_saved_itinerary_details(
            data.get('itineraryId'),
            user_uid=get_current_user().get('uid'),
            date=result.get('date')
        )
    return jsonify(result)

# Get notifications for real-time updates
@app.route('/api/collaboration/notifications', methods=['GET'])
def get_notifications():
    itinerary_id = request.args.get('itineraryId', '')
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


@app.route('/api/collaboration/notifications/read', methods=['POST'])
def mark_notifications_read():
    data = request.json or {}
    itinerary_id = data.get('itineraryId', '')
    user_uid = get_current_user().get('uid')

    try:
        updated = collab_service.mark_notifications_read(user_uid, itinerary_id)
        return jsonify({'success': True, 'updated': updated})
    except Exception as e:
        return jsonify({'success': False, 'updated': 0, 'error': str(e)}), 500


@app.route("/health/firebase", methods=["GET"])
def firebase_health():
    return jsonify({
        "firebase_connected": firebase_db is not None,
        "collaboration_backend": type(collab_service).__name__,
        "firebase_error": firebase_init_error,
        "saved_itineraries_backend": "Firestore" if firebase_db is not None else "Local JSON",
        "project_id": os.getenv("FIREBASE_PROJECT_ID"),
    })


@app.route("/admin/firebase/migrate-local", methods=["POST"])
def migrate_local_to_firebase():
    if firebase_db is None:
        return jsonify({
            "success": False,
            "message": "Firebase is not connected.",
            "firebase_error": firebase_init_error,
        }), 503

    result = migrate_local_json_to_firestore(firebase_db, collab_service, get_current_user())
    return jsonify({"success": True, **result})


@app.route("/admin/firebase/test-notification", methods=["POST"])
def create_test_notification():
    if firebase_db is None:
        return jsonify({
            "success": False,
            "message": "Firebase is not connected.",
            "firebase_error": firebase_init_error,
        }), 503

    current_user = get_current_user()
    user_uid = current_user.get("uid", "guest")
    payload = request.get_json(silent=True) or {}
    itinerary_id = request.form.get("itinerary_id") or payload.get("itinerary_id") or ""
    message = "Test notification from PandaJourney Firebase setup"

    notification = collab_service._notify(
        recipient_uid=user_uid,
        message=message,
        itin_id=itinerary_id,
        icon="test",
    )

    return jsonify({
        "success": True,
        "message": "Test notification created.",
        "collaboration_collection": "notifications",
        "erd_collection": "notifications",
        "notification": notification,
    })

# ==========================================
# 3. Application Entry Point
# ==========================================
if __name__ == "__main__":
    app.run(debug=True, port=int(os.getenv("FLASK_RUN_PORT", "5001")))
