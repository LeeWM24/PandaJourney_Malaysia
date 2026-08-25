from typing import Any, Dict, List, Optional

from google.cloud.firestore_v1 import FieldFilter

from services.collaboration_service_local import LocalCollaborationService


class CollaborationService(LocalCollaborationService):
    """Firestore-backed collaboration service.

    Collaboration data uses the shared ERD collections used by the rest of the
    app: Itinerary, itinerary_stops, collaborators, comments, and notifications.
    """

    ITINERARIES = "Itinerary"
    NOTIFICATIONS = "notifications"
    USERS = "users"
    STOPS = "itinerary_stops"
    COLLABORATORS = "collaborators"
    COMMENTS = "comments"
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
        itineraries = {}
        for doc in self._stream(self.db.collection(self.ITINERARIES)):
            itinerary = self._with_stops_and_collaborators(self._doc_data(doc))
            itineraries[doc.id] = itinerary

        invitations = self._collaborators_as_invitations(status="pending")
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
            comments[itin_id] = [
                self._doc_data(doc)
                for doc in self._stream(
                    self.db.collection(self.COMMENTS).where(
                        filter=FieldFilter("itinerary_id", "==", str(itin_id))
                    )
                )
            ]
            activities[itin_id] = [
                self._doc_data(doc)
                for doc in self._stream(
                    self.db.collection(self.ITINERARIES).document(itin_id).collection("activities")
                )
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

    def _get_itinerary_stops(self, itin_id: str) -> List[Dict[str, Any]]:
        stops = []
        query = self.db.collection(self.STOPS).where(
            filter=FieldFilter("itinerary_id", "==", str(itin_id))
        )
        for doc in self._stream(query):
            stop = self._doc_data(doc)
            stop["name"] = stop.get("name") or stop.get("stop_name") or stop.get("title") or f"Stop {len(stops) + 1}"
            stop["stopNumber"] = int(stop.get("stopNumber") or stop.get("stop_order") or len(stops) + 1)
            stop["time"] = stop.get("time") or stop.get("arrival_time") or ""
            stop["duration"] = (
                stop.get("duration")
                or stop.get("visit_duration")
                or self._format_minutes_as_duration(stop.get("visit_duration_minutes"))
            )
            stops.append(stop)
        return sorted(stops, key=lambda stop: int(stop.get("stopNumber") or stop.get("stop_order") or 0))

    def _get_itinerary_collaborators(self, itin_id: str) -> Dict[str, Dict[str, Any]]:
        collaborators = {}
        query = self.db.collection(self.COLLABORATORS).where(
            filter=FieldFilter("itinerary_id", "==", str(itin_id))
        )
        for doc in self._stream(query):
            row = self._doc_data(doc)
            uid = row.get("invitee_user_id") or row.get("user_id") or row.get("owner_user_id")
            if not uid:
                continue
            raw_status = row.get("status", "pending")
            collaborators[uid] = {
                "role": row.get("role") or row.get("permission") or "Viewer",
                "status": "active" if raw_status == "accepted" else "pending" if raw_status == "queued" else raw_status,
                "name": row.get("name") or row.get("invitee_name") or row.get("invitee_email") or uid,
                "email": row.get("invitee_email") or row.get("email", ""),
                "collaborator_id": doc.id,
            }
        return collaborators

    def _can_edit_itinerary(self, itin_id: str, user_uid: str) -> bool:
        itinerary_doc = self._get(self.db.collection(self.ITINERARIES).document(str(itin_id)))
        if itinerary_doc.exists:
            itinerary = self._doc_data(itinerary_doc)
            if str(itinerary.get("user_id") or itinerary.get("user_uid")) == str(user_uid):
                return True

        collaborators = self._get_itinerary_collaborators(str(itin_id))
        collaborator = collaborators.get(str(user_uid), {})
        return collaborator.get("status") == "active" and collaborator.get("role") in ("Owner", "Editor")

    def _with_stops_and_collaborators(self, itinerary: Dict[str, Any]) -> Dict[str, Any]:
        itin_id = str(itinerary.get("itinerary_id") or itinerary.get("id"))
        itinerary["id"] = itin_id
        itinerary["date"] = itinerary.get("date") or itinerary.get("travel_date") or ""
        embedded_stops = itinerary.get("stops")
        if not isinstance(embedded_stops, list):
            embedded_stops = []
        itinerary["stops"] = self._normalize_stops_for_save(
            embedded_stops or self._get_itinerary_stops(itin_id)
        )
        collaborators = self._get_itinerary_collaborators(itin_id)
        owner_uid = itinerary.get("user_uid") or itinerary.get("user_id")
        if owner_uid:
            owner = self._get(self.db.collection(self.USERS).document(str(owner_uid)))
            owner_data = self._doc_data(owner) if owner.exists else {}
            collaborators.setdefault(str(owner_uid), {
                "role": "Owner",
                "status": "active",
                "name": owner_data.get("displayName") or owner_data.get("name") or "Owner",
                "email": owner_data.get("email", ""),
            })
        itinerary["collaborators"] = collaborators
        itinerary["collaboratorEmails"] = [
            data.get("email") for data in collaborators.values() if data.get("email")
        ]
        return itinerary

    def _write_itinerary_data(self, itinerary: Dict[str, Any]) -> None:
        itin_id = str(itinerary.get("id") or itinerary.get("itinerary_id"))
        if not itin_id:
            return

        self.db.collection(self.ITINERARIES).document(itin_id).set({
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
            self.db.collection(self.STOPS).document(stop_id).set({
                "stop_id": stop_id,
                "itinerary_id": itin_id,
                "place_id": str(stop.get("place_id") or ""),
                "name": stop.get("name") or stop.get("stop_name") or f"Stop {index}",
                "stop_order": int(stop.get("stopNumber") or stop.get("stop_order") or index),
                "arrival_time": stop.get("arrival_time") or stop.get("time", ""),
                "departure_time": stop.get("departure_time", ""),
                "visit_duration": stop.get("visit_duration") or stop.get("duration") or self._format_minutes_as_duration(stop.get("visit_duration_minutes")),
                "time": stop.get("time", ""),
                "duration": stop.get("duration", ""),
                "icon": stop.get("icon") or "pin",
            }, merge=True)

    def _write_collaborator(
        self,
        collaborator_id: str,
        itin_id: str,
        inviter_uid: str,
        invitee_email: str,
        permission: str,
        status: str,
        invitee_uid: str = "",
    ) -> None:
        collaborator_id = str(collaborator_id or f"{itin_id}_{invitee_email}")
        self.db.collection(self.COLLABORATORS).document(collaborator_id).set({
            "collaborator_id": collaborator_id,
            "itinerary_id": str(itin_id),
            "inviter_user_id": inviter_uid,
            "invitee_user_id": invitee_uid,
            "invitee_email": invitee_email,
            "permission": permission,
            "status": status,
            "updated_at": self._get_current_timestamp(),
        }, merge=True)

    def _queued_invite_uid(self, email: str) -> str:
        return f"pending_{email.replace('@', '_at_').replace('.', '_')}"

    def claim_queued_invitations(self, user: Dict[str, Any]) -> int:
        uid = str(user.get("uid") or "")
        email = (user.get("email") or "").strip().lower()
        display_name = user.get("display_name") or user.get("displayName") or user.get("name") or email

        if not uid or not email:
            return 0

        self._set_user_if_missing(uid, {
            "uid": uid,
            "displayName": display_name,
            "email": email,
        })

        claimed = 0
        queued = (
            self.db.collection(self.COLLABORATORS)
            .where(filter=FieldFilter("invitee_email", "==", email))
            .where(filter=FieldFilter("status", "==", "queued"))
        )

        for doc in self._stream(queued):
            row = self._doc_data(doc)
            itin_id = str(row.get("itinerary_id") or "")
            if not itin_id:
                continue

            now = self._get_current_timestamp()
            doc.reference.set({
                "invitee_user_id": uid,
                "status": "pending",
                "updated_at": now,
            }, merge=True)

            itinerary = self.get_itinerary(itin_id) or {}
            collaborators = itinerary.setdefault("collaborators", {})
            pending_uid = self._queued_invite_uid(email)
            pending_collaborator = collaborators.pop(pending_uid, {})
            collaborators[uid] = {
                **pending_collaborator,
                "role": pending_collaborator.get("role") or row.get("permission") or "Viewer",
                "status": "pending",
                "name": display_name,
                "email": email,
            }
            self.db.collection(self.ITINERARIES).document(itin_id).set({
                "collaborators": collaborators,
                "updatedAt": now,
                "updated_at": now,
            }, merge=True)
            claimed += 1

        return claimed

    def _collaborators_as_invitations(self, status: str = "") -> List[Dict[str, Any]]:
        invitations = []
        query = self.db.collection(self.COLLABORATORS)
        if status:
            query = query.where(filter=FieldFilter("status", "==", status))
        for doc in self._stream(query):
            row = self._doc_data(doc)
            invitations.append({
                "id": doc.id,
                "itineraryId": row.get("itinerary_id"),
                "invitedEmail": row.get("invitee_email"),
                "invitedUid": row.get("invitee_user_id"),
                "ownerId": row.get("inviter_user_id"),
                "status": row.get("status"),
                "role": row.get("permission") or row.get("role", "Viewer"),
                "createdAt": row.get("created_at", ""),
            })
        return invitations

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
        now = self._get_current_timestamp()
        query = self.db.collection(self.NOTIFICATIONS).where(
            filter=FieldFilter("user_id", "==", str(recipient_uid))
        )
        for doc in self._stream(query):
            existing = self._doc_data(doc)
            if (
                (existing.get("itineraryId") == itin_id or existing.get("reference_id") == itin_id)
                and existing.get("message") == message
                and (existing.get("icon") == icon or existing.get("type") == icon)
                and not existing.get("isRead")
                and self._timestamps_are_close(existing.get("createdAt") or existing.get("created_at", ""), now, 12)
            ):
                return existing
        notification = {
            "notification_id": "",
            "user_id": recipient_uid,
            "type": icon,
            "title": message,
            "recipientUid": recipient_uid,
            "message": message,
            "itineraryId": itin_id,
            "reference_id": itin_id,
            "isRead": False,
            "is_read": False,
            "createdAt": now,
            "created_at": now,
            "icon": icon,
        }
        _, doc_ref = self.db.collection(self.NOTIFICATIONS).add(notification)
        notification["id"] = doc_ref.id
        self.db.collection(self.NOTIFICATIONS).document(doc_ref.id).set({"notification_id": doc_ref.id}, merge=True)
        return notification

    def create_notification(
        self,
        recipient_uid: str,
        message: str,
        itin_id: str,
        icon: str = "notification",
    ) -> Dict[str, Any]:
        return self._notify(recipient_uid, message, itin_id, icon)

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

        owner_uid = owner.get("uid") or "guest"
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
        self._write_itinerary_data(itinerary)
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
            invitation_id = f"{itin_id}_{invited_uid}"
            invitation = {
                "id": invitation_id,
                "itineraryId": str(itin_id),
                "invitedEmail": invited_email,
                "invitedUid": invited_uid,
                "ownerId": owner_id,
                "status": "pending",
                "role": "Viewer",
                "createdAt": self._get_current_timestamp(),
            }
            self._write_collaborator(invitation_id, itin_id, owner_id, invited_email, "Viewer", "pending", invited_uid)

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
            owner_name = self._get_user_name(data, owner_id, "Someone")
            itinerary_title = itinerary.get("title", "an itinerary")
            self._notify(invited_uid, f"{owner_name} invited you to collaborate on \"{itinerary_title}\"", str(itin_id), "invite")
            self._append_activity(data, str(itin_id), owner_id, owner_name, f"Invitation sent to {invited_email}", "invite")
            return {"success": True, "message": "Invitation sent successfully!", "invitation": invitation, "collaborator": collaborator}

        invitation_id = f"{itin_id}_{invited_email}"
        pending_uid = self._queued_invite_uid(invited_email)
        self._write_collaborator(invitation_id, itin_id, owner_id, invited_email, "Viewer", "queued", pending_uid)
        owner_name = self._get_user_name(data, owner_id, "Someone")
        itinerary_title = itinerary.get("title", "an itinerary")
        try:
            email_result = self._send_external_invite_email(invited_email, owner_name, itinerary_title)
        except Exception as error:
            email_result = {
                "sent": False,
                "reason": f"Email send failed: {error}",
                "to": invited_email,
            }
        self._append_activity(
            data,
            str(itin_id),
            owner_id,
            owner_name,
            f"Email invitation sent to unregistered user {invited_email}" if email_result.get("sent") else f"External invitation queued for {invited_email}",
            "invite"
        )
        collaborator_emails.append(invited_email)
        itinerary.setdefault("collaborators", {})[pending_uid] = {
            "role": "Viewer",
            "status": "pending",
            "name": invited_email,
            "email": invited_email,
        }
        self.db.collection(self.ITINERARIES).document(str(itin_id)).set({
            "collaborators": itinerary["collaborators"],
            "collaboratorEmails": collaborator_emails,
            "updatedAt": self._get_current_timestamp(),
        }, merge=True)
        return {
            "success": True,
            "message": (
                "Invitation email sent. They can register to join this itinerary."
                if email_result.get("sent")
                else "External invitation queued. Configure SMTP settings to send the email."
            ),
            "emailQueued": True,
            "email": email_result,
        }

    def respond_invitation(self, invitation_id: str, user_uid: str, action: str) -> Dict[str, Any]:
        inv_ref = self.db.collection(self.COLLABORATORS).document(str(invitation_id))
        inv_doc = self._get(inv_ref)
        if not inv_doc.exists:
            return {"success": False, "message": "Invitation not found"}
        if action not in ("accept", "decline"):
            return {"success": False, "message": "Invalid action"}

        invitation = self._doc_data(inv_doc)
        inv_ref.set({
            "status": "accepted" if action == "accept" else "declined",
            "respondedAt": self._get_current_timestamp(),
            "responded_at": self._get_current_timestamp(),
        }, merge=True)

        if action == "accept":
            itin_id = invitation.get("itinerary_id")
            itin_ref = self.db.collection(self.ITINERARIES).document(str(itin_id))
            itin_doc = self._get(itin_ref)
            if itin_doc.exists:
                data = self._read_data()
                collaborators = self._get_itinerary_collaborators(str(itin_id))
                collaborators.setdefault(user_uid, {})
                collaborators[user_uid]["status"] = "active"
                itin_ref.set({"collaborators": collaborators}, merge=True)
                user_name = self._get_user_name(data, user_uid, "Someone")
                self._append_activity(data, str(itin_id), user_uid, user_name, f"{user_name} accepted the invitation", "accepted")

        return {"success": True, "message": f"Invitation {action}ed" if action == "accept" else "Invitation declined"}

    def _get_collaborator_doc_refs(self, itin_id: str, collaborator_uid: str) -> List[Any]:
        refs = []
        for field_name in ("invitee_user_id", "user_id", "owner_user_id"):
            query = (
                self.db.collection(self.COLLABORATORS)
                .where(filter=FieldFilter("itinerary_id", "==", str(itin_id)))
                .where(filter=FieldFilter(field_name, "==", str(collaborator_uid)))
            )
            for doc in self._stream(query):
                refs.append(doc.reference)
        unique_refs = {}
        for ref in refs:
            unique_refs[ref.id] = ref
        return list(unique_refs.values())

    def update_collaborator_role(self, itin_id: str, owner_uid: str, collaborator_uid: str, role: str) -> Dict[str, Any]:
        if role not in ("Editor", "Viewer"):
            return {"success": False, "message": "Invalid role"}

        itinerary = self.get_itinerary(str(itin_id))
        if not itinerary:
            return {"success": False, "message": "Itinerary not found"}

        collaborators = itinerary.get("collaborators", {})
        if collaborators.get(str(owner_uid), {}).get("role") != "Owner":
            return {"success": False, "message": "Only the owner can change collaborator roles"}

        collaborator = collaborators.get(str(collaborator_uid))
        if not collaborator:
            return {"success": False, "message": "Collaborator not found"}
        if collaborator.get("role") == "Owner":
            return {"success": False, "message": "Owner role cannot be changed"}

        now = self._get_current_timestamp()
        for ref in self._get_collaborator_doc_refs(str(itin_id), str(collaborator_uid)):
            ref.set({
                "permission": role,
                "role": role,
                "status": "accepted",
                "updated_at": now,
            }, merge=True)

        collaborators[str(collaborator_uid)]["role"] = role
        collaborators[str(collaborator_uid)]["status"] = "active"
        self.db.collection(self.ITINERARIES).document(str(itin_id)).set({
            "collaborators": collaborators,
            "updatedAt": now,
            "updated_at": now,
        }, merge=True)

        data = self._read_data()
        self._append_activity(
            data,
            str(itin_id),
            str(owner_uid),
            self._get_user_name(data, str(owner_uid), "Owner"),
            f"{collaborator.get('name') or collaborator_uid} assigned as {role}",
            "role"
        )
        self._notify(str(collaborator_uid), f"Your itinerary role changed to {role}", str(itin_id), "role")
        return {"success": True, "message": "Role updated", "role": role}

    def remove_collaborator(self, itin_id: str, owner_uid: str, collaborator_uid: str) -> Dict[str, Any]:
        itinerary = self.get_itinerary(str(itin_id))
        if not itinerary:
            return {"success": False, "message": "Itinerary not found"}

        collaborators = itinerary.get("collaborators", {})
        if collaborators.get(str(owner_uid), {}).get("role") != "Owner":
            return {"success": False, "message": "Only the owner can remove collaborators"}

        collaborator = collaborators.get(str(collaborator_uid))
        if not collaborator:
            return {"success": False, "message": "Collaborator not found"}
        if collaborator.get("role") == "Owner":
            return {"success": False, "message": "Owner cannot be removed"}

        removed_name = collaborator.get("name") or str(collaborator_uid)
        removed_email = collaborator.get("email", "")
        for ref in self._get_collaborator_doc_refs(str(itin_id), str(collaborator_uid)):
            ref.delete()

        collaborators.pop(str(collaborator_uid), None)
        collaborator_emails = [
            email for email in itinerary.get("collaboratorEmails", [])
            if email.lower() != removed_email.lower()
        ]
        now = self._get_current_timestamp()
        self.db.collection(self.ITINERARIES).document(str(itin_id)).set({
            "collaborators": collaborators,
            "collaboratorEmails": collaborator_emails,
            "updatedAt": now,
            "updated_at": now,
        }, merge=True)

        data = self._read_data()
        self._append_activity(
            data,
            str(itin_id),
            str(owner_uid),
            self._get_user_name(data, str(owner_uid), "Owner"),
            f"{removed_name} was removed from the plan",
            "removed"
        )
        self._notify(str(collaborator_uid), "You were removed from an itinerary", str(itin_id), "removed")
        return {"success": True, "message": "Collaborator removed"}

    def update_itinerary(self, itin_id: str, editor_uid: str, stops: List[Dict[str, Any]]) -> Dict[str, Any]:
        if not isinstance(stops, list):
            return {"success": False, "message": "Stops must be a list"}
        itin_ref = self.db.collection(self.ITINERARIES).document(str(itin_id))
        itin_doc = self._get(itin_ref)
        if not itin_doc.exists:
            return {"success": False, "message": "Itinerary not found"}
        if not self._can_edit_itinerary(str(itin_id), str(editor_uid)):
            return {"success": False, "message": "You do not have permission to edit this itinerary"}

        data = self._read_data()
        stops = self._normalize_stops_for_save(stops)
        itin_ref.set({
            "stops": stops,
            "updatedAt": self._get_current_timestamp(),
            "lastEditedBy": editor_uid,
        }, merge=True)
        self._write_itinerary_data({**self._doc_data(itin_doc), "stops": stops, "updatedAt": self._get_current_timestamp()})
        editor_name = self._get_user_name(data, editor_uid, "Someone")
        self._append_activity(data, str(itin_id), editor_uid, editor_name, f"{editor_name} updated the itinerary with {len(stops)} stops", "edited")

        for collab_uid, collab_data in self._get_itinerary_collaborators(str(itin_id)).items():
            if collab_uid != editor_uid and collab_data.get("status") == "active":
                self._notify(collab_uid, f"{editor_name} updated the itinerary to {len(stops)} stops", str(itin_id), "edited")
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
        _, doc_ref = self.db.collection(self.COMMENTS).add({
            **comment,
            "itinerary_id": str(itin_id),
            "user_id": author_uid,
            "comment_text": text,
        })
        comment["id"] = doc_ref.id
        self.db.collection(self.COMMENTS).document(doc_ref.id).set({
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
                self._notify(collab_uid, f"{activity_name} added a comment: \"{text[:80]}\"", str(itin_id), "comment")
        return {"success": True, "message": "Comment added successfully", "comment": comment}

    def update_comment(self, itin_id: str, comment_id: str, author_uid: str, text: str) -> Dict[str, Any]:
        text = (text or "").strip()
        if not text:
            return {"success": False, "message": "Comment cannot be empty"}
        comment_ref = (
            self.db.collection(self.COMMENTS)
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
        self.db.collection(self.COMMENTS).document(str(comment_id)).set({
            "comment_text": text,
            "text": text,
            "updated_at": comment["updatedAt"],
        }, merge=True)
        data = self._read_data()
        actor_name = self._get_user_name(data, author_uid, "Someone")
        self._append_activity(data, str(itin_id), author_uid, actor_name, f"{actor_name} edited a comment", "edited")
        itinerary = data.get("itineraries", {}).get(str(itin_id), {})
        for collab_uid, collab_data in itinerary.get("collaborators", {}).items():
            if collab_uid != author_uid and collab_data.get("status") == "active":
                self._notify(collab_uid, f"{actor_name} edited a comment", str(itin_id), "edited")
        return {"success": True, "message": "Comment updated successfully", "comment": comment}

    def get_comments(self, itin_id: str) -> Dict[str, Any]:
        comments = []
        docs = (
            self.db.collection(self.COMMENTS)
            .where(filter=FieldFilter("itinerary_id", "==", str(itin_id)))
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
        if not self._can_edit_itinerary(str(itin_id), str(editor_uid)):
            return {"success": False, "message": "You do not have permission to edit this itinerary"}
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
        if not self._can_edit_itinerary(itin_id, editor_uid):
            return {"success": False, "message": "You do not have permission to edit this itinerary"}
        data = self._read_data()
        itin_ref.set({
            field_name: value,
            "updatedAt": self._get_current_timestamp(),
            "lastEditedBy": editor_uid,
        }, merge=True)
        self.db.collection(self.ITINERARIES).document(itin_id).set({
            field_name: value,
            "updated_at": self._get_current_timestamp(),
        }, merge=True)
        editor_name = self._get_user_name(data, editor_uid, "Someone")
        self._append_activity(data, itin_id, editor_uid, editor_name, f"{editor_name} {message_suffix}", "edited")
        for collab_uid, collab_data in self._get_itinerary_collaborators(itin_id).items():
            if collab_uid != editor_uid and collab_data.get("status") == "active":
                self._notify(collab_uid, f"Trip {message_suffix}", itin_id, "edited")
        return {"success": True, "message": f"{field_name.title()} updated successfully", **payload}

    def get_itinerary(self, itin_id: str) -> Optional[Dict[str, Any]]:
        doc = self._get(self.db.collection(self.ITINERARIES).document(str(itin_id)))
        if not doc.exists:
            return None
        return self._normalize_itinerary_for_display(self._with_stops_and_collaborators(self._doc_data(doc)))

    def get_activities(self, itin_id: str) -> List[Dict[str, Any]]:
        data = self._read_data()
        return self._build_activity_feed(data, str(itin_id))

    def get_notifications(self, user_uid: str) -> List[Dict[str, Any]]:
        notifications = []
        query = self.db.collection(self.NOTIFICATIONS).where(
            filter=FieldFilter("user_id", "==", str(user_uid))
        )
        for doc in self._stream(query):
            notification = self._doc_data(doc)
            created_at = notification.get("createdAt") or notification.get("created_at", "")
            notifications.append({
                **notification,
                "iconLabel": self._activity_icon_label(notification.get("message", ""), notification.get("icon", "")),
                "timeAgo": self._format_time_ago(created_at)
            })
        return sorted(
            notifications,
            key=lambda item: self._parse_timestamp(item.get("createdAt") or item.get("created_at", "")),
            reverse=True
        )

    def mark_notifications_read(self, user_uid: str, itinerary_id: str = "") -> int:
        updated = 0
        query = self.db.collection(self.NOTIFICATIONS).where(
            filter=FieldFilter("user_id", "==", str(user_uid))
        )
        for doc in self._stream(query):
            notification = self._doc_data(doc)
            if itinerary_id and notification.get("itineraryId") != itinerary_id and notification.get("reference_id") != itinerary_id:
                continue
            if notification.get("isRead") and notification.get("is_read"):
                continue
            doc.reference.set({
                "isRead": True,
                "is_read": True,
                "readAt": self._get_current_timestamp(),
                "read_at": self._get_current_timestamp(),
            }, merge=True)
            updated += 1
        return updated
