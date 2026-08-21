import json
from copy import deepcopy
from datetime import datetime
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
        with open(self.data_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    
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
            parsed = self._split_saved_time_duration(stop.get("time", ""), stop.get("duration", ""))
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
            parsed = self._split_saved_time_duration(stop.get("time", ""), stop.get("duration", ""))
            normalized.append({
                **stop,
                "time": parsed["time"],
                "duration": parsed["duration"],
                "stopNumber": int(stop.get("stopNumber") or index),
                "icon": stop.get("icon") or "pin"
            })
        return sorted(normalized, key=lambda stop: int(stop.get("stopNumber") or 0))

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

    def _default_stops_from_saved(self, saved_item: Dict[str, Any]) -> List[Dict[str, Any]]:
        timetable = saved_item.get("timetable") or []
        if timetable:
            return [{
                "name": stop.get("name") or stop.get("title") or f"Stop {index + 1}",
                "time": stop.get("time", ""),
                "duration": stop.get("duration", ""),
                "icon": stop.get("icon", "pin"),
                "stopNumber": int(stop.get("stopNumber") or index + 1)
            } for index, stop in enumerate(timetable)]

        selected = saved_item.get("selected") or []
        if selected:
            return [{
                "name": stop.get("name") or stop.get("title") or f"Stop {index + 1}",
                "time": stop.get("time", ""),
                "duration": stop.get("duration", ""),
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
            
            # Send notification
            notification = {
                "id": f"notif_{len(data['notifications']) + 1}",
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
                self._get_user_name(data, owner_id, "Someone"),
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
            self._append_activity(
                data,
                itin_id,
                owner_id,
                self._get_user_name(data, owner_id, "Someone"),
                f"External invitation queued for {invited_email}",
                "✉️"
            )
            self._write_data(data)
            return {'success': True, 'message': 'External email invitation queued.'}
    
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
    
    # FR 4.4: Update Shared Itinerary
    def update_itinerary(self, itin_id: str, editor_uid: str, stops: List[Dict[str, Any]]) -> Dict[str, Any]:
        data = self._read_data()
        
        if itin_id not in data["itineraries"]:
            return {'success': False, 'message': 'Itinerary not found'}
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
        for notification in data.get("notifications", []):
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
            if notif.get("recipientUid") != user_uid:
                continue
            user_notifications.append({
                **notif,
                "iconLabel": self._activity_icon_label(notif.get("message", ""), notif.get("icon", "")),
                "timeAgo": self._format_time_ago(notif.get("createdAt", ""))
            })
        return user_notifications
