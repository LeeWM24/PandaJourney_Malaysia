from typing import Any, Dict, List, Optional

from google.cloud.firestore_v1 import FieldFilter

from services.collaboration_service_local import LocalCollaborationService


class CollaborationService(LocalCollaborationService):
    """Firestore-backed collaboration service.

    Collaboration data is intentionally stored in module-owned collections so
    existing teammate-created itinerary documents are not overwritten.
    """

    ITINERARIES = "collaboration_itineraries"
    INVITATIONS = "collaboration_invitations"
    NOTIFICATIONS = "collaboration_notifications"
    USERS = "users"
    ERD_ITINERARIES = "itineraries"
    ERD_STOPS = "itinerary_stops"
    ERD_COLLABORATORS = "collaborators"
    ERD_COMMENTS = "comments"
    ERD_NOTIFICATIONS = "notifications"
    TIMEOUT_SECONDS = 10

    def __init__(self, db):
        self.db = db

    def _doc_data(self, doc) -> Dict[str, Any]:
        data = doc.to_dict() or {}
        data.setdefault("id", doc.id)
        return data

    def _stream(self, query):
        return query.stream(retry=None, timeout=self.TIMEOUT_SECONDS)

    def _get(self, doc_ref):
        return doc_ref.get(retry=None, timeout=self.TIMEOUT_SECONDS)

    def _read_data(self) -> Dict[str, Any]:
        itineraries = {
            doc.id: self._doc_data(doc)
            for doc in self._stream(self.db.collection(self.ITINERARIES))
        }
        invitations = [
            self._doc_data(doc)
            for doc in self._stream(self.db.collection(self.INVITATIONS))
        ]
        notifications = [
            self._doc_data(doc)
            for doc in self._stream(self.db.collection(self.NOTIFICATIONS))
        ]
        users = {
            doc.id: self._doc_data(doc)
            for doc in self._stream(self.db.collection(self.USERS))
        }

        comments: Dict[str, List[Dict[str, Any]]] = {}
        activities: Dict[str, List[Dict[str, Any]]] = {}
        for itin_id in itineraries:
            itin_ref = self.db.collection(self.ITINERARIES).document(itin_id)
            comments[itin_id] = [
                self._doc_data(doc)
                for doc in self._stream(itin_ref.collection("comments"))
            ]
            activities[itin_id] = [
                self._doc_data(doc)
                for doc in self._stream(itin_ref.collection("activities"))
            ]

        return {
            "itineraries": itineraries,
            "invitations": invitations,
            "comments": comments,
            "activities": activities,
            "notifications": notifications,
            "users": users,
        }

    def _set_user_if_missing(self, uid: str, user_data: Dict[str, Any]) -> None:
        if not uid:
            return
        payload = {
            "user_id": uid,
            "uid": uid,
            "email": user_data.get("email", ""),
            "name": user_data.get("name") or user_data.get("displayName", ""),
            "displayName": user_data.get("displayName") or user_data.get("name", ""),
            "profile_picture": user_data.get("profile_picture", ""),
            "created_at": user_data.get("created_at") or self._get_current_timestamp(),
            "updated_at": self._get_current_timestamp(),
            "is_deleted": False,
            "deleted_at": None,
        }
        self.db.collection(self.USERS).document(uid).set(payload, merge=True)

    def _mirror_itinerary_to_erd(self, itinerary: Dict[str, Any]) -> None:
        itin_id = str(itinerary.get("id") or itinerary.get("itinerary_id"))
        if not itin_id:
            return

        self.db.collection(self.ERD_ITINERARIES).document(itin_id).set({
            "itinerary_id": itin_id,
            "id": itin_id,
            "user_id": next(
                (uid for uid, data in itinerary.get("collaborators", {}).items() if data.get("role") == "Owner"),
                itinerary.get("user_id") or itinerary.get("user_uid")
            ),
            "title": itinerary.get("title", "Untitled Itinerary"),
            "travel_date": itinerary.get("travel_date") or itinerary.get("date", ""),
            "date": itinerary.get("date", ""),
            "status": itinerary.get("status", "Draft"),
            "created_at": itinerary.get("createdAt") or itinerary.get("created_at") or self._get_current_timestamp(),
            "updated_at": itinerary.get("updatedAt") or self._get_current_timestamp(),
            "stop_count": len(itinerary.get("stops", [])),
        }, merge=True)
        for index, stop in enumerate(itinerary.get("stops", []), start=1):
            stop_id = str(stop.get("stop_id") or f"{itin_id}_stop_{index}")
            self.db.collection(self.ERD_STOPS).document(stop_id).set({
                "stop_id": stop_id,
                "itinerary_id": itin_id,
                "place_id": str(stop.get("place_id") or ""),
                "name": stop.get("name", f"Stop {index}"),
                "stop_order": int(stop.get("stopNumber") or stop.get("stop_order") or index),
                "arrival_time": stop.get("arrival_time") or stop.get("time", ""),
                "departure_time": stop.get("departure_time", ""),
                "visit_duration": stop.get("visit_duration") or stop.get("duration", ""),
                "time": stop.get("time", ""),
                "duration": stop.get("duration", ""),
                "icon": stop.get("icon") or "pin",
            }, merge=True)

    def _mirror_collaborator_to_erd(
        self,
        invitation_id: str,
        itin_id: str,
        inviter_uid: str,
        invitee_email: str,
        permission: str,
        status: str,
        invitee_uid: str = "",
    ) -> None:
        collaborator_id = str(invitation_id or f"{itin_id}_{invitee_email}")
        self.db.collection(self.ERD_COLLABORATORS).document(collaborator_id).set({
            "collaborator_id": collaborator_id,
            "itinerary_id": str(itin_id),
            "inviter_user_id": inviter_uid,
            "invitee_user_id": invitee_uid,
            "invitee_email": invitee_email,
            "permission": permission,
            "status": status,
            "updated_at": self._get_current_timestamp(),
        }, merge=True)

    def _append_activity(
        self,
        data: Dict[str, Any],
        itin_id: str,
        actor_uid: str,
        actor_name: str,
        message: str,
        icon: str,
    ) -> Dict[str, Any]:
        activity = {
            "itineraryId": itin_id,
            "actorUid": actor_uid,
            "actorName": actor_name or self._get_user_name(data, actor_uid, "Someone"),
            "message": message,
            "icon": icon,
            "createdAt": self._get_current_timestamp(),
        }
        _, doc_ref = (
            self.db.collection(self.ITINERARIES)
            .document(itin_id)
            .collection("activities")
            .add(activity)
        )
        activity["id"] = doc_ref.id
        return activity

    def _notify(
        self,
        recipient_uid: str,
        message: str,
        itin_id: str,
        icon: str = "notification",
    ) -> Dict[str, Any]:
        notification = {
            "recipientUid": recipient_uid,
            "message": message,
            "itineraryId": itin_id,
            "isRead": False,
            "createdAt": self._get_current_timestamp(),
            "icon": icon,
        }
        _, doc_ref = self.db.collection(self.NOTIFICATIONS).add(notification)
        notification["id"] = doc_ref.id
        self.db.collection(self.ERD_NOTIFICATIONS).document(doc_ref.id).set({
            "notification_id": doc_ref.id,
            "user_id": recipient_uid,
            "type": icon,
            "title": message,
            "message": message,
            "reference_id": itin_id,
            "is_read": False,
            "created_at": notification["createdAt"],
        }, merge=True)
        return notification

    def create_itinerary_from_saved(
        self,
        saved_item: Dict[str, Any],
        owner: Dict[str, Any],
    ) -> Dict[str, Any]:
        itin_id = str(saved_item.get("id"))
        itin_ref = self.db.collection(self.ITINERARIES).document(itin_id)
        existing = self._get(itin_ref)
        if existing.exists:
            return self._normalize_itinerary_for_display(self._doc_data(existing))

        owner_uid = owner.get("uid", "user_123")
        owner_email = owner.get("email", "")
        owner_name = owner.get("display_name") or owner.get("displayName") or "You"
        now = self._get_current_timestamp()

        self._set_user_if_missing(owner_uid, {
            "uid": owner_uid,
            "displayName": owner_name,
            "email": owner_email,
        })

        itinerary = {
            "id": itin_id,
            "sourceType": "saved_itinerary",
            "sourceItineraryId": itin_id,
            "title": saved_item.get("title", "Untitled Itinerary"),
            "date": saved_item.get("date", ""),
            "stops": self._normalize_stops_for_save(self._default_stops_from_saved(saved_item)),
            "collaborators": {
                owner_uid: {
                    "role": "Owner",
                    "status": "active",
                    "name": owner_name,
                    "email": owner_email,
                }
            },
            "collaboratorEmails": [owner_email] if owner_email else [],
            "createdAt": now,
            "updatedAt": now,
            "lastEditedBy": owner_uid,
        }
        itin_ref.set(itinerary)
        self._mirror_itinerary_to_erd(itinerary)
        return self._normalize_itinerary_for_display(itinerary)

    def invite_collaborator(self, itin_id: str, invited_email: str, owner_id: str) -> Dict[str, Any]:
        data = self._read_data()
        itinerary = data["itineraries"].get(str(itin_id))
        if not itinerary:
            return {"success": False, "message": "Itinerary not found"}

        invited_email = (invited_email or "").strip().lower()
        if not invited_email:
            return {"success": False, "message": "Email is required"}

        collaborator_emails = itinerary.setdefault("collaboratorEmails", [])
        if invited_email in [email.lower() for email in collaborator_emails]:
            return {"success": False, "message": "This user is already invited or collaborating"}

        users = (
            self.db.collection(self.USERS)
            .where(filter=FieldFilter("email", "==", invited_email))
            .limit(1)
            .stream(retry=None, timeout=self.TIMEOUT_SECONDS)
        )
        user_doc = next(users, None)

        if user_doc:
            invited_uid = user_doc.id
            user = self._doc_data(user_doc)
            invitation = {
                "itineraryId": str(itin_id),
                "invitedEmail": invited_email,
                "invitedUid": invited_uid,
                "ownerId": owner_id,
                "status": "pending",
                "role": "Viewer",
                "createdAt": self._get_current_timestamp(),
            }
            _, inv_ref = self.db.collection(self.INVITATIONS).add(invitation)
            invitation["id"] = inv_ref.id
            self._mirror_collaborator_to_erd(inv_ref.id, itin_id, owner_id, invited_email, "Viewer", "pending", invited_uid)

            collaborator = {
                "role": "Viewer",
                "status": "pending",
                "name": user.get("displayName") or user.get("name") or invited_email,
                "email": invited_email,
            }
            itinerary["collaborators"][invited_uid] = collaborator
            itinerary["collaboratorEmails"] = collaborator_emails + [invited_email]
            self.db.collection(self.ITINERARIES).document(str(itin_id)).set({
                "collaborators": itinerary["collaborators"],
                "collaboratorEmails": itinerary["collaboratorEmails"],
                "updatedAt": self._get_current_timestamp(),
            }, merge=True)
            self._notify(invited_uid, "You were invited to collaborate on an itinerary!", str(itin_id), "invite")
            self._append_activity(data, str(itin_id), owner_id, self._get_user_name(data, owner_id, "Someone"), f"Invitation sent to {invited_email}", "invite")
            return {"success": True, "message": "Invitation sent successfully!", "invitation": invitation, "collaborator": collaborator}

            self._append_activity(data, str(itin_id), owner_id, self._get_user_name(data, owner_id, "Someone"), f"External invitation queued for {invited_email}", "invite")
        self._mirror_collaborator_to_erd("", itin_id, owner_id, invited_email, "Viewer", "queued")
        return {"success": True, "message": "External email invitation queued."}

    def respond_invitation(self, invitation_id: str, user_uid: str, action: str) -> Dict[str, Any]:
        inv_ref = self.db.collection(self.INVITATIONS).document(str(invitation_id))
        inv_doc = self._get(inv_ref)
        if not inv_doc.exists:
            return {"success": False, "message": "Invitation not found"}
        if action not in ("accept", "decline"):
            return {"success": False, "message": "Invalid action"}

        invitation = self._doc_data(inv_doc)
        inv_ref.set({
            "status": "accepted" if action == "accept" else "declined",
            "respondedAt": self._get_current_timestamp(),
        }, merge=True)
        self._mirror_collaborator_to_erd(
            invitation_id,
            invitation.get("itineraryId"),
            invitation.get("ownerId"),
            invitation.get("invitedEmail"),
            invitation.get("role", "Viewer"),
            "accepted" if action == "accept" else "declined",
            invitation.get("invitedUid", user_uid),
        )

        if action == "accept":
            itin_id = invitation.get("itineraryId")
            itin_ref = self.db.collection(self.ITINERARIES).document(str(itin_id))
            itin_doc = self._get(itin_ref)
            if itin_doc.exists:
                data = self._read_data()
                itinerary = self._doc_data(itin_doc)
                collaborators = itinerary.get("collaborators", {})
                collaborators.setdefault(user_uid, {})
                collaborators[user_uid]["status"] = "active"
                itin_ref.set({"collaborators": collaborators}, merge=True)
                user_name = self._get_user_name(data, user_uid, "Someone")
                self._append_activity(data, str(itin_id), user_uid, user_name, f"{user_name} accepted the invitation", "accepted")

        return {"success": True, "message": f"Invitation {action}ed" if action == "accept" else "Invitation declined"}

    def update_itinerary(self, itin_id: str, editor_uid: str, stops: List[Dict[str, Any]]) -> Dict[str, Any]:
        if not isinstance(stops, list):
            return {"success": False, "message": "Stops must be a list"}
        itin_ref = self.db.collection(self.ITINERARIES).document(str(itin_id))
        itin_doc = self._get(itin_ref)
        if not itin_doc.exists:
            return {"success": False, "message": "Itinerary not found"}

        data = self._read_data()
        stops = self._normalize_stops_for_save(stops)
        itin_ref.set({
            "stops": stops,
            "updatedAt": self._get_current_timestamp(),
            "lastEditedBy": editor_uid,
        }, merge=True)
        self._mirror_itinerary_to_erd({**self._doc_data(itin_doc), "stops": stops, "updatedAt": self._get_current_timestamp()})
        editor_name = self._get_user_name(data, editor_uid, "Someone")
        self._append_activity(data, str(itin_id), editor_uid, editor_name, f"{editor_name} updated the itinerary with {len(stops)} stops", "edited")

        for collab_uid, collab_data in self._doc_data(itin_doc).get("collaborators", {}).items():
            if collab_uid != editor_uid and collab_data.get("status") == "active":
                self._notify(collab_uid, f"Itinerary was updated with {len(stops)} stops", str(itin_id), "edited")
        return {"success": True, "message": "Itinerary updated successfully"}

    def add_comment(self, itin_id: str, author_uid: str, author_name: str, text: str) -> Dict[str, Any]:
        text = (text or "").strip()
        if not text:
            return {"success": False, "message": "Comment cannot be empty"}
        comment = {
            "authorUid": author_uid,
            "authorName": author_name,
            "text": text,
            "createdAt": self._get_current_timestamp(),
        }
        _, doc_ref = (
            self.db.collection(self.ITINERARIES)
            .document(str(itin_id))
            .collection("comments")
            .add(comment)
        )
        comment["id"] = doc_ref.id
        self.db.collection(self.ERD_COMMENTS).document(doc_ref.id).set({
            "comment_id": doc_ref.id,
            "itinerary_id": str(itin_id),
            "user_id": author_uid,
            "parent_comment_id": None,
            "comment_text": text,
            "text": text,
            "created_at": comment["createdAt"],
        }, merge=True)

        data = self._read_data()
        activity_name = author_name or self._get_user_name(data, author_uid, "Someone")
        self._append_activity(data, str(itin_id), author_uid, activity_name, f"{activity_name} added a comment", "comment")
        self.db.collection(self.ITINERARIES).document(str(itin_id)).set({
            "lastActivityAt": self._get_current_timestamp()
        }, merge=True)

        itinerary = data.get("itineraries", {}).get(str(itin_id), {})
        for collab_uid, collab_data in itinerary.get("collaborators", {}).items():
            if collab_uid != author_uid and collab_data.get("status") == "active":
                self._notify(collab_uid, f"{activity_name} added a comment", str(itin_id), "comment")
        return {"success": True, "message": "Comment added successfully", "comment": comment}

    def update_comment(self, itin_id: str, comment_id: str, author_uid: str, text: str) -> Dict[str, Any]:
        text = (text or "").strip()
        if not text:
            return {"success": False, "message": "Comment cannot be empty"}
        comment_ref = (
            self.db.collection(self.ITINERARIES)
            .document(str(itin_id))
            .collection("comments")
            .document(str(comment_id))
        )
        comment_doc = self._get(comment_ref)
        if not comment_doc.exists:
            return {"success": False, "message": "Comment not found"}
        comment = self._doc_data(comment_doc)
        if comment.get("authorUid") and comment.get("authorUid") != author_uid:
            return {"success": False, "message": "You can only edit your own comment"}

        comment_ref.set({"text": text, "updatedAt": self._get_current_timestamp()}, merge=True)
        comment.update({"text": text, "updatedAt": self._get_current_timestamp()})
        self.db.collection(self.ERD_COMMENTS).document(str(comment_id)).set({
            "comment_text": text,
            "text": text,
            "updated_at": comment["updatedAt"],
        }, merge=True)
        data = self._read_data()
        actor_name = self._get_user_name(data, author_uid, "Someone")
        self._append_activity(data, str(itin_id), author_uid, actor_name, f"{actor_name} edited a comment", "edited")
        return {"success": True, "message": "Comment updated successfully", "comment": comment}

    def get_comments(self, itin_id: str) -> Dict[str, Any]:
        comments = []
        docs = (
            self.db.collection(self.ITINERARIES)
            .document(str(itin_id))
            .collection("comments")
            .stream(retry=None, timeout=self.TIMEOUT_SECONDS)
        )
        for doc in docs:
            comment = self._doc_data(doc)
            created_at = comment.get("updatedAt") or comment.get("createdAt", "")
            comments.append({**comment, "timeAgo": self._format_time_ago(created_at)})
        comments.sort(key=lambda item: self._parse_timestamp(item.get("createdAt", "")))
        return {"success": True, "comments": comments}

    def update_stop(self, itin_id: str, stop_index: int, stop_data: Dict[str, Any], editor_uid: str) -> Dict[str, Any]:
        itinerary = self.get_itinerary(str(itin_id))
        if not itinerary:
            return {"success": False, "message": "Itinerary not found"}
        try:
            stop_index = int(stop_index)
        except (TypeError, ValueError):
            return {"success": False, "message": "Invalid stop index"}
        stops = itinerary.get("stops", [])
        if stop_index < 0 or stop_index >= len(stops):
            return {"success": False, "message": "Invalid stop index"}
        stops[stop_index] = {
            **stops[stop_index],
            **(stop_data or {}),
            "stopNumber": int((stop_data or {}).get("stopNumber") or stops[stop_index].get("stopNumber") or stop_index + 1),
            "updatedAt": self._get_current_timestamp(),
            "updatedBy": editor_uid,
        }
        result = self.update_itinerary(str(itin_id), editor_uid, stops)
        if result.get("success"):
            return {"success": True, "message": "Stop updated successfully"}
        return result

    def update_title(self, itin_id: str, new_title: str, editor_uid: str) -> Dict[str, Any]:
        new_title = (new_title or "").strip()
        if not new_title:
            return {"success": False, "message": "Title cannot be empty"}
        return self._update_field(str(itin_id), "title", new_title, editor_uid, f"renamed the trip to \"{new_title}\"", {"title": new_title})

    def update_date(self, itin_id: str, new_date: str, editor_uid: str) -> Dict[str, Any]:
        new_date = (new_date or "").strip()
        if not new_date:
            return {"success": False, "message": "Date cannot be empty"}
        return self._update_field(str(itin_id), "date", new_date, editor_uid, f"changed the trip date to \"{new_date}\"", {"date": new_date})

    def _update_field(
        self,
        itin_id: str,
        field_name: str,
        value: str,
        editor_uid: str,
        message_suffix: str,
        payload: Dict[str, Any],
    ) -> Dict[str, Any]:
        itin_ref = self.db.collection(self.ITINERARIES).document(itin_id)
        itin_doc = self._get(itin_ref)
        if not itin_doc.exists:
            return {"success": False, "message": "Itinerary not found"}
        data = self._read_data()
        itin_ref.set({
            field_name: value,
            "updatedAt": self._get_current_timestamp(),
            "lastEditedBy": editor_uid,
        }, merge=True)
        self.db.collection(self.ERD_ITINERARIES).document(itin_id).set({
            field_name: value,
            "updated_at": self._get_current_timestamp(),
        }, merge=True)
        editor_name = self._get_user_name(data, editor_uid, "Someone")
        self._append_activity(data, itin_id, editor_uid, editor_name, f"{editor_name} {message_suffix}", "edited")
        for collab_uid, collab_data in self._doc_data(itin_doc).get("collaborators", {}).items():
            if collab_uid != editor_uid and collab_data.get("status") == "active":
                self._notify(collab_uid, f"Trip {message_suffix}", itin_id, "edited")
        return {"success": True, "message": f"{field_name.title()} updated successfully", **payload}

    def get_itinerary(self, itin_id: str) -> Optional[Dict[str, Any]]:
        doc = self._get(self.db.collection(self.ITINERARIES).document(str(itin_id)))
        if not doc.exists:
            return None
        return self._normalize_itinerary_for_display(self._doc_data(doc))

    def get_activities(self, itin_id: str) -> List[Dict[str, Any]]:
        return super().get_activities(str(itin_id))

    def get_notifications(self, user_uid: str) -> List[Dict[str, Any]]:
        return super().get_notifications(user_uid)
