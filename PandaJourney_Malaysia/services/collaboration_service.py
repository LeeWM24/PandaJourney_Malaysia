from datetime import datetime
from firebase_admin import firestore

class CollaborationService:
    def __init__(self, db):
        self.db = db

    # FR 4.1: Send Invitation
    def invite_collaborator(self, itin_id, invited_email, owner_id):
        # 1. Check if user exists
        users_ref = self.db.collection('users').where('email', '==', invited_email).get()

        if users_ref:
            invited_uid = users_ref[0].id
            
            # Create invitation document
            self.db.collection('invitations').add({
                'itineraryId': itin_id,
                'invitedEmail': invited_email,
                'invitedUid': invited_uid,
                'ownerId': owner_id,
                'status': 'pending',
                'role': 'Viewer',
                'createdAt': datetime.utcnow().isoformat()
            })

            # Update itinerary doc
            self.db.collection('itineraries').document(itin_id).update({
                f'collaborators.{invited_uid}': {'role': 'Viewer', 'status': 'pending'},
                'collaboratorEmails': firestore.ArrayUnion([invited_email])
            })

            # Send Notification
            self.db.collection('notifications').add({
                'recipientUid': invited_uid,
                'message': "You were invited to collaborate on an itinerary!",
                'itineraryId': itin_id,
                'isRead': False,
                'createdAt': datetime.utcnow().isoformat()
            })

            return {'success': True, 'message': 'Invitation sent successfully!'}
        else:
            return {'success': False, 'message': 'User not registered. External email invitation queued.'}

    # FR 4.2: Accept/Decline Invitation
    def respond_invitation(self, invitation_id, user_uid, action):
        invitation_ref = self.db.collection('invitations').document(invitation_id)
        invitation = invitation_ref.get()

        if not invitation.exists:
            return {'success': False, 'message': 'Invitation not found'}

        invitation_data = invitation.to_dict()

        if action == 'accept':
            # Update invitation status
            invitation_ref.update({
                'status': 'accepted',
                'respondedAt': datetime.utcnow().isoformat()
            })

            # Update itinerary collaborator status
            itin_id = invitation_data.get('itineraryId')
            self.db.collection('itineraries').document(itin_id).update({
                f'collaborators.{user_uid}.status': 'active'
            })

            return {'success': True, 'message': 'Invitation accepted'}
        elif action == 'decline':
            invitation_ref.update({
                'status': 'declined',
                'respondedAt': datetime.utcnow().isoformat()
            })

            return {'success': True, 'message': 'Invitation declined'}
        else:
            return {'success': False, 'message': 'Invalid action'}

    # FR 4.4: Update Shared Itinerary
    def update_itinerary(self, itin_id, editor_uid, stops):
        try:
            itin_ref = self.db.collection('itineraries').document(itin_id)
            itin_doc = itin_ref.get()

            if not itin_doc.exists:
                return {'success': False, 'message': 'Itinerary not found'}

            # Update stops in the itinerary
            itin_ref.update({
                'stops': stops,
                'updatedAt': datetime.utcnow().isoformat(),
                'lastEditedBy': editor_uid
            })

            # Notify collaborators (except the editor)
            itin_data = itin_doc.to_dict()
            collaborators = itin_data.get('collaborators', {})

            for collab_uid, collab_data in collaborators.items():
                if collab_uid != editor_uid and collab_data.get('status') == 'active':
                    self.db.collection('notifications').add({
                        'recipientUid': collab_uid,
                        'message': f"Itinerary was updated with {len(stops)} stops",
                        'itineraryId': itin_id,
                        'isRead': False,
                        'createdAt': datetime.utcnow().isoformat()
                    })

            return {'success': True, 'message': 'Itinerary updated successfully'}
        except Exception as e:
            return {'success': False, 'message': str(e)}

    # FR 4.5: Add Comment
    def add_comment(self, itin_id, author_uid, author_name, text):
        try:
            self.db.collection('itineraries').document(itin_id).collection('comments').add({
                'authorUid': author_uid,
                'authorName': author_name,
                'text': text,
                'createdAt': datetime.utcnow().isoformat()
            })

            # Update itinerary last activity
            self.db.collection('itineraries').document(itin_id).update({
                'lastActivityAt': datetime.utcnow().isoformat()
            })

            return {'success': True, 'message': 'Comment added successfully'}
        except Exception as e:
            return {'success': False, 'message': str(e)}

    # New: Update single stop
    def update_stop(self, itin_id, stop_index, stop_data, editor_uid):
        try:
            itin_ref = self.db.collection('itineraries').document(itin_id)
            itin_doc = itin_ref.get()

            if not itin_doc.exists:
                return {'success': False, 'message': 'Itinerary not found'}

            itin_data = itin_doc.to_dict()
            stops = itin_data.get('stops', [])

            if stop_index < 0 or stop_index >= len(stops):
                return {'success': False, 'message': 'Invalid stop index'}

            # Update the specific stop
            stops[stop_index] = {
                **stops[stop_index],
                **stop_data,
                'updatedAt': datetime.utcnow().isoformat(),
                'updatedBy': editor_uid
            }

            # Save updated stops
            itin_ref.update({
                'stops': stops,
                'updatedAt': datetime.utcnow().isoformat(),
                'lastEditedBy': editor_uid
            })

            # Notify collaborators
            collaborators = itin_data.get('collaborators', {})
            for collab_uid, collab_data in collaborators.items():
                if collab_uid != editor_uid and collab_data.get('status') == 'active':
                    self.db.collection('notifications').add({
                        'recipientUid': collab_uid,
                        'message': f"Stop {stop_index + 1} was updated: {stop_data.get('name', 'Unknown')}",
                        'itineraryId': itin_id,
                        'isRead': False,
                        'createdAt': datetime.utcnow().isoformat()
                    })

            return {'success': True, 'message': 'Stop updated successfully'}
        except Exception as e:
            return {'success': False, 'message': str(e)}