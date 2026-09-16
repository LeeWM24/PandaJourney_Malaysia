import unittest
from unittest.mock import patch

import app as app_module


class AuthenticationSecurityTests(unittest.TestCase):
    def setUp(self):
        app_module.app.config.update(
            TESTING=True,
            SECRET_KEY="test-secret",
        )
        self.client = app_module.app.test_client()

    def test_dashboard_redirects_without_server_session(self):
        response = self.client.get("/dashboard")

        self.assertEqual(response.status_code, 302)
        self.assertIn("/login?next=/dashboard", response.location)

    def test_profile_redirects_without_server_session(self):
        response = self.client.get("/profile")

        self.assertEqual(response.status_code, 302)
        self.assertIn("/login?next=/profile", response.location)

    def test_session_login_rejects_missing_token(self):
        response = self.client.post(
            "/session-login",
            json={},
        )

        self.assertEqual(response.status_code, 400)

    @patch("app._verify_firebase_id_token")
    def test_verified_firebase_token_creates_session(
        self,
        verify_token,
    ):
        verify_token.return_value = {
            "uid": "user-123",
            "email": "user@example.com",
            "name": "Test User",
            "email_verified": True,
        }

        response = self.client.post(
            "/session-login",
            json={"idToken": "valid-token"},
        )

        self.assertEqual(response.status_code, 200)

        with self.client.session_transaction() as session:
            self.assertEqual(
                session["user"]["uid"],
                "user-123",
            )
            self.assertTrue(session.permanent)

    @patch("app._verify_firebase_id_token")
    def test_unverified_email_does_not_create_session(
        self,
        verify_token,
    ):
        verify_token.return_value = {
            "uid": "user-123",
            "email": "user@example.com",
            "email_verified": False,
        }

        response = self.client.post(
            "/session-login",
            json={"idToken": "unverified-token"},
        )

        self.assertEqual(response.status_code, 403)

        with self.client.session_transaction() as session:
            self.assertNotIn("user", session)

    @patch("app._verify_firebase_id_token")
    def test_invalid_token_is_rejected(
        self,
        verify_token,
    ):
        verify_token.side_effect = app_module.FirebaseTokenRejected()

        response = self.client.post(
            "/session-login",
            json={"idToken": "invalid-token"},
        )

        self.assertEqual(response.status_code, 401)

    def test_private_pages_redirect_without_session(self):
        private_paths = [
            "/smart-itinerary",
            "/saved-itineraries",
            "/saved-itineraries/example-id",
            "/saved-itineraries/example-id/edit",
            "/collaboration",
        ]

        for path in private_paths:
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 302)
                self.assertIn("/login?next=", response.location)

    def test_private_api_returns_json_unauthorized(self):
        response = self.client.get("/api/location-suggestions?q=Kuala")

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.get_json()["error"], "Authentication required.")


if __name__ == "__main__":
    unittest.main()
