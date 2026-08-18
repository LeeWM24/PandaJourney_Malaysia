# from services.firebase_service import db
# from firebase_admin import firestore

# def increment_view(itinerary_id):
#     doc_ref = db.collection("itineraries").document(itinerary_id)

#     doc_ref.update({
#         "views": firestore.Increment(1)
#     })

# def toggle_like(itinerary_id):
#     itinerary_ref = db.collection("itineraries").document(itinerary_id)

#     doc = itinerary_ref.get()

#     if not doc.exists:
#         return False

#     data = doc.to_dict()

#     is_liked = data.get("is_liked", False)

#     if is_liked:
#         itinerary_ref.update({
#             "is_liked": False,
#             "likes": firestore.Increment(-1)
#         })

#         return False

#     else:
#         itinerary_ref.update({
#             "is_liked": True,
#             "likes": firestore.Increment(1)
#         })

#         return True

# def toggle_save(itinerary_id):
#     itinerary_ref = db.collection("itineraries").document(itinerary_id)

#     doc = itinerary_ref.get()

#     if not doc.exists:
#         return False

#     data = doc.to_dict()

#     is_saved = data.get("is_saved", False)

#     if is_saved:
#         itinerary_ref.update({
#             "is_saved": False,
#             "saves": firestore.Increment(-1)
#         })

#         return False

#     else:
#         itinerary_ref.update({
#             "is_saved": True,
#             "saves": firestore.Increment(1)
#         })

#         return True

# def get_public_itineraries():
#     docs = (
#         db.collection("itineraries")
#         .where("is_public", "==", True)
#         .stream()
#     )

#     itineraries = []

#     for doc in docs:
#         data = doc.to_dict()

#         itinerary = {
#             "id": doc.id,
#             "title": data.get("title", ""),
#             "author": data.get("author_name", "Unknown User"),
#             "destination": data.get("destination", ""),
#             "duration": data.get("duration", ""),
#             "stops": data.get("stop_count", 0),
#             "description": data.get("description", ""),
#             "image": data.get("image_url", ""),
#             "views": data.get("views", 0),
#             "likes": data.get("likes", 0),
#             "saves": data.get("saves", 0),

#             "isLiked": data.get("is_liked", False),
#             "isSaved": data.get("is_saved", False),

#             "createdAt": "",
#             "isYours": False,
#             "stopList": data.get("stops", [])
#         }

#         created_at = data.get("created_at")

#         if created_at:
#             itinerary["createdAt"] = created_at.strftime("%Y-%m-%d")

#         itineraries.append(itinerary)

#     return itineraries