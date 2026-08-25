from typing import Any, Dict

from services.collaboration_service_local import LocalCollaborationService
from services.saved_itinerary_service import read_saved_itineraries, save_itinerary


def _exists(doc_ref) -> bool:
    return doc_ref.get(retry=None, timeout=10).exists


def migrate_local_json_to_firestore(db, collab_service, default_user: Dict[str, Any]) -> Dict[str, int]:
    """Copy local JSON data to Firestore without overwriting existing documents."""
    if db is None:
        return {"saved_inserted": 0, "collaboration_inserted": 0, "skipped": 0}

    local_collab = LocalCollaborationService()
    local_data = local_collab._read_data()
    counts = {"saved_inserted": 0, "collaboration_inserted": 0, "skipped": 0}
    user_uid = default_user.get("uid", "user_123")

    for item in read_saved_itineraries():
        item_id = str(item.get("id"))
        if _exists(db.collection("Itinerary").document(item_id)):
            counts["skipped"] += 1
            continue

        saved_item = save_itinerary(item, item.get("user_uid") or user_uid)
        counts["saved_inserted"] += 1
        collab_service.create_itinerary_from_saved(saved_item, default_user)

    for itin_id, itinerary in local_data.get("itineraries", {}).items():
        if _exists(db.collection("Itinerary").document(str(itin_id))):
            counts["skipped"] += 1
            continue

        if hasattr(collab_service, "_write_itinerary_data"):
            collab_service._write_itinerary_data(itinerary)
        else:
            db.collection("Itinerary").document(str(itin_id)).set(itinerary)
        counts["collaboration_inserted"] += 1

    for invitation in local_data.get("invitations", []):
        invitation_id = str(invitation.get("id"))
        if not invitation_id or _exists(db.collection("collaborators").document(invitation_id)):
            counts["skipped"] += 1
            continue

        if hasattr(collab_service, "_write_collaborator"):
            collab_service._write_collaborator(
                invitation_id,
                invitation.get("itineraryId"),
                invitation.get("ownerId"),
                invitation.get("invitedEmail"),
                invitation.get("role", "Viewer"),
                invitation.get("status", "pending"),
                invitation.get("invitedUid", ""),
            )
        else:
            db.collection("collaborators").document(invitation_id).set(invitation)

    for itin_id, comments in local_data.get("comments", {}).items():
        for index, comment in enumerate(comments, start=1):
            comment_id = str(comment.get("id") or f"{itin_id}_comment_{index}")
            comment_ref = (
                db.collection("comments").document(comment_id)
            )
            if _exists(comment_ref):
                counts["skipped"] += 1
                continue

            comment_ref.set({
                **comment,
                "comment_id": comment_id,
                "itinerary_id": str(itin_id),
                "user_id": comment.get("authorUid", ""),
                "parent_comment_id": None,
                "comment_text": comment.get("text", ""),
                "text": comment.get("text", ""),
                "created_at": comment.get("createdAt", ""),
                "updated_at": comment.get("updatedAt", ""),
            }, merge=True)

    for itin_id, activities in local_data.get("activities", {}).items():
        for index, activity in enumerate(activities, start=1):
            activity_id = str(activity.get("id") or f"{itin_id}_activity_{index}")
            activity_ref = (
                db.collection("Itinerary")
                .document(str(itin_id))
                .collection("activities")
                .document(activity_id)
            )
            if _exists(activity_ref):
                counts["skipped"] += 1
                continue
            activity_ref.set(activity)

    for notification in local_data.get("notifications", []):
        notification_id = str(notification.get("id"))
        if not notification_id or _exists(db.collection("notifications").document(notification_id)):
            counts["skipped"] += 1
            continue

        db.collection("notifications").document(notification_id).set({
            **notification,
            "notification_id": notification_id,
            "user_id": notification.get("recipientUid", ""),
            "type": notification.get("icon", "notification"),
            "title": notification.get("message", ""),
            "message": notification.get("message", ""),
            "reference_id": notification.get("itineraryId", ""),
            "is_read": bool(notification.get("isRead", False)),
            "created_at": notification.get("createdAt", ""),
        }, merge=True)

    for uid, user in local_data.get("users", {}).items():
        db.collection("users").document(str(uid)).set({
            "user_id": str(uid),
            "uid": str(uid),
            "email": user.get("email", ""),
            "name": user.get("name") or user.get("displayName", ""),
            "displayName": user.get("displayName") or user.get("name", ""),
            "profile_picture": user.get("profile_picture", ""),
            "created_at": user.get("created_at", ""),
            "updated_at": user.get("updated_at", ""),
            "is_deleted": bool(user.get("is_deleted", False)),
            "deleted_at": user.get("deleted_at"),
        }, merge=True)

    return counts
