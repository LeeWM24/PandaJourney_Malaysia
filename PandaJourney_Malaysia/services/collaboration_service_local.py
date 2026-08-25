import json
import os
import smtplib
from copy import deepcopy
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path
from typing import Any, Dict, List, Optional


class LocalCollaborationService:
    """Local JSON-based collaboration service (fallback when Firestore is not available)"""
    
    def __init__(self, data_file: str = None):
        if data_file is None:
            # Default to collaboration_data.json in the data directory
            base_dir = Path(__file__).resolve().parents[1]
            data_file = base_dir / "data" / "collaboration_data.json"
        
        self.data_file = Path(data_file)
        self._ensure_data_file()
    
    def _ensure_data_file(self):
        """Create data file with default structure if it doesn't exist"""
        if not self.data_file.exists():
            self.data_file.parent.mkdir(parents=True, exist_ok=True)
            default_data = {
                "itineraries": {},
                "invitations": [],
                "comments": {},
                "activities": {},
                "notifications": [],
                "users": {}
            }
            self._write_data(default_data)
    
    def _read_data(self) -> Dict[str, Any]:
        """Read data from JSON file"""
        try:
            with open(self.data_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            data = {
                "itineraries": {},
                "invitations": [],
                "comments": {},
                "activities": {},
                "notifications": [],
                "users": {}
            }
        data.setdefault("itineraries", {})
        data.setdefault("invitations", [])
        data.setdefault("comments", {})
        data.setdefault("activities", {})
        data.setdefault("notifications", [])
        data.setdefault("users", {})
        return data
    
    def _write_data(self, data: Dict[str, Any]):
        """Write data to JSON file"""
        data["notifications"] = self._dedupe_notifications(data.get("notifications", []))
        with open(self.data_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

    def _dedupe_notifications(self, notifications: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        deduped = []
        seen = set()
        for notification in notifications:
            minute_key = (notification.get("createdAt") or notification.get("created_at") or "")[:16]
            key = (
                notification.get("recipientUid") or notification.get("user_id"),
                notification.get("itineraryId") or notification.get("reference_id"),
                notification.get("message"),
                notification.get("icon") or notification.get("type"),
                minute_key,
            )
            if key in seen:
                continue
            seen.add(key)
            deduped.append(notification)
        return deduped
    
    def _get_current_timestamp(self) -> str:
        """Get current ISO timestamp"""
        return datetime.utcnow().isoformat() + 'Z'

    def _parse_timestamp(self, value: str) -> datetime:
        if not value:
            return datetime.min
        try:
            return datetime.fromisoformat(value.replace("Z", ""))
        except ValueError:
            return datetime.min

    def _format_time_ago(self, value: str) -> str:
        created_at = self._parse_timestamp(value)
        if created_at == datetime.min:
            return "just now"

        seconds = max(0, int((datetime.utcnow() - created_at).total_seconds()))
        if seconds < 60:
            return "just now"

        minutes = seconds // 60
        if minutes < 60:
            return f"{minutes}m ago"

        hours = minutes // 60
        if hours < 24:
            return f"{hours}h ago"

        days = hours // 24
        if days == 1:
            return "Yesterday"
        if days < 7:
            return f"{days}d ago"

        return created_at.strftime("%b %d, %Y")

    def _split_saved_time_duration(self, time_value: str, duration_value: str = "") -> Dict[str, str]:
        cleaned_time = str(time_value or "")
        cleaned_duration = str(duration_value or "")
        for value in ("\u00c3\u201a", "\u00c2"):
            cleaned_time = cleaned_time.replace(value, "")
            cleaned_duration = cleaned_duration.replace(value, "")

        parts = [part.strip() for part in cleaned_time.split("\u00b7") if part.strip()]
        if len(parts) >= 2 and not cleaned_duration.strip():
            return {"time": parts[0], "duration": parts[1]}

        return {
            "time": parts[0] if parts else cleaned_time.strip(),
            "duration": cleaned_duration.strip()
        }

    def _normalize_itinerary_for_display(self, itinerary: Dict[str, Any]) -> Dict[str, Any]:
        normalized = deepcopy(itinerary)
        for index, stop in enumerate(normalized.get("stops", []), start=1):
            parsed = self._split_saved_time_duration(
                stop.get("time") or stop.get("arrival_time", ""),
                stop.get("duration") or stop.get("visit_duration") or self._format_minutes_as_duration(stop.get("visit_duration_minutes"))
            )
            stop["name"] = stop.get("name") or stop.get("stop_name") or stop.get("title") or f"Stop {index}"
            stop["time"] = parsed["time"]
            stop["duration"] = parsed["duration"]
            stop["stopNumber"] = int(stop.get("stopNumber") or index)
            if stop.get("icon") in ("", None):
                stop["icon"] = "pin"
        normalized["stops"] = sorted(
            normalized.get("stops", []),
            key=lambda stop: int(stop.get("stopNumber") or 0)
        )
        return normalized

    def _normalize_stops_for_save(self, stops: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        normalized = []
        for index, stop in enumerate(stops, start=1):
            parsed = self._split_saved_time_duration(
                stop.get("time") or stop.get("arrival_time", ""),
                stop.get("duration") or stop.get("visit_duration") or self._format_minutes_as_duration(stop.get("visit_duration_minutes"))
            )
            normalized.append({
                **stop,
                "name": stop.get("name") or stop.get("stop_name") or stop.get("title") or f"Stop {index}",
                "time": parsed["time"],
                "duration": parsed["duration"],
                "stopNumber": int(stop.get("stopNumber") or index),
                "icon": stop.get("icon") or "pin"
            })
        return sorted(normalized, key=lambda stop: int(stop.get("stopNumber") or 0))

    def _format_minutes_as_duration(self, minutes: Any) -> str:
        try:
            value = int(minutes or 0)
        except (TypeError, ValueError):
            return ""
        if value <= 0:
            return ""
        hours = value / 60
        if value % 60 == 0:
            return f"{value // 60} hrs"
        return f"{hours:.1f} hrs"

    def _activity_icon_label(self, message: str = "", icon: str = "") -> str:
        text = f"{message} {icon}".lower()
        if "comment" in text:
            return "C"
        if "invite" in text or "invitation" in text:
            return "I"
        if "accepted" in text:
            return "A"
        if "deleted" in text or "removed" in text:
            return "D"
        if "added" in text or "new stop" in text:
            return "+"
        if "renamed" in text or "updated" in text or "edited" in text:
            return "E"
        return "N"

    def _timestamps_are_close(self, first: str, second: str, max_seconds: int = 2) -> bool:
        first_dt = self._parse_timestamp(first)
        second_dt = self._parse_timestamp(second)
        if first_dt == datetime.min or second_dt == datetime.min:
            return False
        return abs((first_dt - second_dt).total_seconds()) <= max_seconds

    def _get_user_name(self, data: Dict[str, Any], uid: str, fallback: str = "Someone") -> str:
        if not uid:
            return fallback

        user = data.get("users", {}).get(uid, {})
        if user.get("displayName") or user.get("name"):
            return user.get("displayName") or user.get("name")

        for itinerary in data.get("itineraries", {}).values():
            collaborator = itinerary.get("collaborators", {}).get(uid)
            if collaborator and collaborator.get("name"):
                return collaborator.get("name")

        return fallback

    def _can_edit_itinerary(self, data: Dict[str, Any], itin_id: str, user_uid: str) -> bool:
        collaborator = (
            data.get("itineraries", {})
            .get(str(itin_id), {})
            .get("collaborators", {})
            .get(str(user_uid), {})
        )
        return collaborator.get("status") == "active" and collaborator.get("role") in ("Owner", "Editor")

    def _append_activity(
        self,
        data: Dict[str, Any],
        itin_id: str,
        actor_uid: str,
        actor_name: str,
        message: str,
        icon: str
    ) -> Dict[str, Any]:
        activities = data.setdefault("activities", {}).setdefault(itin_id, [])
        activity = {
            "id": f"activity_{len(activities) + 1}",
            "itineraryId": itin_id,
            "actorUid": actor_uid,
            "actorName": actor_name or self._get_user_name(data, actor_uid, "Someone"),
            "message": message,
            "icon": icon,
            "createdAt": self._get_current_timestamp()
        }
        activities.append(activity)
        return activity

    def _notify(
        self,
        data: Dict[str, Any],
        recipient_uid: str,
        message: str,
        itin_id: str,
        icon: str = "notification",
    ) -> Dict[str, Any]:
        notifications = data.setdefault("notifications", [])
        now = self._get_current_timestamp()
        for existing in reversed(notifications):
            if (
                (existing.get("recipientUid") == recipient_uid or existing.get("user_id") == recipient_uid)
                and (existing.get("itineraryId") == itin_id or existing.get("reference_id") == itin_id)
                and existing.get("message") == message
                and (existing.get("icon") == icon or existing.get("type") == icon)
                and not existing.get("isRead")
                and self._timestamps_are_close(existing.get("createdAt") or existing.get("created_at", ""), now, 12)
            ):
                return existing
        notif_id = f"notif_{len(notifications) + 1}"
        notification = {
            "id": notif_id,
            "notification_id": notif_id,
            "recipientUid": recipient_uid,
            "user_id": recipient_uid,
            "message": message,
            "title": message,
            "itineraryId": itin_id,
            "reference_id": itin_id,
            "isRead": False,
            "is_read": False,
            "createdAt": now,
            "created_at": now,
            "icon": icon,
            "type": icon,
        }
        notifications.append(notification)
        return notification

    def _send_external_invite_email(self, invited_email: str, owner_name: str, itinerary_title: str) -> Dict[str, Any]:
        join_url = os.getenv("PANDAJOURNEY_REGISTER_URL") or "/create-account"
        subject = f"{owner_name} invited you to PandaJourney"
        body = (
            f"{owner_name} is trying to invite you to collaborate on \"{itinerary_title}\" in PandaJourney.\n\n"
            f"Register now to accept the invitation: {join_url}?email={invited_email}\n"
        )

        smtp_host = os.getenv("SMTP_HOST")
        mail_from = os.getenv("MAIL_FROM") or os.getenv("SMTP_USER")
        if not smtp_host or not mail_from:
            return {
                "sent": False,
                "reason": "SMTP email settings are not configured.",
                "to": invited_email,
                "subject": subject,
                "joinUrl": f"{join_url}?email={invited_email}",
            }

        message = EmailMessage()
        message["From"] = mail_from
        message["To"] = invited_email
        message["Subject"] = subject
        message.set_content(body)

        port = int(os.getenv("SMTP_PORT", "587"))
        username = os.getenv("SMTP_USER")
        password = os.getenv("SMTP_PASSWORD")
        use_tls = os.getenv("SMTP_USE_TLS", "true").lower() in ("1", "true", "yes", "on")

        with smtplib.SMTP(smtp_host, port, timeout=15) as smtp:
            if use_tls:
                smtp.starttls()
            if username and password:
                smtp.login(username, password)
            smtp.send_message(message)

        return {
            "sent": True,
            "to": invited_email,
            "subject": subject,
            "joinUrl": f"{join_url}?email={invited_email}",
        }

    def _queued_invite_uid(self, email: str) -> str:
        return f"pending_{email.replace('@', '_at_').replace('.', '_')}"

    def claim_queued_invitations(self, user: Dict[str, Any]) -> int:
        data = self._read_data()
        uid = str(user.get("uid") or "")
        email = (user.get("email") or "").strip().lower()
        display_name = user.get("display_name") or user.get("displayName") or user.get("name") or email

        if not uid or not email:
            return 0

        pending_uid = self._queued_invite_uid(email)
        claimed = 0

        data.setdefault("users", {}).setdefault(uid, {
            "uid": uid,
            "displayName": display_name,
            "email": email,
        })

        for invitation in data.get("invitations", []):
            if (
                (invitation.get("invitedEmail") or "").lower() == email
                and invitation.get("status") == "pending"
            ):
                invitation["invitedUid"] = uid
                claimed += 1

        for itin_id, itinerary in data.get("itineraries", {}).items():
            collaborators = itinerary.setdefault("collaborators", {})
            pending_collaborator = collaborators.pop(pending_uid, None)
            if not pending_collaborator:
                continue

            collaborators[uid] = {
                **pending_collaborator,
                "name": display_name,
                "email": email,
                "status": "pending",
            }
            self._append_activity(
                data,
                str(itin_id),
                uid,
                display_name,
                f"{display_name} can now respond to the invitation",
                "invite"
            )
            claimed += 1

        if claimed:
            self._write_data(data)

        return claimed

    def _notify_active_collaborators(
        self,
        data: Dict[str, Any],
        itin_id: str,
        actor_uid: str,
        message: str,
        icon: str,
    ) -> None:
        collaborators = data.get("itineraries", {}).get(itin_id, {}).get("collaborators", {})
        for collab_uid, collab_data in collaborators.items():
            if collab_uid != actor_uid and collab_data.get("status") == "active":
                self._notify(data, collab_uid, message, itin_id, icon)

    def _default_stops_from_saved(self, saved_item: Dict[str, Any]) -> List[Dict[str, Any]]:
        timetable = saved_item.get("timetable") or []
        if timetable:
            return [{
                "name": stop.get("name") or stop.get("stop_name") or stop.get("title") or f"Stop {index + 1}",
                "time": stop.get("time") or stop.get("arrival_time", ""),
                "duration": stop.get("duration") or stop.get("visit_duration") or self._format_minutes_as_duration(stop.get("visit_duration_minutes")),
                "icon": stop.get("icon", "pin"),
                "stopNumber": int(stop.get("stopNumber") or index + 1)
            } for index, stop in enumerate(timetable)]

        selected = saved_item.get("selected") or []
        if selected:
            return [{
                "name": stop.get("name") or stop.get("stop_name") or stop.get("title") or f"Stop {index + 1}",
                "time": stop.get("time") or stop.get("arrival_time", ""),
                "duration": stop.get("duration") or stop.get("visit_duration") or self._format_minutes_as_duration(stop.get("visit_duration_minutes")),
                "icon": stop.get("icon", "pin"),
                "stopNumber": int(stop.get("stopNumber") or index + 1)
            } for index, stop in enumerate(selected)]

        stop_count = int(saved_item.get("stop_count") or 0)
        return [{
            "name": f"Stop {index + 1}",
            "time": "",
            "duration": "",
            "icon": "pin",
            "stopNumber": index + 1
        } for index in range(stop_count)]

    def create_itinerary_from_saved(
        self,
        saved_item: Dict[str, Any],
        owner: Dict[str, Any]
    ) -> Dict[str, Any]:
        data = self._read_data()
        itin_id = str(saved_item.get("id"))

        if itin_id in data["itineraries"]:
            return data["itineraries"][itin_id]

        owner_uid = owner.get("uid", "user_123")
        owner_email = owner.get("email", "")
        owner_name = owner.get("display_name") or owner.get("displayName") or "You"

        data["users"].setdefault(owner_uid, {
            "uid": owner_uid,
            "displayName": owner_name,
            "email": owner_email
        })

        data["itineraries"][itin_id] = {
            "id": itin_id,
            "title": saved_item.get("title", "Untitled Itinerary"),
            "date": saved_item.get("date", ""),
            "stops": self._normalize_stops_for_save(self._default_stops_from_saved(saved_item)),
            "collaborators": {
                owner_uid: {
                    "role": "Owner",
                    "status": "active",
                    "name": owner_name,
                    "email": owner_email
                }
            },
            "collaboratorEmails": [owner_email] if owner_email else [],
            "createdAt": self._get_current_timestamp(),
            "updatedAt": self._get_current_timestamp(),
            "lastEditedBy": owner_uid
        }
        data.setdefault("comments", {}).setdefault(itin_id, [])
        self._write_data(data)
        return self._normalize_itinerary_for_display(data["itineraries"][itin_id])
    
    # FR 4.1: Send Invitation
    def invite_collaborator(self, itin_id: str, invited_email: str, owner_id: str) -> Dict[str, Any]:
        data = self._read_data()
        
        if not itin_id or itin_id not in data["itineraries"]:
            return {'success': False, 'message': 'Itinerary not found'}

        invited_email = (invited_email or "").strip().lower()
        if not invited_email:
            return {'success': False, 'message': 'Email is required'}

        collaborators = data["itineraries"][itin_id].setdefault("collaborators", {})
        collaborator_emails = data["itineraries"][itin_id].setdefault("collaboratorEmails", [])
        if invited_email in [email.lower() for email in collaborator_emails]:
            return {'success': False, 'message': 'This user is already invited or collaborating'}

        # Check if user exists
        user = None
        for uid, user_data in data["users"].items():
            if user_data.get("email", "").lower() == invited_email:
                user = {"uid": uid, **user_data}
                break
        
        if user:
            invited_uid = user["uid"]
            
            # Create invitation
            invitation = {
                "id": f"inv_{len(data['invitations']) + 1}",
                "itineraryId": itin_id,
                "invitedEmail": invited_email,
                "invitedUid": invited_uid,
                "ownerId": owner_id,
                "status": "pending",
                "role": "Viewer",
                "createdAt": self._get_current_timestamp()
            }
            data["invitations"].append(invitation)
            
            # Update itinerary collaborators
            data["itineraries"][itin_id]["collaborators"][invited_uid] = {
                "role": "Viewer",
                "status": "pending",
                "name": user.get("displayName") or user.get("name") or invited_email,
                "email": invited_email
            }
            data["itineraries"][itin_id]["collaboratorEmails"].append(invited_email)
            
            owner_name = self._get_user_name(data, owner_id, "Someone")
            itinerary_title = data["itineraries"][itin_id].get("title", "an itinerary")
            # Send notification
            notification = {
                "id": f"notif_{len(data['notifications']) + 1}",
                "notification_id": f"notif_{len(data['notifications']) + 1}",
                "recipientUid": invited_uid,
                "message": "You were invited to collaborate on an itinerary!",
                "itineraryId": itin_id,
                "isRead": False,
                "createdAt": self._get_current_timestamp(),
                "icon": "✉️"
            }
            data["notifications"].append(notification)
            self._append_activity(
                data,
                itin_id,
                owner_id,
                owner_name,
                f"Invitation sent to {invited_email}",
                "✉️"
            )
            
            self._write_data(data)
            return {
                'success': True,
                'message': 'Invitation sent successfully!',
                'invitation': invitation,
                'collaborator': data["itineraries"][itin_id]["collaborators"][invited_uid]
            }
        else:
            pending_uid = self._queued_invite_uid(invited_email)
            owner_name = self._get_user_name(data, owner_id, "Someone")
            itinerary_title = data["itineraries"][itin_id].get("title", "an itinerary")
            invitation = {
                "id": f"inv_{len(data['invitations']) + 1}",
                "itineraryId": itin_id,
                "invitedEmail": invited_email,
                "invitedUid": pending_uid,
                "ownerId": owner_id,
                "status": "pending",
                "role": "Viewer",
                "createdAt": self._get_current_timestamp()
            }
            data["invitations"].append(invitation)
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
                itin_id,
                owner_id,
                owner_name,
                (
                    f"Email invitation sent to unregistered user {invited_email}"
                    if email_result.get("sent")
                    else f"External invitation queued for {invited_email}"
                ),
                "✉️"
            )
            data["itineraries"][itin_id]["collaborators"][pending_uid] = {
                "role": "Viewer",
                "status": "pending",
                "name": invited_email,
                "email": invited_email
            }
            data["itineraries"][itin_id]["collaboratorEmails"].append(invited_email)
            self._write_data(data)
            return {
                'success': True,
                'message': (
                    'Invitation email sent. They can register to join this itinerary.'
                    if email_result.get("sent")
                    else 'External invitation queued. Configure SMTP settings to send the email.'
                ),
                'emailQueued': True,
                'email': email_result
            }
    
    # FR 4.2: Accept/Decline Invitation
    def respond_invitation(self, invitation_id: str, user_uid: str, action: str) -> Dict[str, Any]:
        data = self._read_data()
        
        # Find invitation
        invitation = None
        for inv in data["invitations"]:
            if inv.get("id") == invitation_id:
                invitation = inv
                break
        
        if not invitation:
            return {'success': False, 'message': 'Invitation not found'}
        
        if action == 'accept':
            invitation["status"] = "accepted"
            invitation["respondedAt"] = self._get_current_timestamp()
            
            # Update itinerary collaborator status
            itin_id = invitation.get("itineraryId")
            if itin_id in data["itineraries"]:
                if "collaborators" in data["itineraries"][itin_id]:
                    if user_uid in data["itineraries"][itin_id]["collaborators"]:
                        data["itineraries"][itin_id]["collaborators"][user_uid]["status"] = "active"
                user_name = self._get_user_name(data, user_uid, "Someone")
                self._append_activity(
                    data,
                    itin_id,
                    user_uid,
                    user_name,
                    f"{user_name} accepted the invitation",
                    "✅"
                )
            
            self._write_data(data)
            return {'success': True, 'message': 'Invitation accepted'}
        elif action == 'decline':
            invitation["status"] = "declined"
            invitation["respondedAt"] = self._get_current_timestamp()
            
            self._write_data(data)
            return {'success': True, 'message': 'Invitation declined'}
        else:
            return {'success': False, 'message': 'Invalid action'}

    def update_collaborator_role(self, itin_id: str, owner_uid: str, collaborator_uid: str, role: str) -> Dict[str, Any]:
        data = self._read_data()
        itinerary = data.get("itineraries", {}).get(str(itin_id))
        if not itinerary:
            return {"success": False, "message": "Itinerary not found"}

        collaborators = itinerary.get("collaborators", {})
        owner = collaborators.get(owner_uid, {})
        if owner.get("role") != "Owner":
            return {"success": False, "message": "Only the owner can change collaborator roles"}

        if role not in ("Editor", "Viewer"):
            return {"success": False, "message": "Invalid role"}

        collaborator = collaborators.get(collaborator_uid)
        if not collaborator:
            return {"success": False, "message": "Collaborator not found"}
        if collaborator.get("role") == "Owner":
            return {"success": False, "message": "Owner role cannot be changed"}

        collaborator["role"] = role
        collaborator["status"] = collaborator.get("status") or "active"
        itinerary["updatedAt"] = self._get_current_timestamp()
        self._append_activity(
            data,
            str(itin_id),
            owner_uid,
            self._get_user_name(data, owner_uid, "Owner"),
            f"{collaborator.get('name') or collaborator_uid} assigned as {role}",
            "role"
        )
        self._write_data(data)
        return {"success": True, "message": "Role updated", "role": role}

    def remove_collaborator(self, itin_id: str, owner_uid: str, collaborator_uid: str) -> Dict[str, Any]:
        data = self._read_data()
        itinerary = data.get("itineraries", {}).get(str(itin_id))
        if not itinerary:
            return {"success": False, "message": "Itinerary not found"}

        collaborators = itinerary.get("collaborators", {})
        owner = collaborators.get(owner_uid, {})
        if owner.get("role") != "Owner":
            return {"success": False, "message": "Only the owner can remove collaborators"}

        collaborator = collaborators.get(collaborator_uid)
        if not collaborator:
            return {"success": False, "message": "Collaborator not found"}
        if collaborator.get("role") == "Owner":
            return {"success": False, "message": "Owner cannot be removed"}

        removed_name = collaborator.get("name") or collaborator_uid
        removed_email = collaborator.get("email", "")
        collaborators.pop(collaborator_uid, None)
        itinerary["collaboratorEmails"] = [
            email for email in itinerary.get("collaboratorEmails", [])
            if email.lower() != removed_email.lower()
        ]
        itinerary["updatedAt"] = self._get_current_timestamp()
        self._append_activity(
            data,
            str(itin_id),
            owner_uid,
            self._get_user_name(data, owner_uid, "Owner"),
            f"{removed_name} was removed from the plan",
            "removed"
        )
        self._write_data(data)
        return {"success": True, "message": "Collaborator removed"}
    
    # FR 4.4: Update Shared Itinerary
    def update_itinerary(self, itin_id: str, editor_uid: str, stops: List[Dict[str, Any]]) -> Dict[str, Any]:
        data = self._read_data()
        
        if itin_id not in data["itineraries"]:
            return {'success': False, 'message': 'Itinerary not found'}
        if not self._can_edit_itinerary(data, itin_id, editor_uid):
            return {'success': False, 'message': 'You do not have permission to edit this itinerary'}
        if not isinstance(stops, list):
            return {'success': False, 'message': 'Stops must be a list'}
        
        # Update stops
        stops = self._normalize_stops_for_save(stops)
        data["itineraries"][itin_id]["stops"] = stops
        data["itineraries"][itin_id]["updatedAt"] = self._get_current_timestamp()
        data["itineraries"][itin_id]["lastEditedBy"] = editor_uid
        editor_name = self._get_user_name(data, editor_uid, "Someone")
        self._append_activity(
            data,
            itin_id,
            editor_uid,
            editor_name,
            f"{editor_name} updated the itinerary with {len(stops)} stops",
            "📝"
        )
        
        # Notify collaborators
        collaborators = data["itineraries"][itin_id].get("collaborators", {})
        for collab_uid, collab_data in collaborators.items():
            if collab_uid != editor_uid and collab_data.get("status") == "active":
                notification = {
                    "id": f"notif_{len(data['notifications']) + 1}",
                    "recipientUid": collab_uid,
                    "message": f"Itinerary was updated with {len(stops)} stops",
                    "itineraryId": itin_id,
                    "isRead": False,
                    "createdAt": self._get_current_timestamp(),
                    "icon": "📝"
                }
                data["notifications"].append(notification)
        
        self._write_data(data)
        return {'success': True, 'message': 'Itinerary updated successfully'}
    
    # FR 4.5: Add Comment
    def add_comment(self, itin_id: str, author_uid: str, author_name: str, text: str) -> Dict[str, Any]:
        data = self._read_data()
        
        if itin_id not in data["comments"]:
            data["comments"][itin_id] = []
        
        comment = {
            "id": f"comment_{len(data['comments'][itin_id]) + 1}",
            "authorUid": author_uid,
            "authorName": author_name,
            "text": text,
            "createdAt": self._get_current_timestamp()
        }
        data["comments"][itin_id].append(comment)
        activity_name = author_name or self._get_user_name(data, author_uid, "Someone")
        self._append_activity(
            data,
            itin_id,
            author_uid,
            activity_name,
            f"{activity_name} added a comment",
            "💬"
        )
        
        # Update itinerary last activity
        if itin_id in data["itineraries"]:
            data["itineraries"][itin_id]["lastActivityAt"] = self._get_current_timestamp()
            
            # Notify collaborators about the comment
            collaborators = data["itineraries"][itin_id].get("collaborators", {})
            for collab_uid, collab_data in collaborators.items():
                if collab_uid != author_uid and collab_data.get("status") == "active":
                    notification = {
                        "id": f"notif_{len(data['notifications']) + 1}",
                        "recipientUid": collab_uid,
                        "message": f"{author_name} added a comment",
                        "itineraryId": itin_id,
                        "isRead": False,
                        "createdAt": self._get_current_timestamp(),
                        "icon": "💬"
                    }
                    data["notifications"].append(notification)
        
        self._write_data(data)
        return {'success': True, 'message': 'Comment added successfully', 'comment': comment}

    # Update an existing comment
    def update_comment(self, itin_id: str, comment_id: str, author_uid: str, text: str) -> Dict[str, Any]:
        data = self._read_data()
        comments = data.get("comments", {}).get(itin_id, [])
        text = (text or "").strip()

        if not text:
            return {'success': False, 'message': 'Comment cannot be empty'}

        for comment in comments:
            if comment.get("id") == comment_id:
                if comment.get("authorUid") and comment.get("authorUid") != author_uid:
                    return {'success': False, 'message': 'You can only edit your own comment'}

                comment["text"] = text
                comment["updatedAt"] = self._get_current_timestamp()
                actor_name = self._get_user_name(data, author_uid, "Someone")
                self._append_activity(
                    data,
                    itin_id,
                    author_uid,
                    actor_name,
                    f"{actor_name} edited a comment",
                    "✏️"
                )

                if itin_id in data["itineraries"]:
                    data["itineraries"][itin_id]["lastActivityAt"] = self._get_current_timestamp()
                    self._notify_active_collaborators(
                        data,
                        itin_id,
                        author_uid,
                        f"{actor_name} edited a comment",
                        "edited"
                    )

                self._write_data(data)
                return {'success': True, 'message': 'Comment updated successfully', 'comment': comment}

        return {'success': False, 'message': 'Comment not found'}
    
    # Get comments for an itinerary
    def get_comments(self, itin_id: str) -> Dict[str, Any]:
        data = self._read_data()
        comments = []
        for comment in data.get("comments", {}).get(itin_id, []):
            created_at = comment.get("updatedAt") or comment.get("createdAt", "")
            comments.append({
                **comment,
                "timeAgo": self._format_time_ago(created_at)
            })
        return {'success': True, 'comments': comments}
    
    # Update single stop
    def update_stop(self, itin_id: str, stop_index: int, stop_data: Dict[str, Any], editor_uid: str) -> Dict[str, Any]:
        data = self._read_data()
        
        if itin_id not in data["itineraries"]:
            return {'success': False, 'message': 'Itinerary not found'}
        if not self._can_edit_itinerary(data, itin_id, editor_uid):
            return {'success': False, 'message': 'You do not have permission to edit this itinerary'}

        try:
            stop_index = int(stop_index)
        except (TypeError, ValueError):
            return {'success': False, 'message': 'Invalid stop index'}
        
        stops = data["itineraries"][itin_id].get("stops", [])
        
        if stop_index < 0 or stop_index >= len(stops):
            return {'success': False, 'message': 'Invalid stop index'}
        
        # Update the specific stop
        stops[stop_index] = {
            **stops[stop_index],
            **stop_data,
            "stopNumber": int(stop_data.get("stopNumber") or stops[stop_index].get("stopNumber") or stop_index + 1),
            "updatedAt": self._get_current_timestamp(),
            "updatedBy": editor_uid
        }
        
        # Save updated stops
        data["itineraries"][itin_id]["stops"] = stops
        data["itineraries"][itin_id]["updatedAt"] = self._get_current_timestamp()
        data["itineraries"][itin_id]["lastEditedBy"] = editor_uid
        editor_name = self._get_user_name(data, editor_uid, "Someone")
        self._append_activity(
            data,
            itin_id,
            editor_uid,
            editor_name,
            f"{editor_name} updated stop {stop_index + 1}: {stop_data.get('name', 'Unknown')}",
            "✏️"
        )
        
        # Notify collaborators
        collaborators = data["itineraries"][itin_id].get("collaborators", {})
        for collab_uid, collab_data in collaborators.items():
            if collab_uid != editor_uid and collab_data.get("status") == "active":
                notification = {
                    "id": f"notif_{len(data['notifications']) + 1}",
                    "recipientUid": collab_uid,
                    "message": f"Stop {stop_index + 1} was updated: {stop_data.get('name', 'Unknown')}",
                    "itineraryId": itin_id,
                    "isRead": False,
                    "createdAt": self._get_current_timestamp(),
                    "icon": "✏️"
                }
                data["notifications"].append(notification)
        
        self._write_data(data)
        return {'success': True, 'message': 'Stop updated successfully'}
    
    # Update itinerary title (plan name)
    def update_title(self, itin_id: str, new_title: str, editor_uid: str) -> Dict[str, Any]:
        data = self._read_data()

        if itin_id not in data["itineraries"]:
            return {'success': False, 'message': 'Itinerary not found'}
        if not self._can_edit_itinerary(data, itin_id, editor_uid):
            return {'success': False, 'message': 'You do not have permission to edit this itinerary'}

        new_title = (new_title or '').strip()
        if not new_title:
            return {'success': False, 'message': 'Title cannot be empty'}

        data["itineraries"][itin_id]["title"] = new_title
        data["itineraries"][itin_id]["updatedAt"] = self._get_current_timestamp()
        data["itineraries"][itin_id]["lastEditedBy"] = editor_uid
        editor_name = self._get_user_name(data, editor_uid, "Someone")
        self._append_activity(
            data,
            itin_id,
            editor_uid,
            editor_name,
            f"{editor_name} renamed the trip to \"{new_title}\"",
            "✏️"
        )

        # Notify collaborators
        collaborators = data["itineraries"][itin_id].get("collaborators", {})
        for collab_uid, collab_data in collaborators.items():
            if collab_uid != editor_uid and collab_data.get("status") == "active":
                notification = {
                    "id": f"notif_{len(data['notifications']) + 1}",
                    "recipientUid": collab_uid,
                    "message": f"Trip renamed to \"{new_title}\"",
                    "itineraryId": itin_id,
                    "isRead": False,
                    "createdAt": self._get_current_timestamp(),
                    "icon": "✏️"
                }
                data["notifications"].append(notification)

        self._write_data(data)
        return {'success': True, 'message': 'Title updated successfully', 'title': new_title}

    # Update itinerary date
    def update_date(self, itin_id: str, new_date: str, editor_uid: str) -> Dict[str, Any]:
        data = self._read_data()

        if itin_id not in data["itineraries"]:
            return {'success': False, 'message': 'Itinerary not found'}
        if not self._can_edit_itinerary(data, itin_id, editor_uid):
            return {'success': False, 'message': 'You do not have permission to edit this itinerary'}

        new_date = (new_date or '').strip()
        if not new_date:
            return {'success': False, 'message': 'Date cannot be empty'}

        data["itineraries"][itin_id]["date"] = new_date
        data["itineraries"][itin_id]["updatedAt"] = self._get_current_timestamp()
        data["itineraries"][itin_id]["lastEditedBy"] = editor_uid
        editor_name = self._get_user_name(data, editor_uid, "Someone")
        self._append_activity(
            data,
            itin_id,
            editor_uid,
            editor_name,
            f"{editor_name} changed the trip date to \"{new_date}\"",
            "edited"
        )

        collaborators = data["itineraries"][itin_id].get("collaborators", {})
        for collab_uid, collab_data in collaborators.items():
            if collab_uid != editor_uid and collab_data.get("status") == "active":
                notification = {
                    "id": f"notif_{len(data['notifications']) + 1}",
                    "recipientUid": collab_uid,
                    "message": f"Trip date changed to \"{new_date}\"",
                    "itineraryId": itin_id,
                    "isRead": False,
                    "createdAt": self._get_current_timestamp(),
                    "icon": "edited"
                }
                data["notifications"].append(notification)

        self._write_data(data)
        return {'success': True, 'message': 'Date updated successfully', 'date': new_date}

    # Get itinerary data
    def get_itinerary(self, itin_id: str) -> Optional[Dict[str, Any]]:
        data = self._read_data()
        itinerary = data.get("itineraries", {}).get(itin_id)
        if not itinerary:
            return None
        return self._normalize_itinerary_for_display(itinerary)

    # Get saved activity for one itinerary, newest first
    def get_activities(self, itin_id: str) -> List[Dict[str, Any]]:
        data = self._read_data()
        return self._build_activity_feed(data, itin_id)

    def _build_activity_feed(self, data: Dict[str, Any], itin_id: str) -> List[Dict[str, Any]]:
        activities: List[Dict[str, Any]] = []

        for activity in data.get("activities", {}).get(itin_id, []):
            created_at = activity.get("createdAt", "")
            activities.append({
                **activity,
                "iconLabel": self._activity_icon_label(activity.get("message", ""), activity.get("icon", "")),
                "timeAgo": self._format_time_ago(created_at),
                "sourceType": "activity",
                "sourceId": activity.get("id", "")
            })

        for comment in data.get("comments", {}).get(itin_id, []):
            created_at = comment.get("updatedAt") or comment.get("createdAt", "")
            author_name = comment.get("authorName") or self._get_user_name(data, comment.get("authorUid", ""), "Someone")
            action = "edited a comment" if comment.get("updatedAt") else "added a comment"
            message = f"{author_name} {action}"
            if any(
                activity.get("sourceType") == "activity"
                and activity.get("message") == message
                and self._timestamps_are_close(activity.get("createdAt", ""), created_at)
                for activity in activities
            ):
                continue
            activities.append({
                "id": f"comment_activity_{comment.get('id', created_at)}",
                "itineraryId": itin_id,
                "actorUid": comment.get("authorUid", ""),
                "actorName": author_name,
                "message": message,
                "iconLabel": "E" if comment.get("updatedAt") else "C",
                "icon": "✏️" if comment.get("updatedAt") else "💬",
                "createdAt": created_at,
                "timeAgo": self._format_time_ago(created_at),
                "sourceType": "comment",
                "sourceId": comment.get("id", "")
            })

        seen_notifications = set()
        for notification in []:
            if notification.get("itineraryId") != itin_id:
                continue
            key = (
                notification.get("message", ""),
                notification.get("createdAt", ""),
                notification.get("icon", "")
            )
            if key in seen_notifications:
                continue
            seen_notifications.add(key)
            created_at = notification.get("createdAt", "")
            activities.append({
                "id": f"notification_activity_{notification.get('id', created_at)}",
                "itineraryId": itin_id,
                "message": notification.get("message", "Notification sent"),
                "icon": notification.get("icon", "🔔"),
                "createdAt": created_at,
                "timeAgo": self._format_time_ago(created_at),
                "sourceType": "notification",
                "sourceId": notification.get("id", "")
            })

        deduped: List[Dict[str, Any]] = []
        seen_messages = set()
        for activity in sorted(
            activities,
            key=lambda item: self._parse_timestamp(item.get("createdAt", "")),
            reverse=True
        ):
            key = (activity.get("message", ""), activity.get("createdAt", ""))
            if key in seen_messages:
                continue
            seen_messages.add(key)
            deduped.append(activity)

        return deduped
    
    # Get notifications for a user
    def get_notifications(self, user_uid: str) -> List[Dict[str, Any]]:
        data = self._read_data()
        user_notifications = []
        for notif in data.get("notifications", []):
            if notif.get("recipientUid") != user_uid and notif.get("user_id") != user_uid:
                continue
            user_notifications.append({
                **notif,
                "iconLabel": self._activity_icon_label(notif.get("message", ""), notif.get("icon", "")),
                "timeAgo": self._format_time_ago(notif.get("createdAt", ""))
            })
        return user_notifications

    def mark_notifications_read(self, user_uid: str, itinerary_id: str = "") -> int:
        data = self._read_data()
        updated = 0
        for notif in data.get("notifications", []):
            if notif.get("recipientUid") != user_uid and notif.get("user_id") != user_uid:
                continue
            if itinerary_id and notif.get("itineraryId") != itinerary_id and notif.get("reference_id") != itinerary_id:
                continue
            if not notif.get("isRead") or not notif.get("is_read"):
                notif["isRead"] = True
                notif["is_read"] = True
                updated += 1
        if updated:
            self._write_data(data)
        return updated
